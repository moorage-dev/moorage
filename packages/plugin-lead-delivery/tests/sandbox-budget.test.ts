// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// B39: subrequests per sandboxed invocation, counted on the real sandbox wrapper.
//
// On Cloudflare each sandboxed hook call, route call (every admin page load and action) and cron
// run may make at most 10 calls to the host (SANDBOX_SUBREQUESTS); every ctx.* call, logging
// included, is one. The 11th and every later call throw "Too many subrequests by single Worker
// invocation". Nothing enforces this locally, so bridge-budget.ts counts the RPCs.
//
// These tests PIN the current exact count of every hook and route path in its worst realistic
// state (cold isolate: host.restart() before each measure), so any change shows up. They are not
// a target: a path pinned above 10 fails on Cloudflare today and carries a TODO(B39). The
// enforced tests show what happens there when the limit is hit (what was written, what is lost).
// tests/budget.test.ts is the older fake-ctx counter (no logging, no real wrapper).
//
// Not reached: a failing ctx.email.send. The test host's email transport never fails, and a send
// this plugin's own email:beforeSend cancels resolves without an error.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { Config, Delivery, Enquiry, KnownForm, Send } from "../src/types.js";
import {
	describeCalls,
	measure,
	SANDBOX_SUBREQUESTS,
	TOO_MANY,
	type Measured,
} from "./bridge-budget.js";

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

/** A site that has been running this release: settings saved, mirrored to the old KV keys. */
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
	return h;
}

/** Right after updating from 0.3.0: the old KV keys only, nothing under settings. */
async function justUpdated(deliveries: Delivery[] = [zap]): Promise<Host> {
	const h = await newHost();
	await h.fixtures.plugin.kv("config", { ...CONFIG, deliveries });
	await h.fixtures.plugin.kv("forms", { contact: CONTACT });
	await h.fixtures.plugin.kv("schedule", "* * * * *");
	await h.fixtures.plugin.kv("origin", ORIGIN);
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

const cron = (h: Host, name: string) => () => h.transport.invokeHook("cron", { name, data: null });

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

/** What a run left behind, in one line: pinned for each path run with the limit enforced. */
async function outcome(
	h: Host,
	m: Measured<unknown>,
	more: { http: number; settings: string; extra?: string },
): Promise<string> {
	const all = (await h.inspect.storage.list<Send>("deliveries")).map((r) => r.data);
	const real = all.filter((r) => !r.test).map((r) => r.status);
	const tests = all.filter((r) => r.test).map((r) => r.status);
	const kept = (await h.inspect.storage.list<Enquiry>("enquiries")).map((e) =>
		e.data.cleared ? "cleared" : "kept",
	);
	const emails = (await h.inspect.email()).length;
	const result = m.result as
		| { status?: number; toast?: { type: string } }
		| boolean
		| null
		| undefined;
	let answer: string;
	if (m.error) {
		const text = String(m.error);
		answer = `throws${text.includes(TOO_MANY) ? " (too many subrequests)" : `: ${text.slice(0, 80)}`}`;
	} else if (typeof result === "boolean" || result === null || result === undefined) {
		answer = `answers ${String(result)}`;
	} else if (typeof result.status === "number") {
		answer = `answers ${result.status}`;
	} else {
		answer = `answers ${result.toast?.type ?? "a page"}`;
	}
	return [
		answer,
		`refused ${m.refused.length}`,
		`log [${real.sort().join(",")}]`,
		...(tests.length ? [`tests [${tests.join(",")}]`] : []),
		`enquiries [${kept.sort().join(",")}]`,
		`emails ${emails}`,
		`requests ${more.http}`,
		`settings ${more.settings}`,
		...(more.extra ? [more.extra] : []),
	].join("; ");
}

interface Case {
	/** The path and the state it runs in. */
	name: string;
	setup: () => Promise<{ h: Host; invoke: Invoke }>;
	/** What the path did (limit not enforced). */
	did?: (h: Host, m: Measured<unknown>) => Promise<void>;
	/** Calls to the host in that one invocation, cold isolate. */
	count: number;
	/** Calls made by this plugin's own hooks the host ran meanwhile (separate invocations). */
	nested?: number;
	/** With the limit enforced as on Cloudflare: what the run did and left behind. */
	onCloudflare?: string;
	extra?: (h: Host) => Promise<string>;
}

function run(cases: Case[]) {
	for (const c of cases) {
		it(c.name, async () => {
			const { h, invoke } = await c.setup();
			const m = await cold(h, invoke);
			log(c.name, m);
			await c.did?.(h, m);
			expect(m.nested.length).toBe(c.nested ?? 0);
			expect(m.calls.length).toBe(c.count);
		});
		if (c.count < SANDBOX_SUBREQUESTS) continue;
		it(`${c.name}, on Cloudflare (limit enforced)`, async () => {
			const { h, invoke } = await c.setup();
			const saved = () => Promise.all([h.inspect.setting("config"), h.inspect.setting("forms")]);
			const before = JSON.stringify(await saved());
			const fetched = h.http.requests().length;
			const m = await cold(h, invoke, true);
			const changed = JSON.stringify(await saved()) !== before;
			const seen = await outcome(h, m, {
				http: h.http.requests().length - fetched,
				settings: changed ? "changed" : "unchanged",
				...(c.extra ? { extra: await c.extra(h) } : {}),
			});
			console.info(`on Cloudflare: ${c.name}: ${seen}`);
			expect(seen).toBe(c.onCloudflare);
		});
	}
}

const statuses = async (h: Host) => (await sendRows(h)).map((r) => r.status).sort();
const daily = async (h: Host) =>
	`daily ${(await h.inspect.kv.get("daily")) ? "marked" : "not marked"}`;
const settingsCopied = async (h: Host) =>
	`settings ${(await h.inspect.setting("config")) ? "copied" : "not copied"}`;

const formEmail = { to: PRIVATE, subject: "New submission: Contact us", text: FORM_EMAIL };

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
			count: 9,
		},
		{
			name: "activate, just updated from 0.3.0",
			setup: async () => {
				const h = await justUpdated();
				return { h, invoke: () => h.transport.invokeHook("plugin:activate", {}) };
			},
			did: async (h) => expect((await h.inspect.setting<Config>("config"))?.key).toBe(KEY),
			count: 5,
		},
	]);
});

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
		},
		{
			name: "beforeSend, a stray email to the private domain",
			setup: async () => {
				const h = await running([mail]);
				const stray = { to: "enquiries-old@lead-delivery.invalid", subject: "x", text: "y" };
				return { h, invoke: emailWay(h, stray, "someone") };
			},
			did: async (_h, m) => expect(m.result).toBe(false),
			count: 1,
		},
		{
			name: "beforeSend, the email way, running site, one email delivery",
			setup: async () => {
				const h = await running([mail]);
				return { h, invoke: emailWay(h, formEmail) };
			},
			did: async (h, m) => {
				expect(m.result).toBe(false);
				expect(await statuses(h)).toEqual(["retrying"]);
			},
			count: 11, // TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers false; refused 2; log [retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "beforeSend, the email way, three deliveries for the form",
			setup: async () => {
				const h = await running([mail, zap, hub]);
				return { h, invoke: emailWay(h, formEmail) };
			},
			did: async (h) => expect(await statuses(h)).toEqual(["retrying", "retrying", "retrying"]),
			count: 11, // TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers false; refused 2; log [retrying,retrying,retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "beforeSend, the email way, first enquiry after updating from 0.3.0",
			setup: async () => {
				const h = await justUpdated([mail]);
				return { h, invoke: emailWay(h, formEmail) };
			},
			did: async (h) => expect(await statuses(h)).toEqual(["retrying"]),
			count: 15, // TODO(B39): 15 calls, over Cloudflare's sandbox limit of 10 -- see report
			// Lost: the enquiry is stored but has no log row, so no run ever delivers it, and the
			// email is cancelled. The error is caught, and its ctx.log.error is refused too.
			onCloudflare:
				"answers false; refused 2; log []; enquiries [kept]; emails 0; requests 0; settings changed; settings copied",
			extra: settingsCopied,
		},
		{
			name: "beforeSend, the email way, fields cannot be read",
			setup: async () => {
				const h = await running([mail]);
				return { h, invoke: emailWay(h, { ...formEmail, text: "garbled" }) };
			},
			// Recorded as text under a form id of its own, so no delivery takes it: "Not sent".
			did: async (h) => expect(await statuses(h)).toEqual(["skipped"]),
			count: 11, // TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers false; refused 2; log [skipped]; enquiries [kept]; emails 0; requests 0; settings changed",
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
			count: 11, // TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers false; refused 2; log [delivered,retrying]; enquiries [kept,kept]; emails 0; requests 0; settings changed",
		},
	]);
});

/** A running site with `n` enquiries waiting for a try through `delivery`, due now. */
async function due(
	delivery: Delivery,
	n: number,
	answer?: () => Response,
	extra: Partial<Send> = {},
) {
	const h = await running([delivery]);
	for (let i = 1; i <= n; i++) {
		await row(h, `s${i}`, delivery.id, extra);
		if (answer) await h.http.respond(delivery.kind === "hubspot" ? HUBSPOT : HOOK, answer());
	}
	return h;
}

describe("cron deliver", () => {
	const deliver = (h: Host) => ({ h, invoke: cron(h, "deliver") });
	run([
		{
			name: "deliver, nothing due",
			setup: async () => deliver(await running()),
			count: 3,
		},
		{
			name: "deliver, one due try, delivered",
			setup: async () => deliver(await due(zap, 1, ok)),
			did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
			count: 11, // TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [delivered]; enquiries [cleared]; emails 0; requests 1; settings unchanged",
		},
		{
			name: "deliver, three due tries, delivered",
			setup: async () => deliver(await due(zap, 3, ok)),
			did: async (h) => expect(await statuses(h)).toEqual(["delivered", "delivered", "delivered"]),
			count: 27, // TODO(B39): 27 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [delivered,retrying,retrying]; enquiries [cleared,kept,kept]; emails 0; requests 1; settings unchanged",
		},
		{
			name: "deliver, three due tries, the app answers 500",
			setup: async () => deliver(await due(zap, 3, fails)),
			did: async (h) => expect(await statuses(h)).toEqual(["retrying", "retrying", "retrying"]),
			count: 13, // TODO(B39): 13 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [retrying,retrying,retrying]; enquiries [kept,kept,kept]; emails 0; requests 3; settings unchanged",
		},
		{
			name: "deliver, three due tries, no answer (fetch throws)",
			setup: async () => deliver(await due(zap, 3)),
			did: async (h) => expect(await statuses(h)).toEqual(["retrying", "retrying", "retrying"]),
			count: 13, // TODO(B39): 13 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [retrying,retrying,retrying]; enquiries [kept,kept,kept]; emails 0; requests 3; settings unchanged",
		},
		{
			name: "deliver, last try fails: gives up and alerts",
			setup: async () => deliver(await due(zap, 1, fails, { attempts: 7 })),
			did: async (h) => {
				expect(await statuses(h)).toEqual(["gaveup"]);
				expect(await h.inspect.email()).toHaveLength(1);
			},
			count: 12, // TODO(B39): 12 calls, over Cloudflare's sandbox limit of 10 -- see report
			// The alert is marked sent for today (kvSet) but its email is refused: nobody hears.
			onCloudflare:
				"throws (too many subrequests); refused 3; log [gaveup]; enquiries [kept]; emails 0; requests 1; settings unchanged",
		},
		{
			name: "deliver, HubSpot refuses: needs fixing and alerts",
			setup: async () => deliver(await due(hub, 1, refused)),
			did: async (h) => {
				expect(await statuses(h)).toEqual(["fixing"]);
				expect(await h.inspect.email()).toHaveLength(1);
			},
			count: 12, // TODO(B39): 12 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 3; log [fixing]; enquiries [kept]; emails 0; requests 1; settings unchanged",
		},
		{
			name: "deliver, three HubSpot refusals",
			setup: async () => deliver(await due(hub, 3, refused)),
			did: async (h) => expect(await statuses(h)).toEqual(["fixing", "fixing", "fixing"]),
			count: 26, // TODO(B39): 26 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 3; log [fixing,retrying,retrying]; enquiries [kept,kept,kept]; emails 0; requests 1; settings unchanged",
		},
		{
			name: "deliver, one email delivery due",
			setup: async () => deliver(await due(mail, 1)),
			did: async (h) => {
				expect(await statuses(h)).toEqual(["delivered"]);
				expect(await h.inspect.email()).toHaveLength(1);
			},
			count: 12, // TODO(B39): 12 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [delivered]; enquiries [kept]; emails 1; requests 0; settings unchanged",
		},
		{
			name: "deliver, three email deliveries due",
			setup: async () => deliver(await due(mail, 3)),
			did: async (h) => expect(await h.inspect.email()).toHaveLength(3),
			count: 30, // TODO(B39): 30 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [delivered,retrying,retrying]; enquiries [kept,kept,kept]; emails 1; requests 0; settings unchanged",
		},
	]);
});

describe("cron maintenance", () => {
	const maintenance = (h: Host) => ({ h, invoke: cron(h, "maintenance") });
	run([
		{
			name: "maintenance, idle minute (already ran today, nothing due)",
			setup: async () => {
				const h = await running();
				await h.fixtures.plugin.kv("daily", today());
				return maintenance(h);
			},
			count: 6,
		},
		{
			name: "maintenance, first run of the day, nothing due",
			setup: async () => maintenance(await running()),
			did: async (h) => expect(await h.inspect.kv.get("daily")).toBe(today()),
			count: 11, // TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
			// The day is marked done before the quiet check and cleanup, which are then refused:
			// the 30-day cleanup and the quiet-form alert never run.
			onCloudflare:
				"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 0; settings unchanged; daily marked",
			extra: daily,
		},
		{
			name: "maintenance, first run of the day, one due try",
			setup: async () => maintenance(await due(zap, 1, ok)),
			did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
			count: 19, // TODO(B39): 19 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [delivered]; enquiries [kept]; emails 0; requests 1; settings unchanged; daily not marked",
			extra: daily,
		},
		{
			name: "maintenance, any minute, one due try",
			setup: async () => {
				const h = await due(zap, 1, ok);
				await h.fixtures.plugin.kv("daily", today());
				return maintenance(h);
			},
			did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
			count: 14, // TODO(B39): 14 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [delivered]; enquiries [kept]; emails 0; requests 1; settings unchanged",
		},
		{
			name: "maintenance, worst day (3 due, quiet form, 2 expired codes, old rows)",
			setup: async () => {
				const quiet: KnownForm = {
					...CONTACT,
					lastAt: ago(5 * DAY),
					days: [9, 7, 5].map((d) => ago(d * DAY).slice(0, 10)),
				};
				const h = await running([zap], {}, { contact: quiet });
				for (const id of ["s1", "s2", "s3"]) {
					await row(h, id, zap.id);
					await h.http.respond(HOOK, ok());
				}
				for (const k of ["a", "b"]) {
					await h.fixtures.plugin.kv(`approval:${k}`, {
						deviceCode: "x",
						userCode: "AB",
						approveUrl: "x",
						expiresAt: 1,
						intent: { form: "contact" },
					});
				}
				const old = ago(40 * DAY);
				await row(
					h,
					"old",
					zap.id,
					{ status: "delivered", nextAt: "", createdAt: old },
					{
						receivedAt: old,
					},
				);
				return maintenance(h);
			},
			did: async (h) => {
				expect(await statuses(h)).toEqual(["delivered", "delivered", "delivered"]);
				expect(await h.inspect.email()).toHaveLength(1);
			},
			count: 45, // TODO(B39): 45 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log [delivered,delivered,retrying,retrying]; enquiries [kept,kept,kept,kept]; emails 0; requests 1; settings unchanged; daily not marked",
			extra: daily,
		},
		{
			name: "cron, a task with another name",
			setup: async () => {
				const h = await running();
				return { h, invoke: cron(h, "other") };
			},
			count: 0,
		},
	]);
});

// ─── Public routes ───────────────────────────────────────────────────

describe("inbound", () => {
	const arrive = (h: Host, body: unknown = payload("01A"), key?: string) => ({
		h,
		invoke: inbound(h, body, key),
	});
	run([
		{
			name: "inbound, wrong key",
			setup: async () => arrive(await running(), payload("01A"), "x".repeat(32)),
			did: async (_h, m) => expect(m.result).toMatchObject({ status: 401 }),
			count: 1,
		},
		{
			name: "inbound, not an enquiry",
			setup: async () => arrive(await running(), { hello: "world" }),
			did: async (_h, m) => expect(m.result).toMatchObject({ status: 400 }),
			count: 2,
		},
		{
			name: "inbound, already received",
			setup: async () => {
				const h = await running();
				await h.fixtures.plugin.storage("enquiries", "01A", enquiry({ cleared: true, fields: [] }));
				return arrive(h);
			},
			did: async (_h, m) => expect(m.result).toMatchObject({ text: "Already received." }),
			count: 7,
		},
		{
			name: "inbound, fresh site, no delivery takes the form",
			setup: async () => {
				const h = await newHost();
				await h.fixtures.plugin.setting("config", { ...CONFIG });
				return arrive(h);
			},
			did: async (h) => expect(await statuses(h)).toEqual(["skipped"]),
			count: 18, // TODO(B39): 18 calls, over Cloudflare's sandbox limit of 10 -- see report
			// The enquiry is stored without its "Not sent" row; a resend gets "Already received".
			onCloudflare:
				"answers 400; refused 1; log []; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, one app delivery, delivered",
			setup: async () => {
				const h = await running();
				await h.http.respond(HOOK, ok());
				return arrive(h);
			},
			did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
			count: 21, // TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, one email delivery, delivered",
			setup: async () => arrive(await running([mail])),
			did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
			count: 22, // TODO(B39): 22 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, three deliveries (app, HubSpot, email), delivered",
			setup: async () => {
				const h = await running([zap, hub, mail]);
				await h.http.respond(HOOK, ok());
				await h.http.respond(HUBSPOT, ok());
				return arrive(h);
			},
			did: async (h) => expect(await statuses(h)).toEqual(["delivered", "delivered", "delivered"]),
			count: 32, // TODO(B39): 32 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [retrying,retrying,retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, four deliveries (three now, one scheduled)",
			setup: async () => {
				const h = await running([zap, make, hub, mail]);
				await h.http.respond(HOOK, ok());
				await h.http.respond(HOOK2, ok());
				await h.http.respond(HUBSPOT, ok());
				return arrive(h);
			},
			did: async (h) =>
				expect(await statuses(h)).toEqual(["delivered", "delivered", "delivered", "retrying"]),
			count: 31, // TODO(B39): 31 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [retrying,retrying,retrying,retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, the app answers 500",
			setup: async () => {
				const h = await running();
				await h.http.respond(HOOK, fails());
				return arrive(h);
			},
			did: async (h) => expect(await statuses(h)).toEqual(["retrying"]),
			count: 17, // TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, no answer (fetch throws)",
			setup: async () => arrive(await running()),
			did: async (h) => expect(await statuses(h)).toEqual(["retrying"]),
			count: 17, // TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, HubSpot refuses: needs fixing and alerts",
			setup: async () => {
				const h = await running([hub]);
				await h.http.respond(HUBSPOT, refused());
				return arrive(h);
			},
			did: async (h) => {
				expect(await statuses(h)).toEqual(["fixing"]);
				expect(await h.inspect.email()).toHaveLength(1);
			},
			count: 23, // TODO(B39): 23 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [retrying]; enquiries [kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, retries stuck: scheduler alert",
			setup: async () => {
				const h = await running();
				await row(h, "old1", zap.id, { nextAt: ago(30 * 60_000) });
				await h.http.respond(HOOK, ok());
				return arrive(h);
			},
			did: async (h) => expect(await h.inspect.email()).toHaveLength(1),
			count: 26, // TODO(B39): 26 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [retrying,retrying]; enquiries [kept,kept]; emails 0; requests 0; settings changed",
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
			did: async (h) => expect(await statuses(h)).toEqual(["delivered", "skipped"]),
			count: 14, // TODO(B39): 14 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"answers 400; refused 1; log [delivered,skipped]; enquiries [kept,kept]; emails 0; requests 0; settings changed",
		},
		{
			name: "inbound, first enquiry after updating from 0.3.0",
			setup: async () => {
				const h = await justUpdated();
				await h.http.respond(HOOK, ok());
				return arrive(h);
			},
			did: async (h) => expect(await statuses(h)).toEqual(["delivered"]),
			count: 25, // TODO(B39): 25 calls, over Cloudflare's sandbox limit of 10 -- see report
			// Lost: stored with no log row, so nothing delivers it; a resend gets "Already received".
			onCloudflare:
				"answers 400; refused 3; log []; enquiries [kept]; emails 0; requests 0; settings changed; settings copied",
			extra: settingsCopied,
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
		},
		{
			name: "ping, no code waiting",
			setup: async () => {
				const h = await running();
				const invoke = async () => {
					const r = await h.actions.routes.request("ping", {
						method: "GET",
						url: `${PING}?code=abc`,
					});
					return { status: r.status };
				};
				return { h, invoke };
			},
			did: async (_h, m) => expect(m.result).toEqual({ status: 404 }),
			count: 1,
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
			count: 16, // TODO(B39): 16 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 0; settings unchanged; settings not copied",
			extra: settingsCopied,
		},
		{
			name: "admin home, first visit after updating from 0.3.0",
			setup: async () => home(await justUpdated()),
			count: 21, // TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed; settings copied",
			extra: settingsCopied,
		},
		{
			name: "admin home, 1 delivery",
			setup: async () => home(await running([zap])),
			count: 17, // TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 4; log []; enquiries []; emails 0; requests 0; settings unchanged",
		},
		{
			name: "admin home, 2 deliveries",
			setup: async () => home(await running([zap, hub])),
			count: 21, // TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings unchanged",
		},
		{
			name: "admin home, 3 deliveries",
			setup: async () => home(await running([zap, hub, mail])),
			count: 25, // TODO(B39): 25 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings unchanged",
		},
		{
			name: "admin home, no deliveries yet",
			setup: async () => home(await running([])),
			count: 4,
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
			count: 8,
		},
		{
			name: "admin home, fresh site, the visit after a first visit cut off by the limit",
			setup: async () => {
				// What the cut-off first visit wrote: the schedule and the origin, nothing else.
				const h = await newHost();
				await h.fixtures.plugin.kv("schedule", "* * * * *");
				await h.fixtures.plugin.kv("origin", ORIGIN);
				return home(h);
			},
			count: 13, // TODO(B39): 13 calls, over Cloudflare's sandbox limit of 10 -- see report
			// The settings are saved at call 10, so the third visit works.
			onCloudflare:
				"throws (too many subrequests); refused 3; log []; enquiries []; emails 0; requests 0; settings changed; settings copied",
			extra: settingsCopied,
		},
		{
			name: "admin home as an editor, 1 delivery",
			setup: async () => home(await running([zap]), "editor"),
			count: 17, // TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
			onCloudflare:
				"throws (too many subrequests); refused 4; log []; enquiries []; emails 0; requests 0; settings unchanged",
		},
		{
			name: "dashboard widget",
			setup: async () => {
				const h = await running();
				const { admin } = await people(h);
				return { h, invoke: () => h.admin.loadWidget("enquiries", { user: admin }) };
			},
			count: 7,
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
	count: number;
	nested?: number;
	onCloudflare?: string;
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

const ACTIONS: ActionCase[] = [
	{ action: "see_all", count: 7 },
	{ action: "open_log", value: zap.id, count: 7 },
	{ action: "filter_log", values: { delivery: zap.id }, count: 7 },
	{
		action: "log_page",
		label: "log_page, a delivery's log",
		blockId: `log:delivery:${zap.id}`,
		value: { cursor: "" },
		count: 10, // TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"answers a page; refused 0; log []; enquiries []; emails 0; requests 0; settings unchanged",
	},
	{
		action: "send_again",
		seed: async (h) => {
			await row(h, "s1", zap.id, gaveUp);
			await h.http.respond(HOOK, ok());
		},
		value: { row: `s1~${zap.id}`, from: { screen: "home" } },
		count: 29, // TODO(B39): 29 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log [delivered]; enquiries [kept]; emails 0; requests 1; settings unchanged",
	},
	{
		action: "send_again",
		label: "send_again, as an editor",
		editor: true,
		seed: async (h) => {
			await row(h, "s1", zap.id, gaveUp);
			await h.http.respond(HOOK, ok());
		},
		value: { row: `s1~${zap.id}`, from: { screen: "home" } },
		count: 29, // TODO(B39): 29 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log [delivered]; enquiries [kept]; emails 0; requests 1; settings unchanged",
	},
	{
		action: "send_now",
		seed: async (h) => {
			await row(h, "s1", zap.id);
			await h.http.respond(HOOK, ok());
		},
		value: { row: `s1~${zap.id}`, from: { screen: "delivery", id: zap.id } },
		count: 22, // TODO(B39): 22 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log [delivered]; enquiries [kept]; emails 0; requests 1; settings unchanged",
	},
	{
		action: "send_all",
		label: "send_all, 3 failed",
		seed: async (h) => {
			for (const id of ["s1", "s2", "s3"]) {
				await row(h, id, zap.id, gaveUp);
				await h.http.respond(HOOK, ok());
			}
		},
		value: { delivery: zap.id, from: { screen: "home" } },
		count: 51, // TODO(B39): 51 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log [gaveup,gaveup,gaveup]; enquiries [kept,kept,kept]; emails 0; requests 1; settings unchanged",
	},
	{ action: "new", value: {}, count: 4 },
	{ action: "new_continue", values: { form: "contact", kind: "app" }, count: 4 },
	{
		action: "new_save",
		label: "new_save, app, form connected (sends a test)",
		blockId: "new2:app:contact",
		values: { url: HOOK2, app: "make", name: "" },
		seed: async (h) => h.http.respond(HOOK2, ok()),
		count: 32, // TODO(B39): 32 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "new_save",
		label: "new_save, email, form never connected, site not checked",
		forms: unconnected,
		blockId: "new2:email:contact",
		values: { to: "shop@crumb.test", name: "" },
		seed: async (h) => h.http.respond(PING, notReachable()),
		count: 34, // TODO(B39): 34 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 0; settings changed",
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
		count: 30, // TODO(B39): 30 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "open",
		value: zap.id,
		count: 11, // TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 0; settings unchanged",
	},
	{ action: "edit", value: zap.id, count: 4 },
	{
		action: "test",
		label: "test, app",
		value: zap.id,
		seed: async (h) => h.http.respond(HOOK, ok()),
		count: 26, // TODO(B39): 26 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; tests [retrying]; enquiries [kept]; emails 0; requests 1; settings unchanged",
	},
	{
		action: "test",
		label: "test, email",
		deliveries: [mail],
		value: mail.id,
		count: 27, // TODO(B39): 27 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; tests [retrying]; enquiries [kept]; emails 0; requests 0; settings unchanged",
	},
	{
		action: "test",
		label: "test, the app answers 500",
		value: zap.id,
		seed: async (h) => h.http.respond(HOOK, fails()),
		failToast: true,
		count: 25, // TODO(B39): 25 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; tests [retrying]; enquiries [kept]; emails 0; requests 1; settings unchanged",
	},
	{
		action: "toggle",
		value: zap.id,
		count: 14, // TODO(B39): 14 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "save_repeats",
		blockId: `repeats:${zap.id}`,
		values: { repeat: "24h", hold_spam: true },
		count: 14, // TODO(B39): 14 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "new_secret",
		value: zap.id,
		count: 14, // TODO(B39): 14 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "delete",
		label: "delete, with enquiries still on their way",
		seed: async (h) => {
			await row(h, "s1", zap.id);
			await row(h, "s2", zap.id, { status: "fixing", nextAt: "" });
			await row(h, "s3", zap.id, { status: "gaveup", nextAt: "" });
		},
		value: zap.id,
		count: 14, // TODO(B39): 14 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log [skipped,skipped,skipped]; enquiries [kept,kept,kept]; emails 0; requests 0; settings unchanged",
	},
	{
		action: "save_edit",
		blockId: `edit:${zap.id}`,
		values: { forms: ["contact"], url: HOOK, app: "zapier", name: "Renamed", on: true },
		count: 14, // TODO(B39): 14 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed",
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
		seed: async (h) =>
			h.http.respond(`${ORIGIN}/_emdash/api/plugins/emdash-forms/definition`, notReachable()),
		count: 16, // TODO(B39): 16 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 4; log []; enquiries []; emails 0; requests 1; settings changed",
	},
	{
		action: "save_matching",
		deliveries: [hub],
		blockId: `matching:${hub.id}:contact`,
		values: { "f:name": "firstname", "f:email": "email" },
		count: 8,
	},
	{ action: "adopt_choose", value: "other", count: 5 },
	{
		action: "adopt",
		label: "adopt, 3 held enquiries",
		seed: async (h) => {
			for (const id of ["h1", "h2", "h3"]) {
				const held = {
					formId: "other",
					formName: "Other",
					status: "skipped",
					nextAt: "",
					held: true,
				};
				await row(h, id, "none", held as Partial<Send>, { formId: "other" });
				await h.http.respond(HOOK, ok());
			}
		},
		value: { form: "other", delivery: zap.id },
		count: 51, // TODO(B39): 51 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log [retrying,retrying,retrying,skipped,skipped,skipped]; enquiries [kept,kept,kept]; emails 0; requests 0; settings changed",
	},
	{
		action: "connect",
		label: "connect, one-click (a new code)",
		forms: unconnected,
		extra: connectable,
		seed: async (h) => h.http.respond(CODE, codeAnswer()),
		value: { id: zap.id, form: "contact" },
		count: 10, // TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"answers a page; refused 0; log []; enquiries []; emails 0; requests 1; settings unchanged",
	},
	{
		action: "connect",
		label: "connect, site not checked yet",
		forms: unconnected,
		seed: async (h) => h.http.respond(PING, notReachable()),
		value: { id: zap.id, form: "contact" },
		count: 11, // TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 1; settings changed",
	},
	{
		action: "connect_finish",
		label: "connect_finish, not approved yet",
		forms: unconnected,
		extra: connectable,
		seed: async (h, admin) => {
			await h.fixtures.plugin.kv(`approval:${zap.id}:${admin.id}`, approvalCode());
			await h.http.respond(
				TOKEN,
				Response.json({ error: "authorization_pending" }, { status: 400 }),
			);
		},
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		count: 10, // TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"answers info; refused 0; log []; enquiries []; emails 0; requests 1; settings unchanged",
	},
	{
		action: "connect_finish",
		label: "connect_finish, connected",
		forms: unconnected,
		extra: connectable,
		seed: async (h, admin) => {
			await h.fixtures.plugin.kv(`approval:${zap.id}:${admin.id}`, approvalCode());
			await h.http.respond(TOKEN, tokens());
			await h.http.respond(LIST, formsList());
			await h.http.respond(UPDATE, Response.json({ data: {} }));
			await h.http.respond(REVOKE, ok());
		},
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		count: 25, // TODO(B39): 25 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 4; log []; enquiries []; emails 0; requests 2; settings unchanged",
	},
	{
		action: "connect_finish",
		label: "connect_finish, connected but the access could not be revoked",
		forms: unconnected,
		extra: connectable,
		seed: async (h, admin) => {
			await h.fixtures.plugin.kv(`approval:${zap.id}:${admin.id}`, approvalCode());
			await h.http.respond(TOKEN, tokens());
			await h.http.respond(LIST, formsList());
			await h.http.respond(UPDATE, Response.json({ data: {} }));
			await h.http.respond(REVOKE, fails());
			await h.http.respond(REVOKE, fails());
		},
		value: { id: zap.id, form: "contact", code: "ABCD-EFGH" },
		count: 32, // TODO(B39): 32 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 4; log []; enquiries []; emails 0; requests 2; settings unchanged",
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
		count: 12, // TODO(B39): 12 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 1; settings unchanged",
	},
	{
		action: "connect_replace",
		forms: unconnected,
		extra: connectable,
		seed: async (h) => h.http.respond(CODE, codeAnswer()),
		value: { id: zap.id, form: "contact", host: "other.test", hash: "a".repeat(64) },
		count: 7,
	},
	{
		action: "connect_keep",
		forms: unconnected,
		value: { id: zap.id, form: "contact", host: "other.test" },
		count: 4,
	},
	{
		action: "dismiss_access",
		extra: { accessLeft: { at: now(), form: "Contact us" } },
		count: 21, // TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "connected",
		label: "connected (I have done this)",
		forms: unconnected,
		value: { id: zap.id, form: "contact" },
		count: 16, // TODO(B39): 16 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 4; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "email_instructions",
		forms: unconnected,
		blockId: `instructions:${zap.id}:contact`,
		values: { to: "web@pixel.dev" },
		count: 5,
	},
	{
		action: "dismiss_notice",
		extra: { notice: true },
		count: 21, // TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "save_alerts",
		values: { alert_to: "anna@crumb.test, sam@pixel.dev" },
		count: 21, // TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed",
	},
	{
		action: "check_reach",
		seed: async (h) => h.http.respond(PING, notReachable()),
		count: 24, // TODO(B39): 24 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 1; log []; enquiries []; emails 0; requests 1; settings changed",
	},
	{
		action: "reset_address",
		count: 21, // TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
		onCloudflare:
			"throws (too many subrequests); refused 2; log []; enquiries []; emails 0; requests 0; settings changed",
	},
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
			did: async (_h: Host, m: Measured<unknown>) => {
				expect(m.error).toBeUndefined();
				const toast = (m.result as { toast?: { type: string; message: string } }).toast;
				if (toast) console.info(`  toast: ${toast.type}: ${toast.message}`);
				expect(toast?.type === "error").toBe(c.failToast === true);
			},
			count: c.count,
			...(c.nested ? { nested: c.nested } : {}),
			...(c.onCloudflare !== undefined ? { onCloudflare: c.onCloudflare } : {}),
		})),
	);
});
