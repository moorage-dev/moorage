// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// B39: pins how many calls to the host (subrequests) each Site Health invocation makes in its
// worst realistic state, counted at the real PluginBridge by tests/bridge-budget.ts. On Cloudflare
// a sandboxed invocation may make 10; the 11th and every later call throw. src/budget.ts counts
// only some services (not ctx.log), so these numbers, not `scan.ops`, are the truth.
//
// Every count is exact (`toBe`), so a change that adds or removes a call shows up here. Each
// measurement starts on a cold isolate (`host.restart()`): settings are not kept in memory then.
// Paths at 10 (no room left) or over are marked TODO(B39); the enforced tests show what Cloudflare
// does to the ones over: which calls are refused, and what is left saved.

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
		expect(m.calls.length).toBe(8);
		expect((await scanOf(runtime))?.phase).toBe("walk");
		expect(m.nested).toEqual([]);
		// src/budget.ts's own count misses the first cron.schedule, made on the uncounted ctx.
		expect((await scanOf(runtime))?.ops).toBe(7);
	});

	it("a site upgraded from 0.1.2 also copies its settings", async () => {
		const runtime = await start();
		await asUpgraded(runtime);
		const m = await cold(runtime, "activate upgraded", () =>
			runtime.transport.invokeHook("plugin:activate", {}),
		);
		expect(m.calls.length).toBe(9);
		expect(await runtime.inspect.setting("options")).toEqual(SAVED);
		expect((await scanOf(runtime))?.phase).toBe("walk");
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
		// The summary, the alert for the broken menu link, the check.
		expect(counts.freeze).toBe(9);
		expect((await runtime.inspect.kv.get<Alerts>("alerts"))?.pending).toHaveLength(1);
		expect((await runtime.inspect.kv.get<Summary>("summary"))?.rows.site.length).toBe(1);
	});

	it("each phase, when it is the first run after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await asUpgraded(runtime);
		const first = await cold(runtime, "cron start upgraded", () => cron(runtime));
		expect(first.calls.length).toBe(8);
		const counts = print(
			"cron upgraded",
			await phaseByPhase(
				runtime,
				() => cron(runtime),
				() => asUpgraded(runtime),
			),
		);
		expect(Object.keys(counts)).toEqual(PHASES);
		expect(counts.walk).toBe(7);
		expect(counts.resolve).toBe(7);
		expect(counts["live-home"]).toBe(7);
		expect(counts["live-pages"]).toBe(8);
		expect(counts["live-paths"]).toBe(7);
		expect(counts.checklist).toBe(9);
		expect(counts.sweep).toBe(5);
		expect(counts.count).toBe(9);
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		expect(counts.freeze).toBe(10);
	});

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
		// Nothing new to alert about: no alerts write.
		expect(counts.freeze).toBe(8);
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
	// Both other sites turn HEAD away, so each wants a GET as well; the budget allows one.
	await runtime.http.respond("https://gone.example/rye", new Response(null, { status: 404 }));
	await runtime.http.respond("https://gone.example/rye", new Response(null, { status: 404 }));
	await runtime.http.respond(
		"https://linkedin.com/company/acme",
		new Response(null, { status: 403 }),
	);
	await runtime.http.respond(
		"https://linkedin.com/company/acme",
		new Response(null, { status: 403 }),
	);
	return id;
}

describe("hooks: cron, what is due between checks", () => {
	it("three checks, one retried with GET, a page newly broken: summary, alert and queue saved", async () => {
		const runtime = await start();
		const id = await dueState(runtime);
		const m = await cold(runtime, "cron due", () => cron(runtime));
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		expect(m.calls.length).toBe(10);
		expect(m.calls.filter((c) => c === "httpFetch")).toHaveLength(4);
		// Here src/budget.ts agrees with the bridge.
		expect((await runtime.inspect.kv.get<Queue>("queue"))?.ops).toBe(10);
		expect(await runtime.inspect.storage.get<LinkRow>("links", id)).toMatchObject({
			state: "broken",
			reason: "page-error",
		});
		const alerts = await runtime.inspect.kv.get<Alerts>("alerts");
		expect(alerts?.pending.map((a) => a.id)).toContain(id);
	});

	it("the same, as the first run after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		const id = await dueState(runtime);
		await asUpgraded(runtime);
		const m = await cold(runtime, "cron due upgraded", () => cron(runtime));
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		expect(m.calls.length).toBe(11);
		expect(await runtime.inspect.storage.get<LinkRow>("links", id)).toMatchObject({
			state: "broken",
		});
	});

	it("enforced: the upgraded run loses its queue write; the next run carries on", async () => {
		const runtime = await start();
		const id = await dueState(runtime);
		await asUpgraded(runtime);
		const before = await runtime.inspect.kv.get<Queue>("queue");
		const m = await cold(runtime, "cron due upgraded (enforced)", () => cron(runtime), true);
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		expect(m.calls.length).toBe(11);
		expect(m.refused).toEqual(["kvSet"]);
		expect(String(m.error)).toContain(TOO_MANY);
		// Saved: the settings copy, the checked rows, the summary and the alert. Lost: the queue,
		// so the hosts just asked are not remembered and may be asked again within the minute.
		expect(await runtime.inspect.setting("options")).toEqual(SAVED);
		expect(await runtime.inspect.storage.get<LinkRow>("links", id)).toMatchObject({
			state: "broken",
		});
		expect((await runtime.inspect.kv.get<Alerts>("alerts"))?.pending.map((a) => a.id)).toContain(
			id,
		);
		expect(await runtime.inspect.kv.get<Queue>("queue")).toEqual(before);
		const next = await cold(runtime, "cron due after (enforced)", () => cron(runtime), true);
		expect(next.error).toBeUndefined();
		expect(next.calls.length).toBeLessThanOrEqual(SANDBOX_SUBREQUESTS);
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
			expect(m.calls.length).toBe(9);
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
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		expect(m.calls.length).toBe(10);
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

	it("load and Refresh move a stalled check one step, each phase", async () => {
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
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		expect(counts.freeze).toBe(10);
	});

	it("Refresh, each phase, when it is the first action after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		const counts = print(
			"refresh upgraded",
			await phaseByPhase(
				runtime,
				() => runtime.admin.act(PAGE, "refresh"),
				() => asUpgraded(runtime),
			),
		);
		expect(Object.keys(counts)).toEqual(PHASES);
		expect(counts.walk).toBe(8);
		expect(counts.resolve).toBe(8);
		expect(counts["live-home"]).toBe(8);
		expect(counts["live-pages"]).toBe(9);
		expect(counts["live-paths"]).toBe(8);
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		expect(counts.checklist).toBe(10);
		expect(counts.sweep).toBe(6);
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		expect(counts.count).toBe(10);
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		expect(counts.freeze).toBe(11);
	});

	it("a stalled check at its last step, first load after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runUntil(runtime, "freeze");
		await stall(runtime);
		await asUpgraded(runtime);
		const m = await cold(runtime, "page load stalled freeze upgraded", () =>
			runtime.admin.loadPage(PAGE),
		);
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		expect(m.calls.length).toBe(11);
		expect((await scanOf(runtime))?.status).toBe("done");
		// src/budget.ts records 10: the list of links marked as fine is read after it writes.
		expect((await scanOf(runtime))?.ops).toBe(10);
	});

	it("enforced: the upgraded load finishes the check but the page fails to show", async () => {
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
		expect(m.refused).toEqual(["storageQuery"]);
		expect(String(m.error)).toContain(TOO_MANY);
		expect((await scanOf(runtime))?.status).toBe("done");
		expect(await runtime.inspect.kv.get("summary")).not.toBeNull();
		const again = await cold(runtime, "page load after (enforced)", () =>
			runtime.admin.loadPage(PAGE),
		);
		expect(again.error).toBeUndefined();
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
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		expect(m.calls.length).toBe(11);
		expect(m.refused).toEqual(["storageQuery"]);
		expect(String(m.error)).toContain(TOO_MANY);
		// The check finished and its results, alert and settings copy were saved; only the
		// answer to the Admin was lost (an error instead of the page).
		const scan = await scanOf(runtime);
		expect(scan?.status).toBe("done");
		expect(scan?.ops).toBe(10);
		expect(await runtime.inspect.kv.get("summary")).not.toBeNull();
		expect((await runtime.inspect.kv.get<Alerts>("alerts"))?.pending).toHaveLength(1);
		expect(await runtime.inspect.setting("options")).toEqual(SAVED);
		const again = await cold(
			runtime,
			"refresh after (enforced)",
			() => runtime.admin.act(PAGE, "refresh"),
			true,
		);
		expect(again.error).toBeUndefined();
		expect(again.calls.length).toBe(2);
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
		expect(m.calls.length).toBe(9);
	});

	it("the widget, stalled, first load after an upgrade from 0.1.2", async () => {
		const runtime = await start();
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runUntil(runtime, "freeze");
		await stall(runtime);
		await asUpgraded(runtime);
		const m = await cold(runtime, "widget stalled freeze upgraded", () =>
			runtime.admin.loadWidget("site-health"),
		);
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		expect(m.calls.length).toBe(10);
	});

	it("an Editor's load of a stalled check", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		await ownSite(runtime);
		await runtime.transport.invokeHook("plugin:activate", {});
		await runUntil(runtime, "freeze");
		await stall(runtime);
		const editor = await runtime.fixtures.user({ email: "sam@acme.test", role: "editor" });
		const m = await cold(runtime, "editor load stalled freeze", () =>
			runtime.admin.loadPage(PAGE, { user: editor }),
		);
		expect(m.calls.length).toBe(9);
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
});
