// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";
import type { Config, Delivery, KnownForm, Send } from "../src/types.js";
import * as old from "./fixtures/v030/config.js";
import * as v031 from "./fixtures/v031/config.js";
import { runQueued } from "./queue.js";

// Where the settings live. EmDash 1.3 keeps a plugin's KV in a different table depending on how
// the plugin runs (emdash-cms/emdash#4269): in-process in `options` as `plugin:lead-delivery:<key>`,
// sandboxed in `_plugin_storage` (`__kv`). Only `settings:` keys are in one place for both.
//
// This harness runs the plugin sandboxed. `fixtures.plugin.kv` writes the sandboxed `__kv` row,
// `fixtures.plugin.setting` the shared row an in-process plugin reads too. A leftover plain key
// stands for what the other mode saved before a switch.
//
// The private key matters most: it is in every connected form's address and in the private
// email address. A new one made after a switch would disconnect every form.
//
// Going back must keep working. 0.3.1's reader (vendored unchanged from cb2bb02 in
// tests/fixtures/v031) reads the settings first, so it sees everything this release writes.
// 0.3.0's reader (vendored from 3f5ecf2 in tests/fixtures/v030) reads only the plain `config`
// and `forms` keys, which this release writes on an admin's save only: an arriving enquiry
// (on Cloudflare limited to 10 calls) updates the known forms in the settings alone.
//
// From 0.4 the hot paths (an arriving enquiry, the scheduled runs) read the settings and the
// plain keys with one `ctx.kv.list()` and copy nothing: the admin page copies settings found
// only under the plain keys.

const ORIGIN = "https://crumb.test";
const HOOK = "https://hooks.zapier.com/hooks/catch/123/abc/";
const KEY = "K".repeat(32);
const OTHER = "Q".repeat(32);

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
	name: "Every form → orders@crumb.test",
	forms: "all",
	on: true,
	repeat: "off",
	holdSpam: false,
	createdAt: "2026-10-20T00:00:00.000Z",
	to: ["orders@crumb.test"],
};

const CONFIG: Config = {
	version: 2,
	deliveries: [zap, mail],
	alertTo: ["anna@crumb.test"],
	key: KEY,
	keySetAt: "2026-10-01T00:00:00.000Z",
	reach: { result: "self", at: "2026-10-01T00:00:00.000Z" },
};

const CONNECTED = "2026-10-02T00:00:00.000Z";
const FORMS: Record<string, KnownForm> = {
	contact: {
		slug: "contact",
		name: "Contact us",
		fields: [{ key: "name", label: "Your name" }],
		source: "definition",
		addedAt: "2026-10-01T00:00:00.000Z",
		days: [],
		connectedAt: CONNECTED,
		connectedWay: "straight",
	},
};

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function site() {
	host = await createPluginRuntimeTestHost({
		site: { name: "Crumb & Co.", url: ORIGIN, locale: "en" },
	});
	await host.http.respond(HOOK, new Response("ok", { status: 200 }));
	const admin = await host.fixtures.user({ email: "anna@crumb.test", role: "admin" });
	return { runtime: host, admin };
}

/** 0.3.0's settings, as it left them in this mode's KV. */
async function savedBy030(runtime: PluginRuntimeTestHost, config: Config = CONFIG) {
	await runtime.fixtures.plugin.kv("config", config);
	await runtime.fixtures.plugin.kv("forms", FORMS);
}

function payload(id: string) {
	return {
		event: "form.submission",
		formId: "contact",
		formName: "Contact us",
		submissionId: id,
		data: { name: "Tom Reyes", email: "tom@example.com", message: "Hello" },
		files: [],
		submittedAt: new Date().toISOString(),
	};
}

async function inbound(runtime: PluginRuntimeTestHost, key: string, id = "sub1") {
	return runtime.actions.routes.request("inbound", {
		method: "POST",
		url: `${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${key}`,
		body: payload(id),
	});
}

async function emailWay(runtime: PluginRuntimeTestHost, key: string) {
	return runtime.transport.invokeHook("email:beforeSend", {
		source: "emdash-forms",
		message: {
			to: `enquiries-${key}@lead-delivery.invalid`,
			subject: "New submission: Contact us",
			text: 'New submission for "Contact us"\n\nYour name: Tom Reyes\nEmail: tom@example.com\nMessage: Hello\n\nSubmitted at: 2026-10-16T09:00:00.000Z',
		},
	});
}

async function rows(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.storage.list<Send>("deliveries")).map((r) => r.data);
}

const sharedKey = async (runtime: PluginRuntimeTestHost) =>
	(await runtime.inspect.setting<Config>("config"))?.key;

describe("settings saved by 0.3.0 under the plain `config` and `forms` keys", () => {
	it("an enquiry arriving first after the update is delivered; the admin page copies the settings and the old keys stay", async () => {
		const { runtime, admin } = await site();
		await savedBy030(runtime);

		const response = await inbound(runtime, KEY);
		expect(response.status).toBe(200);
		await runQueued(runtime);
		expect((await rows(runtime)).find((r) => r.destination === zap.id)?.status).toBe("delivered");
		expect(await runtime.inspect.setting("config")).toBeNull();

		await runtime.admin.loadPage("/enquiries", { user: admin });
		expect(await sharedKey(runtime)).toBe(KEY);
		expect(await runtime.inspect.setting("config")).toMatchObject({
			deliveries: [{ id: zap.id }, { id: mail.id }],
			alertTo: CONFIG.alertTo,
			keySetAt: CONFIG.keySetAt,
		});
		const forms = await runtime.inspect.setting<Record<string, KnownForm>>("forms");
		expect(forms?.contact?.connectedAt).toBe(CONNECTED);
		expect(forms?.contact?.lastAt).toBeTruthy();
		// Kept for rollback until a later release.
		expect((await runtime.inspect.kv.get<Config>("config"))?.key).toBe(KEY);
		expect(await runtime.inspect.kv.get("forms")).toBeTruthy();
	});

	it("an email to the old private address, first after the update, is recorded and cancelled", async () => {
		const { runtime } = await site();
		await savedBy030(runtime);

		expect(await emailWay(runtime, KEY)).toBe(false);
		// The email names the form "Contact us", known from 0.3.0's forms as "contact".
		expect((await rows(runtime)).map((r) => r.formId)).toEqual(["contact", "contact"]);
		expect((await runtime.inspect.kv.get<Config>("config"))?.key).toBe(KEY);
	});

	it.each([
		["activation", (r: PluginRuntimeTestHost) => r.actions.plugin.activate()],
		[
			"the scheduled run",
			(r: PluginRuntimeTestHost) =>
				r.transport.invokeHook("cron", { name: "maintenance", data: null }),
		],
	])("keeps the private key when %s reads first", async (_name, first) => {
		const { runtime, admin } = await site();
		await savedBy030(runtime);

		await first(runtime);
		expect((await inbound(runtime, KEY)).status).toBe(200);
		await runtime.admin.loadPage("/enquiries", { user: admin });
		expect(await sharedKey(runtime)).toBe(KEY);
	});

	it("the Lead delivery page, opened first, shows the same private address", async () => {
		const { runtime, admin } = await site();
		await savedBy030(runtime);

		await runtime.admin.loadPage("/enquiries", { user: admin });
		expect(await sharedKey(runtime)).toBe(KEY);
		expect((await runtime.inspect.kv.get<Config>("config"))?.key).toBe(KEY);
	});
});

describe("switching between in-process and sandboxed", () => {
	it("a sandboxed plugin accepts the private address an in-process one made", async () => {
		const { runtime } = await site();
		await runtime.fixtures.plugin.setting("config", CONFIG);
		await runtime.fixtures.plugin.setting("forms", FORMS);

		expect((await inbound(runtime, KEY)).status).toBe(200);
		expect(await emailWay(runtime, KEY)).toBe(false);
		expect(await sharedKey(runtime)).toBe(KEY);
	});

	it("the shared settings win over a leftover plain `config` and `forms` from the other mode", async () => {
		const { runtime, admin } = await site();
		// Saved in this mode once, before a switch: another key, no deliveries, form not connected.
		await runtime.fixtures.plugin.kv("config", { ...CONFIG, key: OTHER, deliveries: [] });
		const { connectedAt: _c, connectedWay: _w, ...unconnected } = FORMS.contact!;
		await runtime.fixtures.plugin.kv("forms", { contact: unconnected });
		await runtime.fixtures.plugin.setting("config", CONFIG);
		await runtime.fixtures.plugin.setting("forms", FORMS);

		expect((await inbound(runtime, OTHER)).status).toBe(401);
		expect((await inbound(runtime, KEY)).status).toBe(200);
		await runQueued(runtime);
		expect((await rows(runtime)).find((r) => r.destination === zap.id)?.status).toBe("delivered");
		await runtime.admin.loadPage("/enquiries", { user: admin });
		expect(await sharedKey(runtime)).toBe(KEY);
		const forms = await runtime.inspect.setting<Record<string, KnownForm>>("forms");
		expect(forms?.contact?.connectedAt).toBe(CONNECTED);
	});

	it("never makes a new private key while an old one is waiting under the plain key", async () => {
		const { runtime, admin } = await site();
		// Shared settings without a usable key, next to the old key: the old key is kept.
		await runtime.fixtures.plugin.setting("config", { ...CONFIG, key: "" });
		await savedBy030(runtime);

		expect((await inbound(runtime, KEY)).status).toBe(200);
		await runtime.admin.loadPage("/enquiries", { user: admin });
		expect(await sharedKey(runtime)).toBe(KEY);
	});

	it("a save writes the shared settings and keeps the plain key in step", async () => {
		const { runtime, admin } = await site();
		await savedBy030(runtime);
		await runtime.admin.submit(
			"/enquiries",
			"save_alerts",
			{ alert_to: "anna@crumb.test, sam@pixel.dev" },
			{ user: admin },
		);
		expect((await runtime.inspect.setting<Config>("config"))?.alertTo).toEqual([
			"anna@crumb.test",
			"sam@pixel.dev",
		]);
		expect((await runtime.inspect.kv.get<Config>("config"))?.alertTo).toEqual([
			"anna@crumb.test",
			"sam@pixel.dev",
		]);
	});
});

/** A context for an earlier release's reader, on what this release left in the site. */
function readerCtx(runtime: PluginRuntimeTestHost) {
	return {
		settings: {
			get: (key: string) => runtime.inspect.setting(key),
			set: async () => {},
		},
		kv: { get: (key: string) => runtime.inspect.kv.get(key), set: async () => {} },
		log: { warn() {}, info() {}, error() {}, debug() {} },
	} as unknown as Parameters<typeof v031.loadConfig>[0];
}

describe("going back after this release has saved and received", () => {
	async function used() {
		const { runtime, admin } = await site();
		await savedBy030(runtime);
		await runtime.admin.submit(
			"/enquiries",
			"save_alerts",
			{ alert_to: "anna@crumb.test, sam@pixel.dev" },
			{ user: admin },
		);
		await inbound(runtime, KEY);
		await runQueued(runtime);
		return runtime;
	}

	it("0.3.1's reader finds the newest settings and forms", async () => {
		const runtime = await used();
		const ctx = readerCtx(runtime);
		const config = await v031.loadConfig(ctx);
		expect(config.key).toBe(KEY);
		expect(config.alertTo).toEqual(["anna@crumb.test", "sam@pixel.dev"]);
		expect(config.deliveries.map((d) => d.id)).toEqual([zap.id, mail.id]);
		const forms = await v031.loadForms(ctx);
		expect(forms).toEqual(await runtime.inspect.setting("forms"));
		expect(forms.contact?.connectedAt).toBe(CONNECTED);
		expect(forms.contact?.lastAt).toBeTruthy();
	});

	it("0.3.0's reader finds the newest setup an admin saved under the plain keys", async () => {
		const runtime = await used();
		const plain = await runtime.inspect.kv.get("config");
		const shared = await runtime.inspect.setting("config");
		expect(normalizeConfig(shared).alertTo).toEqual(["anna@crumb.test", "sam@pixel.dev"]);
		expect(old.normalizeConfig(plain)).toEqual(old.normalizeConfig(shared));
		expect(old.normalizeConfig(plain).key).toBe(KEY);

		// The forms as an admin last saved them: still connected; when the form last sent is not kept.
		const plainForms = await runtime.inspect.kv.get<Record<string, KnownForm>>("forms");
		expect(plainForms?.contact?.connectedAt).toBe(CONNECTED);
	});
});
