// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// B39: subrequests per sandboxed invocation, counted on the real sandbox wrapper.
//
// On Cloudflare each sandboxed hook call, route call (every admin page load and action) and cron
// run may make at most 10 calls to the host (SANDBOX_SUBREQUESTS); every ctx.* call, logging
// included, is one. The 11th and every later call throw "Too many subrequests by single Worker
// invocation". Nothing enforces this locally, so bridge-budget.ts counts the RPCs.
//
// Every hook and route path is PINNED at its exact count in its worst realistic state (cold
// isolate: host.restart() before each measure), and every pin is also checked to be 9 or fewer:
// one call is always spare. `before` is what 0.3.1 made on the same path (B39 audit). The
// enforced section runs paths with Cloudflare's limit on, to show that nothing is refused:
// the access of one-click connect is always revoked before anything is written, every enquiry
// is stored with its log rows, and a backlog is delivered once, a few per run, every run within
// the limit.
//
// Not reached: a failing ctx.email.send. The test host's email transport never fails, and a send
// this plugin's own email:beforeSend cancels resolves without an error.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { Config, Delivery, Enquiry, KnownForm, Send } from "../src/types.js";
import { describeCalls, measure, SANDBOX_SUBREQUESTS, type Measured } from "./bridge-budget.js";

type Host = PluginRuntimeTestHost;
type User = Awaited<ReturnType<Host["fixtures"]["user"]>>;

const PAGE = "/enquiries";
const ORIGIN = "https://crumb.test";
const KEY = "K".repeat(32);
const HOOK = "https://hooks.zapier.com/hooks/catch/123/abc/";
const HOOK2 = "https://hook.eu1.make.com/abcdefg";
const HUBSPOT =
	"https://api.hsforms.com/submissions/v3/integration/submit/4410287/9f1c2b3a-1111-2222-3333-444455556666";
const PING = `${ORIGIN}/_emdash/api/plugins/lead-delivery/ping`;
const CODE = `${ORIGIN}/_emdash/api/oauth/device/code`;
const TOKEN = `${ORIGIN}/_emdash/api/oauth/device/token`;
const REVOKE = `${ORIGIN}/_emdash/api/oauth/token/revoke`;
const LIST = `${ORIGIN}/_emdash/api/plugins/emdash-forms/forms/list`;
const UPDATE = `${ORIGIN}/_emdash/api/plugins/emdash-forms/forms/update`;
const DAY = 86_400_000;
const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const today = () => now().slice(0, 10);

const zap: Delivery = {
	id: "zapdeliver",
	kind: "app",
	name: "Contact us → Zapier",
	forms: ["contact"],
	on: true,
	repeat: "off",
	holdSpam: false,
	createdAt: "2026-10-20T00:00:00.000Z",
	app: "zapier",
	url: HOOK,
	secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0",
};
const make: Delivery = {
	...zap,
	id: "makedelive",
	name: "Contact us → Make",
	app: "make",
	url: HOOK2,
};
const hub: Delivery = {
	id: "hubdeliver",
	kind: "hubspot",
	name: "Contact us → HubSpot",
	forms: ["contact"],
	on: true,
	repeat: "off",
	holdSpam: false,
	createdAt: "2026-10-20T00:00:00.000Z",
	portalId: "4410287",
	formGuid: "9f1c2b3a-1111-2222-3333-444455556666",
};
const mail: Delivery = {
	id: "maildelive",
	kind: "email",
	name: "Contact us → orders@crumb.test",
	forms: ["contact"],
	on: true,
	repeat: "off",
	holdSpam: false,
	createdAt: "2026-10-20T00:00:00.000Z",
	to: ["orders@crumb.test"],
};

const CONFIG: Config = {
	version: 2,
	deliveries: [],
	alertTo: ["anna@crumb.test"],
	key: KEY,
	keySetAt: "2026-10-01T00:00:00.000Z",
};

const CONTACT: KnownForm = {
	slug: "contact",
	name: "Contact us",
	fields: [
		{ key: "name", label: "Your name" },
		{ key: "email", label: "Email" },
		{ key: "message", label: "Message" },
	],
	source: "definition",
	addedAt: "2026-10-01T00:00:00.000Z",
	days: [],
	connectedAt: "2026-10-02T00:00:00.000Z",
	connectedWay: "straight",
};

const ok = () => new Response("ok", { status: 200 });
const fails = () => new Response("down", { status: 500 });
const refused = () =>
	Response.json(
		{
			errors: [
				{ errorType: "FIELD_NOT_IN_FORM_DEFINITION", message: 'Property "message" does not exist' },
			],
		},
		{ status: 400 },
	);

let host: Host | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function newHost(): Promise<Host> {
	host = await createPluginRuntimeTestHost({
		site: { name: "Crumb & Co.", url: ORIGIN, locale: "en" },
	});
	return host;
}

/**
 * A site that has been running this release: settings saved, mirrored to the old KV keys, and
 * the every-minute task running (it ran a minute ago).
 */
async function running(
	deliveries: Delivery[] = [zap],
	extra: Partial<Config> = {},
	forms: Record<string, KnownForm> = { contact: CONTACT },
): Promise<Host> {
	const h = await newHost();
	const config = { ...CONFIG, deliveries, ...extra };
	await h.fixtures.plugin.setting("config", config);
	await h.fixtures.plugin.kv("config", config);
	await h.fixtures.plugin.setting("forms", forms);
	await h.fixtures.plugin.kv("forms", forms);
	await h.fixtures.plugin.kv("schedule", "* * * * *");
	await h.fixtures.plugin.kv("origin", ORIGIN);
	await h.fixtures.plugin.kv("tick", ago(60_000));
	return h;
}

/** Right after updating from 0.3.0: the old KV keys only, nothing under settings. */
async function justUpdated(deliveries: Delivery[] = [zap]): Promise<Host> {
	const h = await newHost();
	await h.fixtures.plugin.kv("config", { ...CONFIG, deliveries });
	await h.fixtures.plugin.kv("forms", { contact: CONTACT });
	await h.fixtures.plugin.kv("schedule", "* * * * *");
	await h.fixtures.plugin.kv("origin", ORIGIN);
	await h.fixtures.plugin.kv("tick", ago(60_000));
	return h;
}

const users = new WeakMap<Host, { admin: User; editor: User }>();

async function people(h: Host) {
	const have = users.get(h);
	if (have) return have;
	const admin = await h.fixtures.user({
		email: "anna@crumb.test",
		name: "Anna Baker",
		role: "admin",
	});
	const editor = await h.fixtures.user({ email: "eve@crumb.test", name: "Eve Ed", role: "editor" });
	const both = { admin, editor };
	users.set(h, both);
	return both;
}

function enquiry(extra: Partial<Enquiry> = {}): Enquiry {
	return {
		formId: "contact",
		formName: "Contact us",
		receivedAt: now(),
		fields: [{ key: "name", label: "Your name", value: "Tom Reyes" }],
		name: "Tom Reyes",
		email: "tom@example.com",
		via: "web",
		throwaway: false,
		hasFiles: false,
		...extra,
	};
}

/** One enquiry and its log row for `delivery`. */
async function row(
	h: Host,
	id: string,
	destination: string,
	extra: Partial<Send> = {},
	stored: Partial<Enquiry> = {},
) {
	await h.fixtures.plugin.storage("enquiries", id, enquiry(stored));
	const data: Send = {
		enquiryId: id,
		formId: "contact",
		formName: "Contact us",
		who: "Tom Reyes",
		email: "tom@example.com",
		destination,
		status: "retrying",
		nextAt: ago(60_000),
		attempts: 1,
		createdAt: now(),
		notes: [],
		...extra,
	};
	await h.fixtures.plugin.storage("deliveries", `${id}~${destination}`, data);
}

async function sendRows(h: Host) {
	return (await h.inspect.storage.list<Send>("deliveries"))
		.map((r) => r.data)
		.filter((r) => !r.test);
}

function payload(id: string, data: Record<string, unknown> = {}) {
	return {
		event: "form.submission",
		formId: "contact",
		formName: "Contact us",
		submissionId: id,
		data: { name: "Tom Reyes", email: "tom@example.com", message: "Hello", ...data },
		files: [],
		submittedAt: now(),
	};
}

const inbound =
	(h: Host, body: unknown, key = KEY) =>
	async () => {
		const response = await h.actions.routes.request("inbound", {
			method: "POST",
			url: `${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${key}`,
			body,
		});
		return { status: response.status, text: await response.text() };
	};

const PRIVATE = `enquiries-${KEY}@lead-delivery.invalid`;
const FORM_EMAIL =
	'New submission for "Contact us"\n\nYour name: Tom Reyes\nEmail: tom@example.com\nMessage: Hello\n\nSubmitted at: 2026-10-16T09:00:00.000Z';

const emailWay =
	(h: Host, message: Record<string, unknown>, source = "emdash-forms") =>
	() =>
		h.transport.invokeHook("email:beforeSend", { source, message });

const page = (h: Host, user: User) => () => h.admin.loadPage(PAGE, { user });

type Invoke = () => Promise<unknown>;

/** Seed, restart (cold isolate), measure one invocation. */
async function cold(h: Host, invoke: Invoke, enforce = false): Promise<Measured<unknown>> {
	await h.restart();
	return measure(invoke, { enforce });
}

function log(label: string, m: Measured<unknown>) {
	const error = m.error ? ` | error: ${String(m.error).slice(0, 160)}` : "";
	console.info(`${describeCalls(label, m)}${error}`);
}

/** Calls a path may make: Cloudflare allows 10, and the plugin keeps one spare. */
const BUDGET = SANDBOX_SUBREQUESTS - 1;

interface Case {
	/** The path and the state it runs in. */
	name: string;
	setup: () => Promise<{ h: Host; invoke: Invoke }>;
	/** What the path did. */
	did?: (h: Host, m: Measured<unknown>) => Promise<void>;
	/** Calls to the host in that one invocation, cold isolate. */
	count: number;
	/** What 0.3.1 made on the same path (B39 audit), where it was measured. */
	before?: number;
	/** Calls made by this plugin's own hooks the host ran meanwhile (separate invocations). */
	nested?: number;
}

function run(cases: Case[]) {
	for (const c of cases) {
		it(c.name, async () => {
			const { h, invoke } = await c.setup();
			const m = await cold(h, invoke);
			log(`${c.name}${c.before !== undefined ? ` (0.3.1: ${c.before})` : ""}`, m);
			await c.did?.(h, m);
			expect(m.nested.length).toBe(c.nested ?? 0);
			expect(m.calls.length).toBe(c.count);
			expect(m.calls.length).toBeLessThanOrEqual(BUDGET);
		});
	}
}

const statuses = async (h: Host) => (await sendRows(h)).map((r) => r.status).sort();
const formEmail = { to: PRIVATE, subject: "New submission: Contact us", text: FORM_EMAIL };

/** Run each one-shot task as EmDash's scheduler does, one per tick, until none is due. */
async function runQueued(h: Host, { enforce = false, max = 40 } = {}): Promise<number[]> {
	const counts: number[] = [];
	for (let n = 0; n < max; n++) {
		const at = new Date(Date.now() + 5_000);
		const tasks = (await h.inspect.scheduledTasks()) as Array<{ name: string; nextRunAt: string }>;
		const due = tasks.filter((t) => Date.parse(t.nextRunAt) <= at.getTime());
		if (due.length === 0) return counts;
		expect(due, "one task due at a time").toHaveLength(1);
		h.scheduled.setTime(at);
		const m = await measure(() => h.scheduled.run(), { enforce });
		log(`run ${n + 1} (${due[0]!.name.split("-")[0]})`, m);
		expect(m.error).toBeUndefined();
		expect(m.refused).toEqual([]);
		expect(m.calls.length).toBeLessThanOrEqual(BUDGET);
		counts.push(m.calls.length);
	}
	throw new Error(`still running after ${max} runs`);
}

// ─── Hooks ───────────────────────────────────────────────────────────

describe("plugin:activate", () => {
	run([
		{
			name: "activate, fresh site",
			setup: async () => {
				const h = await newHost();
				return { h, invoke: () => h.transport.invokeHook("plugin:activate", {}) };
			},
			did: async (h) => {
				expect((await h.inspect.setting<Config>("config"))?.key).toHaveLength(32);
				expect(await h.inspect.kv.get("schedule")).toBe("* * * * *");
			},
			count: 5,
			before: 9,
		},
		{
			name: "activate, just updated from 0.3.0",
			setup: async () => {
				const h = await justUpdated();
				return { h, invoke: () => h.transport.invokeHook("plugin:activate", {}) };
			},
			did: async (h) => expect((await h.inspect.setting<Config>("config"))?.key).toBe(KEY),
			count: 5,
			before: 5,
		},
	]);
});

/** The enquiry arrived and is waiting for a run: stored, with its log rows. */
async function isStored(h: Host, rows: string[]) {
	expect(await statuses(h)).toEqual(rows);
	const kept = (await h.inspect.storage.list<Enquiry>("enquiries")).filter((e) => !e.data.cleared);
	expect(kept.length).toBeGreaterThan(0);
}

describe("email:beforeSend", () => {
	run([
		{
			name: "beforeSend, an email to someone else",
			setup: async () => {
				const h = await running([mail]);
				return { h, invoke: emailWay(h, { to: "anna@crumb.test", subject: "Hi", text: "Hello" }) };
			},
			did: async (_h, m) => expect(m.result).toMatchObject({ to: "anna@crumb.test" }),
			count: 0,
			before: 0,
		},
		{
			name: "beforeSend, an email copied to the private domain",
			setup: async () => {
				const h = await running([mail]);
				const message = { to: "anna@crumb.test", cc: [PRIVATE], subject: "Hi", text: "Hello" };
				return { h, invoke: emailWay(h, message) };
			},
			did: async (_h, m) => expect(m.result).toMatchObject({ cc: [] }),
			count: 0,
			before: 0,
		},
		{
			name: "beforeSend, a stray email to the private domain",
			setup: async () => {
				const h = await running([mail]);
				const stray = { to: "enquiries-old@lead-delivery.invalid", subject: "x", text: "y" };
				return { h, invoke: emailWay(h, stray, "someone") };
			},
			did: async (_h, m) => expect(m.result).toBe(false),
			count: 0,
			before: 1,
		},
		{
			name: "beforeSend, the email way, running site, one email delivery",
			setup: async () => {
				const h = await running([mail]);
				return { h, invoke: emailWay(h, formEmail) };
			},
			did: async (h, m) => {
				expect(m.result).toBe(false);
				await isStored(h, ["retrying"]);
			},
			count: 6,
			before: 11,
		},
		{
			name: "beforeSend, the email way, three deliveries for the form",
			setup: async () => {
				const h = await running([mail, zap, hub]);
				return { h, invoke: emailWay(h, formEmail) };
			},
			did: async (h) => isStored(h, ["retrying", "retrying", "retrying"]),
			count: 6,
			before: 11,
		},
		{
			name: "beforeSend, the email way, first enquiry after updating from 0.3.0",
			setup: async () => {
				const h = await justUpdated([mail]);
				return { h, invoke: emailWay(h, formEmail) };
			},
			// Stored with its log row (0.3.1 lost it here); the settings are copied by the admin page.
			did: async (h) => {
				await isStored(h, ["retrying"]);
				expect(await h.inspect.setting("config")).toBeNull();
			},
			count: 6,
			before: 15,
		},
		{
			name: "beforeSend, the email way, fields cannot be read",
			setup: async () => {
				const h = await running([mail]);
				return { h, invoke: emailWay(h, { ...formEmail, text: "garbled" }) };
			},
			// Recorded as text under a form id of its own, so no delivery takes it: "Not sent".
			did: async (h) => {
				await isStored(h, ["skipped"]);
				expect(await h.inspect.kv.get("unreadable")).toBeTruthy();
			},
			count: 6,
			before: 11,
		},
		{
			name: "beforeSend, the email way, the same person again within 7 days",
			setup: async () => {
				const h = await running([mail]);
				await row(h, "earlier", mail.id, {
					status: "delivered",
					nextAt: "",
					createdAt: ago(3_600_000),
				});
				return { h, invoke: emailWay(h, formEmail) };
			},
			did: async (h) => expect(await statuses(h)).toEqual(["delivered", "retrying"]),
			count: 6,
			before: 11,
		},
	]);
});

/** A running site with `n` enquiries waiting for a try through `delivery`, due now. */
async function dueRows(
	delivery: Delivery,
	n: number,
	answer?: () => Response,
	extra: Partial<Send> = {},
	deliveries: Delivery[] = [delivery],
) {
	const h = await running(deliveries);
	for (let i = 1; i <= n; i++) {
		await row(h, `s${i}`, delivery.id, extra, { rows: deliveries.map((d) => d.id) });
		if (answer) await h.http.respond(delivery.kind === "hubspot" ? HUBSPOT : HOOK, answer());
	}
	return h;
}

const DELIVER = { name: "deliver", data: null };
const deliverRun =
	(h: Host, event: { name: string; data: unknown } = DELIVER) =>
	() =>
		h.transport.invokeHook("cron", event);

describe("cron deliver", () => {
	const deliver = (h: Host) => ({ h, invoke: deliverRun(h) });
	run([
		{
			name: "deliver, nothing due",
			setup: async () => deliver(await running()),
			count: 2,
			before: 3,
		},
		{
			name: "deliver, one due try, delivered",
			setup: async () => deliver(await dueRows(zap, 1, ok)),
			did: async (h) => {
				expect(await statuses(h)).toEqual(["delivered"]);
				const [e] = await h.inspect.storage.list<Enquiry>("enquiries");
				expect(e?.data).toMatchObject({ cleared: true, counted: true });
			},
			// kvList storageQuery storageGetMany httpFetch storagePutMany storagePutMany kvSet
			count: 7,
			before: 11,
		},
		{
			name: "deliver, three due tries, two sent, one left for a follow-up run",
			setup: async () => deliver(await dueRows(zap, 3, ok)),
			did: async (h) => {
				expect(await statuses(h)).toEqual(["delivered", "delivered", "retrying"]);
				const tasks = (await h.inspect.scheduledTasks()) as Array<{ name: string }>;
				expect(tasks.map((t) => t.name.split("-")[0])).toEqual(["deliver"]);
			},
			count: 9,
			before: 27,
		},
		{
			name: "deliver, three due tries, the app answers 500",
			setup: async () => deliver(await dueRows(zap, 3, fails)),
			did: async (h) => expect(await statuses(h)).toEqual(["retrying", "retrying", "retrying"]),
			count: 7,
			before: 13,
		},
		{
			name: "deliver, three due tries, no answer (fetch throws)",
			setup: async () => deliver(await dueRows(zap, 3)),
			did: async (h) => expect(await statuses(h)).toEqual(["retrying", "retrying", "retrying"]),
			count: 7,
			before: 13,
		},
		{
			name: "deliver, last try fails: gives up and alerts",
			setup: async () => deliver(await dueRows(zap, 1, fails, { attempts: 7 })),
			did: async (h, m) => {
				expect(await statuses(h)).toEqual(["gaveup"]);
				expect(await h.inspect.email()).toHaveLength(1);
				expect(await h.inspect.kv.get("alerts")).toMatchObject({ failure: today() });
				// Sent first, then marked: a send that fails is tried again by a later run.
				expect(m.calls.slice(-2)).toEqual(["emailSend", "kvSet"]);
			},
			count: 7,
			before: 12,
		},
		{
			name: "deliver, HubSpot refuses: needs fixing and alerts",
			setup: async () => deliver(await dueRows(hub, 1, refused)),
			did: async (h) => {
				expect(await statuses(h)).toEqual(["fixing"]);
				expect(await h.inspect.email()).toHaveLength(1);
			},
			count: 7,
			before: 12,
		},
		{
			name: "deliver, three HubSpot refusals",
			setup: async () => deliver(await dueRows(hub, 3, refused)),
			did: async (h) => expect(await statuses(h)).toEqual(["fixing", "fixing", "retrying"]),
			count: 9,
			before: 26,
		},
		{
			name: "deliver, one email delivery due",
			setup: async () => deliver(await dueRows(mail, 1)),
			did: async (h) => {
				expect(await statuses(h)).toEqual(["delivered"]);
				expect(await h.inspect.email()).toHaveLength(1);
			},
			count: 7,
			before: 12,
			nested: 0,
		},
		{
			name: "deliver, three email deliveries due",
			setup: async () => deliver(await dueRows(mail, 3)),
			did: async (h) => expect(await h.inspect.email()).toHaveLength(2),
			count: 9,
			before: 30,
		},
		{
			name: "deliver, a retry whose enquiry has another delivery (its row is read)",
			setup: async () => {
				const h = await dueRows(zap, 1, ok, {}, [zap, mail]);
				await h.fixtures.plugin.storage("deliveries", `s1~${mail.id}`, {
					enquiryId: "s1",
					formId: "contact",
					formName: "Contact us",
					who: "Tom Reyes",
					destination: mail.id,
					status: "delivered",
					nextAt: "",
					attempts: 1,
					createdAt: now(),
					notes: [],
				} satisfies Send);
				return deliver(h);
			},
			did: async (h) => {
				expect(await statuses(h)).toEqual(["delivered", "delivered"]);
				const [e] = await h.inspect.storage.list<Enquiry>("enquiries");
				expect(e?.data.cleared).toBe(true);
			},
			count: 8,
		},
		{
			name: "deliver, an enquiry from before 0.4 (no list of its rows)",
			setup: async () => {
				const h = await dueRows(zap, 1, ok);
				const e = (await h.inspect.storage.get<Enquiry>("enquiries", "s1"))!;
				const { rows: _rows, ...old } = e;
				await h.fixtures.plugin.storage("enquiries", "s1", old);
				return deliver(h);
			},
			did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
			count: 8,
		},
		{
			name: "deliver, a follow-up run with the failure alert left over",
			setup: async () => {
				const h = await dueRows(zap, 1, ok);
				await row(h, "f1", zap.id, { status: "fixing", nextAt: "", plain: "Refused." });
				return { h, invoke: deliverRun(h, { name: "deliver-x1", data: { alert: true } }) };
			},
			did: async (h) => {
				expect(await h.inspect.email()).toHaveLength(1);
				expect(await statuses(h)).toEqual(["fixing", "retrying"]);
			},
			// kvList storageQuery emailSend kvSet, then storageQuery storageGetMany: no room to send,
			// so a follow-up.
			count: 7,
		},
	]);
});

describe("cron maintenance and the daily run", () => {
	const maintenance = (h: Host) => ({
		h,
		invoke: deliverRun(h, { name: "maintenance", data: null }),
	});
	const dailyRun = (h: Host) => ({ h, invoke: deliverRun(h, { name: "daily", data: null }) });
	const quiet: KnownForm = {
		...CONTACT,
		lastAt: ago(5 * DAY),
		days: [9, 7, 5].map((d) => ago(d * DAY).slice(0, 10)),
	};
	run([
		{
			name: "maintenance, idle minute (already ran today, nothing due)",
			setup: async () => {
				const h = await running();
				await h.fixtures.plugin.kv("daily", today());
				return maintenance(h);
			},
			count: 3,
			before: 6,
		},
		{
			name: "maintenance, first run of the day, nothing due: asks for the daily run",
			setup: async () => maintenance(await running()),
			did: async (h) => {
				const tasks = (await h.inspect.scheduledTasks()) as Array<{ name: string }>;
				expect(tasks.map((t) => t.name)).toEqual(["daily"]);
				expect(await h.inspect.kv.get("daily")).toBeNull();
			},
			count: 4,
			before: 11,
		},
		{
			name: "maintenance, any minute, one due try",
			setup: async () => {
				const h = await dueRows(zap, 1, ok);
				await h.fixtures.plugin.kv("daily", today());
				return maintenance(h);
			},
			did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
			count: 8,
			before: 14,
		},
		{
			name: "maintenance, first run of the day, one due try: left for a follow-up run",
			setup: async () => maintenance(await dueRows(zap, 1, ok)),
			did: async (h) => expect(await statuses(h)).toEqual(["retrying"]),
			count: 6,
			before: 19,
		},
		{
			name: "maintenance, five expired approval codes, nothing due",
			setup: async () => {
				const h = await running();
				await h.fixtures.plugin.kv("daily", today());
				for (const k of ["a", "b", "c", "d", "e"]) {
					await h.fixtures.plugin.kv(`approval:${k}`, {
						deviceCode: "x",
						userCode: "AB",
						approveUrl: "x",
						expiresAt: 1,
						intent: { form: "contact" },
					});
				}
				return maintenance(h);
			},
			did: async (h) =>
				expect((await h.inspect.kv.list()).filter((e) => e.id.startsWith("approval:"))).toEqual([]),
			count: 8,
		},
		{
			name: "daily, nothing to do",
			setup: async () => dailyRun(await running()),
			did: async (h) => expect(await h.inspect.kv.get("daily")).toBe(today()),
			count: 4,
		},
		{
			name: "daily, already done today",
			setup: async () => {
				const h = await running();
				await h.fixtures.plugin.kv("daily", today());
				return dailyRun(h);
			},
			count: 1,
		},
		{
			name: "daily, worst day (a quiet form to alert, old rows and enquiries to delete)",
			setup: async () => {
				const h = await running([zap], {}, { contact: quiet });
				const old = ago(40 * DAY);
				for (const id of ["o1", "o2"])
					await row(
						h,
						id,
						zap.id,
						{ status: "delivered", nextAt: "", createdAt: old },
						{ receivedAt: old },
					);
				return dailyRun(h);
			},
			did: async (h) => {
				expect(await h.inspect.email()).toHaveLength(1);
				expect(await h.inspect.storage.list("deliveries")).toEqual([]);
				expect(await h.inspect.storage.list("enquiries")).toEqual([]);
				expect(
					(await h.inspect.setting<Record<string, KnownForm>>("forms"))?.contact?.quietAlertedFor,
				).toBe(quiet.lastAt);
				expect(await h.inspect.kv.get("daily")).toBe(today());
			},
			count: 9,
		},
		{
			name: "cron, a task with another name",
			setup: async () => {
				const h = await running();
				return { h, invoke: deliverRun(h, { name: "other", data: null }) };
			},
			count: 0,
			before: 0,
		},
	]);
});

// ─── Public routes ───────────────────────────────────────────────────

describe("inbound", () => {
	const arrive = (h: Host, body: unknown = payload("01A"), key?: string) => ({
		h,
		invoke: inbound(h, body, key),
	});
	/** Stored and waiting for a run, and a run asked for. */
	const queued = async (h: Host, rows: string[]) => {
		await isStored(h, rows);
		const tasks = (await h.inspect.scheduledTasks()) as Array<{ name: string }>;
		expect(tasks.map((t) => t.name)).toEqual(["deliver"]);
	};
	run([
		{
			name: "inbound, wrong key",
			setup: async () => arrive(await running(), payload("01A"), "x".repeat(32)),
			did: async (_h, m) => expect(m.result).toMatchObject({ status: 401 }),
			count: 1,
			before: 1,
		},
		{
			name: "inbound, not an enquiry",
			setup: async () => arrive(await running(), { hello: "world" }),
			did: async (_h, m) => expect(m.result).toMatchObject({ status: 400 }),
			count: 1,
			before: 2,
		},
		{
			name: "inbound, already received",
			setup: async () => {
				const h = await running();
				await h.fixtures.plugin.storage("enquiries", "01A", enquiry({ cleared: true, fields: [] }));
				return arrive(h);
			},
			did: async (_h, m) => expect(m.result).toMatchObject({ text: "Already received." }),
			count: 3,
			before: 7,
		},
		{
			name: "inbound, fresh site, no delivery takes the form",
			setup: async () => {
				const h = await newHost();
				await h.fixtures.plugin.setting("config", { ...CONFIG });
				return arrive(h);
			},
			did: async (h) => {
				await isStored(h, ["skipped"]);
				expect(await h.inspect.kv.get("schedule")).toBe("* * * * *");
			},
			count: 9,
			before: 18,
		},
		{
			name: "inbound, one app delivery",
			setup: async () => arrive(await running()),
			did: async (h, m) => {
				expect(m.result).toMatchObject({ status: 200, text: "Received." });
				await queued(h, ["retrying"]);
			},
			count: 7,
			before: 21,
		},
		{
			name: "inbound, one email delivery",
			setup: async () => arrive(await running([mail])),
			did: async (h) => queued(h, ["retrying"]),
			count: 7,
			before: 22,
		},
		{
			name: "inbound, four deliveries (app, app, HubSpot, email)",
			setup: async () => arrive(await running([zap, make, hub, mail])),
			did: async (h) => queued(h, ["retrying", "retrying", "retrying", "retrying"]),
			count: 7,
			before: 31,
		},
		{
			name: "inbound, no email address in the enquiry",
			setup: async () => arrive(await running(), payload("01A", { email: "" })),
			did: async (h) => queued(h, ["retrying"]),
			count: 6,
		},
		{
			name: "inbound, the every-minute task stopped and tries are overdue: scheduler alert",
			setup: async () => {
				const h = await running();
				await h.fixtures.plugin.kv("tick", ago(60 * 60_000));
				await row(h, "old1", zap.id, { nextAt: ago(30 * 60_000) });
				return arrive(h);
			},
			did: async (h) => {
				expect(await h.inspect.email()).toHaveLength(1);
				expect(await statuses(h)).toEqual(["retrying", "retrying"]);
			},
			count: 9,
			before: 26,
		},
		{
			name: "inbound, the same person again, repeats held",
			setup: async () => {
				const h = await running([{ ...zap, repeat: "24h" }]);
				await row(h, "earlier", zap.id, {
					status: "delivered",
					nextAt: "",
					createdAt: ago(3_600_000),
				});
				return arrive(h);
			},
			// Nothing to send, so no run is asked for.
			did: async (h) => expect(await statuses(h)).toEqual(["delivered", "skipped"]),
			count: 6,
			before: 14,
		},
		{
			name: "inbound, first enquiry after updating from 0.3.0",
			setup: async () => arrive(await justUpdated()),
			// Stored with its log row (0.3.1 lost it here); the settings are copied by the admin page.
			did: async (h) => {
				await queued(h, ["retrying"]);
				expect(await h.inspect.setting("config")).toBeNull();
			},
			count: 7,
			before: 25,
		},
	]);
});

describe("ping", () => {
	run([
		{
			name: "ping, answers its code",
			setup: async () => {
				const h = await running();
				await h.fixtures.plugin.kv("ping", "abc");
				const invoke = async () => {
					const r = await h.actions.routes.request("ping", {
						method: "GET",
						url: `${PING}?code=abc`,
					});
					return { status: r.status };
				};
				return { h, invoke };
			},
			did: async (_h, m) => expect(m.result).toEqual({ status: 200 }),
			count: 1,
			before: 1,
		},
	]);
});

// ─── Admin ───────────────────────────────────────────────────────────

describe("admin page and widget", () => {
	const home = async (h: Host, role: "admin" | "editor" = "admin") => {
		const user = (await people(h))[role];
		return { h, invoke: page(h, user) };
	};
	run([
		{
			name: "admin home, first visit on a fresh site",
			setup: async () => home(await newHost()),
			did: async (h) =>
				expect((await h.inspect.setting<Config>("config"))?.alertTo).toEqual(["anna@crumb.test"]),
			count: 6,
			before: 16,
		},
		{
			name: "admin home, first visit after updating from 0.3.0",
			setup: async () => home(await justUpdated()),
			did: async (h) => {
				expect((await h.inspect.setting<Config>("config"))?.key).toBe(KEY);
				expect(await h.inspect.setting("forms")).toBeTruthy();
			},
			count: 6,
			before: 21,
		},
		{
			name: "admin home, 1 delivery",
			setup: async () => home(await running([zap])),
			count: 4,
			before: 17,
		},
		{
			name: "admin home, 3 deliveries",
			setup: async () => home(await running([zap, hub, mail])),
			count: 4,
			before: 25,
		},
		{
			name: "admin home, 3 deliveries, failures, retries, enquiries no delivery took",
			setup: async () => {
				const h = await running([zap, hub, mail]);
				await row(h, "f1", hub.id, { status: "fixing", nextAt: "" });
				await row(h, "r1", zap.id);
				await row(h, "n1", "none", { status: "skipped", nextAt: "", held: true });
				return home(h);
			},
			count: 4,
		},
		{
			name: "admin home, no deliveries yet",
			setup: async () => home(await running([])),
			count: 1,
			before: 4,
		},
		{
			name: "admin home, first visit after install (plugin:activate ran)",
			setup: async () => {
				const h = await newHost();
				await h.transport.invokeHook("plugin:activate", {});
				return home(h);
			},
			did: async (h) =>
				expect((await h.inspect.setting<Config>("config"))?.alertTo).toEqual(["anna@crumb.test"]),
			count: 4,
			before: 8,
		},
		{
			name: "admin home as an editor, 1 delivery",
			setup: async () => home(await running([zap]), "editor"),
			count: 4,
			before: 17,
		},
		{
			name: "dashboard widget",
			setup: async () => {
				const h = await running();
				const { admin } = await people(h);
				return { h, invoke: () => h.admin.loadWidget("enquiries", { user: admin }) };
			},
			count: 2,
			before: 7,
		},
	]);
});
interface ActionCase {
	action: string;
	label?: string;
	deliveries?: Delivery[];
	extra?: Partial<Config>;
	forms?: Record<string, KnownForm>;
	seed?: (h: Host, admin: User) => Promise<unknown>;
	values?: Record<string, unknown>;
	value?: unknown;
	blockId?: string;
	editor?: boolean;
	/** The action answers with an error toast (a test that did not arrive). */
	failToast?: boolean;
	/** The action answers with a short screen, not the full page it came from. */
	light?: boolean;
	did?: (h: Host, m: Measured<unknown>) => Promise<void>;
	count: number;
	before?: number;
	nested?: number;
}

const connectable: Partial<Config> = { reach: { result: "self", at: now() } };
const unconnected: Record<string, KnownForm> = {
	contact: { ...CONTACT, connectedAt: undefined, connectedWay: undefined },
};
const approvalCode = (expiresAt = Date.now() + 600_000) => ({
	deviceCode: "dev1ce",
	userCode: "ABCD-EFGH",
	approveUrl: `${ORIGIN}/_emdash/admin/device`,
	expiresAt,
	intent: { form: "contact" },
});
const codeAnswer = () =>
	Response.json({
		data: {
			device_code: "dev1ce",
			user_code: "ABCD-EFGH",
			verification_uri: `${ORIGIN}/_emdash/admin/device`,
			expires_in: 900,
		},
	});
const tokens = () =>
	Response.json({ data: { access_token: "ec_oat_a", refresh_token: "ec_ort_r" } });
const formsList = () =>
	Response.json({
		data: {
			items: [{ id: "f1", slug: "contact", name: "Contact us", pages: [], settings: {} }],
		},
	});
const notReachable = () => new Response("nope", { status: 404 });
const gaveUp: Partial<Send> = { status: "gaveup", nextAt: "", attempts: 8 };

const conflictList = () =>
	Response.json({
		data: {
			items: [
				{
					id: "f1",
					slug: "contact",
					name: "Contact us",
					pages: [],
					settings: { webhookUrl: "https://other.test/hook" },
				},
			],
		},
	});
/** One-click connect waiting for "Done, connect": the code stored, EmDash's answers queued. */
const approving =
	(...answers: Array<[string, () => Response]>) =>
	async (h: Host, admin: User) => {
		await h.fixtures.plugin.kv(`approval:${zap.id}:${admin.id}`, approvalCode());
		for (const [url, answer] of answers) await h.http.respond(url, answer());
	};
const lookup = `${ORIGIN}/_emdash/api/plugins/emdash-forms/definition`;
const definition = () =>
	Response.json({
		data: {
			slug: "quote",
			name: "Quote",
			pages: [{ fields: [{ name: "name", label: "Your name", type: "text" }] }],
		},
	});

const ACTIONS: ActionCase[] = [
	{ action: "see_all", count: 3, before: 7 },
	{ action: "open_log", value: zap.id, count: 3, before: 7 },
	{ action: "filter_log", values: { delivery: zap.id }, count: 3, before: 7 },
	{
		action: "log_page",
		label: "log_page, a delivery's log",
		blockId: `log:delivery:${zap.id}`,
		value: { cursor: "" },
		count: 4,
		before: 10,
	},
	{
		action: "send_again",
		seed: async (h) => {
			await row(h, "s1", zap.id, gaveUp, { rows: [zap.id] });
			await h.http.respond(HOOK, ok());
		},
		value: { row: `s1~${zap.id}`, from: { screen: "home" } },
		light: true,
		did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
		count: 7,
		before: 29,
	},
	{
		action: "send_again",
		label: "send_again, as an editor",
		editor: true,
		seed: async (h) => {
			await row(h, "s1", zap.id, gaveUp, { rows: [zap.id] });
			await h.http.respond(HOOK, ok());
		},
		value: { row: `s1~${zap.id}`, from: { screen: "home" } },
		light: true,
		count: 7,
		before: 29,
	},
	{
		action: "send_again",
		label: "send_again, an enquiry with two deliveries (the other row is read)",
		deliveries: [zap, mail],
		seed: async (h) => {
			await row(h, "s1", zap.id, gaveUp, { rows: [zap.id, mail.id] });
			await h.fixtures.plugin.storage("deliveries", `s1~${mail.id}`, {
				enquiryId: "s1",
				formId: "contact",
				formName: "Contact us",
				who: "Tom Reyes",
				destination: mail.id,
				status: "delivered",
				nextAt: "",
				attempts: 1,
				createdAt: now(),
				notes: [],
			} satisfies Send);
			await h.http.respond(HOOK, ok());
		},
		value: { row: `s1~${zap.id}`, from: { screen: "delivery", id: zap.id } },
		light: true,
		count: 8,
	},
	{
		action: "send_again",
		label: "send_again, refused again: alerts",
		deliveries: [hub],
		seed: async (h) => {
			await row(h, "s1", hub.id, gaveUp, { rows: [hub.id] });
			await h.http.respond(HUBSPOT, refused());
		},
		value: { row: `s1~${hub.id}`, from: { screen: "home" } },
		light: true,
		failToast: true,
		did: async (h) => expect(await h.inspect.email()).toHaveLength(1),
		count: 7,
	},
	{
		action: "send_now",
		seed: async (h) => {
			await row(h, "s1", zap.id, {}, { rows: [zap.id] });
			await h.http.respond(HOOK, ok());
		},
		value: { row: `s1~${zap.id}`, from: { screen: "delivery", id: zap.id } },
		light: true,
		count: 7,
		before: 22,
	},
	{
		action: "send_all",
		label: "send_all, 3 failed: queued",
		seed: async (h) => {
			for (const id of ["s1", "s2", "s3"]) await row(h, id, zap.id, gaveUp);
		},
		value: { delivery: zap.id, from: { screen: "home" } },
		did: async (h) => expect(await statuses(h)).toEqual(["retrying", "retrying", "retrying"]),
		count: 7,
		before: 51,
	},
	{ action: "new", value: {}, count: 1, before: 4 },
	{
		action: "new_continue",
		label: "new_continue, a known form, site not checked yet (checked here)",
		values: { form: "contact", kind: "app" },
		seed: async (h) => h.http.respond(PING, notReachable()),
		count: 6,
		before: 4,
	},
	{
		action: "new_continue",
		label: "new_continue, a form typed by its short name, site not checked yet",
		values: { form: "__other", short_name: "quote", kind: "app" },
		seed: async (h) => {
			await h.http.respond(lookup, definition());
			await h.http.respond(PING, notReachable());
		},
		did: async (h) => {
			expect((await h.inspect.setting<Record<string, KnownForm>>("forms"))?.quote?.name).toBe(
				"Quote",
			);
			expect((await h.inspect.setting<Config>("config"))?.reach?.result).toBe("email");
		},
		count: 9,
	},
	{
		action: "new_save",
		label: "new_save, app, form connected (sends a test)",
		blockId: "new2:app:contact",
		values: { url: HOOK2, app: "make", name: "" },
		seed: async (h) => h.http.respond(HOOK2, ok()),
		count: 8,
		before: 32,
	},
	{
		action: "new_save",
		label: "new_save, email, form never connected, site not checked",
		forms: unconnected,
		blockId: "new2:email:contact",
		values: { to: "shop@crumb.test", name: "" },
		seed: async (h) => h.http.respond(PING, notReachable()),
		count: 8,
		before: 34,
	},
	{
		action: "new_save",
		label: "new_save, app, form never connected, one-click offered",
		forms: unconnected,
		extra: connectable,
		blockId: "new2:app:contact",
		values: { url: HOOK2, app: "make", name: "" },
		seed: async (h) => {
			await h.http.respond(HOOK2, ok());
			await h.http.respond(CODE, codeAnswer());
		},
		did: async (_h, m) => expect(JSON.stringify(m.result)).toContain("ABCD-EFGH"),
		count: 7,
		before: 30,
	},
	{
		action: "new_save",
		label: "new_save, a typed form the site cannot look up, one-click site",
		forms: {},
		extra: connectable,
		blockId: "new2:app:quote",
		values: { url: HOOK2, app: "make", name: "" },
		seed: async (h) => {
			await h.http.respond(lookup, new Response("down", { status: 500 }));
			await h.http.respond(HOOK2, ok());
			await h.http.respond(CODE, codeAnswer());
		},
		count: 9,
	},
	{ action: "open", value: zap.id, count: 4, before: 11 },
	{ action: "edit", value: zap.id, count: 1, before: 4 },
	{
		action: "test",
		label: "test, app",
		value: zap.id,
		seed: async (h) => h.http.respond(HOOK, ok()),
		count: 8,
		before: 26,
	},
	{
		action: "test",
		label: "test, email",
		deliveries: [mail],
		value: mail.id,
		count: 8,
		before: 27,
	},
	{
		action: "test",
		label: "test, the app answers 500",
		value: zap.id,
		seed: async (h) => h.http.respond(HOOK, fails()),
		failToast: true,
		count: 8,
		before: 25,
	},
	{ action: "toggle", value: zap.id, count: 6, before: 14 },
	{
		action: "save_repeats",
		blockId: `repeats:${zap.id}`,
		values: { repeat: "24h", hold_spam: true },
		count: 6,
		before: 14,
	},
	{ action: "new_secret", value: zap.id, count: 6, before: 14 },
	{
		action: "delete",
		label: "delete, with enquiries still on their way",
		seed: async (h) => {
			await row(h, "s1", zap.id);
			await row(h, "s2", zap.id, { status: "fixing", nextAt: "" });
			await row(h, "s3", zap.id, { status: "gaveup", nextAt: "" });
		},
		value: zap.id,
		did: async (h) => expect(await statuses(h)).toEqual(["skipped", "skipped", "skipped"]),
		count: 5,
		before: 14,
	},
	{
		action: "save_edit",
		blockId: `edit:${zap.id}`,
		values: { forms: ["contact"], url: HOOK, app: "zapier", name: "Renamed", on: true },
		count: 6,
		before: 14,
	},
	{
		action: "save_edit",
		label: "save_edit, HubSpot (refreshes form definitions)",
		deliveries: [hub],
		blockId: `edit:${hub.id}`,
		values: {
			forms: ["contact"],
			hubspot: "https://share.hsforms.com/4410287/9f1c2b3a-1111-2222-3333-444455556666",
			name: "x",
			on: true,
		},
		seed: async (h) => h.http.respond(lookup, notReachable()),
		count: 7,
		before: 16,
	},
	{
		action: "save_matching",
		deliveries: [hub],
		blockId: `matching:${hub.id}:contact`,
		values: { "f:name": "firstname", "f:email": "email" },
		count: 3,
		before: 8,
	},
	{ action: "adopt_choose", value: "other", count: 2, before: 5 },
	{
		action: "adopt",
		label: "adopt, 3 held enquiries: queued",
		seed: async (h) => {
			for (const id of ["h1", "h2", "h3"]) {
				const held = {
					formId: "other",
					formName: "Other",
					status: "skipped",
					nextAt: "",
					held: true,
				};
				await row(h, id, "none", held as Partial<Send>, { formId: "other", rows: ["none"] });
			}
		},
		value: { form: "other", delivery: zap.id },
		light: true,
		did: async (h) => expect(await statuses(h)).toEqual(["retrying", "retrying", "retrying"]),
		count: 8,
		before: 51,
	},
	{
		action: "connect",
		label: "connect, one-click (a new code)",
		forms: unconnected,
		extra: connectable,
		seed: async (h) => h.http.respond(CODE, codeAnswer()),
		value: { id: zap.id, form: "contact" },
		count: 3,
		before: 10,
	},
	{
		action: "connect",
		label: "connect, site not checked yet",
		forms: unconnected,
		seed: async (h) => h.http.respond(PING, notReachable()),
		value: { id: zap.id, form: "contact" },
		count: 6,
		before: 11,
	},
	{
		action: "connect_finish",
		label: "connect_finish, not approved yet",
		forms: unconnected,
		extra: connectable,
		seed: approving([
			TOKEN,
			() => Response.json({ error: "authorization_pending" }, { status: 400 }),
		]),
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		count: 2,
		before: 10,
	},
	{
		action: "connect_finish",
		label: "connect_finish, connected",
		forms: unconnected,
		extra: connectable,
		seed: approving(
			[TOKEN, tokens],
			[LIST, formsList],
			[UPDATE, () => Response.json({ data: {} })],
			[REVOKE, ok],
		),
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		did: async (h) => {
			expect(
				(await h.inspect.setting<Record<string, KnownForm>>("forms"))?.contact?.connectedWay,
			).toBe("straight");
			expect((await h.inspect.kv.list()).filter((e) => e.id.startsWith("approval:"))).toEqual([]);
		},
		count: 9,
		before: 25,
	},
	{
		action: "connect_finish",
		label: "connect_finish, connected, the revoke works at the second try",
		forms: unconnected,
		extra: connectable,
		seed: approving(
			[TOKEN, tokens],
			[LIST, formsList],
			[UPDATE, () => Response.json({ data: {} })],
			[REVOKE, fails],
			[REVOKE, ok],
		),
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		did: async (h) =>
			expect(
				(await h.inspect.setting<Record<string, KnownForm>>("forms"))?.contact?.connectedWay,
			).toBe("straight"),
		count: 9,
	},
	{
		action: "connect_finish",
		label: "connect_finish, connected but the access could not be revoked",
		forms: unconnected,
		extra: connectable,
		seed: approving(
			[TOKEN, tokens],
			[LIST, formsList],
			[UPDATE, () => Response.json({ data: {} })],
			[REVOKE, fails],
			[REVOKE, fails],
		),
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		light: true,
		did: async (h) => {
			expect((await h.inspect.setting<Config>("config"))?.accessLeft?.form).toBe("Contact us");
			expect(await h.inspect.email()).toHaveLength(1);
			expect(
				(await h.inspect.setting<Record<string, KnownForm>>("forms"))?.contact?.connectedWay,
			).toBe("straight");
		},
		count: 9,
		before: 32,
	},
	{
		action: "connect_finish",
		label: "connect_finish, the form sends somewhere else",
		forms: unconnected,
		extra: connectable,
		seed: approving([TOKEN, tokens], [LIST, conflictList], [REVOKE, ok]),
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		did: async (_h, m) => expect(JSON.stringify(m.result)).toContain("Replace it"),
		count: 5,
	},
	{
		action: "connect_finish",
		label: "connect_finish, the change is refused and the access could not be revoked",
		forms: unconnected,
		extra: connectable,
		seed: approving(
			[TOKEN, tokens],
			[LIST, formsList],
			[UPDATE, () => new Response("no", { status: 403 })],
			[REVOKE, fails],
			[REVOKE, fails],
		),
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		light: true,
		failToast: true,
		did: async (h) => {
			expect((await h.inspect.setting<Config>("config"))?.accessLeft).toBeTruthy();
			expect(await h.inspect.email()).toHaveLength(1);
		},
		count: 9,
	},
	{
		action: "connect_finish",
		label: "connect_finish, code expired (a new code)",
		forms: unconnected,
		extra: connectable,
		seed: async (h, admin) => {
			await h.fixtures.plugin.kv(`approval:${zap.id}:${admin.id}`, approvalCode(Date.now() - 1000));
			await h.http.respond(CODE, codeAnswer());
		},
		value: { id: zap.id, form: "contact" },
		count: 5,
		before: 12,
	},
	{
		action: "connect_replace",
		forms: unconnected,
		extra: connectable,
		seed: async (h) => h.http.respond(CODE, codeAnswer()),
		value: { id: zap.id, form: "contact", host: "other.test", hash: "a".repeat(64) },
		count: 3,
		before: 7,
	},
	{
		action: "connect_keep",
		forms: unconnected,
		value: { id: zap.id, form: "contact", host: "other.test" },
		count: 1,
		before: 4,
	},
	{
		action: "dismiss_access",
		extra: { accessLeft: { at: now(), form: "Contact us" } },
		count: 6,
		before: 21,
	},
	{
		action: "connected",
		label: "connected (I have done this)",
		forms: unconnected,
		value: { id: zap.id, form: "contact" },
		count: 6,
		before: 16,
	},
	{
		action: "email_instructions",
		forms: unconnected,
		blockId: `instructions:${zap.id}:contact`,
		values: { to: "web@pixel.dev" },
		count: 2,
		before: 5,
	},
	{ action: "dismiss_notice", extra: { notice: true }, count: 6, before: 21 },
	{
		action: "save_alerts",
		values: { alert_to: "anna@crumb.test, sam@pixel.dev" },
		count: 6,
		before: 21,
	},
	// New in 0.4.1: the switch that hides the help line. The same one save as the alert list.
	{
		action: "save_help_line",
		values: { hide_help_line: true },
		did: async (h) => {
			expect((await h.inspect.setting<Config>("config"))?.hideHelpLine).toBe(true);
		},
		count: 6,
	},
	{
		action: "check_reach",
		seed: async (h) => h.http.respond(PING, notReachable()),
		count: 9,
		before: 24,
	},
	{ action: "reset_address", count: 6, before: 21 },
];

describe("admin actions, on a running site with one delivery", () => {
	run(
		ACTIONS.map((c) => ({
			name: `admin ${c.label ?? c.action}`,
			setup: async () => {
				const h = await running(
					c.deliveries ?? [zap],
					c.extra ?? {},
					c.forms ?? { contact: CONTACT },
				);
				const { admin, editor } = await people(h);
				await c.seed?.(h, admin);
				const user = c.editor ? editor : admin;
				const blockId = c.blockId ? { blockId: c.blockId } : {};
				const invoke = c.values
					? () => h.admin.submit(PAGE, c.action, c.values!, { user, ...blockId })
					: () =>
							h.admin.act(PAGE, c.action, {
								user,
								...(c.value === undefined ? {} : { value: c.value }),
								...blockId,
							});
				return { h, invoke };
			},
			did: async (h: Host, m: Measured<unknown>) => {
				expect(m.error).toBeUndefined();
				const result = m.result as { blocks: unknown[]; toast?: { type: string; message: string } };
				const toast = result.toast;
				if (toast) console.info(`  toast: ${toast.type}: ${toast.message}`);
				expect(toast?.type === "error").toBe(c.failToast === true);
				// A short screen has a way back and no tables.
				const tables = JSON.stringify(result.blocks).includes('"type":"table"');
				if (c.light) expect(tables).toBe(false);
				await c.did?.(h, m);
			},
			count: c.count,
			...(c.before !== undefined ? { before: c.before } : {}),
			...(c.nested ? { nested: c.nested } : {}),
		})),
	);
});

// ─── With Cloudflare's limit enforced ────────────────────────────────

const WRITES = new Set([
	"kvSet",
	"kvDelete",
	"settingsSet",
	"storagePut",
	"storagePutMany",
	"storageDelete",
	"storageDeleteMany",
	"storageCompareAndSet",
	"cronSchedule",
	"emailSend",
]);

describe("one-click connect with the limit enforced: the access is always revoked first", () => {
	const cases: Array<[string, Array<[string, () => Response]>]> = [
		[
			"connected",
			[
				[TOKEN, tokens],
				[LIST, formsList],
				[UPDATE, () => Response.json({ data: {} })],
				[REVOKE, ok],
			],
		],
		[
			"connected, the revoke fails twice",
			[
				[TOKEN, tokens],
				[LIST, formsList],
				[UPDATE, () => Response.json({ data: {} })],
				[REVOKE, fails],
				[REVOKE, fails],
			],
		],
		[
			"the form sends somewhere else",
			[
				[TOKEN, tokens],
				[LIST, conflictList],
				[REVOKE, ok],
			],
		],
		[
			"the change is refused",
			[
				[TOKEN, tokens],
				[LIST, formsList],
				[UPDATE, () => new Response("no", { status: 403 })],
				[REVOKE, ok],
			],
		],
		[
			"the forms cannot be listed",
			[
				[TOKEN, tokens],
				[LIST, () => new Response("down", { status: 500 })],
				[REVOKE, ok],
			],
		],
	];
	for (const [label, answers] of cases) {
		it(label, async () => {
			const h = await running([zap], connectable, unconnected);
			const { admin } = await people(h);
			await approving(...answers)(h, admin);
			await h.restart();
			const from = h.http.requests().length;
			const m = await measure(
				() =>
					h.admin.act(PAGE, "connect_finish", {
						user: admin,
						value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
					}),
				{ enforce: true },
			);
			log(`connect_finish, enforced, ${label}`, m);
			expect(m.error).toBeUndefined();
			expect(m.refused).toEqual([]);
			const requests = h.http.requests().slice(from);
			const revokes = requests.filter((r) => r.url === REVOKE);
			expect(revokes.length).toBeGreaterThan(0);
			// The k-th httpFetch in the calls is the k-th request: find the first revoke's place.
			const first = requests.findIndex((r) => r.url === REVOKE);
			let fetches = -1;
			const at = m.calls.findIndex((call) => call === "httpFetch" && ++fetches === first);
			expect(at).toBeGreaterThan(0);
			expect(m.calls.slice(0, at).filter((call) => WRITES.has(call))).toEqual([]);
			// Only the revoke and its one retry came after the token.
			expect(requests.at(-1)!.url === REVOKE || requests.at(-2)!.url === REVOKE).toBe(true);
		});
	}
});

describe("arriving enquiries with the limit enforced: none is lost", () => {
	const paths: Array<[string, () => Promise<{ h: Host; invoke: Invoke }>]> = [
		[
			"inbound, running site, four deliveries",
			async () => {
				const h = await running([zap, make, hub, mail]);
				return { h, invoke: inbound(h, payload("01A")) };
			},
		],
		[
			"inbound, fresh site, no delivery",
			async () => {
				const h = await newHost();
				await h.fixtures.plugin.setting("config", { ...CONFIG });
				return { h, invoke: inbound(h, payload("01A")) };
			},
		],
		[
			"inbound, first after updating from 0.3.0",
			async () => {
				const h = await justUpdated();
				return { h, invoke: inbound(h, payload("01A")) };
			},
		],
		[
			"inbound, scheduler stopped, overdue tries",
			async () => {
				const h = await running();
				await h.fixtures.plugin.kv("tick", ago(60 * 60_000));
				await row(h, "old1", zap.id, { nextAt: ago(30 * 60_000) });
				return { h, invoke: inbound(h, payload("01A")) };
			},
		],
		[
			"email way, running site, three deliveries",
			async () => {
				const h = await running([mail, zap, hub]);
				return { h, invoke: emailWay(h, formEmail) };
			},
		],
		[
			"email way, first after updating from 0.3.0",
			async () => {
				const h = await justUpdated([mail]);
				return { h, invoke: emailWay(h, formEmail) };
			},
		],
		[
			"email way, fields cannot be read",
			async () => {
				const h = await running([mail]);
				return { h, invoke: emailWay(h, { ...formEmail, text: "garbled" }) };
			},
		],
	];
	for (const [label, setup] of paths) {
		it(label, async () => {
			const { h, invoke } = await setup();
			const m = await cold(h, invoke, true);
			log(`${label}, enforced`, m);
			expect(m.error).toBeUndefined();
			expect(m.refused).toEqual([]);
			const enquiries = await h.inspect.storage.list<Enquiry>("enquiries");
			const id = label.startsWith("email")
				? enquiries.find((e) => e.id.startsWith("m"))?.id
				: "01A";
			expect(id).toBeTruthy();
			const rows = (await sendRows(h)).filter((r) => r.enquiryId === id);
			expect(rows.length).toBeGreaterThan(0);
			expect(
				enquiries
					.find((e) => e.id === id)
					?.data.rows?.slice()
					.sort(),
			).toEqual(rows.map((r) => r.destination).sort());
		});
	}
});

describe("a backlog with the limit enforced", () => {
	it("10 enquiries through 3 deliveries: each sent once, every run within the limit", async () => {
		const h = await running([zap, make, hub]);
		for (let i = 0; i < 10; i++) {
			await h.http.respond(HOOK, ok());
			await h.http.respond(HOOK2, ok());
			await h.http.respond(HUBSPOT, ok());
			await h.restart();
			const m = await measure(inbound(h, payload(`01B${i}`, { email: `p${i}@example.com` })), {
				enforce: true,
			});
			expect(m.refused).toEqual([]);
			expect(m.calls.length).toBeLessThanOrEqual(BUDGET);
		}
		const counts = await runQueued(h, { enforce: true });
		console.info(`backlog: ${counts.length} runs: ${counts.join(" ")}`);
		const hits = (url: string) => h.http.requests().filter((r) => r.url === url).length;
		expect([hits(HOOK), hits(HOOK2), hits(HUBSPOT)]).toEqual([10, 10, 10]);
		expect(await statuses(h)).toEqual(Array(30).fill("delivered"));
		const kept = await h.inspect.storage.list<Enquiry>("enquiries");
		expect(kept.every((e) => e.data.cleared && e.data.counted)).toBe(true);
		const stats = (await h.inspect.kv.get<Record<string, { r: number; d: number }>>("stats"))!;
		expect(stats[today()]).toEqual({ r: 10, d: 10 });
		expect(await h.inspect.scheduledTasks()).toEqual([]);
	});

	it("Send all failed again, pressed twice: each sent once", async () => {
		const h = await running();
		const { admin } = await people(h);
		for (const id of ["s1", "s2", "s3"]) {
			await row(h, id, zap.id, gaveUp, { rows: [zap.id] });
			await h.http.respond(HOOK, ok());
		}
		const press = () =>
			h.admin.act(PAGE, "send_all", {
				user: admin,
				value: { delivery: zap.id, from: { screen: "home" } },
			});
		await press();
		await press();
		await runQueued(h, { enforce: true });
		await press();
		await runQueued(h, { enforce: true });
		expect(h.http.requests().filter((r) => r.url === HOOK)).toHaveLength(3);
		expect(await statuses(h)).toEqual(["delivered", "delivered", "delivered"]);
	});

	it("adding a form to a delivery, pressed again after its enquiries went: each sent once", async () => {
		const h = await running();
		const { admin } = await people(h);
		for (const id of ["h1", "h2", "h3"]) {
			const held = {
				formId: "other",
				formName: "Other",
				status: "skipped",
				nextAt: "",
				held: true,
			};
			await row(h, id, "none", held as Partial<Send>, { formId: "other", rows: ["none"] });
			await h.http.respond(HOOK, ok());
		}
		const adopt = () =>
			h.admin.act(PAGE, "adopt", { user: admin, value: { form: "other", delivery: zap.id } });
		await adopt();
		await runQueued(h, { enforce: true });
		// An answer lost on the way: the held rows came back from a backup, the press is repeated.
		for (const id of ["h1", "h2", "h3"]) {
			const held = {
				formId: "other",
				formName: "Other",
				status: "skipped",
				nextAt: "",
				held: true,
			};
			await h.fixtures.plugin.storage("deliveries", `${id}~none`, {
				enquiryId: id,
				who: "Tom Reyes",
				destination: "none",
				attempts: 0,
				createdAt: now(),
				notes: [],
				...held,
			});
		}
		await adopt();
		await runQueued(h, { enforce: true });
		expect(h.http.requests().filter((r) => r.url === HOOK)).toHaveLength(3);
		expect(await statuses(h)).toEqual(["delivered", "delivered", "delivered"]);
	});
});
