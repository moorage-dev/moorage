// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { MISSING_PATH } from "../src/checklist.js";
import type { LinkRow } from "../src/model.js";
import type { Queue, ScanState, Summary } from "../src/state.js";
import { idFor } from "../src/url.js";

const PAGE = "/health";
const SITE = "https://acme.test";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

function link(text: string, href: string, key: string) {
	return {
		_type: "block",
		_key: `b${key}`,
		children: [{ _type: "span", _key: `s${key}`, text, marks: [key] }],
		markDefs: [{ _key: key, _type: "link", href }],
	};
}

async function start(url = SITE): Promise<PluginRuntimeTestHost> {
	host = await createPluginRuntimeTestHost({ site: { name: "Acme Bakery", url, locale: "en" } });
	await host.fixtures.collection({
		slug: "pages",
		label: "Pages",
		urlPattern: "/{slug}",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "body", label: "Body", type: "portableText" },
		],
	});
	await host.fixtures.content("pages", {
		slug: "home",
		status: "published",
		data: {
			title: "Home",
			body: [
				link("About", "/about", "k1"),
				link("Christmas", "/christmas", "k2"),
				link("Old page", "/old-page", "k3"),
				link("Rye flour", "https://gone.example/rye", "k4"),
				link("LinkedIn", "https://linkedin.com/company/acme", "k5"),
				{ _type: "iframe", _key: "m1", src: "http://maps.example/embed" },
			],
		},
	});
	await host.fixtures.content("pages", {
		slug: "about",
		status: "published",
		data: { title: "About", body: [link("Home", "/", "k6")] },
	});
	await host.fixtures.content("pages", {
		slug: "christmas",
		status: "draft",
		data: { title: "Christmas orders", body: [] },
	});
	return host;
}

const HOME_HTML = `<!doctype html><html><head></head><body>
<header><nav><a href="/about">About</a><a href="/menu-2024">Menu</a></nav></header>
<main><p>Fresh bread.</p></main>
<footer><a href="https://instagram.com/acme">Instagram</a><a href="mailto:hi@acme.test">Email</a></footer>
</body></html>`;

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

function redirect(to: string): Response {
	return new Response(null, { status: 301, headers: { location: to } });
}

/** The site's own pages, as the site would answer them. */
async function ownSite(runtime: PluginRuntimeTestHost): Promise<void> {
	await runtime.http.respond(
		`${SITE}/`,
		html(HOME_HTML, 200, { "cache-control": "public, max-age=60" }),
	);
	await runtime.http.respond(`${SITE}/about`, html("<html><body>About</body></html>"));
	await runtime.http.respond(`${SITE}/home`, html("<html><body>Home</body></html>"));
	await runtime.http.respond(`${SITE}/old-page`, html("Not found", 404));
	await runtime.http.respond(`${SITE}/menu-2024`, html("Not found", 404));
	await runtime.http.respond("http://acme.test/", redirect(`${SITE}/`));
	await runtime.http.respond("https://www.acme.test/", redirect(`${SITE}/`));
	await runtime.http.respond(`${SITE}${MISSING_PATH}`, html("Not found", 404));
	await runtime.http.respond(`${SITE}/robots.txt`, new Response("User-agent: *\nAllow: /\n"));
	await runtime.http.respond(`${SITE}/sitemap.xml`, new Response("", { status: 200 }));
}

/**
 * Time passing, for the plugin: hosts may be asked again, the row is due now,
 * and its first failure moves back by \`ago\`.
 */
async function moveOn(runtime: PluginRuntimeTestHost, id: string, ago: number): Promise<void> {
	const row = await runtime.inspect.storage.get<LinkRow>("links", id);
	const queue = await runtime.inspect.kv.get<Queue>("queue");
	await runtime.fixtures.plugin.kv("queue", { ...queue, hosts: {} });
	const past = new Date(Date.now() - 1000).toISOString();
	await runtime.fixtures.plugin.storage("links", id, {
		...row,
		due: past,
		...(row?.firstFailAt
			? { firstFailAt: new Date(Date.parse(row.firstFailAt) - ago).toISOString() }
			: {}),
	});
}

async function cron(runtime: PluginRuntimeTestHost): Promise<void> {
	await runtime.transport.invokeHook("cron", {
		name: "site-health",
		scheduledAt: new Date().toISOString(),
	});
}

/** Run the scheduled task until the full check is done; returns the most host calls any run made. */
async function finish(runtime: PluginRuntimeTestHost): Promise<number> {
	let most = 0;
	for (let run = 0; run < 60; run += 1) {
		const scan = await runtime.inspect.kv.get<ScanState>("scan");
		most = Math.max(most, scan?.ops ?? 0);
		if (scan?.status === "done") return most;
		await cron(runtime);
	}
	throw new Error("the check did not finish in 60 runs");
}

function text(response: BlockResponse): string {
	return JSON.stringify(response.blocks);
}

async function summary(runtime: PluginRuntimeTestHost): Promise<Summary> {
	const value = await runtime.inspect.kv.get<Summary>("summary");
	if (!value) throw new Error("no summary");
	return value;
}

describe("a full check of a public site", () => {
	it("finds broken links by how bad, without counting anything unconfirmed, in at most 10 calls a run", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		// No numbers before the check is complete.
		const first = await runtime.admin.loadPage(PAGE);
		expect(text(first)).toContain("Checking your site for the first time");
		// The first screen says how long it takes, and that other sites follow a day later.
		expect(text(first)).toMatch(/This (usually )?takes /);
		expect(text(first)).toContain("Links to other sites follow a day later");
		expect(text(first)).not.toContain('Pages checked","value');

		const most = await finish(runtime);
		expect(most).toBeLessThanOrEqual(10);

		const result = await summary(runtime);
		expect(result.live).toBe("ok");
		expect(result.pages).toBe(2);
		expect(result.rows.site.map((r) => r.url)).toEqual(["/menu-2024"]);
		expect(result.rows.page.map((r) => r.url)).toEqual(["http://maps.example/embed"]);
		expect(result.rows.link.map((r) => `${r.url} ${r.reason}`).sort()).toEqual([
			"/christmas draft",
			"/old-page missing",
		]);
		// Links to other sites are not judged by the full check: they come a day later.
		expect(result.fix).toEqual({ site: 1, page: 1, link: 2 });

		const page = await runtime.admin.loadPage(PAGE);
		const words = text(page);
		for (const heading of ["Every page", "One page", "One link"]) expect(words).toContain(heading);
		expect(words).toContain(
			"/menu-2024 goes to a page that does not exist. Found on: Site menu (every page).",
		);
		expect(words).toContain("/christmas goes to a page that is not published yet. Found on: Home.");
		expect(words).not.toMatch(/\b(404|500|cron|robots\.txt)\b/);

		// The Checklist read the site's own answers.
		expect(words).toContain(
			"Secure connection. The insecure address sends visitors to the secure one.",
		);
		expect(words).toContain("www.acme.test sends visitors on to your address.");
	});

	it("checks links to other sites politely, and calls one broken only after two answers a day apart", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		// The first run after the check starts the weekly email clock; give it its turn.
		await runtime.admin.loadPage(PAGE);

		runtime.http.clear();
		await runtime.http.respond("https://gone.example/rye", new Response(null, { status: 404 }));
		// HEAD turned away, so it asks again with GET: turned away again.
		await runtime.http.respond(
			"https://linkedin.com/company/acme",
			new Response(null, { status: 403 }),
		);
		await runtime.http.respond(
			"https://linkedin.com/company/acme",
			new Response("no", { status: 403 }),
		);
		await runtime.http.respond("https://instagram.com/acme", new Response(null, { status: 200 }));
		for (let run = 0; run < 3; run += 1) await cron(runtime);

		const gone = idFor("external", "https://gone.example/rye");
		const linkedin = idFor("external", "https://linkedin.com/company/acme");
		expect(await runtime.inspect.storage.get<LinkRow>("links", linkedin)).toMatchObject({
			state: "unknown",
			reason: "refuses",
		});
		// Three sites, one request each, and one second try: the budget is spent, so
		// gone.example waits its turn and is asked with GET next time.
		const asked = runtime.http.requests().map((r) => `${r.method} ${r.url}`);
		expect(asked.sort()).toEqual(
			[
				"HEAD https://gone.example/rye",
				"HEAD https://instagram.com/acme",
				"HEAD https://linkedin.com/company/acme",
				"GET https://linkedin.com/company/acme",
			].sort(),
		);
		expect(runtime.http.requests()[0]?.headers["user-agent"]).toMatch(
			/^EmDash-SiteHealth\/0\.1 \(\+https:\/\/acme\.test\)/,
		);
		expect((await runtime.inspect.kv.get<Queue>("queue"))?.ops ?? 0).toBeLessThanOrEqual(10);
		expect(await runtime.inspect.storage.get<LinkRow>("links", gone)).toMatchObject({
			state: "pending",
			get: true,
		});

		// A minute later: one GET, "removed". Not counted yet.
		await moveOn(runtime, gone, 0);
		await runtime.http.respond("https://gone.example/rye", new Response("gone", { status: 404 }));
		await cron(runtime);
		const first = await runtime.inspect.storage.get<LinkRow>("links", gone);
		expect(first).toMatchObject({ state: "pending", fails: 1 });
		expect((await summary(runtime)).fix.link).toBe(2);

		// A day later the same answer confirms it.
		await moveOn(runtime, gone, 25 * 3_600_000);
		await runtime.http.respond("https://gone.example/rye", new Response("gone", { status: 404 }));
		await cron(runtime);
		expect(await runtime.inspect.storage.get<LinkRow>("links", gone)).toMatchObject({
			state: "broken",
			reason: "gone",
			group: "link",
		});
		const after = await summary(runtime);
		expect(after.fix.link).toBe(3);
		const page = text(await runtime.admin.loadPage(PAGE));
		expect(page).toContain("gone.example/rye: that other website has removed this page.");
		expect(page).toContain("Links we could not check (1)");
		expect(page).toContain(
			"linkedin.com/company/acme: that website turns away automatic checkers.",
		);
	});

	it("emails the people on the list at once for a broken menu link, at most once a day", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		// The first Admin to open the page starts the list.
		await runtime.admin.loadPage(PAGE);
		await runtime.admin.submit(PAGE, "save_options", {
			recipients: "",
			outbound: true,
		});
		const admin = await runtime.fixtures.user({
			email: "ellen@acme.test",
			role: "admin",
			name: "Ellen",
		});
		await runtime.admin.submit(
			PAGE,
			"save_options",
			{ recipients: "ellen@acme.test\nstudio@web.example", outbound: false },
			{ user: admin },
		);
		await finish(runtime);
		await cron(runtime);
		await cron(runtime);

		const mail = await runtime.inspect.email();
		expect(mail).toHaveLength(1);
		expect(mail[0]).toMatchObject({
			to: "ellen@acme.test",
			cc: ["studio@web.example"],
			subject: "Acme Bakery: a link in your site menu is broken",
		});
		expect(String(mail[0]?.text)).toContain("/menu-2024 goes to a page that does not exist.");
		expect(String(mail[0]?.text)).toContain(`${SITE}/_emdash/admin/plugins/site-health/health`);

		// A second check the same day sends nothing more.
		await runtime.admin.act(PAGE, "check_all");
		await ownSite(runtime);
		await finish(runtime);
		await cron(runtime);
		expect(await runtime.inspect.email()).toHaveLength(1);
	});

	it("refuses an address that is not an email, and saves nothing", async () => {
		const runtime = await start();
		const response = await runtime.admin.submit(PAGE, "save_options", {
			recipients: "ellen@acme.test\nnope",
			outbound: true,
		});
		expect(response.toast).toMatchObject({
			type: "error",
			message: '"nope" is not an email address. Nothing was saved.',
		});
	});

	it("an Admin sends visitors from a dead address to a page picked from a list", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const id = idFor("internal", "/old-page");

		const form = await runtime.admin.act(PAGE, "fix", { value: `redirect|${id}` });
		expect(text(form)).toContain('"label":"About (/about)","value":"/about"');
		const done = await runtime.admin.submit(PAGE, `add_redirect|${id}`, {
			source: "/old-page",
			destination: "/about",
		});
		expect(done.toast).toMatchObject({
			type: "success",
			message: "Done. /old-page now goes to /about.",
		});
		expect((await runtime.inspect.redirects()).map((r) => [r.source, r.destination])).toEqual([
			["/old-page", "/about"],
		]);
		expect(text(done)).not.toContain("/old-page goes to a page that does not exist");
		expect((await summary(runtime)).fix.link).toBe(1);

		// A live page is never redirected away.
		const refused = await runtime.admin.submit(PAGE, `add_redirect|${id}`, {
			source: "/about",
			destination: "/",
		});
		expect(text(refused)).toContain("/about is a live page.");
	});

	it("checks one row again at once, and marks a row as fine", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const old = idFor("internal", "/old-page");
		await runtime.http.respond(`${SITE}/old-page`, html("Back again"));
		const checked = await runtime.admin.act(PAGE, "fix", { value: `check|${old}` });
		expect(checked.toast).toMatchObject({
			type: "success",
			message: "Works now. /old-page is off the list.",
		});

		const draft = idFor("internal", "/christmas");
		const fine = await runtime.admin.act(PAGE, "fix", { value: `fine|${draft}` });
		expect(fine.toast?.message).toBe("Marked as fine. /christmas is not checked any more.");
		expect(text(fine)).toContain("Links you marked as fine (1)");
		expect((await summary(runtime)).fix.link).toBe(0);
	});

	it("shows an Editor only the links they can fix", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const editor = await runtime.fixtures.user({ email: "sam@acme.test", role: "editor" });
		const page = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(page.blocks.some((block) => block.type === "tab")).toBe(false);
		const words = text(page);
		expect(words).toContain("/old-page goes to a page that does not exist");
		expect(words).not.toContain("Send visitors to another page");
		expect(words).not.toContain("Checklist");
		expect(words).toContain("looked after by your site admin");
		const widget = await runtime.admin.loadWidget("site-health", { user: editor });
		expect(text(widget)).toContain("broken links on your pages");
	});
});

describe("the weekly email", () => {
	async function weekLater(runtime: PluginRuntimeTestHost, since: string) {
		const alerts = (await runtime.inspect.kv.get<Record<string, unknown>>("alerts")) ?? {};
		await runtime.fixtures.plugin.kv("alerts", {
			pending: [],
			sent: [],
			...alerts,
			weeklyAt: since,
		});
	}

	it("lists only problems new since last week, and sends nothing when nothing is new", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runtime.admin.submit(PAGE, "save_options", {
			recipients: "ellen@acme.test",
			outbound: false,
		});
		await finish(runtime);
		// The urgent email for the menu link goes first.
		await cron(runtime);
		const urgent = (await runtime.inspect.email()).length;

		await weekLater(runtime, new Date(Date.now() - 8 * 86_400_000).toISOString());
		await cron(runtime);
		const mail = await runtime.inspect.email();
		expect(mail).toHaveLength(urgent + 1);
		expect(mail.at(-1)).toMatchObject({
			to: "ellen@acme.test",
			subject: "Acme Bakery: 4 new problems this week",
		});
		expect(String(mail.at(-1)?.text)).toContain(
			"/christmas goes to a page that is not published yet.",
		);

		// A week on with nothing new (every problem older than the last email): no email.
		const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
		const current = await summary(runtime);
		const age = (rows: Summary["rows"]["site"]) => rows.map((r) => ({ ...r, since: old }));
		await runtime.fixtures.plugin.kv("summary", {
			...current,
			rows: {
				site: age(current.rows.site),
				page: age(current.rows.page),
				link: age(current.rows.link),
			},
		});
		await weekLater(runtime, new Date(Date.now() - 8 * 86_400_000).toISOString());
		await cron(runtime);
		expect(await runtime.inspect.email()).toHaveLength(urgent + 1);
	});
});

describe("a site that cannot open its own pages", () => {
	it("checks content links and calls nothing broken that needed the live page", async () => {
		const runtime = await start("");
		await runtime.transport.invokeHook("plugin:activate", {});
		const most = await finish(runtime);
		expect(most).toBeLessThanOrEqual(10);
		const result = await summary(runtime);
		expect(result.live).toBe("not-public");
		expect(result.rows.site).toEqual([]);
		// The draft is known from the content alone; the address that matches no page could not be checked.
		expect(result.rows.link.map((r) => r.url)).toEqual(["/christmas"]);
		expect(result.unknownRows.map((r) => `${r.url} ${r.reason}`)).toContain("/old-page no-live");
		expect(runtime.http.requests()).toEqual([]);
		const page = await runtime.admin.loadPage(PAGE);
		expect(text(page)).toContain("This site is not public yet");
	});

	it("degrades to 'could not check' when the site's own pages refuse us", async () => {
		const runtime = await start();
		await runtime.http.respond(`${SITE}/`, html("Checking your browser", 403));
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const result = await summary(runtime);
		expect(result.live).toBe("blocked");
		// Nothing that needed the live page is broken; the insecure map is in the content itself.
		expect(result.rows.site).toEqual([]);
		expect(result.rows.page.map((r) => r.url)).toEqual(["http://maps.example/embed"]);
		expect(text(await runtime.admin.loadPage(PAGE))).toContain(
			"We cannot open your pages to check them",
		);
	});
});

describe("what EmDash will accept", () => {
	it("returns screens that pass EmDash's validator, even with no site address", async () => {
		const runtime = await start("");
		await runtime.transport.invokeHook("plugin:activate", {});
		const screens: BlockResponse[] = [
			await runtime.admin.loadPage(PAGE),
			await runtime.admin.loadWidget("site-health"),
		];
		await finish(runtime);
		const id = idFor("internal", "/old-page");
		screens.push(
			await runtime.admin.loadPage(PAGE),
			await runtime.admin.loadWidget("site-health"),
			await runtime.admin.act(PAGE, "fix", {
				value: `redirect|${idFor("internal", "/christmas")}`,
			}),
			await runtime.admin.act(PAGE, "fix", { value: `edit0|${idFor("internal", "/christmas")}` }),
			await runtime.admin.act(PAGE, "fix", { value: `check|${id}` }),
			await runtime.admin.act(PAGE, "send_test"),
		);
		for (const screen of screens) {
			expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] })).toEqual({
				valid: true,
				errors: [],
			});
		}
	});
});
