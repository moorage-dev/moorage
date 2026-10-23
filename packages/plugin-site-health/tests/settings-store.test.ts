// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { PluginContext } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import * as old from "./fixtures/v012/state.js";

// Where the email list and the "check links to other websites" choice live. EmDash 1.3
// keeps a plugin's KV in a different table depending on how the plugin runs
// (emdash-cms/emdash#4269): in-process in `options` as `plugin:site-health:<key>`,
// sandboxed in `_plugin_storage` (`__kv`). Only `settings:` keys are in one place for
// both: `options`, `plugin:site-health:settings:<key>`.
//
// This harness runs the plugin sandboxed, through EmDash's real bridge. Its fixtures write
// both places: `fixtures.plugin.kv` the sandboxed `__kv` row, `fixtures.plugin.setting`
// the `options` row an in-process plugin reads for `settings:options`
// (emdash src/plugins/context.ts:143 and settings.ts:238).
//
// Going back to 0.1.2 must keep working: its reader is vendored from aeb33cb in
// tests/fixtures/v012 (model.ts with one import line inlined), and it reads only the plain
// `options` key.

const PAGE = "/health";
const SAVED = { recipients: ["anna@acme.test", "studio@web.example"], outbound: false };

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function start(): Promise<PluginRuntimeTestHost> {
	host = await createPluginRuntimeTestHost({
		site: { name: "Acme Bakery", url: "https://acme.test", locale: "en" },
	});
	return host;
}

/** The email list as the Settings form shows it, one address per line. */
async function shownList(runtime: PluginRuntimeTestHost): Promise<string> {
	const page = JSON.stringify((await runtime.admin.loadPage(PAGE)).blocks);
	return page.match(/"action_id":"recipients"[^}]*"initial_value":"([^"]*)"/)?.[1] ?? "";
}

describe("settings saved by 0.1.2 under the plain `options` key", () => {
	it("are shown, copied to `settings:options`, and the old key is kept", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.kv("options", SAVED);

		expect(await shownList(runtime)).toBe("anna@acme.test\\nstudio@web.example");
		expect(await runtime.inspect.setting("options")).toEqual(SAVED);
		expect(await runtime.inspect.kv.get("options")).toEqual(SAVED);
	});
});

describe("switching between in-process and sandboxed", () => {
	it("a sandboxed plugin keeps the list an in-process one saved, not the Admin who opens the page", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);

		expect(await shownList(runtime)).toBe("anna@acme.test\\nstudio@web.example");
		expect(await runtime.inspect.setting("options")).toEqual(SAVED);
	});

	it("an in-process plugin will read what a sandboxed one saves", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_options", {
			recipients: "ellen@acme.test",
			outbound: false,
		});
		expect(await runtime.inspect.setting("options")).toEqual({
			recipients: ["ellen@acme.test"],
			outbound: false,
		});
	});

	it("the shared settings win over a leftover plain `options` from the other mode", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("options", SAVED);
		await runtime.fixtures.plugin.kv("options", { recipients: ["old@acme.test"], outbound: true });

		expect(await shownList(runtime)).toBe("anna@acme.test\\nstudio@web.example");
	});
});

describe("going back to 0.1.2 after this release has saved", () => {
	it("0.1.2's reader still finds the newest list and choice under `options`", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.kv("options", SAVED);
		await runtime.admin.submit(PAGE, "save_options", {
			recipients: "ellen@acme.test\nsam@pixel.dev",
			outbound: true,
		});

		// 0.1.2 reads everything with one kv.list(): give it what the sandboxed store holds.
		const rows = await runtime.inspect.kv.list();
		const ctx = {
			kv: { list: async () => rows.map((row) => ({ key: row.id, value: row.data })) },
		} as unknown as PluginContext;
		const back = await old.load(ctx);
		expect(back.options).toEqual({
			recipients: ["ellen@acme.test", "sam@pixel.dev"],
			outbound: true,
		});
		expect(await runtime.inspect.setting("options")).toEqual(back.options);
	});
});
