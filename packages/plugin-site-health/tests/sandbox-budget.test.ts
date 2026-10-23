// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// B39: pins how many calls to the host (subrequests) each Site Health invocation makes in its
// worst realistic state, counted at the real PluginBridge by tests/bridge-budget.ts. On Cloudflare
// a sandboxed invocation may make 10; the 11th and every later call throw. Every path here stays
// at 9 or under (MOST), one call to spare. src/budget.ts counts the same calls (ctx.log included),
// so `scan.ops` and `queue.ops` match the bridge.
//
// Every count is exact (`toBe`), so a change that adds or removes a call shows up here. Each
// measurement starts on a cold isolate (`host.restart()`): settings are not kept in memory then.
// The enforced tests run the paths that used to go over with Cloudflare's limit applied, and show
// that nothing is refused and nothing is lost.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { MISSING_PATH } from "../src/checklist.js";
import type { LinkRow, PageRow } from "../src/model.js";
import type { Alerts, Options, Queue, ScanState, Summary } from "../src/state.js";
import { idFor } from "../src/url.js";
import {
	describeCalls,
	measure,
	SANDBOX_SUBREQUESTS,
	TOO_MANY,
	type Measured,
} from "./bridge-budget.js";

const PAGE = "/health";
const SITE = "https://acme.test";
const TASK = "site-health";
const SAVED: Options = { recipients: ["anna@acme.test"], outbound: true };
const LONG_AGO = "2000-01-01T00:00:00.000Z";
/** The most calls any invocation may make: one under Cloudflare's limit. */
const MOST = SANDBOX_SUBREQUESTS - 1;
/** The steps of a full check after the first (redirects runs with the start of the check). */
const PHASES = [
	"walk",
	"resolve",
	"live-home",
	"live-pages",
	"live-paths",
	"checklist",
	"sweep",
	"count",
	"freeze",
];

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

/** The bakery from site.test.ts: two published pages, a draft, links in and out, a redirect. */
async function start(): Promise<PluginRuntimeTestHost> {
	host = await createPluginRuntimeTestHost({
		site: { name: "Acme Bakery", url: SITE, locale: "en" },
	});
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
	await host.fixtures.redirect({ source: "/shop", destination: "/about" });
	return host;
}

const HOME_HTML = `<!doctype html><html><head></head><body>
<header><nav><a href="/about">About</a><a href="/menu-2024">Menu</a></nav></header>
<main><p>Fresh bread.</p></main>
<footer><a href="https://instagram.com/acme">Instagram</a></footer>
</body></html>`;

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

function redirect(to: string): Response {
	return new Response(null, { status: 301, headers: { location: to } });
}

/** The site's own answers for one full check. */
async function ownSite(runtime: PluginRuntimeTestHost): Promise<void> {
	await runtime.http.respond(
		`${SITE}/`,
		html(HOME_HTML, 200, { "cache-control": "public, max-age=60" }),
	);
	// An insecure picture on About: the live-pages step has something to save.
	await runtime.http.respond(
		`${SITE}/about`,
		html('<html><body>About <img src="http://cdn.example/oven.jpg"></body></html>'),
	);
	await runtime.http.respond(`${SITE}/home`, html("<html><body>Home</body></html>"));
	await runtime.http.respond(`${SITE}/old-page`, html("Not found", 404));
	await runtime.http.respond(`${SITE}/menu-2024`, html("Not found", 404));
	await runtime.http.respond("http://acme.test/", redirect(`${SITE}/`));
	await runtime.http.respond("https://www.acme.test/", redirect(`${SITE}/`));
	await runtime.http.respond(`${SITE}${MISSING_PATH}`, html("Not found", 404));
	await runtime.http.respond(`${SITE}/robots.txt`, new Response("User-agent: *\nAllow: /\n"));
	await runtime.http.respond(`${SITE}/sitemap.xml`, new Response("", { status: 200 }));
}

const cronEvent = () => ({ name: TASK, scheduledAt: new Date().toISOString() });

async function cron(runtime: PluginRuntimeTestHost): Promise<unknown> {
	return runtime.transport.invokeHook("cron", cronEvent());
}

async function scanOf(runtime: PluginRuntimeTestHost): Promise<ScanState | null> {
	return runtime.inspect.kv.get<ScanState>("scan");
}

/** One invocation on a cold isolate, printed for the B39 report. */
async function cold<T>(
	runtime: PluginRuntimeTestHost,
	label: string,
	invoke: () => Promise<T>,
	enforce = false,
): Promise<Measured<T>> {
	await runtime.restart();
	const measured = await measure(invoke, { enforce });
	console.info(describeCalls(label, measured));
	expect(measured.calls.length).toBeLessThanOrEqual(MOST);
	return measured;
}

/** Settings as 0.1.2 left them: only the plain `options` KV key, nothing in `ctx.settings`. */
async function asUpgraded(runtime: PluginRuntimeTestHost, options: Options = SAVED): Promise<void> {
	await runtime.fixtures.plugin.setting("options", null);
	await runtime.fixtures.plugin.kv("options", options);
}

/** Run the scheduled task until the full check reaches `phase` (not yet run). */
async function runUntil(runtime: PluginRuntimeTestHost, phase: ScanState["phase"]): Promise<void> {
	for (let run = 0; run < 60; run += 1) {
		const scan = await scanOf(runtime);
		if (scan?.status === "running" && scan.phase === phase) return;
		await cron(runtime);
	}
	throw new Error(`the check never reached ${phase}`);
}

async function finish(runtime: PluginRuntimeTestHost): Promise<void> {
	for (let run = 0; run < 60; run += 1) {
		if ((await scanOf(runtime))?.status === "done") return;
		await cron(runtime);
	}
	throw new Error("the check did not finish in 60 runs");
}

/** A check that has not moved for ten minutes: the next page load moves it. */
async function stall(runtime: PluginRuntimeTestHost): Promise<void> {
	const scan = await scanOf(runtime);
	const old = new Date(Date.now() - 600_000).toISOString();
	await runtime.fixtures.plugin.kv("scan", { ...scan, lastStepAt: old });
}

/**
 * Step a full check one run at a time, each on a cold isolate, and keep the largest count seen in
 * each phase. `before` runs ahead of every step (to put the state back each time).
 */
async function phaseByPhase(
	runtime: PluginRuntimeTestHost,
	step: () => Promise<unknown>,
	before: () => Promise<void> = async () => {},
): Promise<Map<string, Measured<unknown>>> {
	const most = new Map<string, Measured<unknown>>();
	for (let run = 0; run < 60; run += 1) {
		const scan = await scanOf(runtime);
		if (scan?.status !== "running") return most;
		await before();
		await runtime.restart();
		const measured = await measure(step);
		if (measured.error) throw measured.error;
		expect(measured.calls.length, `${scan.phase}: ${measured.calls.join(" ")}`).toBeLessThanOrEqual(
			MOST,
		);
		const seen = most.get(scan.phase);
		if (!seen || measured.calls.length > seen.calls.length) most.set(scan.phase, measured);
	}
	throw new Error("the check did not finish in 60 runs");
}

function print(label: string, phases: Map<string, Measured<unknown>>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const [phase, measured] of phases) {
		console.info(describeCalls(`${label} ${phase}`, measured));
		counts[phase] = measured.calls.length;
	}
	return counts;
}

describe("hooks: plugin:activate", () => {
	it("a fresh site starts its first check", async () => {
		const runtime = await start();
		const m = await cold(runtime, "activate fresh", () =>
			runtime.transport.invokeHook("plugin:activate", {}),
		);
		// The task is scheduled once, with the check's start.
		expect(m.calls.length).toBe(7);
		expect(m.calls.filter((c) => c === "cronSchedule")).toHaveLength(1);
		expect((await scanOf(runtime))?.phase).toBe("walk");
		expect(m.nested).toEqual([]);
		// The scan is the last write, so its record of calls is the whole run.
		expect((await scanOf(runtime))?.ops).toBe(m.calls.length);
	});

	it("a site upgraded from 0.1.2 leaves copying its settings to the Admin page", async () => {
		const runtime = await start();
		await asUpgraded(runtime);
		const m = await cold(runtime, "activate upgraded", () =>
			runtime.transport.invokeHook("plugin:activate", {}),
		);
		expect(m.calls.length).toBe(7);
		expect(await runtime.inspect.setting("options")).toBeNull();
		expect((await scanOf(runtime))?.phase).toBe("walk");
		// The first Admin page load copies them.
		await runtime.admin.loadPage(PAGE);
		expect(await runtime.inspect.setting("options")).toEqual(SAVED);
	});

	it("a site that already has a check only re-schedules the task", async () => {
		const runtime = await start();
		await runtime.transport.invokeHook("plugin:activate", {});
		const m = await cold(runtime, "activate again", () =>
			runtime.transport.invokeHook("plugin:activate", {}),
		);
		expect(m.calls.length).toBe(2);
	});
});

describe("hooks: cron, the full check", () => {
	it("each phase of a first check, settings already in place", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		await ownSite(runtime);
		const first = await cold(runtime, "cron start", () => cron(runtime));
		expect(first.calls.length).toBe(7);
		const counts = print("cron", await phaseByPhase(runtime, () => cron(runtime)));
		expect(Object.keys(counts)).toEqual(PHASES);
		expect(counts.walk).toBe(6);
		expect(counts.resolve).toBe(6);
		expect(counts["live-home"]).toBe(6);
		expect(counts["live-pages"]).toBe(7);
		expect(counts["live-paths"]).toBe(6);
		expect(counts.checklist).toBe(8);
		expect(counts.sweep).toBe(4);
		expect(counts.count).toBe(8);
		// In two runs: the rows to look at and could not check (6), then the broken ones, the
		// summary, the alert for the broken menu link and the check (5).
		expect(counts.freeze).toBe(6);
		expect((await runtime.inspect.kv.get<Alerts>("alerts"))?.pending).toHaveLength(1);
		expect((await runtime.inspect.kv.get<Summary>("summary"))?.rows.site.length).toBe(1);
	});

	it("each phase, when it is the first run after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await asUpgraded(runtime);
		const first = await cold(runtime, "cron start upgraded", () => cron(runtime));
		// The scheduled task reads the old settings but leaves copying them to the Admin page.
		expect(first.calls.length).toBe(7);
		expect(first.calls).not.toContain("settingsSet");
		const counts = print(
			"cron upgraded",
			await phaseByPhase(
				runtime,
				() => cron(runtime),
				() => asUpgraded(runtime),
			),
		);
		expect(Object.keys(counts)).toEqual(PHASES);
		expect(counts.walk).toBe(6);
		expect(counts.resolve).toBe(6);
		expect(counts["live-home"]).toBe(6);
		expect(counts["live-pages"]).toBe(7);
		expect(counts["live-paths"]).toBe(6);
		expect(counts.checklist).toBe(8);
		expect(counts.sweep).toBe(4);
		expect(counts.count).toBe(8);
		expect(counts.freeze).toBe(6);
		expect(await runtime.inspect.setting("options")).toBeNull();
		expect((await runtime.inspect.kv.get<Alerts>("alerts"))?.pending).toHaveLength(1);
	});

	for (const left of ["by 0.1.3", "with lists from an earlier check"] as const) {
		it(`a check left at its last step ${left} finishes in two runs`, async () => {
			const runtime = await start();
			await runtime.fixtures.plugin.setting("options", SAVED);
			await ownSite(runtime);
			await runtime.transport.invokeHook("plugin:activate", {});
			await runUntil(runtime, "freeze");
			const scan = (await scanOf(runtime))!;
			// 0.1.3 kept no lists; going back to it and forward again can leave an old check's.
			const stale = { pass: scan.pass - 1, lookRows: [], unknownRows: [] };
			await runtime.fixtures.plugin.kv("scan", {
				...scan,
				lists: left === "by 0.1.3" ? undefined : stale,
			});
			const lists = await cold(runtime, `cron freeze left ${left}`, () => cron(runtime));
			expect(lists.calls.length).toBe(6);
			expect(await scanOf(runtime)).toMatchObject({ phase: "freeze", lists: { pass: scan.pass } });
			const freeze = await cold(runtime, `cron freeze after, left ${left}`, () => cron(runtime));
			expect(freeze.calls.length).toBe(5);
			expect((await scanOf(runtime))?.status).toBe("done");
			expect((await scanOf(runtime))?.lists).toBeUndefined();
			const summary = await runtime.inspect.kv.get<Summary>("summary");
			expect(summary?.rows.site.length).toBe(1);
			expect(summary?.look).toBe(summary?.lookRows.length);
		});
	}

	it("a second check sweeps away pages and links that are gone", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const about = (await runtime.inspect.content.list("pages")).find((e) => e.slug === "about");
		await runtime.actions.content.trash("pages", about!.id);
		await runtime.admin.act(PAGE, "check_all");
		await ownSite(runtime);
		// Give the full check every turn (no links to other sites in between).
		const passTurn = async () => {
			const queue = await runtime.inspect.kv.get<Queue>("queue");
			await runtime.fixtures.plugin.kv("queue", { ...queue, hosts: {}, cronAt: "9999" });
		};
		const counts = print("cron second", await phaseByPhase(runtime, () => cron(runtime), passTurn));
		expect(Object.keys(counts)).toEqual(PHASES);
		expect(counts.walk).toBe(6);
		expect(counts.resolve).toBe(6);
		expect(counts["live-home"]).toBe(6);
		expect(counts["live-pages"]).toBe(7);
		expect(counts["live-paths"]).toBe(6);
		// The Checklist is opened once a week; the second check skips it.
		expect(counts.checklist).toBe(2);
		expect(counts.sweep).toBe(6);
		expect(counts.count).toBe(8);
		expect(counts.freeze).toBe(6);
		expect(await runtime.inspect.storage.get("pages", "/about")).toBeNull();
	});
});

/** A finished check, then links to other sites and an erroring page all due at once. */
async function dueState(runtime: PluginRuntimeTestHost): Promise<string> {
	await ownSite(runtime);
	await runtime.transport.invokeHook("plugin:activate", {});
	await finish(runtime);
	const alerts = await runtime.inspect.kv.get<Alerts>("alerts");
	const now = new Date().toISOString();
	// No email is due: the week started now and nothing urgent waits.
	await runtime.fixtures.plugin.kv("alerts", {
		...alerts,
		pending: [],
		weeklyAt: now,
		urgentAt: now,
	});
	const queue = await runtime.inspect.kv.get<Queue>("queue");
	await runtime.fixtures.plugin.kv("queue", { ...queue, hosts: {} });
	// A page of the site that showed an error a minute ago; the second error makes it broken.
	const id = idFor("page", "/opening-hours");
	const row: LinkRow = {
		kind: "page",
		url: "/opening-hours",
		host: "",
		sources: [{ t: "Opening hours", p: "/opening-hours" }],
		count: 1,
		menu: false,
		content: false,
		editor: false,
		pass: 1,
		state: "pending",
		fails: 1,
		firstFailAt: new Date(Date.now() - 120_000).toISOString(),
		due: LONG_AGO,
	};
	await runtime.fixtures.plugin.storage("links", id, row);
	runtime.http.clear();
	await runtime.http.respond(`${SITE}/opening-hours`, html("Error", 500));
	// Both other sites turn HEAD away, so each wants a GET as well.
	await runtime.http.respond("https://gone.example/rye", new Response(null, { status: 404 }));
	await runtime.http.respond(
		"https://linkedin.com/company/acme",
		new Response(null, { status: 403 }),
	);
	return id;
}

const GONE = idFor("external", "https://gone.example/rye");
const LINKEDIN = idFor("external", "https://linkedin.com/company/acme");

/** A minute later: the hosts may be asked again and the rows put off are due. */
async function minuteLater(runtime: PluginRuntimeTestHost, ids: string[]): Promise<void> {
	const queue = await runtime.inspect.kv.get<Queue>("queue");
	await runtime.fixtures.plugin.kv("queue", { ...queue, hosts: {} });
	for (const id of ids) {
		const row = await runtime.inspect.storage.get<LinkRow>("links", id);
		await runtime.fixtures.plugin.storage("links", id, { ...row, due: LONG_AGO });
	}
}

describe("hooks: cron, what is due between checks", () => {
	it("three checks, a page newly broken: summary, alert and queue saved; the GETs wait", async () => {
		const runtime = await start();
		const id = await dueState(runtime);
		const m = await cold(runtime, "cron due", () => cron(runtime));
		// Three requests and the four writes leave no room for a second try within the run.
		expect(m.calls.length).toBe(9);
		expect(m.calls.filter((c) => c === "httpFetch")).toHaveLength(3);
		expect((await runtime.inspect.kv.get<Queue>("queue"))?.ops).toBe(m.calls.length);
		expect(await runtime.inspect.storage.get<LinkRow>("links", id)).toMatchObject({
			state: "broken",
			reason: "page-error",
		});
		const alerts = await runtime.inspect.kv.get<Alerts>("alerts");
		expect(alerts?.pending.map((a) => a.id)).toContain(id);
		// Both sites that turned HEAD away are asked with GET on their next turn.
		for (const other of [GONE, LINKEDIN])
			expect(await runtime.inspect.storage.get<LinkRow>("links", other)).toMatchObject({
				get: true,
			});
	});

	it("the same, as the first run after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		const id = await dueState(runtime);
		await asUpgraded(runtime);
		const m = await cold(runtime, "cron due upgraded", () => cron(runtime));
		expect(m.calls.length).toBe(9);
		expect(m.calls).not.toContain("settingsSet");
		expect(await runtime.inspect.storage.get<LinkRow>("links", id)).toMatchObject({
			state: "broken",
		});
	});

	it("enforced: the upgraded run keeps everything; the next turn asks with GET at once", async () => {
		const runtime = await start();
		const id = await dueState(runtime);
		await asUpgraded(runtime);
		const before = await runtime.inspect.kv.get<Queue>("queue");
		const m = await cold(runtime, "cron due upgraded (enforced)", () => cron(runtime), true);
		expect(m.refused).toEqual([]);
		expect(m.error).toBeUndefined();
		expect(await runtime.inspect.storage.get<LinkRow>("links", id)).toMatchObject({
			state: "broken",
		});
		expect((await runtime.inspect.kv.get<Alerts>("alerts"))?.pending.map((a) => a.id)).toContain(
			id,
		);
		const queue = await runtime.inspect.kv.get<Queue>("queue");
		expect(queue).not.toEqual(before);
		expect(Object.keys(queue?.hosts ?? {}).sort()).toEqual(["gone.example", "linkedin.com"]);

		await minuteLater(runtime, [GONE, LINKEDIN]);
		runtime.http.clear();
		await runtime.http.respond("https://gone.example/rye", new Response("gone", { status: 404 }));
		await runtime.http.respond(
			"https://linkedin.com/company/acme",
			new Response("no", { status: 403 }),
		);
		await runtime.http.respond("https://instagram.com/acme", new Response(null, { status: 200 }));
		const next = await cold(runtime, "cron due after (enforced)", () => cron(runtime), true);
		expect(next.error).toBeUndefined();
		expect(next.refused).toEqual([]);
		const asked = runtime.http.requests().map((r) => `${r.method} ${r.url}`);
		expect(asked).toContain("GET https://gone.example/rye");
		expect(asked).toContain("GET https://linkedin.com/company/acme");
		expect(asked.filter((r) => r.startsWith("HEAD https://gone.example"))).toEqual([]);
		expect(asked.filter((r) => r.startsWith("HEAD https://linkedin.com"))).toEqual([]);
		expect(await runtime.inspect.storage.get<LinkRow>("links", LINKEDIN)).toMatchObject({
			state: "unknown",
			reason: "refuses",
		});
	});

	it("an alert is due: one email", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await finish(runtime);
		const m = await cold(runtime, "cron mail", () => cron(runtime));
		expect(m.calls.length).toBe(4);
		expect(await runtime.inspect.email()).toHaveLength(1);
		expect(m.nested).toEqual([]);
	});
});

/** Home's page row also lists a broken link that the save has just taken out. */
async function savedWithLinkRemoved(runtime: PluginRuntimeTestHost): Promise<string> {
	await ownSite(runtime);
	await runtime.transport.invokeHook("plugin:activate", {});
	await finish(runtime);
	const gone = idFor("external", "https://removed.example/x");
	const home = await runtime.inspect.storage.get<PageRow>("pages", "/home");
	await runtime.fixtures.plugin.storage("pages", "/home", {
		...home,
		links: [...(home?.links ?? []), gone],
	});
	const entry = (await runtime.inspect.content.list("pages")).find((e) => e.slug === "home");
	const row: LinkRow = {
		kind: "external",
		url: "https://removed.example/x",
		host: "removed.example",
		sources: [{ c: "pages", id: entry!.id, t: "Home", p: "/home" }],
		count: 1,
		menu: false,
		content: true,
		editor: true,
		pass: 1,
		state: "broken",
		reason: "gone",
		group: "link",
		since: LONG_AGO,
		due: LONG_AGO,
	};
	await runtime.fixtures.plugin.storage("links", gone, row);
	return entry!.id;
}

describe("hooks: content", () => {
	for (const hook of [
		"content:afterSave",
		"content:afterPublish",
		"content:afterUnpublish",
	] as const) {
		it(`${hook}: a page with links in and out, one taken out`, async () => {
			const runtime = await start();
			const id = await savedWithLinkRemoved(runtime);
			const m = await cold(runtime, `${hook}`, () =>
				runtime.transport.invokeHook(hook, { collection: "pages", content: { id } }),
			);
			// The page's own row and the pages it links to come in one read.
			expect(m.calls.length).toBe(8);
			expect(
				await runtime.inspect.storage.get("links", idFor("external", "https://removed.example/x")),
			).toBeNull();
		});
	}

	it("content:afterSave as the first run after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		const id = await savedWithLinkRemoved(runtime);
		await asUpgraded(runtime);
		const m = await cold(runtime, "content:afterSave upgraded", () =>
			runtime.transport.invokeHook("content:afterSave", { collection: "pages", content: { id } }),
		);
		expect(m.calls.length).toBe(8);
		expect(m.calls).not.toContain("settingsSet");
	});

	it("content:afterDelete", async () => {
		const runtime = await start();
		const id = await savedWithLinkRemoved(runtime);
		const m = await cold(runtime, "content:afterDelete", () =>
			runtime.transport.invokeHook("content:afterDelete", { collection: "pages", id }),
		);
		expect(m.calls.length).toBe(1);
	});

	it("content:afterSave for a collection that does not exist", async () => {
		const runtime = await start();
		await runtime.transport.invokeHook("plugin:activate", {});
		const m = await cold(runtime, "content:afterSave unknown collection", () =>
			runtime.transport.invokeHook("content:afterSave", {
				collection: "nope",
				content: { id: "x" },
			}),
		);
		// The content read throws; the warning is logged, and the log is a call too.
		expect(m.calls.length).toBe(3);
		expect(m.calls.at(-1)).toBe("log");
	});
});

describe("routes: the Site Health page", () => {
	it("first load on a fresh site: the Admin starts the email list", async () => {
		const runtime = await start();
		await runtime.transport.invokeHook("plugin:activate", {});
		const m = await cold(runtime, "page load fresh", () => runtime.admin.loadPage(PAGE));
		expect(m.calls.length).toBe(4);
		expect((await runtime.inspect.setting<Options>("options"))?.recipients).toHaveLength(1);
	});

	it("first load before any check (the scheduler never ran activate)", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		const m = await cold(runtime, "page load no check", () => runtime.admin.loadPage(PAGE));
		expect(m.calls.length).toBe(8);
		expect((await scanOf(runtime))?.phase).toBe("walk");
	});

	it("Refresh moves a running check one step, each phase", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		const counts = print(
			"refresh",
			await phaseByPhase(runtime, () => runtime.admin.act(PAGE, "refresh")),
		);
		// The cron step's calls plus one: the Admin's list of links marked as fine.
		expect(Object.keys(counts)).toEqual(PHASES);
		expect(counts.walk).toBe(7);
		expect(counts.resolve).toBe(7);
		expect(counts["live-home"]).toBe(7);
		expect(counts["live-pages"]).toBe(8);
		expect(counts["live-paths"]).toBe(7);
		expect(counts.checklist).toBe(9);
		expect(counts.sweep).toBe(5);
		expect(counts.count).toBe(9);
		expect(counts.freeze).toBe(7);
	});

	it("a page load moves a stalled check one step, each phase", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		const counts = print(
			"page load stalled",
			await phaseByPhase(
				runtime,
				() => runtime.admin.loadPage(PAGE),
				() => stall(runtime),
			),
		);
		expect(Object.keys(counts)).toEqual(PHASES);
		expect(counts.checklist).toBe(9);
		expect(counts.count).toBe(9);
		expect(counts.freeze).toBe(7);
	});

	for (const phase of ["checklist", "count", "freeze"] as const) {
		it(`upgraded from 0.1.2, stalled at ${phase}: the first load copies the settings, the next moves the check`, async () => {
			const runtime = await start();
			await ownSite(runtime);
			await runtime.transport.invokeHook("plugin:activate", {});
			await runUntil(runtime, phase);
			await stall(runtime);
			await asUpgraded(runtime);
			const m = await cold(runtime, `page load stalled ${phase} upgraded`, () =>
				runtime.admin.loadPage(PAGE),
			);
			expect(m.calls).toEqual(["kvList", "settingsSet", "storageQuery"]);
			expect(await runtime.inspect.setting("options")).toEqual(SAVED);
			const before = await scanOf(runtime);
			expect(before?.phase).toBe(phase);
			const next = await cold(runtime, `page load stalled ${phase} after the copy`, () =>
				runtime.admin.loadPage(PAGE),
			);
			expect(next.calls).not.toContain("settingsSet");
			expect((await scanOf(runtime))?.lastStepAt).not.toBe(before?.lastStepAt);
		});
	}

	it("enforced: the upgraded load at the last step keeps everything; the next load finishes", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runUntil(runtime, "freeze");
		await stall(runtime);
		await asUpgraded(runtime);
		const m = await cold(
			runtime,
			"page load stalled freeze upgraded (enforced)",
			() => runtime.admin.loadPage(PAGE),
			true,
		);
		expect(m.refused).toEqual([]);
		expect(m.error).toBeUndefined();
		expect(await runtime.inspect.setting("options")).toEqual(SAVED);
		const again = await cold(
			runtime,
			"page load after (enforced)",
			() => runtime.admin.loadPage(PAGE),
			true,
		);
		expect(again.refused).toEqual([]);
		expect(again.error).toBeUndefined();
		// The last step takes two runs.
		await stall(runtime);
		const last = await cold(
			runtime,
			"page load after that (enforced)",
			() => runtime.admin.loadPage(PAGE),
			true,
		);
		expect(last.refused).toEqual([]);
		expect(last.error).toBeUndefined();
		const scan = await scanOf(runtime);
		expect(scan?.status).toBe("done");
		expect(scan?.ops).toBe(last.calls.length - 1);
		expect(await runtime.inspect.kv.get("summary")).not.toBeNull();
		expect((await runtime.inspect.kv.get<Alerts>("alerts"))?.pending).toHaveLength(1);
	});

	it("enforced: Refresh on the last step after an upgrade, the same", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runUntil(runtime, "freeze");
		await asUpgraded(runtime);
		const m = await cold(
			runtime,
			"refresh freeze upgraded (enforced)",
			() => runtime.admin.act(PAGE, "refresh"),
			true,
		);
		expect(m.calls).toEqual(["kvList", "settingsSet", "storageQuery"]);
		expect(m.refused).toEqual([]);
		expect(m.error).toBeUndefined();
		const again = await cold(
			runtime,
			"refresh after (enforced)",
			() => runtime.admin.act(PAGE, "refresh"),
			true,
		);
		expect(again.refused).toEqual([]);
		expect(again.error).toBeUndefined();
		const last = await cold(
			runtime,
			"refresh after that (enforced)",
			() => runtime.admin.act(PAGE, "refresh"),
			true,
		);
		expect(last.refused).toEqual([]);
		expect(last.error).toBeUndefined();
		expect((await scanOf(runtime))?.status).toBe("done");
		expect(await runtime.inspect.kv.get("summary")).not.toBeNull();
		expect((await runtime.inspect.kv.get<Alerts>("alerts"))?.pending).toHaveLength(1);
		expect(await runtime.inspect.setting("options")).toEqual(SAVED);
	});

	it("the widget moves a stalled check too", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runUntil(runtime, "freeze");
		await stall(runtime);
		const m = await cold(runtime, "widget stalled freeze", () =>
			runtime.admin.loadWidget("site-health"),
		);
		expect(m.calls.length).toBe(6);
		await stall(runtime);
		const last = await cold(runtime, "widget stalled freeze, second half", () =>
			runtime.admin.loadWidget("site-health"),
		);
		expect(last.calls.length).toBe(5);
		expect((await scanOf(runtime))?.status).toBe("done");
	});

	it("the widget, stalled, first load after an upgrade from 0.1.2: no copy, the check moves", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runUntil(runtime, "checklist");
		await stall(runtime);
		await asUpgraded(runtime);
		const m = await cold(runtime, "widget stalled checklist upgraded", () =>
			runtime.admin.loadWidget("site-health"),
		);
		expect(m.calls.length).toBe(8);
		expect(m.calls).not.toContain("settingsSet");
		expect((await scanOf(runtime))?.phase).toBe("sweep");
	});

	it("an Editor's load of a stalled check", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runUntil(runtime, "checklist");
		await stall(runtime);
		const editor = await runtime.fixtures.user({ email: "sam@acme.test", role: "editor" });
		const m = await cold(runtime, "editor load stalled checklist", () =>
			runtime.admin.loadPage(PAGE, { user: editor }),
		);
		// Editors do not see the list of links marked as fine.
		expect(m.calls.length).toBe(8);
	});
});

async function finished(runtime: PluginRuntimeTestHost): Promise<void> {
	await runtime.fixtures.plugin.setting("options", SAVED);
	await ownSite(runtime);
	await runtime.transport.invokeHook("plugin:activate", {});
	await finish(runtime);
}

describe("routes: actions on a finished check", () => {
	it("a plain load", async () => {
		const runtime = await start();
		await finished(runtime);
		const m = await cold(runtime, "page load done", () => runtime.admin.loadPage(PAGE));
		expect(m.calls.length).toBe(2);
	});

	it("check everything again", async () => {
		const runtime = await start();
		await finished(runtime);
		const m = await cold(runtime, "check_all", () => runtime.admin.act(PAGE, "check_all"));
		expect(m.calls.length).toBe(8);
		expect((await scanOf(runtime))?.status).toBe("running");
	});

	it("check everything again, first action after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		await finished(runtime);
		await asUpgraded(runtime);
		const m = await cold(runtime, "check_all upgraded", () => runtime.admin.act(PAGE, "check_all"));
		expect(m.calls.length).toBe(9);
	});

	it("check one link to another site again (HEAD refused, then GET)", async () => {
		const runtime = await start();
		await finished(runtime);
		const id = idFor("external", "https://gone.example/rye");
		// It was broken; it answers now, so the summary changes too.
		const row = await runtime.inspect.storage.get<LinkRow>("links", id);
		await runtime.fixtures.plugin.storage("links", id, {
			...row,
			state: "broken",
			reason: "gone",
			group: "link",
			since: LONG_AGO,
		});
		runtime.http.clear();
		await runtime.http.respond("https://gone.example/rye", new Response(null, { status: 405 }));
		await runtime.http.respond("https://gone.example/rye", new Response("back", { status: 200 }));
		// Not listed until checked once, so "Check again" in the list would not find it; the
		// Checklist's check_fine button takes any row and runs the same check.
		const m = await cold(runtime, "check external", () =>
			runtime.admin.act(PAGE, "check_fine", { value: id }),
		);
		expect(m.calls.length).toBe(7);
		expect(m.calls.filter((c) => c === "httpFetch")).toHaveLength(2);
		expect(m.result?.toast?.message).toBe("Works now. gone.example/rye is off the list.");
	});

	it("check one missing page of this site again", async () => {
		const runtime = await start();
		await finished(runtime);
		await runtime.http.respond(`${SITE}/old-page`, html("Back again"));
		const id = idFor("internal", "/old-page");
		const m = await cold(runtime, "fix check internal", () =>
			runtime.admin.act(PAGE, "fix", { value: `check|${id}` }),
		);
		expect(m.calls.length).toBe(7);
		expect(m.result?.toast?.message).toBe("Works now. /old-page is off the list.");
	});

	it("check an insecure item again (re-reads its entry)", async () => {
		const runtime = await start();
		await finished(runtime);
		const id = idFor("insecure", "http://maps.example/embed");
		const m = await cold(runtime, "fix check insecure", () =>
			runtime.admin.act(PAGE, "fix", { value: `check|${id}` }),
		);
		expect(m.calls.length).toBe(5);
	});

	it("check a link marked as fine again (Checklist tab)", async () => {
		const runtime = await start();
		await finished(runtime);
		const id = idFor("internal", "/christmas");
		await runtime.admin.act(PAGE, "fix", { value: `fine|${id}` });
		const m = await cold(runtime, "check_fine", () =>
			runtime.admin.act(PAGE, "check_fine", { value: id }),
		);
		expect(m.calls.length).toBe(6);
	});

	it("mark as fine", async () => {
		const runtime = await start();
		await finished(runtime);
		const id = idFor("internal", "/christmas");
		const m = await cold(runtime, "fix fine", () =>
			runtime.admin.act(PAGE, "fix", { value: `fine|${id}` }),
		);
		expect(m.calls.length).toBe(5);
	});

	it("open the redirect form, the menus panel, the edit panel, more rows, close", async () => {
		const runtime = await start();
		await finished(runtime);
		const id = idFor("internal", "/old-page");
		const form = await cold(runtime, "fix redirect form", () =>
			runtime.admin.act(PAGE, "fix", { value: `redirect|${id}` }),
		);
		expect(form.calls.length).toBe(2);
		const menu = idFor("internal", "/menu-2024");
		const menus = await cold(runtime, "fix menus", () =>
			runtime.admin.act(PAGE, "fix", { value: `menus|${menu}` }),
		);
		expect(menus.calls.length).toBe(2);
		const edit = await cold(runtime, "fix edit", () =>
			runtime.admin.act(PAGE, "fix", { value: `edit0|${id}` }),
		);
		expect(edit.calls.length).toBe(2);
		const more = await cold(runtime, "more_link", () =>
			runtime.admin.act(PAGE, "more_link", { value: { cursor: "start" } }),
		);
		expect(more.calls.length).toBe(3);
		const close = await cold(runtime, "close", () => runtime.admin.act(PAGE, "close"));
		expect(close.calls.length).toBe(2);
	});

	it("send visitors to another page", async () => {
		const runtime = await start();
		await finished(runtime);
		const id = idFor("internal", "/old-page");
		const m = await cold(runtime, "add_redirect", () =>
			runtime.admin.submit(PAGE, `add_redirect|${id}`, {
				source: "/old-page",
				destination: "/about",
			}),
		);
		expect(m.calls.length).toBe(8);
		expect(m.result?.toast?.message).toBe("Done. /old-page now goes to /about.");
	});

	it("send visitors to another page, first action after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		await finished(runtime);
		await asUpgraded(runtime);
		const id = idFor("internal", "/old-page");
		const m = await cold(runtime, "add_redirect upgraded", () =>
			runtime.admin.submit(PAGE, `add_redirect|${id}`, {
				source: "/old-page",
				destination: "/about",
			}),
		);
		expect(m.calls.length).toBe(9);
	});

	it("send visitors away from a live page: refused", async () => {
		const runtime = await start();
		await finished(runtime);
		const id = idFor("internal", "/old-page");
		const m = await cold(runtime, "add_redirect refused", () =>
			runtime.admin.submit(PAGE, `add_redirect|${id}`, { source: "/about", destination: "/" }),
		);
		expect(m.calls.length).toBe(3);
	});

	it("send a test email", async () => {
		const runtime = await start();
		await finished(runtime);
		const m = await cold(runtime, "send_test", () => runtime.admin.act(PAGE, "send_test"));
		expect(m.calls.length).toBe(4);
		expect(m.result?.toast?.type).toBe("success");
	});

	it("save the options", async () => {
		const runtime = await start();
		await finished(runtime);
		const m = await cold(runtime, "save_options", () =>
			runtime.admin.submit(PAGE, "save_options", { recipients: "a@acme.test", outbound: false }),
		);
		expect(m.calls.length).toBe(4);
		expect(await runtime.inspect.setting("options")).toEqual({
			recipients: ["a@acme.test"],
			outbound: false,
		});
	});

	it("save the options, first action after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		await finished(runtime);
		await asUpgraded(runtime);
		const m = await cold(runtime, "save_options upgraded", () =>
			runtime.admin.submit(PAGE, "save_options", { recipients: "a@acme.test", outbound: false }),
		);
		expect(m.calls.length).toBe(5);
	});

	it("hide the help line (the switch under Options)", async () => {
		const runtime = await start();
		await finished(runtime);
		const m = await cold(runtime, "save_help_line", () =>
			runtime.admin.submit(PAGE, "save_help_line", { hide_help_line: true }),
		);
		// The same one settings write as saving the options.
		expect(m.calls.length).toBe(4);
		expect(await runtime.inspect.setting("options")).toMatchObject({ hideHelpLine: true });
	});
});
