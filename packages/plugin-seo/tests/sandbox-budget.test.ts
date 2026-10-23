// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// B39: calls to the host per sandboxed invocation, counted on the real sandbox bridge.
//
// On Cloudflare each hook call, route call and cron run may make 10 calls to the host (see
// bridge-budget.ts); every ctx.* call counts, ctx.log included, and the 11th throws. These tests
// pin the CURRENT number of calls of every path, measured on a cold isolate (settings not yet in
// memory), so any change shows up here. They are a record, not a target: a number above 9 is
// marked TODO(B39) and explained in the B39 audit; lowering it is product work.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { PublicPageContext } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { isDuplicate, type EntryRecord } from "../src/record.js";
import { describeCalls, measure, type Measured } from "./bridge-budget.js";

const PAGE = "/overview";
const LONG_TEXT =
	"We bake bread every morning in our small kitchen on the high street, with flour from a mill down the road. ".repeat(
		4,
	);

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function start(): Promise<PluginRuntimeTestHost> {
	host = await createPluginRuntimeTestHost({
		site: { name: "Acme", url: "https://acme.test", locale: "en" },
	});
	await host.fixtures.collection({
		slug: "pages",
		label: "Pages",
		urlPattern: "/{slug}",
		supports: ["drafts", "revisions", "seo"],
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "body", label: "Body", type: "text" },
		],
	});
	return host;
}

function addPage(runtime: PluginRuntimeTestHost, slug: string, title: string) {
	return runtime.fixtures.content("pages", {
		slug,
		data: { title, body: LONG_TEXT },
		status: "published",
	});
}

/** Settings saved by this release (under settings:), and the copy kept for the earlier one. */
async function configured(runtime: PluginRuntimeTestHost) {
	await runtime.fixtures.plugin.setting("config", DEFAULT_CONFIG);
	await runtime.fixtures.plugin.kv("config", DEFAULT_CONFIG);
}

/** Updated from a release before 0.1.8: the settings only under the old KV key. */
async function migrated(runtime: PluginRuntimeTestHost) {
	await runtime.fixtures.plugin.kv("config", DEFAULT_CONFIG);
}

function page(overrides: Partial<PublicPageContext> = {}): PublicPageContext {
	return {
		url: "https://acme.test/about",
		path: "/about",
		locale: null,
		kind: "custom",
		pageType: "website",
		title: "About | Acme",
		pageTitle: "About",
		description: null,
		canonical: null,
		image: null,
		...overrides,
	};
}

function contentPage(id: string, slug = "about"): PublicPageContext {
	return page({
		url: `https://acme.test/${slug}`,
		path: `/${slug}`,
		kind: "content",
		pageType: "article",
		content: { collection: "pages", id, slug },
	} as Partial<PublicPageContext>);
}

const metadata = (runtime: PluginRuntimeTestHost, context: PublicPageContext) =>
	runtime.transport.invokeHook("page:metadata", { page: context });

/** Measure one invocation on a fresh isolate: nothing the plugin keeps in memory helps it. */
async function cold<T>(
	runtime: PluginRuntimeTestHost,
	label: string,
	invoke: () => Promise<T>,
): Promise<Measured<T>> {
	await runtime.restart();
	const measured = await measure(invoke);
	console.info(describeCalls(label, measured));
	return measured;
}

/** Run the site-wide check to the end, as the SEO page and its background task would. */
async function checkAll(runtime: PluginRuntimeTestHost) {
	await runtime.admin.loadPage(PAGE);
	for (let step = 0; step < 20; step += 1) {
		const scan = await runtime.inspect.kv.get<{ status: string; sweep?: unknown }>("scan");
		if (scan?.status === "done" && !scan.sweep) return;
		await runtime.transport.invokeHook("cron", { name: "seo-scan" });
	}
	throw new Error("the check never finished");
}

describe("page:metadata (every uncached public page view)", () => {
	it("a page that is not an entry, on a site that never saved settings", async () => {
		const runtime = await start();
		const m = await cold(runtime, "metadata custom fresh", () => metadata(runtime, page()));
		expect(m.error).toBeUndefined();
		expect(m.calls).toEqual(["settingsGet", "kvGet"]);
	});

	it("is free once the settings are in memory", async () => {
		const runtime = await start();
		await configured(runtime);
		await runtime.restart();
		await metadata(runtime, page());
		const m = await measure(() => metadata(runtime, page()));
		expect(m.calls).toEqual([]);
	});

	it("an entry with its record, on a configured site", async () => {
		const runtime = await start();
		await configured(runtime);
		const entry = await addPage(runtime, "about", "About us");
		await checkAll(runtime);
		const m = await cold(runtime, "metadata entry configured", () =>
			metadata(runtime, contentPage(entry.id)),
		);
		expect(m.error).toBeUndefined();
		expect(m.calls).toEqual(["settingsGet", "storageGet"]);
	});

	it("an entry with its record, on a site updated from an earlier release", async () => {
		const runtime = await start();
		await migrated(runtime);
		const entry = await addPage(runtime, "about", "About us");
		await checkAll(runtime);
		// The check copied the settings forward; put the site back as it was after the update.
		await runtime.fixtures.plugin.setting("config", null);
		const m = await cold(runtime, "metadata entry migrated", () =>
			metadata(runtime, contentPage(entry.id)),
		);
		expect(m.error).toBeUndefined();
		expect(m.calls.length).toBe(4);
	});

	it("an entry whose picture for shared links is news (writes the record back)", async () => {
		const runtime = await start();
		await configured(runtime);
		const entry = await addPage(runtime, "about", "About us");
		await checkAll(runtime);
		const m = await cold(runtime, "metadata entry image news", () =>
			metadata(runtime, { ...contentPage(entry.id), image: "https://acme.test/hero.jpg" }),
		);
		expect(m.error).toBeUndefined();
		expect(m.calls.length).toBe(4);
	});

	it("first view of an entry saved before the plugin was installed, configured site", async () => {
		const runtime = await start();
		await configured(runtime);
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "metadata no record configured", () =>
			metadata(runtime, contentPage(entry.id)),
		);
		expect(m.error).toBeUndefined();
		expect(await runtime.inspect.storage.get("entries", `pages:${entry.id}`)).not.toBeNull();
		expect(m.calls.length).toBe(9);
	});

	it("first view of an entry saved before the plugin was installed, fresh site", async () => {
		const runtime = await start();
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "metadata no record fresh", () =>
			metadata(runtime, contentPage(entry.id)),
		);
		expect(m.error).toBeUndefined();
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 (see the B39 audit). This is
		// the first view of every page on a fresh registry install until the check has run.
		expect(m.calls.length).toBe(11);
	});

	it("that first view under Cloudflare's limit: the page renders, without the entry's details", async () => {
		const runtime = await start();
		const entry = await addPage(runtime, "about", "About us");
		await runtime.restart();
		const m = await measure(() => metadata(runtime, contentPage(entry.id)), { enforce: true });
		console.info(describeCalls("metadata no record fresh enforced", m));
		expect(m.error).toBeUndefined();
		// The record was written before the limit; reading the pages that share its title was
		// refused, and so was the warning about it.
		expect(m.refused).toEqual(["storageQuery", "log"]);
		expect(await runtime.inspect.storage.get("entries", `pages:${entry.id}`)).not.toBeNull();
	});

	it("first view of an entry saved before the plugin was installed, updated site", async () => {
		const runtime = await start();
		await migrated(runtime);
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "metadata no record migrated", () =>
			metadata(runtime, contentPage(entry.id)),
		);
		expect(m.error).toBeUndefined();
		// TODO(B39): over Cloudflare's sandbox limit of 10 (see the B39 audit).
		expect(m.calls.length).toBe(11);
	});
});

describe("content hooks (each save, publish, unpublish, restore, delete)", () => {
	const save = (runtime: PluginRuntimeTestHost, id: string, hook = "content:afterSave") =>
		runtime.transport.invokeHook(hook, { collection: "pages", content: { id }, isNew: false });

	/** Records of the given pages, as stored. */
	const records = async (runtime: PluginRuntimeTestHost, ids: string[]) =>
		Promise.all(ids.map((id) => runtime.inspect.storage.get(`entries`, `pages:${id}`)));
	const flagged = async (runtime: PluginRuntimeTestHost, id: string) => {
		const record = await runtime.inspect.storage.get<EntryRecord>("entries", `pages:${id}`);
		return record ? isDuplicate(record) : false;
	};
	/**
	 * Give a page a new title and publish it, then put every record back as it was before: EmDash
	 * runs the save hooks of that edit in the background, and the measured run is the one that
	 * has to settle the titles.
	 */
	async function retitle(runtime: PluginRuntimeTestHost, ids: string[], id: string, title: string) {
		const before = await records(runtime, ids);
		await runtime.actions.content.update("pages", id, { data: { title, body: LONG_TEXT } });
		await runtime.actions.content.publish("pages", id);
		await new Promise((resolve) => setTimeout(resolve, 200));
		for (const [index, recordId] of ids.entries())
			await runtime.fixtures.plugin.storage("entries", `pages:${recordId}`, before[index]);
	}

	for (const hook of [
		"content:afterSave",
		"content:afterPublish",
		"content:afterUnpublish",
		"content:afterRestore",
	]) {
		it(`${hook}: an ordinary save on a configured site`, async () => {
			const runtime = await start();
			await configured(runtime);
			const entry = await addPage(runtime, "about", "About us");
			await save(runtime, entry.id, hook);
			const m = await cold(runtime, `${hook} configured`, () => save(runtime, entry.id, hook));
			expect(m.error).toBeUndefined();
			expect(m.calls.length).toBe(7);
		});
	}

	it("content:afterSave on a site that never saved settings", async () => {
		const runtime = await start();
		const entry = await addPage(runtime, "about", "About us");
		await save(runtime, entry.id);
		const m = await cold(runtime, "afterSave fresh", () => save(runtime, entry.id));
		expect(m.calls.length).toBe(8);
	});

	it("content:afterSave, first save after updating from an earlier release", async () => {
		const runtime = await start();
		await migrated(runtime);
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "afterSave migrated first", () => save(runtime, entry.id));
		expect(m.calls.length).toBe(9);
	});

	it("content:afterSave moving a page between shared titles, fresh site", async () => {
		const runtime = await start();
		const a = await addPage(runtime, "a", "Our services");
		const b = await addPage(runtime, "b", "Our services");
		const c = await addPage(runtime, "c", "Weddings");
		for (const entry of [a, b, c]) await save(runtime, entry.id);
		await retitle(runtime, [a.id, b.id, c.id], b.id, "Weddings");
		const m = await cold(runtime, "afterSave move titles fresh", () => save(runtime, b.id));
		expect(m.error).toBeUndefined();
		expect(await flagged(runtime, a.id)).toBe(false);
		expect(await flagged(runtime, c.id)).toBe(true);
		expect(m.calls.length).toBe(9);
	});

	it("content:afterSave moving a page between shared titles, updated site", async () => {
		const runtime = await start();
		await migrated(runtime);
		const a = await addPage(runtime, "a", "Our services");
		const b = await addPage(runtime, "b", "Our services");
		const c = await addPage(runtime, "c", "Weddings");
		for (const entry of [a, b, c]) await save(runtime, entry.id);
		await retitle(runtime, [a.id, b.id, c.id], b.id, "Weddings");
		await runtime.fixtures.plugin.setting("config", null);
		const m = await cold(runtime, "afterSave move titles migrated", () => save(runtime, b.id));
		expect(m.error).toBeUndefined();
		expect(await flagged(runtime, a.id)).toBe(false);
		expect(await flagged(runtime, c.id)).toBe(true);
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 (see the B39 audit).
		expect(m.calls.length).toBe(10);
	});

	it("content:afterDelete of a page that shared its title", async () => {
		const runtime = await start();
		const a = await addPage(runtime, "a", "Our services");
		const b = await addPage(runtime, "b", "Our services");
		for (const entry of [a, b]) await save(runtime, entry.id);
		const m = await cold(runtime, "afterDelete shared title", () =>
			runtime.transport.invokeHook("content:afterDelete", { collection: "pages", id: b.id }),
		);
		expect(m.calls).toEqual(["storageGet", "storageDelete", "storageQuery", "storagePutMany"]);
	});
});

describe("plugin:activate and the background tasks", () => {
	it("plugin:activate on a site with pages, never saved settings", async () => {
		const runtime = await start();
		for (let index = 0; index < 3; index += 1) await addPage(runtime, `p${index}`, `Page ${index}`);
		const m = await cold(runtime, "activate fresh", () =>
			runtime.transport.invokeHook("plugin:activate", {}),
		);
		expect(m.error).toBeUndefined();
		expect(m.calls.length).toBe(10);
	});

	it("each step of the background check on a site of 45 pages", async () => {
		const runtime = await start();
		for (let index = 0; index < 45; index += 1)
			await addPage(runtime, `p${index}`, `Page number ${index}`);
		await runtime.admin.loadPage(PAGE);
		const steps: number[] = [];
		for (let step = 0; step < 20; step += 1) {
			const scan = await runtime.inspect.kv.get<{ status: string; sweep?: unknown }>("scan");
			if (scan?.status === "done" && !scan.sweep) break;
			const m = await cold(runtime, `cron seo-scan step ${step}`, () =>
				runtime.transport.invokeHook("cron", { name: "seo-scan" }),
			);
			expect(m.error).toBeUndefined();
			steps.push(m.calls.length);
		}
		expect(steps.length).toBeGreaterThan(2);
		expect(Math.max(...steps)).toBe(8);
	});
});

describe("SEO admin page", () => {
	it("first visit on a site with pages starts the check", async () => {
		const runtime = await start();
		for (let index = 0; index < 3; index += 1) await addPage(runtime, `p${index}`, `Page ${index}`);
		const m = await cold(runtime, "admin first visit", () => runtime.admin.loadPage(PAGE));
		expect(m.error).toBeUndefined();
		expect(m.calls.length).toBe(9);
	});

	it("a visit once the check is done recounts", async () => {
		const runtime = await start();
		for (let index = 0; index < 3; index += 1) await addPage(runtime, `p${index}`, `Page ${index}`);
		await checkAll(runtime);
		const m = await cold(runtime, "admin visit done", () => runtime.admin.loadPage(PAGE));
		expect(m.calls.length).toBe(9);
	});

	it("the dashboard widget", async () => {
		const runtime = await start();
		await addPage(runtime, "p", "Page");
		await checkAll(runtime);
		const m = await cold(runtime, "widget", () => runtime.admin.loadWidget("seo"));
		expect(m.calls.length).toBe(9);
	});

	it("saving the identity on a site updated from an earlier release", async () => {
		const runtime = await start();
		await migrated(runtime);
		const m = await cold(runtime, "save_identity migrated", () =>
			runtime.admin.submit(PAGE, "save_identity", { kind: "organization", name: "Acme" }),
		);
		expect(m.calls.length).toBe(6);
	});

	for (const action of [
		"save_contact",
		"save_hours",
		"save_profiles",
		"save_company",
		"save_advanced",
		"save_logo",
	]) {
		it(`${action} on a configured site`, async () => {
			const runtime = await start();
			await configured(runtime);
			const m = await cold(runtime, action, () => runtime.admin.submit(PAGE, action, {}));
			expect(m.calls.length).toBe(5);
		});
	}

	it("check_pages restarts the check", async () => {
		const runtime = await start();
		for (let index = 0; index < 3; index += 1) await addPage(runtime, `p${index}`, `Page ${index}`);
		await checkAll(runtime);
		const m = await cold(runtime, "check_pages", () => runtime.admin.act(PAGE, "check_pages"));
		expect(m.calls.length).toBe(9);
	});
});

describe("redirects on the SEO page", () => {
	it("check_redirects reads the existing redirects and stores the plan", async () => {
		const runtime = await start();
		const m = await cold(runtime, "check_redirects", () =>
			runtime.admin.submit(PAGE, "check_redirects", { list: "/a,/x\n/b,/y" }),
		);
		expect(m.calls.length).toBe(5);
	});

	it("add_redirects with 20 rows goes on until the host refuses (by design)", async () => {
		const runtime = await start();
		const list = Array.from({ length: 20 }, (_, i) => `/old-${i},/new-${i}`).join("\n");
		await runtime.admin.submit(PAGE, "check_redirects", { list });
		const m = await cold(runtime, "add_redirects 20 rows", () =>
			runtime.admin.act(PAGE, "add_redirects"),
		);
		// TODO(B39): 32 calls with no limit (every row in one request). On Cloudflare the 11th call
		// throws and the import continues from its last saved row in the background task, by design.
		expect(m.calls.length).toBe(32);
	});

	it("add_redirects with 20 rows under Cloudflare's limit keeps its progress", async () => {
		const runtime = await start();
		const list = Array.from({ length: 20 }, (_, i) => `/old-${i},/new-${i}`).join("\n");
		await runtime.admin.submit(PAGE, "check_redirects", { list });
		await runtime.restart();
		const m = await measure(() => runtime.admin.act(PAGE, "add_redirects"), { enforce: true });
		console.info(describeCalls("add_redirects 20 rows enforced", m));
		expect(m.error).toBeUndefined();
		expect((await runtime.inspect.redirects()).length).toBeGreaterThan(0);
		const state = await runtime.inspect.kv.get<{ cursor: number; status: string }>("redirects");
		expect(state?.status).toBe("adding");
		expect(state?.cursor).toBe(4);
	});

	it("remove_redirects with 20 imported redirects", async () => {
		const runtime = await start();
		const list = Array.from({ length: 20 }, (_, i) => `/old-${i},/new-${i}`).join("\n");
		await runtime.admin.submit(PAGE, "check_redirects", { list });
		await runtime.admin.act(PAGE, "add_redirects");
		const m = await cold(runtime, "remove_redirects 20", () =>
			runtime.admin.act(PAGE, "remove_redirects"),
		);
		// TODO(B39): 47 calls, two per redirect; it relies on the host refusing the 11th call to stop,
		// and asks to press Remove again for the rest.
		expect(m.calls.length).toBe(47);
	});

	it("export_redirects", async () => {
		const runtime = await start();
		await runtime.fixtures.redirect({ source: "/a", destination: "/b" });
		const m = await cold(runtime, "export_redirects", () =>
			runtime.admin.act(PAGE, "export_redirects"),
		);
		expect(m.calls.length).toBe(4);
	});

	it("add_redirect, save_redirect and remove_redirect", async () => {
		const runtime = await start();
		const added = await cold(runtime, "add_redirect", () =>
			runtime.admin.submit(PAGE, "add_redirect", { source: "/a", destination: "/b", code: "301" }),
		);
		expect(added.calls.length).toBe(5);
		const [row] = await runtime.inspect.redirects();
		const saved = await cold(runtime, "save_redirect", () =>
			runtime.admin.submit(PAGE, `save_redirect:${row?.id}`, { destination: "/c" }),
		);
		expect(saved.calls.length).toBe(6);
		const removed = await cold(runtime, "remove_redirect", () =>
			runtime.admin.act(PAGE, "remove_redirect", { value: row?.id }),
		);
		expect(removed.calls.length).toBe(6);
	});
});

describe("Google preview panel", () => {
	it("opening it on a site that never saved settings", async () => {
		const runtime = await start();
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "panel load fresh", () =>
			runtime.admin.loadEditorPanel("preview", "pages", entry.id),
		);
		expect(m.error).toBeUndefined();
		expect(m.calls.length).toBe(8);
	});

	it("changing the page type, updated site", async () => {
		const runtime = await start();
		await migrated(runtime);
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "panel set_type migrated", () =>
			runtime.admin.actEditorPanel("preview", "pages", entry.id, "set_type", {
				value: "AboutPage",
			}),
		);
		expect(m.error).toBeUndefined();
		expect(m.calls.length).toBe(9);
	});
});
