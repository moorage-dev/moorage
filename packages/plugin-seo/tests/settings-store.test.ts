// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { PageMetadataContribution, PublicPageContext } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";
import * as old from "./fixtures/v017/config.js";

// Where the settings live. EmDash 1.3 keeps a plugin's KV in a different table depending
// on how the plugin runs (emdash-cms/emdash#4269): in-process in `options` as
// `plugin:seo:<key>`, sandboxed in `_plugin_storage` (`__kv`). Only `settings:` keys are
// in one place for both: `options`, `plugin:seo:settings:<key>`.
//
// This harness runs the plugin sandboxed, through EmDash's real bridge. Its fixtures write
// both places: `fixtures.plugin.kv` the sandboxed `__kv` row, `fixtures.plugin.setting`
// the `options` row an in-process plugin reads for `settings:config`
// (emdash src/plugins/context.ts:143 and settings.ts:238). So "written in-process, read
// sandboxed" and back can be shown here without a second runner.
//
// Going back to 0.1.7 must keep working: its config reader is vendored unchanged from
// 8f3b6fb in tests/fixtures/v017, and it reads only the plain `config` key.

const SAVED = {
	site: {
		type: "Dentist",
		name: "Acme Dental",
		telephone: "+1 555 0100",
		address: { streetAddress: "1 Main St" },
	},
	collections: { pages: { type: "ContactPage", noindex: true } },
};

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function start(): Promise<PluginRuntimeTestHost> {
	host = await createPluginRuntimeTestHost({
		site: { name: "Acme", url: "https://acme.test", locale: "en" },
	});
	return host;
}

const PAGE: PublicPageContext = {
	url: "https://acme.test/about",
	path: "/about",
	locale: null,
	kind: "custom",
	pageType: "website",
	title: "About | Acme",
	pageTitle: "About",
	description: null,
	canonical: null,
	image: null,
};

/** The organisation's name and type on a public page. */
async function organisation(runtime: PluginRuntimeTestHost): Promise<unknown> {
	const contributions = (await runtime.transport.invokeHook("page:metadata", {
		page: PAGE,
	})) as PageMetadataContribution[];
	const primary = contributions.find((c) => c.kind === "jsonld" && c.id === "primary");
	const graph = primary?.kind === "jsonld" ? primary.graph : undefined;
	const nodes = (graph as { "@graph"?: Array<Record<string, unknown>> })?.["@graph"] ?? [];
	const node = nodes[0];
	return node ? { type: node["@type"], name: node.name } : null;
}

describe("settings saved by 0.1.7 under the plain `config` key", () => {
	it("are read on a page view, copied to `settings:config`, and the old key is kept", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.kv("config", SAVED);

		expect(await organisation(runtime)).toEqual({ type: "Dentist", name: "Acme Dental" });
		expect(await runtime.inspect.setting("config")).toEqual(SAVED);
		expect(await runtime.inspect.kv.get("config")).toEqual(SAVED);
	});

	it("are read and copied when an Admin opens the SEO page first", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.kv("config", SAVED);

		const response = await runtime.admin.loadPage("/overview");
		expect(JSON.stringify(response.blocks)).toContain("Acme Dental");
		expect(await runtime.inspect.setting("config")).toEqual(SAVED);
		expect(await runtime.inspect.kv.get("config")).toEqual(SAVED);
	});
});

describe("switching between in-process and sandboxed", () => {
	it("a sandboxed plugin reads the settings an in-process one saved", async () => {
		const runtime = await start();
		// Saved in-process by this release: only the `options` row exists.
		await runtime.fixtures.plugin.setting("config", SAVED);

		expect(await organisation(runtime)).toEqual({ type: "Dentist", name: "Acme Dental" });
	});

	it("an in-process plugin will read what a sandboxed one saves", async () => {
		const runtime = await start();
		const saved = await runtime.admin.submit("/overview", "save_identity", {
			kind: "organization",
			name: "Harbour Bakery",
		});
		expect(saved.toast?.type).toBe("success");

		const shared = await runtime.inspect.setting("config");
		expect(normalizeConfig(shared).site).toMatchObject({ name: "Harbour Bakery" });
	});

	it("the shared settings win over a leftover plain `config` from the other mode", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", SAVED);
		// An old value this mode kept from before a switch: never read while the shared one exists.
		await runtime.fixtures.plugin.kv("config", { site: { name: "Stale Name" } });

		expect(await organisation(runtime)).toEqual({ type: "Dentist", name: "Acme Dental" });
		const response = await runtime.admin.loadPage("/overview");
		expect(JSON.stringify(response.blocks)).not.toContain("Stale Name");
	});
});

describe("going back to 0.1.7 after this release has saved", () => {
	it("0.1.7's reader still finds the newest settings under `config`", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.kv("config", SAVED);
		await runtime.admin.submit("/overview", "save_identity", {
			kind: "organization",
			name: "Acme Clinic",
		});

		const plain = await runtime.inspect.kv.get("config");
		const shared = await runtime.inspect.setting("config");
		expect(normalizeConfig(shared).site).toMatchObject({ name: "Acme Clinic" });
		// What 0.1.7 reads is what this release saved.
		expect(old.normalizeConfig(plain)).toEqual(old.normalizeConfig(shared));
		expect(old.normalizeConfig(plain).site).toMatchObject({ name: "Acme Clinic" });
	});
});
