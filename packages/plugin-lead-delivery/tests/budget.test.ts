// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";
import type { Config, Delivery, KnownForm, Send } from "../src/types.js";

// Calls to the host per invocation. Sandboxed on Cloudflare a plugin run may make about 10
// (Worker Loader's subrequest limit); nothing enforces it locally, so these tests count every
// call a run makes to KV, settings, storage, email, http and cron on a fake site.
//
// The main paths (an arriving enquiry, the email way, the every-minute run) already make more
// than 10 calls in 0.3.0, because each delivery sends and logs inside the same run. Moving the
// settings must not add to that: each path is pinned at or below what 0.3.0 made.

const KEY = "K".repeat(32);
const ORIGIN = "https://crumb.test";
const HOOK = "https://hooks.zapier.com/hooks/catch/123/abc/";
const NOW = new Date().toISOString();

type Where = Record<string, unknown>;

function matches(data: Record<string, unknown>, where: Where = {}): boolean {
	return Object.entries(where).every(([field, want]) => {
		const have = data[field] as string;
		if (want && typeof want === "object") {
			const range = want as { gte?: string; lte?: string; lt?: string };
			if (range.gte !== undefined && !(have >= range.gte)) return false;
			if (range.lte !== undefined && !(have <= range.lte)) return false;
			if (range.lt !== undefined && !(have < range.lt)) return false;
			return true;
		}
		return have === want;
	});
}

function collection(count: () => void) {
	const rows = new Map<string, Record<string, unknown>>();
	const query = async (opts: {
		where?: Where;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
	}) => {
		count();
		let items = [...rows.entries()]
			.filter(([, data]) => matches(data, opts.where))
			.map(([id, data]) => ({ id, data }));
		const [field, dir] = Object.entries(opts.orderBy ?? {})[0] ?? [];
		if (field)
			items.sort(
				(a, b) =>
					String(a.data[field]).localeCompare(String(b.data[field])) * (dir === "desc" ? -1 : 1),
			);
		items = items.slice(0, opts.limit ?? 50);
		return { items, hasMore: false };
	};
	return {
		rows,
		api: {
			get: async (id: string) => (count(), rows.get(id) ?? null),
			getMany: async (ids: string[]) => {
				count();
				const out = new Map<string, unknown>();
				for (const id of ids) if (rows.has(id)) out.set(id, rows.get(id));
				return out;
			},
			put: async (id: string, data: Record<string, unknown>) => void (count(), rows.set(id, data)),
			putMany: async (items: Array<{ id: string; data: Record<string, unknown> }>) => {
				count();
				for (const item of items) rows.set(item.id, item.data);
			},
			delete: async (id: string) => (count(), rows.delete(id)),
			deleteMany: async (ids: string[]) => {
				count();
				for (const id of ids) rows.delete(id);
				return ids.length;
			},
			compareAndSet: async (id: string, expected: unknown, data: Record<string, unknown>) => {
				count();
				if (expected === null && rows.has(id)) return { applied: false };
				rows.set(id, data);
				return { applied: true };
			},
			count: async (where?: Where) => {
				count();
				return [...rows.values()].filter((data) => matches(data, where)).length;
			},
			query,
		},
	};
}

/** A fake site whose every host call is counted in `ops`. */
function fakeSite() {
	const calls: string[] = [];
	const counter = (name: string) => () => void calls.push(name);
	const kv = new Map<string, unknown>();
	const settings = new Map<string, unknown>();
	const deliveries = collection(counter("storage"));
	const enquiries = collection(counter("storage"));
	const emails: unknown[] = [];
	const ctx = {
		plugin: { id: "lead-delivery", version: "test" },
		site: { name: "Crumb & Co.", url: ORIGIN, locale: "en" },
		log: { debug() {}, info() {}, warn() {}, error() {} },
		kv: {
			get: async (key: string) => (calls.push("kv.get"), kv.get(key) ?? null),
			set: async (key: string, value: unknown) => void (calls.push("kv.set"), kv.set(key, value)),
			delete: async (key: string) => (calls.push("kv.delete"), kv.delete(key)),
			list: async (prefix = "") => (
				calls.push("kv.list"),
				[...kv.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.map(([key, value]) => ({ key, value }))
			),
		},
		settings: {
			get: async (key: string) => (calls.push("settings.get"), settings.get(key) ?? null),
			set: async (key: string, value: unknown) =>
				void (calls.push("settings.set"), settings.set(key, value)),
			delete: async (key: string) => (calls.push("settings.delete"), settings.delete(key)),
			getAll: async () => (calls.push("settings.getAll"), Object.fromEntries(settings)),
		},
		storage: { deliveries: deliveries.api, enquiries: enquiries.api },
		email: {
			send: async (message: unknown) => void (calls.push("email.send"), emails.push(message)),
		},
		http: {
			fetch: async () => (calls.push("http.fetch"), new Response("ok", { status: 200 })),
		},
		cron: {
			schedule: async () => void calls.push("cron.schedule"),
			cancel: async () => void calls.push("cron.cancel"),
			list: async () => (calls.push("cron.list"), []),
		},
	} as unknown as PluginContext;
	return { ctx, calls, kv, settings, deliveries, enquiries, emails };
}

type Site = ReturnType<typeof fakeSite>;

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

const mail: Delivery = {
	id: "maildelive",
	kind: "email",
	name: "Contact us → orders@crumb.test",
	forms: "all",
	on: true,
	repeat: "off",
	holdSpam: false,
	createdAt: "2026-10-20T00:00:00.000Z",
	to: ["orders@crumb.test"],
};

const CONFIG: Config = {
	version: 2,
	deliveries: [zap],
	alertTo: ["anna@crumb.test"],
	key: KEY,
	keySetAt: "2026-10-01T00:00:00.000Z",
};

const FORMS: Record<string, KnownForm> = {
	contact: {
		slug: "contact",
		name: "Contact us",
		fields: [{ key: "name", label: "Your name" }],
		source: "definition",
		addedAt: "2026-10-01T00:00:00.000Z",
		days: [],
		connectedAt: "2026-10-02T00:00:00.000Z",
		connectedWay: "straight",
	},
};

/**
 * A site that has been running: the settings are where this release keeps them and where
 * 0.3.0 kept them (it mirrors every save), and the every-minute task is set up.
 */
function running(config: Config = CONFIG): Site {
	const site = fakeSite();
	for (const [key, value] of [
		["config", config],
		["forms", FORMS],
	] as const) {
		site.kv.set(key, structuredClone(value));
		site.settings.set(key, structuredClone(value));
	}
	site.kv.set("schedule", "* * * * *");
	site.kv.set("origin", ORIGIN);
	return site;
}

/** The same, right after updating from 0.3.0: nothing under settings yet. */
function justUpdated(config: Config = CONFIG): Site {
	const site = running(config);
	site.settings.clear();
	return site;
}

type Route = { handler: (routeCtx: unknown, ctx: PluginContext) => Promise<unknown> };
type Hook = { handler: (event: unknown, ctx: PluginContext) => Promise<unknown> };

async function inbound(site: Site, id = "sub1") {
	const route = plugin.routes!.inbound as unknown as Route;
	site.calls.length = 0;
	await route.handler(
		{
			request: new Request(`${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${KEY}`, {
				method: "POST",
			}),
			input: {
				event: "form.submission",
				formId: "contact",
				formName: "Contact us",
				submissionId: id,
				data: { name: "Tom Reyes", email: "tom@example.com", message: "Hello" },
				files: [],
				submittedAt: NOW,
			},
		},
		site.ctx,
	);
	return [...site.calls];
}

async function emailWay(site: Site) {
	const hook = plugin.hooks!["email:beforeSend"] as unknown as Hook;
	site.calls.length = 0;
	const result = await hook.handler(
		{
			source: "emdash-forms",
			message: {
				to: `enquiries-${KEY}@lead-delivery.invalid`,
				subject: "New submission: Contact us",
				text: 'New submission for "Contact us"\n\nYour name: Tom Reyes\nEmail: tom@example.com\nMessage: Hello\n\nSubmitted at: 2026-10-16T09:00:00.000Z',
			},
		},
		site.ctx,
	);
	expect(result).toBe(false);
	return [...site.calls];
}

async function cron(site: Site, name: "deliver" | "maintenance") {
	const hook = plugin.hooks!.cron as unknown as
		| Hook
		| ((event: unknown, ctx: PluginContext) => Promise<unknown>);
	site.calls.length = 0;
	const run = typeof hook === "function" ? hook : hook.handler;
	await run({ name, data: null }, site.ctx);
	return [...site.calls];
}

/** One enquiry waiting for its next try, due now. */
function due(site: Site) {
	site.enquiries.rows.set("sub9", {
		formId: "contact",
		formName: "Contact us",
		receivedAt: NOW,
		fields: [{ key: "name", label: "Your name", value: "Tom Reyes" }],
		name: "Tom Reyes",
		email: "tom@example.com",
		via: "straight",
		throwaway: false,
		hasFiles: false,
	});
	const row: Send = {
		enquiryId: "sub9",
		formId: "contact",
		formName: "Contact us",
		who: "Tom Reyes",
		email: "tom@example.com",
		destination: zap.id,
		status: "retrying",
		nextAt: new Date(Date.now() - 60_000).toISOString(),
		attempts: 1,
		createdAt: NOW,
		notes: [],
	};
	site.deliveries.rows.set(`sub9~${zap.id}`, row as unknown as Record<string, unknown>);
}

// Host calls per path. 0.3.0 (measured with these tests on 3f5ecf2) made 23 for an enquiry
// arriving straight, 12 the email way, 12 for a scheduled try and 20 for the every-minute run with
// one due try. Moving the settings adds a copy on each save of the forms; passing the config and
// forms already read down the path more than makes up for it.
const LIMIT = {
	inbound: 21,
	emailWay: 10,
	deliver: 11,
	maintenance: 19,
};

describe("host calls per run, on a site that has been running", () => {
	it("an enquiry arriving straight from a form", async () => {
		const site = running();
		const calls = await inbound(site);
		expect(site.deliveries.rows.get(`sub1~${zap.id}`)).toMatchObject({ status: "delivered" });
		console.info("inbound", calls.length, calls.join(" "));
		expect(calls.length).toBeLessThanOrEqual(LIMIT.inbound);
	});

	it("an enquiry arriving the email way", async () => {
		const site = running({ ...CONFIG, deliveries: [mail] });
		const calls = await emailWay(site);
		expect([...site.deliveries.rows.values()]).toHaveLength(1);
		console.info("email way", calls.length, calls.join(" "));
		expect(calls.length).toBeLessThanOrEqual(LIMIT.emailWay);
	});

	it("the scheduled run that sends a due try", async () => {
		const site = running();
		due(site);
		const calls = await cron(site, "deliver");
		expect(site.deliveries.rows.get(`sub9~${zap.id}`)).toMatchObject({ status: "delivered" });
		console.info("deliver", calls.length, calls.join(" "));
		expect(calls.length).toBeLessThanOrEqual(LIMIT.deliver);
	});

	it("the every-minute run, first of the day, with a due try", async () => {
		const site = running();
		due(site);
		const calls = await cron(site, "maintenance");
		expect(site.deliveries.rows.get(`sub9~${zap.id}`)).toMatchObject({ status: "delivered" });
		console.info("maintenance", calls.length, calls.join(" "));
		expect(calls.length).toBeLessThanOrEqual(LIMIT.maintenance);
	});

	it("the every-minute run with nothing to do stays well within 10", async () => {
		const site = running();
		site.kv.set("daily", new Date().toISOString().slice(0, 10));
		const calls = await cron(site, "maintenance");
		console.info("idle maintenance", calls.length, calls.join(" "));
		expect(calls.length).toBeLessThanOrEqual(6);
	});
});

describe("host calls on the first run after updating", () => {
	it("an enquiry arriving straight from a form copies the settings across and still delivers", async () => {
		const site = justUpdated();
		const calls = await inbound(site);
		expect(site.deliveries.rows.get(`sub1~${zap.id}`)).toMatchObject({ status: "delivered" });
		console.info("inbound, first after update", calls.length, calls.join(" "));
		// Once: each old key read and copied forward (4 calls), with the config and forms read once.
		expect(calls.length).toBeLessThanOrEqual(LIMIT.inbound + 4);
	});

	it("an enquiry arriving the email way copies the settings across and is recorded", async () => {
		const site = justUpdated({ ...CONFIG, deliveries: [mail] });
		const calls = await emailWay(site);
		expect([...site.deliveries.rows.values()]).toHaveLength(1);
		console.info("email way, first after update", calls.length, calls.join(" "));
		expect(calls.length).toBeLessThanOrEqual(LIMIT.emailWay + 4);
	});
});
