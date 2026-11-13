// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The two tools an AI assistant can call through EmDash's MCP server: `problems` (what the
// Problems tab shows to the caller) and `add_redirect` (the Fix menu's "Send visitors to another
// page", Admins only). Each tool is a private route; these tests call the routes as EmDash does,
// with the caller's role, and read the built manifest EmDash takes the tools from.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { LinkRow, PageRow } from "../src/model.js";
import type { RowView, Summary } from "../src/state.js";
import { idFor } from "../src/url.js";

const SITE = "https://acme.test";
const PROBLEMS = "mcp/problems";
const ADD_REDIRECT = "mcp/add-redirect";
const FINISHED = "2026-11-12T08:00:00.000Z";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Role = 10 | 20 | 30 | 40 | 50;
const user = (role: Role) => ({
	id: `u${role}`,
	email: `u${role}@acme.test`,
	name: `User ${role}`,
	role,
	createdAt: FINISHED,
});
const ADMIN = user(50);
const EDITOR = user(40);
const CONTRIBUTOR = user(20);

function linkRow(kind: LinkRow["kind"], url: string, extra: Partial<LinkRow> = {}): LinkRow {
	return {
		kind,
		url,
		host: kind === "external" ? new URL(url).hostname : "acme.test",
		sources: [{ c: "pages", id: "home1", t: "Home", p: "/home" }],
		count: 1,
		menu: false,
		content: true,
		editor: true,
		pass: 3,
		state: "broken",
		...extra,
	} as LinkRow;
}

function viewOf(id: string, row: LinkRow): RowView {
	return {
		id,
		kind: row.kind,
		url: row.url,
		...(row.reason ? { reason: row.reason } : {}),
		...(row.detail ? { detail: row.detail } : {}),
		sources: row.sources,
		count: row.count,
		menu: row.menu,
		editor: row.editor,
		...(row.since ? { since: row.since } : {}),
		...(row.code !== undefined ? { code: row.code } : {}),
		...(row.checkedAt ? { checkedAt: row.checkedAt } : {}),
	};
}

const OLD_PAGE = linkRow("internal", "/old-page", {
	reason: "missing",
	group: "link",
	code: 404,
	checkedAt: FINISHED,
	since: "2026-11-10T08:00:00.000Z",
});
const MENU = linkRow("internal", "/menu-2024", {
	reason: "missing",
	group: "site",
	menu: true,
	content: false,
	editor: false,
	sources: [{ t: "Site menu", p: "/", menu: true }],
	code: 404,
	checkedAt: FINISHED,
});
const PAGE_ERROR = linkRow("page", "/shop-old", {
	reason: "page-error",
	group: "page",
	editor: false,
	content: false,
	sources: [],
	code: 500,
	checkedAt: FINISHED,
});
const DRAFT = linkRow("internal", "/christmas", { reason: "draft", group: "link" });
const RYE = linkRow("external", "https://gone.example/rye", {
	reason: "gone",
	group: "link",
	code: 404,
	checkedAt: FINISHED,
});
const LOOK = linkRow("internal", "/news", { state: "look", reason: "redirect", detail: "/blog" });
const UNKNOWN = linkRow("internal", "/spring", { state: "unknown", reason: "no-live" });
const LEFT = linkRow("leftover", "[gallery]", { state: "left", reason: "shortcode" });
const FINE = linkRow("internal", "/kept", { state: "fine" });

const ROWS: Array<[string, LinkRow]> = [
	[idFor("internal", OLD_PAGE.url), OLD_PAGE],
	[idFor("internal", MENU.url), MENU],
	[idFor("page", PAGE_ERROR.url), PAGE_ERROR],
	[idFor("internal", DRAFT.url), DRAFT],
	[idFor("external", RYE.url), RYE],
	[idFor("internal", LOOK.url), LOOK],
	[idFor("internal", UNKNOWN.url), UNKNOWN],
	[idFor("leftover", LEFT.url), LEFT],
	[
		idFor("internal", FINE.url),
		{ ...FINE, fine: { by: "anna@acme.test", at: FINISHED } } as LinkRow,
	],
];
const ID = Object.fromEntries(ROWS.map(([id, row]) => [row.url, id])) as Record<string, string>;
const v = (row: LinkRow) => viewOf(ID[row.url]!, row);

const SUMMARY: Summary = {
	pass: 3,
	finishedAt: FINISHED,
	pages: 4,
	links: 12,
	fix: { site: 1, page: 1, link: 3 },
	editorFix: 3,
	look: 1,
	unknown: 1,
	rows: { site: [v(MENU)], page: [v(PAGE_ERROR)], link: [v(OLD_PAGE), v(DRAFT), v(RYE)] },
	lookRows: [v(LOOK)],
	unknownRows: [v(UNKNOWN)],
	live: "ok",
	left: 1,
	leftRows: [v(LEFT)],
};

/** A finished check, stored as the plugin keeps it, and the page and redirect it knows of. */
async function start(summary: Summary = SUMMARY): Promise<PluginRuntimeTestHost> {
	host = await createPluginRuntimeTestHost({
		site: { name: "Acme Bakery", url: SITE, locale: "en" },
	});
	await host.fixtures.plugin.kv("scan", {
		pass: 3,
		status: "done",
		phase: "freeze",
		collections: [],
		ci: 0,
		walked: 4,
		liveDone: 4,
		startedAt: FINISHED,
		finishedAt: FINISHED,
		nextAt: "2099-01-01T00:00:00.000Z",
	});
	await host.fixtures.plugin.kv("summary", summary);
	for (const [id, row] of ROWS) await host.fixtures.plugin.storage("links", id, row);
	const about: PageRow = { status: "published", path: "/about", title: "About", pass: 3 };
	await host.fixtures.plugin.storage("pages", "/about", about);
	await host.fixtures.redirect({ source: "/shop", destination: "/about" });
	await host.fixtures.plugin.storage("links", idFor("internal", "/shop"), {
		...linkRow("internal", "/shop", { reason: "missing", group: "link" }),
	});
	return host;
}

interface Problem {
	id: string;
	list: string;
	where?: string;
	address: string;
	problem: string;
	details: string;
	httpStatus?: number;
	lastChecked?: string;
	foundOn: Array<{ title: string; address: string; collection?: string; id?: string }>;
	canSendVisitorsElsewhere?: boolean;
}
interface ProblemsResult {
	ok: boolean;
	error?: string;
	checked?: boolean;
	message?: string;
	lastFullCheck?: string;
	checkingNow?: boolean;
	counts?: Record<string, number>;
	problems?: Problem[];
	moreNotListed?: number;
}
interface RedirectResult {
	ok: boolean;
	refused?: string;
	added?: { from: string; to: string; type: number };
	message?: string;
}

async function problems(
	runtime: PluginRuntimeTestHost,
	input: unknown,
	caller = ADMIN,
): Promise<ProblemsResult> {
	return (await runtime.transport.invokeRoute(PROBLEMS, input, { user: caller })) as ProblemsResult;
}

async function addRedirect(
	runtime: PluginRuntimeTestHost,
	input: unknown,
	caller = ADMIN,
): Promise<RedirectResult> {
	return (await runtime.transport.invokeRoute(ADD_REDIRECT, input, {
		user: caller,
	})) as RedirectResult;
}

describe("the built manifest declares both tools", () => {
	it("problems: read-only, for anyone who may open the Site Health page", async () => {
		const runtime = await start();
		const tools = (runtime.manifest as { mcp?: { tools: Array<Record<string, unknown>> } }).mcp
			?.tools;
		const problemsTool = tools?.find((t) => t.name === "problems");
		expect(problemsTool).toMatchObject({
			route: PROBLEMS,
			permission: "plugins:read",
			destructive: false,
		});
		expect(problemsTool?.description).not.toMatch(/moorage|hosting/i);
		expect(problemsTool?.inputSchema).toMatchObject({
			type: "object",
			properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
		});
	});

	it("add_redirect: Admins only, marked destructive", async () => {
		const runtime = await start();
		const tools = (runtime.manifest as { mcp?: { tools: Array<Record<string, unknown>> } }).mcp
			?.tools;
		const tool = tools?.find((t) => t.name === "add_redirect");
		expect(tool).toMatchObject({
			route: ADD_REDIRECT,
			permission: "redirects:manage",
			destructive: true,
		});
		expect(tool?.description).not.toMatch(/moorage|hosting/i);
		expect(tool?.inputSchema).toMatchObject({
			type: "object",
			required: ["id", "destination"],
		});
		expect(tools).toHaveLength(2);
	});

	it("EmDash checks the route's permission before the plugin runs", async () => {
		const runtime = await start();
		const headers = { "X-EmDash-Request": "1" };
		const contributor = await runtime.actions.routes.request(PROBLEMS, {
			user: CONTRIBUTOR,
			headers,
			body: {},
		});
		expect(contributor.status).toBe(403);
		expect(await contributor.text()).not.toContain("CSRF");
		const editor = await runtime.actions.routes.request(ADD_REDIRECT, {
			user: EDITOR,
			headers,
			body: { id: ID["/old-page"], destination: "/about" },
		});
		expect(editor.status).toBe(403);
		expect(await editor.text()).not.toContain("CSRF");
		expect(await runtime.inspect.redirects()).toHaveLength(1);
		const allowed = await runtime.actions.routes.request(PROBLEMS, {
			user: EDITOR,
			headers,
			body: {},
		});
		expect(allowed.status, await allowed.clone().text()).toBe(200);
	});
});

describe("problems", () => {
	it("an Admin gets what the Problems tab shows: counts, then each row, worst first", async () => {
		const runtime = await start();
		const result = await problems(runtime, {});
		expect(result.ok).toBe(true);
		expect(result.checked).toBe(true);
		expect(result.lastFullCheck).toBe(FINISHED);
		expect(result.checkingNow).toBe(false);
		expect(result.counts).toEqual({
			pagesChecked: 4,
			linksChecked: 12,
			toFix: 5,
			worthALook: 1,
			couldNotCheck: 1,
			wordpressLeftovers: 1,
		});
		const list = result.problems ?? [];
		expect(list.map((p) => p.address)).toEqual([
			"/menu-2024",
			"/shop-old",
			"/old-page",
			"/christmas",
			"https://gone.example/rye",
			"[gallery]",
			"/news",
			"/spring",
		]);
		expect(list.map((p) => p.list)).toEqual([
			"broken",
			"broken",
			"broken",
			"broken",
			"broken",
			"wordpress_leftovers",
			"worth_a_look",
			"could_not_check",
		]);
		const old = list.find((p) => p.address === "/old-page");
		expect(old).toMatchObject({
			id: ID["/old-page"],
			where: "one link",
			problem: "/old-page goes to a page that does not exist. Found on: Home.",
			httpStatus: 404,
			lastChecked: FINISHED,
			foundOn: [{ title: "Home", address: "/home", collection: "pages", id: "home1" }],
			canSendVisitorsElsewhere: true,
		});
		expect(old?.details).toMatch(/^\/old-page: HTTP 404, checked /);
		expect(list.find((p) => p.address === "/menu-2024")?.where).toBe("every page");
		// The Fix menu offers no redirect for a draft or a page that shows an error.
		expect(list.find((p) => p.address === "/christmas")?.canSendVisitorsElsewhere).toBe(false);
		expect(list.find((p) => p.address === "/shop-old")?.canSendVisitorsElsewhere).toBe(false);
		expect(result.moreNotListed).toBe(0);
		// Nobody's email address, and nothing marked as fine.
		expect(JSON.stringify(result)).not.toMatch(/@/);
		expect(JSON.stringify(result)).not.toContain("/kept");
	});

	it("an Editor gets the Editor's view: no page errors, no menu rows, no redirect offer", async () => {
		const runtime = await start();
		const result = await problems(runtime, {}, EDITOR);
		expect(result.ok).toBe(true);
		const list = result.problems ?? [];
		expect(list.map((p) => p.address)).toEqual([
			"/old-page",
			"/christmas",
			"https://gone.example/rye",
			"[gallery]",
			"/news",
			"/spring",
		]);
		expect(result.counts).toMatchObject({ toFix: 3, worthALook: 1, couldNotCheck: 1 });
		expect(list.every((p) => p.canSendVisitorsElsewhere === undefined)).toBe(true);
	});

	it("below Editor: refused, as the Site Health page is", async () => {
		const runtime = await start();
		const result = await problems(runtime, {}, CONTRIBUTOR);
		expect(result.ok).toBe(false);
		expect(result.problems).toBeUndefined();
		expect(result.error).toMatch(/Editors and Admins/);
	});

	it("kind picks one list; limit caps the rows and says how many more there are", async () => {
		const runtime = await start();
		const broken = await problems(runtime, { kind: "broken", limit: 2 });
		expect(broken.problems?.map((p) => p.address)).toEqual(["/menu-2024", "/shop-old"]);
		expect(broken.moreNotListed).toBe(3);
		const look = await problems(runtime, { kind: "worth_a_look" });
		expect(look.problems?.map((p) => p.address)).toEqual(["/news"]);
		expect(look.problems?.[0]?.problem).toBe(
			"/news now goes on to /blog. Linking to /blog directly saves a step. Found on: Home.",
		);
		const unknown = await problems(runtime, { kind: "could_not_check" });
		expect(unknown.problems?.[0]?.problem).toBe(
			"/spring: we could not open your site to check this address. Found on: Home.",
		);
	});

	it("an Admin's list goes past the ten rows a group keeps, from storage", async () => {
		const many: Array<[string, LinkRow]> = Array.from({ length: 12 }, (_, i) => {
			const row = linkRow("internal", `/gone-${i}`, {
				reason: "missing",
				group: "link",
				count: 20 - i,
			});
			return [idFor("internal", row.url), row];
		});
		const summary: Summary = {
			...SUMMARY,
			fix: { site: 0, page: 0, link: 12 },
			editorFix: 12,
			rows: { site: [], page: [], link: many.slice(0, 10).map(([id, row]) => viewOf(id, row)) },
		};
		const runtime = await start(summary);
		for (const [id, row] of many) await runtime.fixtures.plugin.storage("links", id, row);
		const result = await problems(runtime, { kind: "broken", limit: 12 });
		expect(result.problems?.map((p) => p.address)).toEqual(many.map(([, row]) => row.url));
		expect(result.moreNotListed).toBe(0);
	});

	it("wrong input is refused in plain words", async () => {
		const runtime = await start();
		for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 2.5 }, { limit: "ten" }]) {
			const result = await problems(runtime, input);
			expect(result.ok).toBe(false);
			expect(result.error).toBe("limit must be a whole number from 1 to 100.");
		}
		const kind = await problems(runtime, { kind: "everything" });
		expect(kind.error).toBe(
			"kind must be one of broken, worth_a_look, could_not_check, wordpress_leftovers.",
		);
	});

	it("before the first check has finished: says so, lists nothing", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.kv("summary", null);
		const result = await problems(runtime, {});
		expect(result).toMatchObject({ ok: true, checked: false, problems: [] });
		expect(result.message).toMatch(/first check/);
	});
});

describe("add_redirect", () => {
	it("sends visitors from a broken address on this site to another page, as the Fix button does", async () => {
		const runtime = await start();
		const id = ID["/old-page"]!;
		const result = await addRedirect(runtime, { id, destination: "/about" });
		expect(result).toEqual({
			ok: true,
			added: { from: "/old-page", to: "/about", type: 301 },
			message: "Done. /old-page now goes to /about.",
		});
		const redirects = await runtime.inspect.redirects();
		expect(redirects.find((r) => r.source === "/old-page")).toMatchObject({
			destination: "/about",
			type: 301,
		});
		// The same writes as the button: the redirect row, and the link is fine now.
		expect(await runtime.inspect.storage.get<PageRow>("pages", "/old-page")).toMatchObject({
			status: "redirect",
			dest: "/about",
		});
		expect((await runtime.inspect.storage.get<LinkRow>("links", id))?.state).not.toBe("broken");
	});

	it("a full address on another site: EmDash refuses it, and the tool says so as the form does", async () => {
		const runtime = await start();
		const result = await addRedirect(runtime, {
			id: ID["/old-page"],
			destination: "https://shop.example/bread",
		});
		expect(result.ok).toBe(false);
		expect(result.refused).toMatch(/^EmDash did not add it: Must be a path starting with \//);
		expect(await runtime.inspect.redirects()).toHaveLength(1);
	});

	it("never replaces a redirect that is already there", async () => {
		const runtime = await start();
		const result = await addRedirect(runtime, {
			id: idFor("internal", "/shop"),
			destination: "/old-page",
		});
		expect(result.ok).toBe(false);
		expect(result.refused).toMatch(/^EmDash did not add it: .*already exists/);
		const redirects = await runtime.inspect.redirects();
		expect(redirects).toHaveLength(1);
		expect(redirects[0]).toMatchObject({ source: "/shop", destination: "/about" });
	});

	it("the form's refusals, word for word", async () => {
		const runtime = await start();
		const id = ID["/old-page"]!;
		expect((await addRedirect(runtime, { id, destination: "about" })).refused).toBe(
			"Pick a page to send visitors to.",
		);
		expect((await addRedirect(runtime, { id, destination: "/old-page/" })).refused).toBe(
			"The old address and the new one are the same.",
		);
		// A live page is never sent elsewhere.
		await runtime.fixtures.plugin.storage("pages", "/old-page", {
			status: "published",
			path: "/old-page",
			title: "Old page",
			pass: 3,
		});
		expect((await addRedirect(runtime, { id, destination: "/about" })).refused).toBe(
			"/old-page is a live page. Change its address in the page editor instead.",
		);
		expect(await runtime.inspect.redirects()).toHaveLength(1);
	});

	it("only what the Fix menu offers it for: not a draft, a page error, another site or a leftover", async () => {
		const runtime = await start();
		for (const url of ["/christmas", "/shop-old", "https://gone.example/rye", "[gallery]"]) {
			const result = await addRedirect(runtime, { id: ID[url], destination: "/about" });
			expect(result.ok, url).toBe(false);
			expect(result.refused).toBe(
				"Sending visitors to another page is not offered for this problem. Its Fix menu on the Site Health page says what to do.",
			);
		}
		expect(await runtime.inspect.redirects()).toHaveLength(1);
	});

	it("a problem that is not listed (unknown id, or marked as fine)", async () => {
		const runtime = await start();
		for (const id of ["nope", ID["/kept"]]) {
			expect((await addRedirect(runtime, { id, destination: "/about" })).refused).toBe(
				"That problem is no longer listed.",
			);
		}
	});

	it("Admins only, even if called past EmDash's permission check", async () => {
		const runtime = await start();
		const result = await addRedirect(
			runtime,
			{ id: ID["/old-page"], destination: "/about" },
			EDITOR,
		);
		expect(result).toEqual({
			ok: false,
			refused: "Only Admins can send visitors to another page.",
		});
		expect(await runtime.inspect.redirects()).toHaveLength(1);
	});

	it("wrong input is refused in plain words", async () => {
		const runtime = await start();
		for (const input of [{}, { id: ID["/old-page"] }, { id: 3, destination: "/about" }, null]) {
			expect((await addRedirect(runtime, input)).refused).toBe(
				"Give the id of a problem from the problems tool, and the address to send visitors to.",
			);
		}
	});
});
