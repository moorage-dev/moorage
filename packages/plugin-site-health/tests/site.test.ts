// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { MISSING_PATH } from "../src/checklist.js";
import { HELP_LINE, HIDE_ACTION } from "../src/help-line.js";
import type { LinkRow, PageRow } from "../src/model.js";
import type { Alerts, Queue, ScanState, Summary } from "../src/state.js";
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
async function ownSite(
	runtime: PluginRuntimeTestHost,
	aboutGone = false,
	robots = "User-agent: *\nAllow: /\n",
	sitemap: Response = sitemapIndex(),
): Promise<void> {
	await runtime.http.respond(
		`${SITE}/`,
		html(HOME_HTML, 200, { "cache-control": "public, max-age=60" }),
	);
	await runtime.http.respond(
		`${SITE}/about`,
		aboutGone ? html("Not found", 404) : html("<html><body>About</body></html>"),
	);
	await runtime.http.respond(`${SITE}/home`, html("<html><body>Home</body></html>"));
	await runtime.http.respond(`${SITE}/old-page`, html("Not found", 404));
	await runtime.http.respond(`${SITE}/menu-2024`, html("Not found", 404));
	await runtime.http.respond("http://acme.test/", redirect(`${SITE}/`));
	await runtime.http.respond("https://www.acme.test/", redirect(`${SITE}/`));
	await runtime.http.respond(`${SITE}${MISSING_PATH}`, html("Not found", 404));
	await runtime.http.respond(`${SITE}/robots.txt`, new Response(robots));
	await runtime.http.respond(`${SITE}/sitemap.xml`, sitemap);
}

/** What EmDash serves at /sitemap.xml: a list of lists, one per collection. */
function sitemapIndex(): Response {
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<sitemap><loc>${SITE}/sitemap-pages.xml</loc></sitemap>\n</sitemapindex>`,
		{ headers: { "content-type": "application/xml" } },
	);
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

const DETAILS = "Details for your web person";

/** The screen's words without the folded details for the owner's web person. */
function withoutDetails(response: BlockResponse): string {
	return JSON.stringify(response.blocks, (_key, value: unknown) =>
		(value as { type?: string; label?: string } | null)?.type === "accordion" &&
		(value as { label?: string }).label === DETAILS
			? undefined
			: value,
	);
}

/** The Checklist row of one name, as the Admin's page shows it. */
async function checklistRow(runtime: PluginRuntimeTestHost, name: string): Promise<string> {
	const page = await runtime.admin.loadPage(PAGE);
	const match = text(page).match(new RegExp(`"check":"${name}\\. ([^"]*)","status":"([^"]*)"`));
	if (!match) throw new Error(`no Checklist row "${name}"`);
	return `${match[2]}: ${match[1]}`;
}

async function entryId(runtime: PluginRuntimeTestHost, path: string): Promise<string> {
	const row = await runtime.inspect.storage.get<PageRow>("pages", path);
	if (!row?.id) throw new Error(`no page ${path}`);
	return row.id;
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
		expect(most).toBeLessThanOrEqual(9);

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
		// Error numbers stay folded away, in the details for the owner's web person.
		expect(withoutDetails(page)).not.toMatch(/\b(404|500|cron|robots\.txt)\b/);
		expect(words).toContain("/old-page: HTTP 404, checked just now (");
		expect(words).toContain("/christmas: not requested, the page is not published.");

		// The Checklist read the site's own answers.
		expect(words).toContain(
			"Secure connection. The insecure address sends visitors to the secure one.",
		);
		expect(words).toContain("www.acme.test sends visitors on to your address.");
	});

	it("the first check after a page is deleted reports links to it", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect((await summary(runtime)).rows.link.map((r) => r.url)).not.toContain("/about");

		// About goes to the bin; the site answers its address with "not found" from now on.
		const about = (await runtime.inspect.content.list("pages")).find((e) => e.slug === "about");
		expect(about).toBeTruthy();
		await runtime.actions.content.trash("pages", about!.id);
		await ownSite(runtime, true);

		// The next full check, due now.
		const scan = await runtime.inspect.kv.get<ScanState>("scan");
		await runtime.fixtures.plugin.kv("scan", {
			...scan,
			nextAt: new Date(Date.now() - 1000).toISOString(),
		});
		await cron(runtime);
		expect((await runtime.inspect.kv.get<ScanState>("scan"))?.pass).toBe((scan?.pass ?? 0) + 1);
		await finish(runtime);

		const result = await summary(runtime);
		expect(result.pages).toBe(1);
		// About is in the site menu too, so it is listed under every page.
		expect(result.rows.site.map((r) => `${r.url} ${r.reason}`)).toContain("/about missing");
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
		await runtime.http.respond(
			"https://linkedin.com/company/acme",
			new Response(null, { status: 403 }),
		);
		await runtime.http.respond("https://instagram.com/acme", new Response(null, { status: 200 }));
		for (let run = 0; run < 3; run += 1) await cron(runtime);

		const gone = idFor("external", "https://gone.example/rye");
		const linkedin = idFor("external", "https://linkedin.com/company/acme");
		// Three sites, one request each: no call to spare for a second try in the same run,
		// so the two that turned HEAD away wait their turn and are asked with GET next time.
		const asked = runtime.http.requests().map((r) => `${r.method} ${r.url}`);
		expect(asked.sort()).toEqual(
			[
				"HEAD https://gone.example/rye",
				"HEAD https://instagram.com/acme",
				"HEAD https://linkedin.com/company/acme",
			].sort(),
		);
		expect(runtime.http.requests()[0]?.headers["user-agent"]).toMatch(
			/^EmDash-SiteHealth\/0\.1 \(\+https:\/\/acme\.test\)/,
		);
		expect((await runtime.inspect.kv.get<Queue>("queue"))?.ops ?? 0).toBeLessThanOrEqual(9);
		for (const id of [gone, linkedin])
			expect(await runtime.inspect.storage.get<LinkRow>("links", id)).toMatchObject({
				state: "pending",
				get: true,
			});

		// A minute later LinkedIn is asked with GET: turned away again.
		await moveOn(runtime, linkedin, 0);
		runtime.http.clear();
		await runtime.http.respond(
			"https://linkedin.com/company/acme",
			new Response("no", { status: 403 }),
		);
		await cron(runtime);
		expect(runtime.http.requests().map((r) => `${r.method} ${r.url}`)).toEqual([
			"GET https://linkedin.com/company/acme",
		]);
		expect(await runtime.inspect.storage.get<LinkRow>("links", linkedin)).toMatchObject({
			state: "unknown",
			reason: "refuses",
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

		// The Checklist's Email row: worked out on load, who gets them, the test button with it.
		const checklist = await runtime.admin.loadPage(PAGE, { user: admin });
		const row = JSON.stringify(checklist.blocks).match(/"text":"Email: [^"]*"[^}]*}/)?.[0] ?? "";
		expect(row).toContain("Email: Working. Last checked just now: an alert was sent.");
		expect(row).toContain("Goes to ellen@acme.test and studio@web.example.");
		expect(row).toContain('"action_id":"send_test"');

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
		expect(most).toBeLessThanOrEqual(9);
		const result = await summary(runtime);
		expect(result.live).toBe("not-public");
		expect(result.rows.site).toEqual([]);
		// The draft is known from the content alone; the address that matches no page could not be checked.
		expect(result.rows.link.map((r) => r.url)).toEqual(["/christmas"]);
		expect(result.unknownRows.map((r) => `${r.url} ${r.reason}`)).toContain("/old-page not-public");
		expect(runtime.http.requests()).toEqual([]);
		const page = await runtime.admin.loadPage(PAGE);
		expect(text(page)).toContain("This site is not public yet");
	});

	it("a page published while the first check finishes says the site is not public, not 'could not open'", async () => {
		// The full Playwright run: the plugin's first check is past its link steps when a page is
		// published; there is no summary yet, only the running check, which knows the site is not public.
		const runtime = await start("");
		await runtime.transport.invokeHook("plugin:activate", {});
		for (let run = 0; run < 60; run += 1) {
			const scan = await runtime.inspect.kv.get<ScanState>("scan");
			if (scan?.phase === "checklist") break;
			await cron(runtime);
		}
		expect((await runtime.inspect.kv.get<ScanState>("scan"))?.live).toBe("not-public");
		expect(await runtime.inspect.kv.get("summary")).toBeNull();
		const spring = (await runtime.fixtures.content("pages", {
			slug: "spring-menu",
			status: "published",
			data: { title: "Spring menu", body: [link("Old menu", "/menu-2024", "s1")] },
		})) as { id: string };
		await runtime.transport.invokeHook("content:afterPublish", {
			collection: "pages",
			content: { id: spring.id },
		});
		await finish(runtime);
		const result = await summary(runtime);
		expect(result.live).toBe("not-public");
		expect(result.unknownRows.map((r) => `${r.url} ${r.reason}`)).toContain(
			"/menu-2024 not-public",
		);
		expect(text(await runtime.admin.loadPage(PAGE))).toContain(
			"/menu-2024 matches no page we know of. Your site is not public yet",
		);
	});

	it("a row saved as 'could not open' before the site was known to be private reads as not public", async () => {
		const runtime = await start("");
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const id = idFor("internal", "/old-page");
		const row = await runtime.inspect.storage.get<LinkRow>("links", id);
		const stored = await summary(runtime);
		// What a 0.2.0 check, or an earlier write, left behind.
		await runtime.fixtures.plugin.storage("links", id, { ...row, reason: "no-live" });
		await runtime.fixtures.plugin.kv("summary", {
			...stored,
			unknownRows: stored.unknownRows.map((r) => (r.id === id ? { ...r, reason: "no-live" } : r)),
		});
		const words = text(await runtime.admin.loadPage(PAGE));
		expect(words).toContain("/old-page matches no page we know of. Your site is not public yet");
		expect(words).not.toContain("/old-page: we could not open your site");
	});

	it("takes a full link to the site's own address on this computer as one of its pages (roundup 2026-11-09)", async () => {
		const runtime = await start("http://127.0.0.1:4321");
		await runtime.fixtures.content("pages", {
			slug: "contact",
			status: "published",
			data: {
				title: "Contact",
				body: [
					link("Team", "http://127.0.0.1:4321/team-old", "t1"),
					link("Team, by name", "http://localhost:4321/team-older", "t2"),
					link("About", "http://localhost:4321/about", "t3"),
				],
			},
		});
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const result = await summary(runtime);
		expect(result.live).toBe("not-public");
		// Each is a path on this site, never a link to another site that is refused.
		const rows = await runtime.inspect.storage.list<LinkRow>("links");
		const external = rows.filter((r) => r.data.kind === "external").map((r) => r.data.url);
		expect(external.filter((url) => /127\.0\.0\.1|localhost/.test(url))).toEqual([]);
		const about = await runtime.inspect.storage.get<LinkRow>("links", idFor("internal", "/about"));
		expect(about?.state).toBe("ok");
		expect(result.unknownRows.map((r) => `${r.url} ${r.reason}`).sort()).toEqual(
			expect.arrayContaining(["/team-old not-public", "/team-older not-public"]),
		);
		// The site cannot open itself here (EmDash refuses plugin requests to this computer).
		expect(runtime.http.requests()).toEqual([]);
		expect(text(await runtime.admin.loadPage(PAGE))).toContain(
			"/team-old matches no page we know of. Your site is not public yet, so we cannot open the address to be sure; it is checked once the site has a public address.",
		);
	});

	for (const [name, status, body] of [
		["a hosting error page", 522, "error code: 522"],
		["a 'not found' error page from the host", 404, "error code: 1042"],
	] as const) {
		it(`degrades to 'could not check' when the site's own address returns ${name}`, async () => {
			const runtime = await start();
			const error = () => new Response(body, { status, headers: { "content-type": "text/plain" } });
			for (const path of [
				"/",
				"/about",
				"/home",
				"/old-page",
				"/menu-2024",
				MISSING_PATH,
				"/robots.txt",
				"/sitemap.xml",
			]) {
				for (let i = 0; i < 4; i += 1) await runtime.http.respond(`${SITE}${path}`, error());
			}
			await runtime.admin.submit(PAGE, "save_options", {
				recipients: "ellen@acme.test",
				outbound: false,
			});
			await runtime.transport.invokeHook("plugin:activate", {});
			await finish(runtime);
			for (let run = 0; run < 3; run += 1) await cron(runtime);

			const result = await summary(runtime);
			expect(result.live).toBe("failed");
			expect(result.rows.site).toEqual([]);
			// Only what the content itself shows: the insecure map and the unpublished page.
			expect(result.rows.page.map((r) => r.url)).toEqual(["http://maps.example/embed"]);
			expect(result.rows.link.map((r) => r.url)).toEqual(["/christmas"]);
			expect(result.unknownRows.map((r) => `${r.url} ${r.reason}`)).toContain("/old-page no-live");
			expect(await runtime.inspect.email()).toEqual([]);
			const page = text(await runtime.admin.loadPage(PAGE));
			expect(page).toContain("We cannot open your pages to check them");
			expect(page).not.toContain("does not exist");

			// Checking a row again does not open the site either.
			const asked = runtime.http.requests().length;
			const again = await runtime.admin.act(PAGE, "fix", {
				value: `check|${idFor("internal", "/old-page")}`,
			});
			expect(again.toast?.message).toContain("It is not counted as broken.");
			expect(runtime.http.requests().length).toBe(asked);
		});
	}

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

describe("a site in the middle of an update", () => {
	const midUpdate = () =>
		new Response(
			"Database migrations are required. Apply the deployment migration manifest and retry.",
			{ status: 503, headers: { "retry-after": "60" } },
		);
	const isUpdateMail = (m: Record<string, unknown>) =>
		String(m.subject).includes("your site is showing visitors an error");

	it("says the site is down until its update finishes, and emails at once, not 'blocked'", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.admin.submit(PAGE, "save_options", {
			recipients: "ellen@acme.test",
			outbound: false,
		});
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		// The first check's urgent email (the broken menu link) goes out; a day passes.
		await cron(runtime);
		expect(await runtime.inspect.email()).toHaveLength(1);
		const alerts = await runtime.inspect.kv.get<Alerts>("alerts");
		await runtime.fixtures.plugin.kv("alerts", {
			...alerts,
			urgentAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
		});
		// Then the site answers every visitor with EmDash's "update not finished" page.
		await runtime.admin.act(PAGE, "check_all");
		for (let i = 0; i < 4; i += 1) await runtime.http.respond(`${SITE}/`, midUpdate());
		await finish(runtime);
		await cron(runtime);
		await cron(runtime);

		const result = await summary(runtime);
		expect(result.live).toBe("updating");
		const update = (await runtime.inspect.email()).filter(isUpdateMail);
		expect(update).toHaveLength(1);
		expect(String(update[0]?.text)).toContain("an update to its database has not finished");

		const page = text(await runtime.admin.loadPage(PAGE));
		expect(page).toContain("Your site is in the middle of an update");
		expect(page).not.toContain("bot protection");
		expect(page).toContain("Site up");

		// The same check again the same day sends nothing more.
		await runtime.admin.act(PAGE, "check_all");
		for (let i = 0; i < 4; i += 1) await runtime.http.respond(`${SITE}/`, midUpdate());
		await finish(runtime);
		await cron(runtime);
		expect((await runtime.inspect.email()).filter(isUpdateMail)).toHaveLength(1);
	});

	it("still calls a bot-protection page with the same error number 'blocked'", async () => {
		const runtime = await start();
		await runtime.http.respond(
			`${SITE}/`,
			new Response(
				"<html><title>Just a moment...</title><body>Checking your browser</body></html>",
				{ status: 503, headers: { "content-type": "text/html", "retry-after": "60" } },
			),
		);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect((await summary(runtime)).live).toBe("blocked");
		const page = text(await runtime.admin.loadPage(PAGE));
		expect(page).toContain("We cannot open your pages to check them");
		expect(page).not.toContain("middle of an update");
	});
});

describe("search engines", () => {
	const HOME = "Home page in search results";

	it("says when the home page tells search engines not to list it, and clears on the next check", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect(await checklistRow(runtime, HOME)).toBe(
			"Working: Search engines may list your home page.",
		);

		await runtime.http.respond(
			`${SITE}/`,
			html(HOME_HTML.replace("<head>", '<head><meta name="robots" content="noindex">'), 200),
		);
		await runtime.admin.act(PAGE, "check_all");
		await finish(runtime);
		const row = await checklistRow(runtime, HOME);
		expect(row).toMatch(/^Needs attention: Your home page tells search engines not to list it/);
		expect(row).toContain("(a noindex tag in the page)");
		// The banner counts it.
		expect(text(await runtime.admin.loadPage(PAGE))).toContain("thing needs attention");

		await runtime.http.respond(
			`${SITE}/`,
			html(HOME_HTML, 200, { "x-robots-tag": "googlebot: noindex" }),
		);
		await runtime.admin.act(PAGE, "check_all");
		await finish(runtime);
		expect(await checklistRow(runtime, HOME)).toContain(
			"(an X-Robots-Tag header the server sends)",
		);

		// Fixed: the next full check says so, without waiting for the weekly Checklist.
		await runtime.http.respond(`${SITE}/`, html(HOME_HTML, 200));
		await runtime.admin.act(PAGE, "check_all");
		await finish(runtime);
		expect(await checklistRow(runtime, HOME)).toBe(
			"Working: Search engines may list your home page.",
		);
	});

	it("reads robots.txt per crawler: Google kept out is a problem", async () => {
		const runtime = await start();
		await ownSite(
			runtime,
			false,
			"User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
		);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect(await checklistRow(runtime, "Search engines")).toBe(
			"Needs attention: Your site tells Google to stay away, so it will not appear in Google's results. Other search engines are allowed in.",
		);
	});

	it("keeping only AI crawlers out is a choice, not a problem", async () => {
		const other = await start();
		await ownSite(
			other,
			false,
			"User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /_emdash/\n",
		);
		await other.transport.invokeHook("plugin:activate", {});
		await finish(other);
		expect(await checklistRow(other, "Search engines")).toBe(
			"Working: They are allowed in, and the list of your pages for them answers.",
		);
	});

	it("follows robots.txt to the list of pages it names, and accepts a list of lists", async () => {
		const runtime = await start();
		await ownSite(
			runtime,
			false,
			`User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap-index.xml\n`,
			html("Not found", 404),
		);
		await runtime.http.respond(`${SITE}/sitemap-index.xml`, sitemapIndex());
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect(await checklistRow(runtime, "Search engines")).toBe(
			"Working: They are allowed in, and the list of your pages for them answers.",
		);
		const requests = runtime.http.requests();
		const asked = requests.map((r) => r.url);
		expect(asked).toContain(`${SITE}/sitemap-index.xml`);
		expect(asked).not.toContain(`${SITE}/sitemap.xml`);
		// Only the start of the list is asked for: the sandbox refuses a body over 8 MiB.
		const sitemap = requests.find((r) => r.url === `${SITE}/sitemap-index.xml`);
		const range = Object.entries(sitemap?.headers ?? {}).find(([k]) => k.toLowerCase() === "range");
		expect(range?.[1]).toBe("bytes=0-2047");
	});

	it("counts a gzipped list of pages as there without reading it", async () => {
		const runtime = await start();
		await ownSite(
			runtime,
			false,
			`﻿User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml.gz\n`,
			html("Not found", 404),
		);
		await runtime.http.respond(
			`${SITE}/sitemap.xml.gz`,
			new Response(null, { headers: { "content-type": "application/gzip" } }),
		);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect(await checklistRow(runtime, "Search engines")).toBe(
			"Working: They are allowed in, and the list of your pages for them answers.",
		);
		const gz = runtime.http.requests().filter((r) => r.url === `${SITE}/sitemap.xml.gz`);
		expect(gz.map((r) => r.method)).toEqual(["HEAD"]);
	});

	it("does not count a page that is not a list of pages", async () => {
		const runtime = await start();
		// A site that answers every address with a normal page.
		await ownSite(runtime, false, undefined, html("<html><body>Home</body></html>"));
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect(await checklistRow(runtime, "Search engines")).toBe(
			"Working: They are allowed in. There is no list of your pages for them yet.",
		);
	});
});

describe("the Links on this page panel", () => {
	it("shows an Editor the problems on the page they are editing, in plain words", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const editor = await runtime.fixtures.user({ email: "sam@acme.test", role: "editor" });
		const home = await entryId(runtime, "/home");
		const panel = await runtime.admin.loadEditorPanel("links", "pages", home, { user: editor });
		const words = text(panel);
		expect(words).toContain("/old-page goes to a page that does not exist.");
		expect(words).toContain("/christmas goes to a page that is not published yet.");
		expect(words).toContain("maps.example/embed is loaded over an insecure connection.");
		// Links to other sites are checked a day later.
		expect(words).toContain("2 links to other sites are not checked yet.");
		expect(words).toContain("1 link works.");
		// Read-only: no buttons, no menus, and no maker's name.
		expect(words).not.toMatch(/"type":"(button|menu)"/);
		expect(words).not.toMatch(/moorage/i);
		expect(validateBlockResponse(panel, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});
		const admin = text(await runtime.admin.loadEditorPanel("links", "pages", home));
		expect(admin).not.toMatch(/moorage/i);

		// The editor fixes a link and publishes: the panel follows at once.
		const fixed = await runtime.actions.content.update("pages", home, {
			data: { body: [link("About", "/about", "k1")] },
			actor: { id: editor.id, role: editor.role },
		});
		expect(fixed.success).toBe(true);
		const published = await runtime.actions.content.publish("pages", home, {
			actor: { id: editor.id, role: editor.role },
		});
		expect(published.success).toBe(true);
		// The test host does not run hooks for its actions; EmDash does.
		await runtime.transport.invokeHook("content:afterPublish", {
			collection: "pages",
			content: { id: home },
		});
		const after = text(
			await runtime.admin.loadEditorPanel("links", "pages", home, { user: editor }),
		);
		expect(after).not.toContain("/old-page");
		expect(after).toContain("The 1 link on this page works.");
	});

	it("follows a page to its new address when its slug changes", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const home = await entryId(runtime, "/home");
		const moved = await runtime.actions.content.update("pages", home, {
			slug: "welcome",
			data: { body: [link("About", "/about", "k1")] },
		});
		expect(moved.success).toBe(true);
		expect((await runtime.actions.content.publish("pages", home)).success).toBe(true);
		await runtime.transport.invokeHook("content:afterPublish", {
			collection: "pages",
			content: { id: home },
		});
		// The row at the old address stays until the next full check sweeps it away.
		expect(await runtime.inspect.storage.get("pages", "/home")).not.toBeNull();
		const panel = text(await runtime.admin.loadEditorPanel("links", "pages", home));
		expect(panel).toContain("The 1 link on this page works.");
		expect(panel).not.toContain("/old-page");
	});

	it("says when a page's links are not checked yet", async () => {
		const runtime = await start();
		const draft = (await runtime.fixtures.content("pages", {
			slug: "spring",
			status: "draft",
			data: { title: "Spring", body: [link("Gone", "/gone", "k9")] },
		})) as { id: string };
		// Before the first check.
		expect(text(await runtime.admin.loadEditorPanel("links", "pages", draft.id))).toContain(
			"Links on this page are checked with the first full check of your site.",
		);
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect(text(await runtime.admin.loadEditorPanel("links", "pages", draft.id))).toContain(
			"Links on this page are checked once it is published.",
		);
	});
});

/** What a WordPress move leaves on a page (the re-run of 2026-11-09). */
async function movedFromWordPress(runtime: PluginRuntimeTestHost): Promise<string> {
	// EmDash does not find a page whose slug is in WordPress's coded form.
	await runtime.http.respond(`${SITE}/%cf%84%cf%85%cf%81%ce%af`, html("Page not found", 404));
	await runtime.http.respond(`${SITE}/contact`, html("<html><body>Contact</body></html>"));
	await runtime.fixtures.content("pages", {
		slug: "%cf%84%cf%85%cf%81%ce%af",
		status: "published",
		data: { title: "Τυρί", body: [] },
	});
	const contact = (await runtime.fixtures.content("pages", {
		slug: "contact",
		status: "published",
		data: {
			title: "Contact",
			body: [
				{
					_type: "htmlBlock",
					_key: "h1",
					html: '[contact-form-7 id="9ee95fa" title="Contact form 1"]',
				},
				{
					_type: "htmlBlock",
					_key: "h2",
					html: "<!-- wp:latest-posts /-->",
					originalBlockName: "core/latest-posts",
				},
				link("Our story", "/?p=12", "w1"),
				link("Old shop", "https://old-bakery.example/wp-content/uploads/2024/05/shop.jpg", "w2"),
				{
					_type: "image",
					_key: "i1",
					asset: { _type: "reference", _ref: "m1", url: "/_emdash/api/media/file/oven.jpg" },
				},
			],
		},
	})) as { id: string };
	return contact.id;
}

function leftWords(page: BlockResponse): string[] {
	const words = text(page);
	return [
		"is a WordPress shortcode",
		"left from WordPress's Latest Posts block",
		"/?p=12 is a WordPress address",
		"looks like an address on your old WordPress site",
		"in WordPress's coded form of its letters",
		"oven.jpg has no alt text",
	].filter((phrase) => words.includes(phrase));
}

describe("left over from WordPress", () => {
	it("lists what a move left behind, says what to do, and costs no extra calls", async () => {
		const runtime = await start();
		await ownSite(runtime);
		const contact = await movedFromWordPress(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		const most = await finish(runtime);
		expect(most).toBeLessThanOrEqual(9);
		const result = await summary(runtime);
		expect(result.left).toBe(6);
		// Not broken links: the counts of links and of problems to fix stay as they were.
		expect(result.fix).toEqual({ site: 1, page: 1, link: 2 });
		const page = await runtime.admin.loadPage(PAGE);
		expect(text(page)).toContain("Left over from WordPress");
		expect(leftWords(page)).toHaveLength(6);
		expect(text(page)).toContain("Edit Contact");
		expect(validateBlockResponse(page, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});

		// An Editor sees them too, and beside the page in the editor.
		const editor = await runtime.fixtures.user({ email: "sam@acme.test", role: "editor" });
		expect(leftWords(await runtime.admin.loadPage(PAGE, { user: editor }))).toHaveLength(6);
		const panel = await runtime.admin.loadEditorPanel("links", "pages", contact, { user: editor });
		expect(text(panel)).toContain("Left over from WordPress (5)");
		expect(text(panel)).toContain("is a WordPress shortcode");
		expect(text(panel)).not.toMatch(/moorage/i);

		// The Edit menu opens a panel with the page and what to do.
		const id = result.leftRows?.find((r) => r.reason === "shortcode")?.id;
		expect(id).toBeDefined();
		const opened = await runtime.admin.act(PAGE, "fix", { value: `edit0|${id}` });
		expect(text(opened)).toContain("Open Contact");
		expect(validateBlockResponse(opened, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});

		// The editor cleans the page up and publishes: the rows go at once.
		const fixed = await runtime.actions.content.update("pages", contact, {
			data: { body: [link("Our story", "/about", "w1")] },
		});
		expect(fixed.success).toBe(true);
		expect((await runtime.actions.content.publish("pages", contact)).success).toBe(true);
		await runtime.transport.invokeHook("content:afterPublish", {
			collection: "pages",
			content: { id: contact },
		});
		const after = await summary(runtime);
		expect(after.left).toBe(1);
		expect(after.leftRows?.map((r) => r.reason)).toEqual(["encoded-slug"]);
		expect(leftWords(await runtime.admin.loadPage(PAGE))).toEqual([
			"in WordPress's coded form of its letters",
		]);
	});

	it("a row marked as fine stays off the list through the next full check", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await movedFromWordPress(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const id = (await summary(runtime)).leftRows?.find((r) => r.reason === "no-alt")?.id;
		const fine = await runtime.admin.act(PAGE, "fix", { value: `fine|${id}` });
		expect(fine.toast?.message).toBe("Marked as fine. oven.jpg is not listed any more.");
		expect((await summary(runtime)).left).toBe(5);
		await runtime.admin.act(PAGE, "check_all");
		await finish(runtime);
		expect((await summary(runtime)).left).toBe(5);
		expect(leftWords(await runtime.admin.loadPage(PAGE))).not.toContain("oven.jpg has no alt text");
	});

	it("finds the old site in the menu the home page shows", async () => {
		const runtime = await start();
		// The first answer for the home page is the full check's; the Checklist gets the usual one.
		await runtime.http.respond(
			`${SITE}/`,
			html(
				'<html><body><header><nav><a href="/about">About</a><a href="/?p=3">News</a><a href="https://old-bakery.example/wp-content/uploads/menu.pdf">Menu</a></nav></header></body></html>',
			),
		);
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const rows = (await summary(runtime)).leftRows ?? [];
		expect(rows.map((r) => `${r.url} ${r.menu}`).sort()).toEqual([
			"/?p=3 true",
			"https://old-bakery.example/wp-content/uploads/menu.pdf true",
		]);
		expect(text(await runtime.admin.loadPage(PAGE))).toContain("Found on: Site menu (every page).");
	});

	it("forgets an old site once no page links to its WordPress addresses", async () => {
		const runtime = await start();
		await ownSite(runtime);
		const contact = await movedFromWordPress(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect((await summary(runtime)).oldHosts).toEqual(["old-bakery.example"]);
		const fixed = await runtime.actions.content.update("pages", contact, {
			data: { body: [link("About", "/about", "w1")] },
		});
		expect(fixed.success).toBe(true);
		expect((await runtime.actions.content.publish("pages", contact)).success).toBe(true);
		await runtime.admin.act(PAGE, "check_all");
		await finish(runtime);
		expect((await summary(runtime)).oldHosts).toBeUndefined();
	});

	it("leaves out the coded slug of content that has no page of its own", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.fixtures.collection({
			slug: "testimonials",
			label: "Testimonials",
			routable: false,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		await runtime.fixtures.content("testimonials", {
			slug: "%cf%84%cf%85",
			status: "published",
			data: { title: "Τυ" },
		});
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect((await summary(runtime)).left ?? 0).toBe(0);
	});

	it("shows nothing about WordPress on a site that never had it", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		expect((await summary(runtime)).left ?? 0).toBe(0);
		expect(text(await runtime.admin.loadPage(PAGE))).not.toContain("WordPress");
	});
});

describe("the help line", () => {
	const line = (response: BlockResponse) =>
		response.blocks.find((block) => block.type === "actions" && block.block_id === HELP_LINE);

	it("ends an admin's page, under both tabs, with the guide, the plugins and the maker", async () => {
		const runtime = await start();
		const page = await runtime.admin.loadPage(PAGE);
		expect(page.blocks.at(-1)).toEqual({
			type: "actions",
			block_id: HELP_LINE,
			elements: [
				{
					type: "link",
					label: "Help",
					target: {
						kind: "external",
						url: "https://moorage.dev/guides/find-and-fix-broken-links-on-emdash",
					},
				},
				{
					type: "link",
					label: "More free plugins",
					target: { kind: "external", url: "https://moorage.dev/plugins" },
				},
				{
					type: "link",
					label: "by Moorage",
					target: { kind: "external", url: "https://moorage.dev" },
				},
			],
		});
		expect(validateBlockResponse(page, { pluginPagePaths: [PAGE] }).valid).toBe(true);
		const saved = await runtime.admin.submit(PAGE, "save_options", { recipients: "a@acme.test" });
		expect(saved.blocks.filter((block) => block.block_id === HELP_LINE)).toHaveLength(1);
	});

	it("never shows to an editor, nor on the widget; authors and contributors cannot open the page", async () => {
		const runtime = await start();
		const editor = await runtime.fixtures.user({ email: "sam@acme.test", role: "editor" });
		expect(text(await runtime.admin.loadPage(PAGE, { user: editor }))).not.toMatch(/moorage/i);
		expect(text(await runtime.admin.loadWidget("site-health"))).not.toMatch(/moorage/i);
		for (const role of ["author", "contributor"] as const) {
			const user = await runtime.fixtures.user({ email: `${role}@acme.test`, role });
			await expect(runtime.admin.loadPage(PAGE, { user })).rejects.toThrow(/403/);
		}
	});

	it("hides with the switch under Options, keeps it through other saves, and shows again", async () => {
		const runtime = await start();
		await runtime.admin.loadPage(PAGE);
		const hidden = await runtime.admin.submit(PAGE, HIDE_ACTION, { hide_help_line: true });
		expect(line(hidden)).toBeUndefined();
		expect(text(hidden)).toContain(HIDE_ACTION);
		expect(
			(await runtime.inspect.setting<{ hideHelpLine?: boolean }>("options"))?.hideHelpLine,
		).toBe(true);
		expect(line(await runtime.admin.loadPage(PAGE))).toBeUndefined();

		await runtime.admin.submit(PAGE, "save_options", {
			recipients: "b@acme.test",
			outbound: false,
		});
		await runtime.admin.submit(PAGE, HIDE_ACTION, {});
		expect(line(await runtime.admin.loadPage(PAGE))).toBeUndefined();

		expect(
			line(await runtime.admin.submit(PAGE, HIDE_ACTION, { hide_help_line: false })),
		).toBeDefined();
	});

	it("an editor cannot use the switch", async () => {
		const runtime = await start();
		await runtime.admin.loadPage(PAGE);
		const editor = await runtime.fixtures.user({ email: "sam@acme.test", role: "editor" });
		await runtime.admin.submit(PAGE, HIDE_ACTION, { hide_help_line: true }, { user: editor });
		expect(line(await runtime.admin.loadPage(PAGE))).toBeDefined();
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
