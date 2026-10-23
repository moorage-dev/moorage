// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// B39: calls to the host per sandboxed invocation, counted on the real sandbox bridge.
//
// On Cloudflare each hook call, route call and cron run may make 10 calls to the host (see
// bridge-budget.ts); every ctx.* call counts, ctx.log included, and the 11th throws. These tests
// pin the number of calls of every path, measured on a cold isolate (settings not yet in memory),
// so any change shows up here, and hold every path to at most 9: one below the limit, so a log
// line on an unexpected error still fits.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { PublicPageContext } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { isDuplicate, type EntryRecord } from "../src/record.js";
import { describeCalls, measure, SANDBOX_SUBREQUESTS, type Measured } from "./bridge-budget.js";

/** The most calls any path may make: one below Cloudflare's limit. */
const BUDGET = SANDBOX_SUBREQUESTS - 1;

/** Calls that change something. A public page view makes none of them, except the one below. */
const WRITES = new Set([
	"kvSet",
	"kvDelete",
	"settingsSet",
	"settingsDelete",
	"storagePut",
	"storagePutMany",
	"storageDelete",
	"storageDeleteMany",
]);
const writes = (m: Measured<unknown>) => m.calls.filter((call) => WRITES.has(call));

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
	expect(measured.calls.length, label).toBeLessThanOrEqual(BUDGET);
	return measured;
}

/** The same with Cloudflare's limit enforced: nothing may be refused. */
async function enforced<T>(
	runtime: PluginRuntimeTestHost,
	label: string,
	invoke: () => Promise<T>,
): Promise<Measured<T>> {
	await runtime.restart();
	const measured = await measure(invoke, { enforce: true });
	console.info(describeCalls(label, measured));
	expect(measured.refused, label).toEqual([]);
	expect(measured.error, label).toBeUndefined();
	expect(measured.calls.length, label).toBeLessThanOrEqual(BUDGET);
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
		// Both are read at once, so they may arrive in either order.
		expect(m.calls).toHaveLength(2);
		expect(m.calls).toEqual(expect.arrayContaining(["settingsGet", "storageGet"]));
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
		expect(writes(m)).toEqual([]);
		expect(m.calls.length).toBe(3);
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

	// An entry saved before the plugin was installed has no record yet. Its page is described
	// from the entry itself, read for this view only: nothing is written, and the record is left
	// to the check (started when the plugin is switched on) or the entry's next save.
	it("first view of an entry saved before the plugin was installed, configured site", async () => {
		const runtime = await start();
		await configured(runtime);
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "metadata no record configured", () =>
			metadata(runtime, contentPage(entry.id)),
		);
		expect(m.error).toBeUndefined();
		expect(writes(m)).toEqual([]);
		expect(await runtime.inspect.storage.get("entries", `pages:${entry.id}`)).toBeNull();
		expect(m.calls.length).toBe(4);
	});

	it("first view of an entry saved before the plugin was installed, fresh site", async () => {
		const runtime = await start();
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "metadata no record fresh", () =>
			metadata(runtime, contentPage(entry.id)),
		);
		expect(m.error).toBeUndefined();
		expect(writes(m)).toEqual([]);
		expect(m.calls.length).toBe(5);
	});

	it("that first view under Cloudflare's limit: nothing is refused", async () => {
		const runtime = await start();
		const entry = await addPage(runtime, "about", "About us");
		await enforced(runtime, "metadata no record fresh enforced", () =>
			metadata(runtime, contentPage(entry.id)),
		);
	});

	it("first view of an entry saved before the plugin was installed, updated site", async () => {
		const runtime = await start();
		await migrated(runtime);
		const entry = await addPage(runtime, "about", "About us");
		const m = await cold(runtime, "metadata no record migrated", () =>
			metadata(runtime, contentPage(entry.id)),
		);
		expect(m.error).toBeUndefined();
		// The settings are copied to their new place by the SEO page, never by a page view.
		expect(writes(m)).toEqual([]);
		expect(await runtime.inspect.setting("config")).toBeNull();
		expect(m.calls.length).toBe(5);
	});

	it("an ordinary view writes nothing, on any site", async () => {
		const runtime = await start();
		await migrated(runtime);
		const entry = await addPage(runtime, "about", "About us");
		await checkAll(runtime);
		await runtime.fixtures.plugin.setting("config", null);
		for (const context of [page(), contentPage(entry.id)]) {
			const m = await cold(runtime, "metadata ordinary view", () => metadata(runtime, context));
			expect(writes(m)).toEqual([]);
		}
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
		expect(m.calls.length).toBe(8);
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
		expect(m.calls.length).toBe(9);
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
		expect(m.calls.length).toBe(8);
		expect(await runtime.inspect.kv.get("scan")).toMatchObject({ status: "done", checked: 3 });
	});

	it("plugin:activate on a site updated from an earlier release, with more pages than one step", async () => {
		const runtime = await start();
		await migrated(runtime);
		for (let index = 0; index < 25; index += 1)
			await addPage(runtime, `p${index}`, `Page ${index}`);
		const m = await cold(runtime, "activate migrated 25 pages", () =>
			runtime.transport.invokeHook("plugin:activate", {}),
		);
		expect(m.error).toBeUndefined();
		expect(await runtime.inspect.kv.get("scan")).toMatchObject({ status: "running", checked: 20 });
	});

	it("plugin:activate again, once the check has run, changes nothing", async () => {
		const runtime = await start();
		await addPage(runtime, "p", "Page");
		await checkAll(runtime);
		const before = await runtime.inspect.kv.get("scan");
		const m = await cold(runtime, "activate again", () =>
			runtime.transport.invokeHook("plugin:activate", {}),
		);
		expect(writes(m)).toEqual([]);
		expect(await runtime.inspect.kv.get("scan")).toEqual(before);
	});

	it("each step of the check when an empty collection comes before the pages", async () => {
		const runtime = await start();
		for (const slug of ["articles", "events", "news"]) {
			await runtime.fixtures.collection({
				slug,
				label: slug,
				urlPattern: `/${slug}/{slug}`,
				supports: ["drafts", "revisions", "seo"],
				fields: [{ slug: "title", label: "Title", type: "string" }],
			});
		}
		for (let index = 0; index < 25; index += 1)
			await addPage(runtime, `p${index}`, `Page ${index}`);
		await cold(runtime, "admin first visit, empty collections first", () =>
			runtime.admin.loadPage(PAGE),
		);
		for (let step = 0; step < 20; step += 1) {
			const scan = await runtime.inspect.kv.get<{ status: string; sweep?: unknown }>("scan");
			if (scan?.status === "done" && !scan.sweep) break;
			await cold(runtime, `cron seo-scan step ${step}, empty collections first`, () =>
				runtime.transport.invokeHook("cron", { name: "seo-scan" }),
			);
		}
		expect(await runtime.inspect.kv.get("scan")).toMatchObject({ status: "done", checked: 25 });
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

	for (const [label, invoke] of [
		["admin visit", (runtime: PluginRuntimeTestHost) => runtime.admin.loadPage(PAGE)],
		["widget", (runtime: PluginRuntimeTestHost) => runtime.admin.loadWidget("seo")],
		["check_pages", (runtime: PluginRuntimeTestHost) => runtime.admin.act(PAGE, "check_pages")],
	] as const) {
		it(`${label} on a site updated from an earlier release, check done`, async () => {
			const runtime = await start();
			await migrated(runtime);
			for (let index = 0; index < 3; index += 1)
				await addPage(runtime, `p${index}`, `Page ${index}`);
			await checkAll(runtime);
			await runtime.fixtures.plugin.setting("config", null);
			const m = await cold(runtime, `${label} migrated done`, () => invoke(runtime));
			expect(m.error).toBeUndefined();
		});
	}

	it("saving the identity on a site updated from an earlier release", async () => {
		const runtime = await start();
		await migrated(runtime);
		const m = await cold(runtime, "save_identity migrated", () =>
			runtime.admin.submit(PAGE, "save_identity", { kind: "organization", name: "Acme" }),
		);
		expect(m.calls.length).toBe(5);
	});

	for (const action of [
		"save_contact",
		"save_hours",
		"save_profiles",
		"save_company",
		"save_advanced",
		"save_logo",
		// The switch that hides the help line: the same one settings write as the others.
		"save_help_line",
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

	const ROWS = 20;
	const list = Array.from({ length: ROWS }, (_, i) => `/old-${i},/new-${i}`).join("\n");
	type Import = { status: string; added: number; cursor: number; skipped: unknown[] };

	/** Run the background task under Cloudflare's limit until the import is no longer under way. */
	async function background(runtime: PluginRuntimeTestHost, label: string) {
		const runs: number[] = [];
		for (let run = 0; run < 30; run += 1) {
			const state = await runtime.inspect.kv.get<Import>("redirects");
			if (state?.status !== "adding" && state?.status !== "removing") return runs;
			const m = await enforced(runtime, `${label} cron ${run}`, () =>
				runtime.transport.invokeHook("cron", { name: "redirects-import" }),
			);
			runs.push(m.calls.length);
		}
		throw new Error("the background task never finished");
	}

	it("add_redirects with 20 rows: the click adds what fits, the background task the rest", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "check_redirects", { list });
		const click = await enforced(runtime, "add_redirects 20 rows", () =>
			runtime.admin.act(PAGE, "add_redirects"),
		);
		const after = await runtime.inspect.kv.get<Import>("redirects");
		expect(after?.status).toBe("adding");
		expect(after?.added).toBeGreaterThan(0);
		// The admin is told how far it got, and that the rest follow.
		expect(click.result?.toast?.message).toBe(
			`${after?.added} added so far. The rest follow in the background, a few each minute.`,
		);
		expect(JSON.stringify(click.result?.blocks)).toContain(`${after?.added} of ${ROWS} added`);

		const runs = await background(runtime, "add_redirects");
		expect(runs.length).toBeGreaterThan(0);
		const done = await runtime.inspect.kv.get<Import>("redirects");
		expect(done).toMatchObject({ status: "done", added: ROWS, cursor: ROWS, skipped: [] });
		expect((await runtime.inspect.redirects()).length).toBe(ROWS);
	});

	it("more_redirects continues where the import got to", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "check_redirects", { list });
		await runtime.admin.act(PAGE, "add_redirects");
		const before = (await runtime.inspect.kv.get<Import>("redirects"))?.added ?? 0;
		await enforced(runtime, "more_redirects", () => runtime.admin.act(PAGE, "more_redirects"));
		expect((await runtime.inspect.kv.get<Import>("redirects"))?.added).toBeGreaterThan(before);
	});

	it("remove_redirects with 20 imported redirects: the rest are removed in the background", async () => {
		const runtime = await start();
		await runtime.fixtures.redirect({ source: "/keep", destination: "/kept" });
		await runtime.admin.submit(PAGE, "check_redirects", { list });
		await runtime.admin.act(PAGE, "add_redirects");
		await background(runtime, "add before remove");
		expect((await runtime.inspect.redirects()).length).toBe(ROWS + 1);

		const click = await enforced(runtime, "remove_redirects 20", () =>
			runtime.admin.act(PAGE, "remove_redirects"),
		);
		const after = await runtime.inspect.kv.get<Import & { removed?: number }>("redirects");
		expect(after?.status).toBe("removing");
		expect(click.result?.toast?.message).toBe(
			`${after?.removed ?? 0} removed so far. The rest are removed in the background, a few each minute.`,
		);
		expect(JSON.stringify(click.result?.blocks)).toContain(`of ${ROWS} removed`);

		await background(runtime, "remove_redirects");
		expect(await runtime.inspect.kv.get("redirects")).toBeNull();
		expect((await runtime.inspect.redirects()).map((row) => row.source)).toEqual(["/keep"]);
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
		expect(m.calls.length).toBe(8);
	});
});
