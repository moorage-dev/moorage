// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The `to_fix` MCP tool: the Overview's pages to fix, for an AI assistant, read only.

import type { Block } from "@emdash-cms/blocks";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { EntryRecord } from "../src/record.js";

const PAGE = "/overview";
const ROUTE = "mcp/to-fix";
const LONG_TEXT =
	"We bake bread every morning in our small kitchen on the high street, with flour from a mill down the road. ".repeat(
		4,
	);

interface ToFix {
	state: "ready" | "checking";
	counts: {
		pagesChecked: number;
		nothingToFix: number;
		toFix: number;
		hiddenFromSearch: number;
	} | null;
	pages: Array<{
		collection: string;
		id: string;
		title: string;
		address: string | null;
		issues: Array<{ code: string; message: string }>;
	}>;
	more: boolean;
	checkedSoFar?: number;
	lastFullCheck?: string;
	message?: string;
	error?: string;
}

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function start(): Promise<PluginRuntimeTestHost> {
	host = await createPluginRuntimeTestHost({
		site: { name: "Acme", url: "https://acme.test", locale: "en" },
	});
	for (const [slug, label, urlPattern] of [
		["pages", "Pages", "/{slug}"],
		["posts", "Posts", "/blog/{year}/{slug}"],
	] as const) {
		await host.fixtures.collection({
			slug,
			label,
			urlPattern,
			supports: ["drafts", "revisions", "seo"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "body", label: "Body", type: "text" },
			],
		});
	}
	return host;
}

/** A published entry; `described` gives it a search description and a picture (nothing to fix). */
async function add(
	runtime: PluginRuntimeTestHost,
	collection: string,
	slug: string,
	title: string,
	{ described = false, noIndex = false } = {},
) {
	const entry = await runtime.fixtures.content(collection, {
		slug,
		data: { title, body: LONG_TEXT },
		status: "published",
		publishedAt: "2026-03-04T10:00:00.000Z",
	});
	if (described || noIndex) {
		await runtime.actions.content.update(collection, entry.id, {
			seo: {
				...(described ? { description: "What we do.", image: "/hero.jpg" } : {}),
				...(noIndex ? { noIndex: true } : {}),
			},
		});
	}
	return entry;
}

/** Run the site-wide check to the end, as the SEO page and its background task would. */
async function checkAll(runtime: PluginRuntimeTestHost) {
	await runtime.admin.loadPage(PAGE);
	for (let step = 0; step < 30; step += 1) {
		const scan = await runtime.inspect.kv.get<{ status: string; sweep?: unknown }>("scan");
		if (scan?.status === "done" && !scan.sweep) return;
		await runtime.transport.invokeHook("cron", { name: "seo-scan" });
	}
	throw new Error("the check never finished");
}

async function editor(runtime: PluginRuntimeTestHost) {
	return runtime.fixtures.user({ email: "editor@acme.test", name: "Eddie", role: "editor" });
}

async function call(
	runtime: PluginRuntimeTestHost,
	body: unknown,
	role: "subscriber" | "contributor" | "author" | "editor" | "admin" = "editor",
): Promise<ToFix> {
	const user = await runtime.fixtures.user({ email: `${role}-${Math.random()}@acme.test`, role });
	const response = await runtime.actions.routes.request(ROUTE, {
		body,
		user,
		headers: { "X-EmDash-Request": "1" },
	});
	expect(response.status, await response.clone().text()).toBe(200);
	const json = (await response.json()) as { data?: ToFix } & ToFix;
	return json.data ?? json;
}

const flat = (blocks: Block[]): Block[] =>
	blocks.flatMap((block) =>
		block.type === "tab"
			? block.panels.flatMap((panel) => flat(panel.blocks))
			: block.type === "accordion"
				? flat(block.blocks)
				: [block],
	);

describe("to_fix: the manifest", () => {
	it("declares one read-only MCP tool on a private route with content:read", async () => {
		const runtime = await start();
		const route = runtime.manifest.routes.find(
			(entry) => (typeof entry === "string" ? entry : entry.name) === ROUTE,
		);
		expect(route).toMatchObject({ name: ROUTE, permission: "content:read" });
		expect(runtime.manifest.mcp?.tools).toEqual([
			expect.objectContaining({
				name: "to_fix",
				route: ROUTE,
				permission: "content:read",
				destructive: false,
				inputSchema: expect.objectContaining({
					type: "object",
					additionalProperties: false,
					properties: {
						limit: expect.objectContaining({
							type: "integer",
							minimum: 1,
							maximum: 100,
							default: 25,
						}),
						collection: expect.objectContaining({ type: "string" }),
					},
				}),
			}),
		]);
		const description = runtime.manifest.mcp?.tools?.[0]?.description ?? "";
		expect(description).not.toMatch(/moorage|hosting/i);
	});

	it("ships the tool in the descriptor sites load, not in the runtime code", async () => {
		// Read when the test runs: the harness builds dist/ before the tests start.
		const descriptor = (await import("../dist/index.mjs?raw")) as { default: string };
		const runtimeCode = (await import("../dist/plugin.mjs?raw")) as { default: string };
		expect(descriptor.default).toContain('"to_fix"');
		expect(descriptor.default).toContain('"mcp/to-fix"');
		expect(runtimeCode.default).not.toContain("to_fix");
	});
});

describe("to_fix: what it returns", () => {
	it("the Overview's pages to fix, worst first, with addresses, codes and the Overview's counts", async () => {
		const runtime = await start();
		const contact = await add(runtime, "pages", "contact", "Contact");
		const home = await add(runtime, "pages", "home-page", "Home");
		await add(runtime, "pages", "about", "About us", { described: true });
		await add(runtime, "pages", "secret", "Secret", { noIndex: true });
		const news = await add(runtime, "posts", "news", "Bread news");
		await new Promise((resolve) => setTimeout(resolve, 300));
		await checkAll(runtime);
		const overview = await runtime.admin.loadPage(PAGE, { user: await editor(runtime) });

		const result = await call(runtime, {});
		expect(result.state).toBe("ready");
		// The same three numbers as the Overview's cards.
		const stats = flat(overview.blocks).find((block) => block.type === "stats");
		expect(stats?.type === "stats" && stats.items.map((item) => item.value)).toEqual([
			result.counts?.pagesChecked,
			result.counts?.nothingToFix,
			result.counts?.toFix,
		]);
		expect(result.counts).toEqual({
			pagesChecked: 4,
			nothingToFix: 1,
			toFix: 3,
			hiddenFromSearch: 1,
		});
		// "Home" has two things to fix, the others one each (then by title).
		expect(result.pages.map((page) => page.title)).toEqual(["Home", "Bread news", "Contact"]);
		expect(result.more).toBe(false);
		expect(result.pages[0]).toEqual({
			collection: "pages",
			id: home.id,
			title: "Home",
			address: "https://acme.test/home-page",
			issues: [
				{
					code: "generic-title",
					message: 'The title is just "Home", which is what Google shows as the headline.',
				},
				{
					code: "no-description",
					message: "No search description, so Google writes its own summary of this page.",
				},
			],
		});
		// The address is the one EmDash itself gives the page.
		for (const [collection, entry] of [
			["pages", contact],
			["posts", news],
		] as const) {
			const page = result.pages.find((row) => row.id === entry.id);
			expect(page?.address).toBe(await runtime.inspect.content.publicUrl(collection, entry.id));
		}
		expect(result.pages.find((row) => row.id === news.id)?.address).toBe(
			"https://acme.test/blog/2026/news",
		);
		// Advice ("Worth a look") is not a thing to fix, and hidden pages are not listed.
		expect(result.pages.flatMap((page) => page.issues.map((issue) => issue.code))).not.toContain(
			"title-long",
		);
		expect(result.pages.map((page) => page.title)).not.toContain("Secret");
		expect(result.lastFullCheck).toEqual(expect.any(String));
		expect(JSON.stringify(result)).not.toMatch(/@acme\.test/);
	});

	it("limit and collection narrow the list; the counts stay site-wide", async () => {
		const runtime = await start();
		for (let index = 0; index < 4; index += 1)
			await add(runtime, "pages", `p${index}`, `Page ${index}`);
		await add(runtime, "posts", "news", "Bread news");
		await checkAll(runtime);

		const two = await call(runtime, { limit: 2 });
		expect(two.pages).toHaveLength(2);
		expect(two.more).toBe(true);
		expect(two.counts?.toFix).toBe(5);

		const posts = await call(runtime, { collection: "posts" });
		expect(posts.pages.map((page) => page.title)).toEqual(["Bread news"]);
		expect(posts.more).toBe(false);
		expect(posts.counts?.toFix).toBe(5);
	});

	it("returns 25 pages unless asked for more, and at most 100", async () => {
		const runtime = await start();
		for (let index = 0; index < 30; index += 1) {
			await runtime.fixtures.plugin.storage("entries", `pages:id${index}`, fixRecord(index));
		}
		await finishedCheck(runtime);
		const result = await call(runtime, {});
		expect(result.pages).toHaveLength(25);
		expect(result.more).toBe(true);
		expect((await call(runtime, { limit: 100 })).pages).toHaveLength(30);
	});

	it("an address for a page saved before this release, from EmDash", async () => {
		const runtime = await start();
		const entry = await add(runtime, "pages", "contact", "Contact");
		await checkAll(runtime);
		const key = `pages:${entry.id}`;
		const stored = await runtime.inspect.storage.get<EntryRecord>("entries", key);
		const { slug: _slug, ...old } = stored as EntryRecord & { slug?: string };
		await runtime.fixtures.plugin.storage("entries", key, old);

		const result = await call(runtime, {});
		expect(result.pages[0]?.address).toBe("https://acme.test/contact");
	});
});

describe("to_fix: refusals and the check in progress", () => {
	it("refuses a limit outside 1 to 100, a fraction, or a content type the site does not have", async () => {
		const runtime = await start();
		await add(runtime, "pages", "contact", "Contact");
		await checkAll(runtime);
		for (const limit of [0, 101, 2.5, "ten", null]) {
			const result = await call(runtime, { limit });
			expect(result.error, String(limit)).toMatch(/limit/i);
			expect(result.pages).toBeUndefined();
		}
		const unknown = await call(runtime, { collection: "recipes" });
		expect(unknown.error).toMatch(/recipes/);
		expect(unknown.error).toMatch(/pages, posts/);
		expect((await call(runtime, { collection: "" })).error).toMatch(/collection/i);
		expect((await call(runtime, "pages")).error).toBeDefined();
		expect((await call(runtime, { limit: 1, extra: true })).error).toMatch(/extra/);
	});

	it("is for Editors and Admins, as the SEO page is", async () => {
		const runtime = await start();
		await add(runtime, "pages", "contact", "Contact");
		await checkAll(runtime);
		for (const role of ["subscriber", "contributor", "author"] as const) {
			const result = await call(runtime, {}, role);
			expect(result.error, role).toMatch(/Editors and Admins/);
			expect(result.pages, role).toBeUndefined();
		}
		expect((await call(runtime, {}, "admin")).pages).toHaveLength(1);
	});

	it("before the first full check it says the pages are being checked, and starts nothing", async () => {
		const runtime = await start();
		await add(runtime, "pages", "contact", "Contact");
		const result = await call(runtime, {});
		expect(result).toMatchObject({ state: "checking", counts: null, pages: [], more: false });
		expect(result.message).toMatch(/being checked/);
		expect(await runtime.inspect.kv.get("scan")).toBeNull();
		expect(await runtime.inspect.storage.list("entries")).toEqual([]);
	});

	it("while a check is running it says how far it got", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.kv("scan", {
			status: "running",
			collections: ["pages"],
			phase: "entries",
			checked: 20,
			rev: 3,
			tally: { checked: 20, fix: 3, hidden: 0, rows: [], more: false },
			startedAt: "2026-11-01T00:00:00.000Z",
		});
		const result = await call(runtime, {});
		expect(result).toMatchObject({ state: "checking", checkedSoFar: 20, pages: [] });
	});
});

/** A stored record of a published page with one thing to fix, as a check writes it. */
function fixRecord(index: number): EntryRecord {
	return {
		v: 1,
		publishedAt: "2026-03-04T10:00:00.000Z",
		updatedAt: "2026-03-04T10:00:00.000Z",
		authors: [],
		custom: [],
		collection: "pages",
		entryId: `id${index}`,
		slug: `page-${index}`,
		title: `Page ${String(index).padStart(3, "0")}`,
		status: "fix",
		titleKey: `page ${index}`,
		issues: [
			{
				id: "no-description",
				level: "fix",
				message: "No search description, so Google writes its own summary of this page.",
				fix: "Fill in Meta Description in the page's SEO panel.",
			},
		],
		checkedAt: "2026-03-04T10:00:00.000Z",
	} as EntryRecord;
}

/** A finished check, as the SEO page leaves it. */
async function finishedCheck(runtime: PluginRuntimeTestHost) {
	await runtime.fixtures.plugin.kv("scan", {
		status: "done",
		collections: [],
		scope: ["pages", "posts"],
		phase: "titles",
		checked: 0,
		rev: 3,
		tally: { checked: 0, fix: 0, hidden: 0, rows: [], more: false },
		startedAt: "2026-03-04T10:00:00.000Z",
		finishedAt: "2026-03-04T10:01:00.000Z",
	});
}

export { fixRecord, finishedCheck };
