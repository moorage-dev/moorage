// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";
import * as old from "./fixtures/v015/config.js";

// Where the settings live. EmDash 1.3 keeps a plugin's KV in a different table depending
// on how the plugin runs (emdash-cms/emdash#4269): in-process in `options` as
// `plugin:approvals:<key>`, sandboxed in `_plugin_storage` (`__kv`). Only `settings:` keys
// are in one place for both: `options`, `plugin:approvals:settings:<key>`.
//
// This harness runs the plugin sandboxed, through EmDash's real bridge. Its fixtures write
// both places: `fixtures.plugin.kv` the sandboxed `__kv` row, `fixtures.plugin.setting`
// the `options` row an in-process plugin reads for `settings:config`
// (emdash src/plugins/context.ts:143 and settings.ts:238).
//
// Going back to 0.1.5 must keep working: its config reader is vendored unchanged from
// 564ec81 in tests/fixtures/v015, and it reads only the plain `config` key.

const HELD = { collections: ["pages"], preset: "others", ai: true, checks: "remind", remind: true };

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function site() {
	const runtime = await createPluginRuntimeTestHost({
		site: { name: "Harbour Street Bakery", url: "https://bakery.test", locale: "en" },
	});
	host = runtime;
	await runtime.fixtures.collection({
		slug: "pages",
		label: "Pages",
		supports: ["drafts", "revisions"],
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "text" },
		],
	});
	const admin = await runtime.fixtures.user({
		email: "ellen@agency.test",
		name: "Ellen Marsh",
		role: "admin",
	});
	const editor = await runtime.fixtures.user({
		email: "sam@bakery.test",
		name: "Sam Reyes",
		role: "editor",
	});
	return { host: runtime, admin, editor };
}

type Site = Awaited<ReturnType<typeof site>>;

/** Whether an Editor's publish is held. */
async function held(s: Site): Promise<boolean> {
	const created = await s.host.actions.content.create("pages", {
		data: { title: "Summer menu", content: "Iced coffee and lemon tart" },
		slug: `menu-${crypto.randomUUID().slice(0, 8)}`,
		authorId: s.editor.id,
		actor: { id: s.editor.id, role: s.editor.role },
	});
	if (!created.success) throw new Error(created.error.message);
	const result = await s.host.actions.content.publish("pages", created.data.item.id, {
		actor: { id: s.editor.id, role: s.editor.role },
		origin: { source: "api" },
	});
	return !result.success;
}

describe("settings saved by 0.1.5 under the plain `config` key", () => {
	it("still hold publishing, are copied to `settings:config`, and the old key is kept", async () => {
		const s = await site();
		await s.host.fixtures.plugin.kv("config", HELD);

		expect(await held(s)).toBe(true);
		expect(await s.host.inspect.setting("config")).toEqual(HELD);
		expect(await s.host.inspect.kv.get("config")).toEqual(HELD);
	});

	it("show on the Approvals page and are copied when an Admin opens it first", async () => {
		const s = await site();
		await s.host.fixtures.plugin.kv("config", { ...HELD, preset: "me" });

		const response = await s.host.admin.loadPage("/overview", { user: s.admin });
		expect(JSON.stringify(response)).not.toContain("Approval is off until you save these settings");
		expect(await s.host.inspect.setting("config")).toEqual({ ...HELD, preset: "me" });
	});
});

describe("switching between in-process and sandboxed", () => {
	it("a sandboxed plugin holds publishing with settings an in-process one saved", async () => {
		const s = await site();
		await s.host.fixtures.plugin.setting("config", HELD);

		expect(await held(s)).toBe(true);
	});

	it("an in-process plugin will read what a sandboxed one saves", async () => {
		const s = await site();
		const saved = await s.host.admin.submit(
			"/overview",
			"save_settings",
			{ collections: ["pages"], preset: "me", ai: true, checks: "require" },
			{ user: s.admin },
		);
		expect(saved.toast?.type).toBe("success");
		expect(await s.host.inspect.setting("config")).toMatchObject({
			collections: ["pages"],
			preset: "me",
			checks: "require",
		});
	});

	it("the shared settings win over a leftover plain `config` from the other mode", async () => {
		const s = await site();
		// Saved in this mode once, before a switch: nothing held. Now the shared settings hold pages.
		await s.host.fixtures.plugin.kv("config", { ...HELD, collections: [] });
		await s.host.fixtures.plugin.setting("config", HELD);

		expect(await held(s)).toBe(true);
	});
});

describe("going back to 0.1.5 after this release has saved", () => {
	it("0.1.5's reader still finds the newest settings under `config`", async () => {
		const s = await site();
		await s.host.fixtures.plugin.kv("config", HELD);
		await s.host.admin.submit(
			"/overview",
			"save_settings",
			{ collections: ["pages"], preset: "me", ai: false, checks: "off" },
			{ user: s.admin },
		);

		const plain = await s.host.inspect.kv.get("config");
		const shared = await s.host.inspect.setting("config");
		expect(normalizeConfig(shared)).toMatchObject({ preset: "me", ai: false, checks: "off" });
		expect(old.normalizeConfig(plain)).toEqual(old.normalizeConfig(shared));
	});
});
