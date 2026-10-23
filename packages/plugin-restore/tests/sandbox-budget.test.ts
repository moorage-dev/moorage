// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// B39: calls to the host per sandboxed invocation, counted on the real sandbox bridge.
//
// On Cloudflare each hook call, route call and cron run may make 10 calls to the host (see
// bridge-budget.ts); every ctx.* call counts (kv, settings, storage, email, cron, ctx.log) and so
// does every ctx.http.fetch to api.cloudflare.com, which this plugin makes for every query on the
// site's database. The 11th call throws. These tests pin the CURRENT number of calls of every
// path, measured on a cold isolate, so any change shows up here. They are a record, not a target:
// a number above 9 is marked TODO(B39) and explained in the B39 audit; lowering it is product
// work. The "on Cloudflare" tests run the same path with the limit enforced and pin what a site
// is left with.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { PluginBridge } from "@emdash-cms/plugin-test/worker";
import { afterEach, describe, expect, it } from "vitest";

import {
	createSimulatedCloudflare,
	type SimulatedCloudflare,
} from "../test-support/simulated-cloudflare.mjs";
import { describeCalls, measure, TOO_MANY, type Measured } from "./bridge-budget.js";
import { ago, sql } from "./helpers.js";

const PAGE = "/restore";

// The key setting is a secret, which EmDash encrypts with the site's EMDASH_ENCRYPTION_KEY (a real
// site has one); the harness has none, so give it one or every write of the key fails.
const keyBytes = crypto.getRandomValues(new Uint8Array(32));
process.env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${btoa(String.fromCharCode(...keyBytes))
	.replaceAll("+", "-")
	.replaceAll("/", "_")
	.replace(/=+$/, "")}`;

// ------------------------------------------------------------------ Cloudflare behind the bridge

// The harness answers a plugin's request only from responses queued per URL, but every query on
// the site's database goes to the same URL with a different SQL body, several at once. So the
// bridge's own httpFetch (capability and host checks, wire format) runs without the harness's
// transport and fetches with globalThis.fetch, which hands api.cloudflare.com to the simulated
// Cloudflare (it runs each query on the test site's real database). This sits underneath
// bridge-budget's counter (installed on the first measure), so each request is still counted
// once, and a request the counter refuses never reaches Cloudflare.
type AnyFn = (...args: unknown[]) => unknown;
const proto = PluginBridge.prototype as unknown as Record<string | symbol, AnyFn | boolean>;
if (proto[Symbol.for("moorage.bridgeBudget")])
	throw new Error("bridge-budget is already installed: the Cloudflare stand-in would go uncounted");
const bridgeHttpFetch = proto.httpFetch as AnyFn;

interface Site {
	host: PluginRuntimeTestHost;
	sim: SimulatedCloudflare;
	/** Answer the next matching request differently: a response, or an error for no answer. */
	fail?: { match: (url: string) => boolean; with: () => Response | Error; times: number };
}
let site: Site | undefined;

proto.httpFetch = function (this: { ctx: { props: Record<string, unknown> } }, ...args: unknown[]) {
	if (!site) return bridgeHttpFetch.apply(this, args);
	// The same bridge method, minus the harness's transport: it then fetches with globalThis.fetch.
	const self = Object.create(this, {
		ctx: { value: { ...this.ctx, props: { ...this.ctx.props, httpFetchKey: undefined } } },
	}) as unknown;
	return bridgeHttpFetch.apply(self, args);
};

const workerFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const href = input instanceof Request ? input.url : String(input);
	const current = site;
	if (!current || !href.startsWith("https://api.cloudflare.com/")) return workerFetch(input, init);
	const fail = current.fail;
	if (fail && fail.times > 0 && fail.match(href)) {
		fail.times--;
		const answer = fail.with();
		if (answer instanceof Error) throw answer;
		return answer;
	}
	return current.sim.fetch(input, init);
};

// ------------------------------------------------------------------ test site

afterEach(async () => {
	await site?.host.dispose();
	site = undefined;
});

interface Seeded extends Site {
	admin: { id: string; email: string; name: string | null; role: number; createdAt: string };
}

const DAY = 24;

/** A site on Cloudflare with two collections, an administrator, and Restore not yet set up. */
async function start(otherDatabases: string[] = []): Promise<Seeded> {
	const host = await createPluginRuntimeTestHost({
		site: { name: "Rosie's Bakery", url: "https://rosies.test", locale: "en" },
	});
	for (const [slug, label, singular] of [
		["pages", "Pages", "Page"],
		["products", "Products", "Product"],
	] as const) {
		await host.fixtures.collection({
			slug,
			label,
			labelSingular: singular,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
	}
	const sim = createSimulatedCloudflare({
		exec: (statement, params) => sql(statement, params),
		accountName: "Rosie's Bakery",
		siteDatabase: "rosies-bakery",
		otherDatabases,
	});
	const created = await host.fixtures.user({
		email: "rosie@rosiesbakery.test",
		name: "Rosie",
		role: "admin",
	});
	// Everything before "now" happened well before the moments the tests go back to.
	await sql("UPDATE _emdash_migrations SET timestamp = ?", [ago(10)]);
	await sql("UPDATE users SET created_at = ?, updated_at = ?", [ago(48), ago(48)]);
	site = { host, sim };
	return { host, sim, admin: { ...created, role: 50, createdAt: ago(48) } };
}

/** Restore set up a day ago with a working key, and one person to email. */
async function connected(s: Seeded, overrides: Record<string, unknown> = {}, key = "good-key") {
	await s.host.fixtures.plugin.setting("token", key);
	await s.host.fixtures.plugin.setting("connection", {
		accountId: s.sim.account.id,
		accountName: s.sim.account.name,
		databaseId: s.sim.site.uuid,
		databaseName: s.sim.site.name,
		setupAt: ago(DAY),
		windowDays: 30,
		reach: [{ name: s.sim.site.name, account: s.sim.account.name, isSite: true }],
		zone: "UTC",
		zoneSet: false,
		expiresOn: null,
		lastCheck: { at: ago(1), ok: true },
		...overrides,
	});
	await s.host.fixtures.plugin.setting("emails", ["rosie@rosiesbakery.test"]);
}

/** Two edits since setup, and the list of people already taken (as after any earlier page load). */
async function edited(s: Seeded) {
	await s.host.fixtures.content("pages", { slug: "about", data: { title: "About" } });
	await s.host.fixtures.content("products", { slug: "loaf", data: { title: "Loaf" } });
	await act(s, "back");
}

/** The worst case for any screen: the time zone and the people changed since the last look. */
async function changedSinceLastLook(s: Seeded) {
	await sql("INSERT INTO options (name, value) VALUES ('site:timezone', ?)", [
		JSON.stringify("Europe/London"),
	]);
	await s.host.fixtures.user({ email: "maria@rosiesbakery.test", name: "Maria", role: "editor" });
}

function act(s: Seeded, actionId: string, value?: unknown) {
	return s.host.admin.act(PAGE, actionId, {
		user: s.admin,
		...(value === undefined ? {} : { value }),
	});
}

function submit(s: Seeded, actionId: string, values: Record<string, unknown>) {
	return s.host.admin.submit(PAGE, actionId, values, { user: s.admin });
}

function cron(s: Seeded) {
	return s.host.transport.invokeHook("cron", { name: "daily", data: {}, scheduledAt: ago(0) });
}

/** Cold isolate, then exactly one invocation. */
async function cold<T>(s: Seeded, invoke: () => Promise<T>, enforce = false): Promise<Measured<T>> {
	await s.host.restart();
	return measure(invoke, { enforce });
}

/** Print the calls and pin their number. */
function pin(label: string, m: Measured<unknown>, count: number): void {
	console.info(describeCalls(label, m));
	if (m.error) console.info(`  error: ${String(m.error)}`);
	expect(m.calls.length).toBe(count);
}

function text(m: Measured<unknown>): string {
	return JSON.stringify((m.result as { blocks?: unknown } | undefined)?.blocks ?? null);
}

/** A review of the moment two hours ago, ticked, ready for the red button. */
async function reviewed(s: Seeded): Promise<string> {
	const at = ago(2);
	await act(s, "pick", { at, from: at, to: at, who: null, collection: null, what: "Loaf edited" });
	await act(s, "understand", ["yes"]);
	return at;
}

/** A restore made an hour ago, back to three hours ago. */
async function pastRestore(s: Seeded) {
	const record = {
		id: "r1",
		at: ago(1),
		to: ago(3),
		byId: s.admin.id,
		byName: "Rosie",
		result: "done",
		undoPoint: s.sim.bookmarkFor(Date.now() - 3_600_000),
		undoTo: ago(1),
		tookMs: 1000,
	};
	await s.host.fixtures.plugin.storage("restores", record.id, record);
	return record;
}

async function savedMoment(s: Seeded) {
	await s.host.fixtures.plugin.storage("moments", "m1", {
		name: "Before the menu import",
		at: ago(2),
		byName: "Rosie",
	});
}

const kv = <T>(s: Seeded, key: string) => s.host.inspect.kv.get<T>(key);
const setting = <T>(s: Seeded, key: string) => s.host.inspect.setting<T>(key);
const leadRows = () =>
	sql("SELECT count(*) AS n FROM _plugin_storage WHERE plugin_id = 'lead-delivery'");

/** Answer every request to Cloudflare that matches with `answer` instead. */
function failing(match: (url: string) => boolean, answer: () => Response | Error) {
	if (site) site.fail = { match, with: answer, times: 1000 };
}

const serverError = () =>
	Response.json(
		{ success: false, errors: [{ code: 7500, message: "Internal error" }] },
		{ status: 500 },
	);
const noAnswer = () => new Error("network connection lost");

// ------------------------------------------------------------------ paths

interface Run {
	s: Seeded;
	m: Measured<unknown>;
}

/**
 * One path: seed a site, then restart the isolate and run exactly one invocation, with or without
 * Cloudflare's limit. The unlimited run pins the count; the enforced run pins what a site is left
 * with on Cloudflare.
 */
function path(
	seed: (s: Seeded) => Promise<() => Promise<unknown>>,
	otherDatabases: string[] = [],
): (enforce?: boolean) => Promise<Run> {
	return async (enforce = false) => {
		const s = await start(otherDatabases);
		const invoke = await seed(s);
		const m = await cold(s, invoke, enforce);
		return { s, m };
	};
}

const weekOld = { lastCheck: { at: ago(8 * DAY), ok: true } };
const pickValue = (at: string) => ({
	at,
	from: at,
	to: at,
	who: null,
	collection: null,
	what: "Loaf (product) added",
});
const loadAsAdmin = (s: Seeded) => () => s.host.admin.loadPage(PAGE, { user: s.admin });

function timeTwoHoursAgo() {
	const at = new Date(Date.now() - 2 * 3_600_000);
	return {
		day: at.toISOString().slice(0, 10),
		hour: String(at.getUTCHours()),
		minute: String(Math.floor(at.getUTCMinutes() / 5) * 5),
	};
}

const paths = {
	weeklyWorking: path(async (s) => {
		await connected(s, weekOld);
		return () => cron(s);
	}),
	weeklyRefused: path(async (s) => {
		await connected(s, weekOld, "refused-key");
		return () => cron(s);
	}),
	weeklyExpiring: path(async (s) => {
		await connected(s, weekOld);
		s.sim.state.expiresOn = new Date(Date.now() + 5 * 86_400_000).toISOString();
		return () => cron(s);
	}),
	connect: path(async (s) => () => submit(s, "connect", { key: "good-key" })),
	connectFourDatabases: path(
		async (s) => {
			// Cloudflare lists this site's database last, so every other one is searched first.
			failing(
				(url) => url.includes("/d1/database?"),
				() =>
					Response.json({
						success: true,
						errors: [],
						result: [...s.sim.others, s.sim.site].map(({ uuid, name }) => ({ uuid, name })),
					}),
			);
			return () => submit(s, "connect", { key: "good-key" });
		},
		["shop", "blog", "staging"],
	),
	connectReplacing: path(async (s) => {
		await connected(s);
		return () => submit(s, "connect", { key: "good-key-2" });
	}),
	main: path(async (s) => {
		await connected(s);
		await edited(s);
		return loadAsAdmin(s);
	}),
	mainWorst: path(async (s) => {
		await connected(s);
		await edited(s);
		await savedMoment(s);
		await pastRestore(s);
		await changedSinceLastLook(s);
		return loadAsAdmin(s);
	}),
	checkNow: path(async (s) => {
		await connected(s);
		await edited(s);
		return () => act(s, "check_now");
	}),
	saveEmails: path(async (s) => {
		await connected(s);
		await edited(s);
		return () => submit(s, "save_emails", { emails: "a@rosies.test" });
	}),
	saveEmailsInvalid: path(async (s) => {
		await connected(s);
		await edited(s);
		return () => submit(s, "save_emails", { emails: "nope" });
	}),
	saveMoment: path(async (s) => {
		await connected(s);
		await edited(s);
		return () => submit(s, "save_moment", { name: "Before the import" });
	}),
	saveMomentNoName: path(async (s) => {
		await connected(s);
		await edited(s);
		return () => submit(s, "save_moment", { name: " " });
	}),
	pick: path(async (s) => {
		await connected(s);
		await edited(s);
		await changedSinceLastLook(s);
		return () => act(s, "pick", pickValue(ago(2)));
	}),
	pickTime: path(async (s) => {
		await connected(s);
		await edited(s);
		return () => submit(s, "pick_time", timeTwoHoursAgo());
	}),
	pickTimeNoDay: path(async (s) => {
		await connected(s);
		await edited(s);
		return () => submit(s, "pick_time", { day: "", hour: "0", minute: "0" });
	}),
	pickMoment: path(async (s) => {
		await connected(s);
		await edited(s);
		await savedMoment(s);
		return () => act(s, "pick_moment", "m1");
	}),
	restore: path(async (s) => {
		await connected(s);
		await edited(s);
		await savedMoment(s);
		const at = await reviewed(s);
		return () => act(s, "restore", { at });
	}),
	restoreNoReview: path(async (s) => {
		await connected(s);
		await edited(s);
		return () => act(s, "restore", { at: ago(2) });
	}),
	restoreServerError: path(async (s) => {
		await connected(s);
		await edited(s);
		await savedMoment(s);
		const at = await reviewed(s);
		s.sim.state.failNextRestore = "error";
		return () => act(s, "restore", { at });
	}),
	restoreUnconfirmed: path(async (s) => {
		await connected(s);
		await edited(s);
		await savedMoment(s);
		const at = await reviewed(s);
		s.sim.state.failNextRestore = "timeout";
		// After the restore's answer is lost, the site's database can't be read either.
		failing(
			(url) =>
				url.endsWith("/query") &&
				s.sim.state.calls.some((c) => c.path.includes("/time_travel/restore")),
			serverError,
		);
		return () => act(s, "restore", { at });
	}),
	undoReview: path(async (s) => {
		await connected(s);
		await edited(s);
		const record = await pastRestore(s);
		return () => act(s, "undo", { point: record.undoPoint, to: record.undoTo, of: record.id });
	}),
	undoQuiet: path(async (s) => {
		await connected(s);
		await act(s, "back");
		const record = await pastRestore(s);
		return () => act(s, "undo", { point: record.undoPoint, to: record.undoTo, of: record.id });
	}),
	confirmWentBack: path(async (s) => {
		await connected(s);
		await act(s, "back");
		const record = { ...(await pastRestore(s)), id: "r2", at: ago(0.5), result: "unconfirmed" };
		await s.host.fixtures.plugin.kv("lock", { byId: s.admin.id, byName: "Rosie", at: ago(0.05) });
		// The marker is gone from the database: the restore went through.
		await s.host.fixtures.plugin.kv("pending", { record, marker: "marker-from-before" });
		return () => act(s, "confirm_check", { id: "r2" });
	}),
	putBack: path(async (s) => {
		await connected(s);
		await act(s, "back");
		const rows = Array.from({ length: 40 }, (_, i) => ({
			plugin_id: "lead-delivery",
			collection: "deliveries",
			id: `d${i}`,
			data: JSON.stringify({ i }),
			created_at: ago(1),
			updated_at: ago(1),
		}));
		await s.host.fixtures.plugin.kv("carry", { restoreId: "r1", rows });
		return () => act(s, "put_back");
	}),
};

const tooMany = (m: Measured<unknown>) => String(m.error ?? "");
type Connection = { lastCheck: { at: string; ok: boolean; problem?: string } };

// ------------------------------------------------------------------ hooks

describe("hooks", () => {
	it("plugin:activate schedules the daily run", async () => {
		const s = await start();
		const m = await cold(s, () => s.host.transport.invokeHook("plugin:activate", {}));
		pin("plugin:activate", m, 1);
		expect(m.calls).toEqual(["cronSchedule"]);
	});

	it("cron for another task name does nothing", async () => {
		const s = await start();
		const m = await cold(s, () =>
			s.host.transport.invokeHook("cron", { name: "other", data: {}, scheduledAt: ago(0) }),
		);
		pin("cron other", m, 0);
	});

	it("daily cron on a site that never set Restore up", async () => {
		const s = await start();
		const m = await cold(s, () => cron(s));
		pin("cron daily, not set up", m, 2);
		expect(s.sim.state.calls).toHaveLength(0);
	});

	it("daily cron, people unchanged", async () => {
		const s = await start();
		await connected(s);
		await act(s, "back");
		const m = await cold(s, () => cron(s));
		pin("cron daily, people unchanged", m, 4);
	});

	it("daily cron, people changed", async () => {
		const s = await start();
		await connected(s);
		const m = await cold(s, () => cron(s));
		pin("cron daily, people changed", m, 5);
		expect(await kv<unknown[]>(s, "people")).toHaveLength(1);
	});

	it("weekly check, key still works", async () => {
		const { s, m } = await paths.weeklyWorking();
		// TODO(B39): 13 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("cron weekly check, working", m, 13);
		const connection = await setting<Connection>(s, "connection");
		expect(connection?.lastCheck.ok).toBe(true);
		expect(Date.parse(connection?.lastCheck.at ?? "")).toBeGreaterThan(Date.now() - 60_000);
	});

	it("weekly check, key stopped working: emails the owner", async () => {
		const { s, m } = await paths.weeklyRefused();
		// TODO(B39): 12 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("cron weekly check, key refused", m, 12);
		expect(await s.host.inspect.email()).toHaveLength(1);
	});

	it("weekly check, key expires within 14 days: emails the owner", async () => {
		const { s, m } = await paths.weeklyExpiring();
		// TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("cron weekly check, key expiring", m, 17);
		expect(await s.host.inspect.email()).toHaveLength(1);
	});

	it("weekly check, Cloudflare not answering", async () => {
		const s = await start();
		await connected(s, weekOld);
		failing(() => true, noAnswer);
		const m = await cold(s, () => cron(s));
		pin("cron weekly check, no answer", m, 8);
		expect((await setting<Connection>(s, "connection"))?.lastCheck.problem).toBe("network");
		expect(await s.host.inspect.email()).toHaveLength(0);
	});

	it("weekly check, Cloudflare answers 500", async () => {
		const s = await start();
		await connected(s, weekOld);
		failing(() => true, serverError);
		const m = await cold(s, () => cron(s));
		pin("cron weekly check, 500", m, 8);
		expect(await s.host.inspect.email()).toHaveLength(0);
	});
});

// ------------------------------------------------------------------ the page before setup

describe("page, not set up", () => {
	it("setup screen", async () => {
		const s = await start();
		const m = await cold(s, loadAsAdmin(s));
		pin("load, not set up", m, 1);
		expect(text(m)).toContain("Connect (once)");
	});

	it("editor, not set up", async () => {
		const s = await start();
		const editor = await s.host.fixtures.user({
			email: "e@rosies.test",
			name: "Ed",
			role: "editor",
		});
		const m = await cold(s, () => s.host.admin.loadPage(PAGE, { user: editor }));
		pin("load as editor, not set up", m, 1);
		expect(text(m)).toContain("Only an administrator");
	});

	it("instructions for the web person", async () => {
		const s = await start();
		const m = await cold(s, () => act(s, "web_person"));
		pin("web_person", m, 1);
		expect(text(m)).toContain("Instructions for your web person");
	});

	it("not on Cloudflare", async () => {
		const s = await start();
		const m = await cold(s, () => act(s, "not_cloudflare"));
		pin("not_cloudflare", m, 1);
		expect(text(m)).toContain("isn't available on this site");
	});

	it("connect with no key", async () => {
		const s = await start();
		const m = await cold(s, () => submit(s, "connect", { key: "" }));
		pin("connect, empty key", m, 1);
		expect(text(m)).toContain("did not accept that key");
	});

	it("connect with a key Cloudflare refuses", async () => {
		const s = await start();
		const m = await cold(s, () => submit(s, "connect", { key: "refused-key" }));
		pin("connect, key refused", m, 2);
		expect(await setting(s, "token")).toBeNull();
	});

	it("connect with a key that may not see databases", async () => {
		const s = await start();
		const m = await cold(s, () => submit(s, "connect", { key: "no-d1-key" }));
		pin("connect, no D1 access", m, 3);
		expect(text(m)).toContain("can't put sites back");
	});

	it("connect with a key for another account", async () => {
		const s = await start(["other-site"]);
		const m = await cold(s, () => submit(s, "connect", { key: "elsewhere-key" }));
		pin("connect, site not found", m, 5);
		expect(text(m)).toContain("couldn't find this site's data");
	});

	it("connect when Cloudflare does not answer", async () => {
		const s = await start();
		failing(() => true, noAnswer);
		const m = await cold(s, () => submit(s, "connect", { key: "good-key" }));
		pin("connect, no answer", m, 2);
		expect(text(m)).toContain("Cloudflare did not answer");
	});

	it("connect with a key that works", async () => {
		const { s, m } = await paths.connect();
		// TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("connect, works", m, 17);
		expect(text(m)).toContain("Connected");
		expect(await setting(s, "connection")).not.toBeNull();
	});

	it("connect with a key that reaches four databases, this site's last", async () => {
		const { m } = await paths.connectFourDatabases();
		// TODO(B39): 20 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("connect, four databases", m, 20);
		expect(text(m)).toContain("This key can change 4 sites");
	});
});

// ------------------------------------------------------------------ the page once set up

describe("page, set up", () => {
	it("editor asks an administrator", async () => {
		const s = await start();
		await connected(s);
		const editor = await s.host.fixtures.user({
			email: "e@rosies.test",
			name: "Ed",
			role: "editor",
		});
		const m = await cold(s, () => s.host.admin.loadPage(PAGE, { user: editor }));
		pin("load as editor, set up", m, 3);
		expect(text(m)).toContain("Ask Rosie");
	});

	it("main page, nothing changed since the last look", async () => {
		const { m } = await paths.main();
		// TODO(B39): 16 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("load, set up", m, 16);
		expect(text(m)).toContain("About (page) added");
	});

	it("main page, worst case: zone and people changed, a moment and a restore listed", async () => {
		const { m } = await paths.mainWorst();
		// TODO(B39): 18 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("load, set up, worst", m, 18);
		expect(text(m)).toContain("Before the menu import");
	});

	it("main page when Cloudflare does not answer", async () => {
		const s = await start();
		await connected(s);
		await edited(s);
		failing(() => true, noAnswer);
		const m = await cold(s, loadAsAdmin(s));
		pin("load, set up, no answer", m, 7);
		expect(text(m)).toContain("couldn't read the recent changes");
	});

	it("replace the key: the form", async () => {
		const s = await start();
		await connected(s);
		const m = await cold(s, () => act(s, "replace_key"));
		pin("replace_key", m, 1);
		expect(text(m)).toContain("Replace the key");
	});

	it("replace the key: a new key that works", async () => {
		const { s, m } = await paths.connectReplacing();
		// TODO(B39): 15 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("connect, replacing", m, 15);
		// Saved encrypted, so it no longer reads as the old plain fixture value.
		expect(await setting(s, "token")).not.toBe("good-key");
	});

	it("disconnect", async () => {
		const s = await start();
		await connected(s);
		const m = await cold(s, () => act(s, "disconnect"));
		pin("disconnect", m, 3);
		expect(await setting(s, "connection")).toBeNull();
	});

	it("check now", async () => {
		const { m } = await paths.checkNow();
		// TODO(B39): 24 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("check_now", m, 24);
		expect(text(m)).toContain("Working");
	});

	it("save emails", async () => {
		const { s, m } = await paths.saveEmails();
		// TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("save_emails", m, 17);
		expect(await setting(s, "emails")).toEqual(["a@rosies.test"]);
	});

	it("save emails, not an address", async () => {
		const { m } = await paths.saveEmailsInvalid();
		// TODO(B39): 16 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("save_emails, invalid", m, 16);
		expect(JSON.stringify(m.result)).toContain("isn't an email address");
	});

	it("save a moment", async () => {
		const { s, m } = await paths.saveMoment();
		// TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("save_moment", m, 17);
		expect(await s.host.inspect.storage.list("moments")).toHaveLength(1);
	});

	it("save a moment with no name", async () => {
		const { m } = await paths.saveMomentNoName();
		// TODO(B39): 16 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("save_moment, no name", m, 16);
		expect(JSON.stringify(m.result)).toContain("Give the moment a name first");
	});
});

// ------------------------------------------------------------------ review

describe("review", () => {
	it("pick a change from the list (worst: zone and people changed)", async () => {
		const { s, m } = await paths.pick();
		// TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("pick", m, 21);
		expect(text(m)).toContain("Changes undone");
		expect(await kv(s, "review")).not.toBeNull();
	});

	it("pick a time", async () => {
		const { m } = await paths.pickTime();
		// TODO(B39): 19 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("pick_time", m, 19);
		expect(text(m)).toContain("Changes undone");
	});

	it("pick a time with no day", async () => {
		const { m } = await paths.pickTimeNoDay();
		// TODO(B39): 18 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("pick_time, no day", m, 18);
		expect(JSON.stringify(m.result)).toContain("Pick a day first");
	});

	it("pick a saved moment", async () => {
		const { m } = await paths.pickMoment();
		// TODO(B39): 20 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("pick_moment", m, 20);
		expect(text(m)).toContain("Changes undone");
	});

	it("pick a moment before setup: refused", async () => {
		const s = await start();
		await connected(s);
		const m = await cold(s, () => act(s, "pick", pickValue(ago(30))));
		pin("pick, before setup", m, 4);
		expect(text(m)).toContain("can't go back that far");
	});

	it("tick the box", async () => {
		const s = await start();
		await connected(s);
		await edited(s);
		await act(s, "pick", pickValue(ago(2)));
		const m = await cold(s, () => act(s, "understand", ["yes"]));
		pin("understand", m, 3);
		expect(text(m)).toContain("Put the site back to");
	});

	it("enquiries reached us", async () => {
		const s = await start();
		await connected(s);
		await edited(s);
		await act(s, "pick", pickValue(ago(2)));
		const m = await cold(s, () => act(s, "enquiries_ok"));
		pin("enquiries_ok", m, 3);
		expect((await kv<{ ack: boolean }>(s, "review"))?.ack).toBe(true);
	});
});

// ------------------------------------------------------------------ restore, undo, check

describe("restore", () => {
	it("put the site back", async () => {
		const { s, m } = await paths.restore();
		// TODO(B39): 34 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("restore", m, 34);
		expect(s.sim.state.restores).toHaveLength(1);
		expect(text(m)).toContain("Done. Your site is back");
		expect(await s.host.inspect.email()).toHaveLength(1);
	});

	it("put the site back with a stale review", async () => {
		const { s, m } = await paths.restoreNoReview();
		// TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("restore, no review", m, 17);
		expect(s.sim.state.restores).toHaveLength(0);
		expect(JSON.stringify(m.result)).toContain("Review the moment again first");
	});

	it("put the site back while another restore runs: refused", async () => {
		const s = await start();
		await connected(s);
		await edited(s);
		const at = await reviewed(s);
		await s.host.fixtures.plugin.kv("lock", { byId: "x", byName: "Maria", at: ago(0.01) });
		const m = await cold(s, () => act(s, "restore", { at }));
		pin("restore, locked", m, 8);
		expect(text(m)).toContain("already running");
	});

	it("Cloudflare refuses the restore (500): nothing changed", async () => {
		const { s, m } = await paths.restoreServerError();
		// TODO(B39): 23 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("restore, Cloudflare 500", m, 23);
		expect(text(m)).toContain("was not put back");
		expect(await kv(s, "lock")).toBeNull();
	});

	it("Cloudflare stops answering mid-restore: unconfirmed", async () => {
		const { s, m } = await paths.restoreUnconfirmed();
		// TODO(B39): 23 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("restore, unconfirmed", m, 23);
		expect(text(m)).toContain("couldn't confirm");
		expect(await kv(s, "pending")).not.toBeNull();
	});

	it("undo with changes since: review first", async () => {
		const { m } = await paths.undoReview();
		// TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("undo, review", m, 17);
		expect(text(m)).toContain("Undo the restore and go back");
	});

	it("undo on a quiet site: straight back", async () => {
		const { s, m } = await paths.undoQuiet();
		// TODO(B39): 46 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("undo, quiet", m, 46);
		expect(s.sim.state.restores).toHaveLength(1);
		expect(text(m)).toContain("Done. Your site is back");
	});

	it("check an unconfirmed restore: it went back", async () => {
		const { s, m } = await paths.confirmWentBack();
		// TODO(B39): 24 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("confirm_check, went back", m, 24);
		expect(text(m)).toContain("Done. Your site is back");
		expect(await kv(s, "pending")).toBeNull();
	});

	it("check an unconfirmed restore: it did not go back", async () => {
		const s = await start();
		await connected(s);
		await act(s, "back");
		const record = { ...(await pastRestore(s)), id: "r2", result: "unconfirmed" };
		await s.host.fixtures.plugin.kv("marker", "marker-still-here");
		await s.host.fixtures.plugin.kv("pending", { record, marker: "marker-still-here" });
		const m = await cold(s, () => act(s, "confirm_check", { id: "r2" }));
		pin("confirm_check, did not go back", m, 9);
		expect(text(m)).toContain("did not go back");
	});

	it("put back 40 Lead Delivery records", async () => {
		const { s, m } = await paths.putBack();
		// TODO(B39): 23 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("put_back, 40 rows", m, 23);
		expect(await leadRows()).toEqual([{ n: 40 }]);
		expect((await kv<{ rows: unknown[] }>(s, "carry"))?.rows).toHaveLength(0);
	});
});

// ------------------------------------------------------------------ on Cloudflare

// The same paths with the limit enforced: the 11th call and every call after it is refused, as
// Worker Loader does. Each test pins where it stops and what the site is left with.
describe("on Cloudflare (limit enforced)", () => {
	it("weekly check, key still works: never records the check, so it runs again every day", async () => {
		const { s, m } = await paths.weeklyWorking(true);
		pin("ENFORCED cron weekly check, working", m, 12);
		expect(m.refused).toEqual(["httpFetch", "settingsSet"]);
		expect(tooMany(m)).toContain(TOO_MANY);
		const connection = await setting<Connection>(s, "connection");
		expect(Date.parse(connection?.lastCheck.at ?? "")).toBeLessThan(Date.now() - 7 * 86_400_000);
	});

	it("weekly check, key stopped working: the warning email is never sent", async () => {
		const { s, m } = await paths.weeklyRefused(true);
		pin("ENFORCED cron weekly check, key refused", m, 12);
		expect(m.refused).toEqual(["emailSend", "log"]);
		expect(await s.host.inspect.email()).toHaveLength(0);
		// The page does show "Restore has stopped working".
		expect((await setting<Connection>(s, "connection"))?.lastCheck).toMatchObject({
			ok: false,
			problem: "refused",
		});
	});

	it("weekly check, key expiring: the warning email is never sent", async () => {
		const { s, m } = await paths.weeklyExpiring(true);
		pin("ENFORCED cron weekly check, key expiring", m, 12);
		expect(await s.host.inspect.email()).toHaveLength(0);
	});

	it("connect: the key is saved but the connection is not, so setup never finishes", async () => {
		const { s, m } = await paths.connect(true);
		pin("ENFORCED connect, works", m, 11);
		expect(m.refused).toEqual(["settingsSet"]);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await setting(s, "token")).not.toBeNull();
		expect(await setting(s, "connection")).toBeNull();
	});

	it("connect, four databases", async () => {
		const { s, m } = await paths.connectFourDatabases(true);
		pin("ENFORCED connect, four databases", m, 12);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await setting(s, "connection")).toBeNull();
	});

	it("replace the key", async () => {
		const { s, m } = await paths.connectReplacing(true);
		pin("ENFORCED connect, replacing", m, 11);
		expect(m.refused).toEqual(["settingsSet"]);
		// The new key is saved, the connection (and its reach) is not.
		expect(await setting(s, "token")).not.toBe("good-key");
	});

	it("main page: does not load", async () => {
		const { m } = await paths.main(true);
		pin("ENFORCED load, set up", m, 12);
		expect(tooMany(m)).toContain(TOO_MANY);
	});

	it("main page, worst case: does not load", async () => {
		const { m } = await paths.mainWorst(true);
		pin("ENFORCED load, set up, worst", m, 14);
		expect(tooMany(m)).toContain(TOO_MANY);
	});

	it("check now", async () => {
		const { s, m } = await paths.checkNow(true);
		pin("ENFORCED check_now", m, 13);
		expect(tooMany(m)).toContain(TOO_MANY);
		// The check itself is saved; the page that shows it fails.
		expect((await setting<Connection>(s, "connection"))?.lastCheck.ok).toBe(true);
	});

	it("save emails", async () => {
		const { s, m } = await paths.saveEmails(true);
		pin("ENFORCED save_emails", m, 13);
		expect(tooMany(m)).toContain(TOO_MANY);
		// Saved, but the admin sees an error instead of "Emails saved".
		expect(await setting(s, "emails")).toEqual(["a@rosies.test"]);
	});

	it("save emails, invalid", async () => {
		const { m } = await paths.saveEmailsInvalid(true);
		pin("ENFORCED save_emails, invalid", m, 12);
		expect(tooMany(m)).toContain(TOO_MANY);
	});

	it("save a moment", async () => {
		const { s, m } = await paths.saveMoment(true);
		pin("ENFORCED save_moment", m, 13);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await s.host.inspect.storage.list("moments")).toHaveLength(1);
	});

	it("save a moment with no name", async () => {
		const { m } = await paths.saveMomentNoName(true);
		pin("ENFORCED save_moment, no name", m, 12);
		expect(tooMany(m)).toContain(TOO_MANY);
	});

	it("pick", async () => {
		const { s, m } = await paths.pick(true);
		pin("ENFORCED pick", m, 13);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await kv(s, "review")).toBeNull();
	});

	it("pick a time", async () => {
		const { s, m } = await paths.pickTime(true);
		pin("ENFORCED pick_time", m, 17);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await kv(s, "review")).toBeNull();
	});

	it("pick a time with no day", async () => {
		const { m } = await paths.pickTimeNoDay(true);
		pin("ENFORCED pick_time, no day", m, 14);
		expect(tooMany(m)).toContain(TOO_MANY);
	});

	it("pick a saved moment", async () => {
		const { s, m } = await paths.pickMoment(true);
		pin("ENFORCED pick_moment", m, 18);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await kv(s, "review")).toBeNull();
	});

	it("restore: Cloudflare is never asked, and the lock is left behind", async () => {
		const { s, m } = await paths.restore(true);
		pin("ENFORCED restore", m, 13);
		expect(m.refused).toEqual(["settingsGet", "kvDelete", "settingsGet"]);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(s.sim.state.restores).toHaveLength(0);
		expect(await kv(s, "lock")).not.toBeNull();
	});

	it("restore with a stale review", async () => {
		const { m } = await paths.restoreNoReview(true);
		pin("ENFORCED restore, no review", m, 13);
		expect(tooMany(m)).toContain(TOO_MANY);
	});

	it("restore, Cloudflare 500", async () => {
		const { s, m } = await paths.restoreServerError(true);
		pin("ENFORCED restore, Cloudflare 500", m, 13);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(s.sim.state.restores).toHaveLength(0);
		expect(await kv(s, "lock")).not.toBeNull();
	});

	it("restore, unconfirmed", async () => {
		const { s, m } = await paths.restoreUnconfirmed(true);
		pin("ENFORCED restore, unconfirmed", m, 13);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(s.sim.state.calls.some((c) => c.path.includes("/time_travel/restore"))).toBe(false);
		expect(await kv(s, "lock")).not.toBeNull();
	});

	it("undo with changes since", async () => {
		const { s, m } = await paths.undoReview(true);
		pin("ENFORCED undo, review", m, 15);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await kv(s, "review")).toBeNull();
	});

	it("undo on a quiet site: nothing is undone", async () => {
		const { s, m } = await paths.undoQuiet(true);
		pin("ENFORCED undo, quiet", m, 15);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(s.sim.state.restores).toHaveLength(0);
		expect(await kv(s, "lock")).toBeNull();
	});

	it("check an unconfirmed restore: never finishes, so Check fails every time", async () => {
		const { s, m } = await paths.confirmWentBack(true);
		pin("ENFORCED confirm_check, went back", m, 13);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await kv(s, "pending")).not.toBeNull();
		expect(await kv(s, "lock")).not.toBeNull();
		expect(await s.host.inspect.storage.list("restores")).toHaveLength(1);
	});

	it("put back records: written, but the page fails", async () => {
		const { s, m } = await paths.putBack(true);
		pin("ENFORCED put_back, 40 rows", m, 12);
		expect(tooMany(m)).toContain(TOO_MANY);
		expect(await leadRows()).toEqual([{ n: 40 }]);
		expect((await kv<{ rows: unknown[] }>(s, "carry"))?.rows).toHaveLength(0);
	});
});
