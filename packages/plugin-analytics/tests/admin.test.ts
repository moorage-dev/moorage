// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { toolStatus, warnings } from "../src/admin.js";
import { CONFIG_KEY, DEFAULT_MESSAGE, DEFAULT_TITLE, normalizeConfig } from "../src/config.js";
import type { AnalyticsConfig } from "../src/config.js";
import { createPlugin } from "../src/index.js";
import { PRUNE_TASK } from "../src/record.js";
import { fakeContext, type FakeContext } from "./helpers.js";

const ADMIN = 50;
const EDITOR = 40;

/** Call the real admin route the way the admin does. */
async function call(fake: FakeContext, input: unknown, role = ADMIN): Promise<BlockResponse> {
	const handler = createPlugin().routes.admin!.handler;
	const response = await handler({
		...fake.ctx,
		input,
		user: { id: "u1", email: "a@acme.test", name: null, role, createdAt: "" },
	} as unknown as RouteContext);
	return response as BlockResponse;
}

const load = (fake: FakeContext, role = ADMIN) =>
	call(fake, { type: "page_load", page: "/settings" }, role);
const submit = (fake: FakeContext, action: string, values: Record<string, unknown>, role = ADMIN) =>
	call(fake, { type: "form_submit", action_id: action, values }, role);

function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) =>
		block.type === "tab"
			? [block, ...block.panels.flatMap((panel) => flatten(panel.blocks))]
			: [block],
	);
}

function saved(fake: FakeContext): AnalyticsConfig {
	return fake.kv.get(CONFIG_KEY) as AnalyticsConfig;
}

function expectValid(response: BlockResponse): void {
	expect(validateBlockResponse(response, { pluginPagePaths: ["/settings"] })).toEqual({
		valid: true,
		errors: [],
	});
}

describe("the admin page", () => {
	it("shows an admin four tabs, starting on Status", async () => {
		const response = await load(fakeContext());
		expectValid(response);
		const tabs = response.blocks.find((block) => block.type === "tab");
		expect(tabs?.type === "tab" && tabs.panels.map((panel) => panel.label)).toEqual([
			"Status",
			"Tracking tools",
			"Cookie banner",
			"Advanced",
		]);
		expect(tabs?.type === "tab" && tabs.default_tab).toBe(0);
		expect(JSON.stringify(response)).toContain("Nothing is being tracked yet");
	});

	it("shows an editor the status only, and refuses their changes", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" } } });
		const response = await load(fake, EDITOR);
		expectValid(response);
		expect(flatten(response.blocks).some((block) => block.type === "form")).toBe(false);
		expect(flatten(response.blocks).some((block) => block.type === "tab")).toBe(false);
		expect(JSON.stringify(response)).toContain("Only an administrator can change these settings.");
		expect(JSON.stringify(response)).toContain("Google Analytics");

		const refused = await submit(fake, "save_tools", { ga4: "" }, EDITOR);
		expect(refused.toast).toEqual({
			type: "error",
			message: "Only an administrator can change these settings.",
		});
		expect(saved(fake).tools.ga4).toBe("G-AB12CD34EF");
		// An editor opening the page changes nothing, the schedule included.
		expect(fake.scheduled).toEqual([]);
	});

	it("keeps every screen valid Block Kit and free of the company name", async () => {
		const fake = fakeContext();
		const screens = [
			await load(fake),
			await load(fake, EDITOR),
			await submit(fake, "save_tools", { ga4: "UA-1-1", gtm: "nope" }),
			await submit(fake, "save_tools", {
				ga4: "G-AB12CD34EF",
				gtm: "GTM-AB12CD3",
				ads: "AW-123456789",
				meta: "123456789012345",
				clarity: "ab12cd34ef",
				hubspot: "12345678",
				cloudflare: "0123456789abcdef0123456789abcdef",
			}),
			await submit(fake, "save_banner", { policy_url: "javascript:alert(1)" }),
			await submit(fake, "save_banner", { audience: "none", policy_url: "/privacy" }),
			await submit(fake, "save_advanced", { exclude: "/a\n/b", gtm_loading: "immediate" }),
			await call(fake, { type: "block_action", action_id: "reset_text" }),
			await call(fake, { type: "block_action", action_id: "unknown" }),
			await call(fake, undefined),
			await call(fake, "nonsense"),
			await load(fake),
		];
		for (const screen of screens) {
			expectValid(screen);
			expect(JSON.stringify(screen)).not.toMatch(/moorage|gosi/i);
		}
	});

	it("makes sure the daily clean-up is scheduled when an admin opens the page", async () => {
		const fake = fakeContext();
		await load(fake);
		await load(fake);
		expect(fake.scheduled).toEqual([{ name: PRUNE_TASK, schedule: "@daily" }]);
	});
});

describe("saving tracking tools", () => {
	it("saves tidy IDs, picks them out of pasted snippets, and returns to the same tab", async () => {
		const fake = fakeContext();
		const response = await submit(fake, "save_tools", {
			ga4: " g-ab12cd34ef ",
			meta: "fbq('init', '123456789012345');",
			hubspot_eu: true,
			enquiries: false,
		});
		expect(response.toast?.type).toBe("success");
		expect(saved(fake).tools).toMatchObject({ ga4: "G-AB12CD34EF", meta: "123456789012345" });
		expect(saved(fake).hubspotEu).toBe(true);
		expect(saved(fake).enquiries).toBe(false);
		const tabs = response.blocks.find((block) => block.type === "tab");
		expect(tabs?.type === "tab" && tabs.default_tab).toBe(1);
	});

	it("saves nothing when one ID is wrong, names every mistake and keeps what was typed", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { tools: { clarity: "ab12cd34ef" } } });
		const response = await submit(fake, "save_tools", {
			ga4: "UA-12345678-1",
			gtm: "G-AB12CD34EF",
			meta: "123456789012345",
		});
		expect(response.toast?.type).toBe("error");
		expect(saved(fake)).toEqual({ tools: { clarity: "ab12cd34ef" } });
		const text = JSON.stringify(response);
		expect(text).toContain("Nothing was saved. Please fix this first:");
		expect(text).toContain("Google Analytics: That is an old Universal Analytics ID (UA-).");
		expect(text).toContain("Put it in the Google Analytics box instead.");

		const form = flatten(response.blocks).find(
			(block) => block.type === "form" && block.block_id?.startsWith("tools-"),
		);
		const fields = form?.type === "form" ? form.fields : [];
		const typed = Object.fromEntries(
			fields.map((field) => [
				field.action_id,
				(field as { initial_value?: unknown }).initial_value,
			]),
		);
		expect(typed).toMatchObject({
			ga4: "UA-12345678-1",
			gtm: "G-AB12CD34EF",
			meta: "123456789012345",
			clarity: "ab12cd34ef",
		});
	});

	it("keeps fields the form did not send, and clears one sent empty", async () => {
		const fake = fakeContext({
			[CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF", clarity: "ab12cd34ef" }, hubspotEu: true },
		});
		await submit(fake, "save_tools", { clarity: "" });
		expect(saved(fake).tools).toMatchObject({ ga4: "G-AB12CD34EF", clarity: "" });
		expect(saved(fake).hubspotEu).toBe(true);
	});

	it("gives a form a new identity after a save, so the tidied values show", async () => {
		const fake = fakeContext();
		const id = (response: BlockResponse) =>
			flatten(response.blocks).find(
				(block) => block.type === "form" && block.block_id?.startsWith("tools-"),
			)?.block_id;
		const before = id(await load(fake));
		const refused = id(await submit(fake, "save_tools", { ga4: "nope" }));
		const after = id(await submit(fake, "save_tools", { ga4: "G-AB12CD34EF" }));
		expect(refused).toBe(before);
		expect(after).not.toBe(before);
	});
});

describe("saving the banner and advanced settings", () => {
	it("saves who sees the banner and how it looks", async () => {
		const fake = fakeContext();
		await submit(fake, "save_banner", {
			audience: "everyone",
			policy_url: " /privacy ",
			title: "Your privacy",
			message: "We use a few cookies.",
			position: "left",
			scheme: "dark",
			settings_button: false,
			months: "12",
		});
		expect(saved(fake).banner).toEqual({
			audience: "everyone",
			policyUrl: "/privacy",
			title: "Your privacy",
			message: "We use a few cookies.",
			position: "left",
			scheme: "dark",
			settingsButton: false,
			months: 12,
		});
	});

	it("refuses a policy link that is not a page or a web link", async () => {
		const fake = fakeContext();
		const response = await submit(fake, "save_banner", { policy_url: "javascript:alert(1)" });
		expect(response.toast?.type).toBe("error");
		expect(JSON.stringify(response)).toContain("Privacy policy page: type a page on this site");
		expect(fake.kv.has(CONFIG_KEY)).toBe(false);
	});

	it("puts the original text back", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { banner: { title: "Mine", message: "Mine too" } } });
		const response = await call(fake, { type: "block_action", action_id: "reset_text" });
		expect(response.toast?.type).toBe("success");
		expect(saved(fake).banner).toMatchObject({ title: DEFAULT_TITLE, message: DEFAULT_MESSAGE });
	});

	it("saves the pages not to track and when Tag Manager loads", async () => {
		const fake = fakeContext();
		await submit(fake, "save_advanced", {
			exclude: "/thank-you\nhttps://acme.test/landing/",
			gtm_loading: "immediate",
		});
		expect(saved(fake).exclude).toEqual(["/thank-you", "/landing/"]);
		expect(saved(fake).gtmLoading).toBe("immediate");
	});
});

describe("status wording", () => {
	const config = (raw: unknown) => normalizeConfig(raw);

	it("says in one line what each tool does", () => {
		const europe = config({
			tools: {
				ga4: "G-AB12CD34EF",
				meta: "123456789012345",
				gtm: "GTM-AB12CD3",
				cloudflare: "0123456789abcdef0123456789abcdef",
			},
		});
		expect(toolStatus(europe, "ga4")).toBe(
			"Google Analytics: on. Waits for visitors in Europe and the UK to accept Analytics cookies. Loads straight away for everyone else.",
		);
		expect(toolStatus(europe, "meta")).toBe(
			"Meta Pixel: on. Waits for visitors in Europe and the UK to accept Marketing cookies. Loads straight away for everyone else.",
		);
		expect(toolStatus(europe, "gtm")).toBe(
			"Google Tag Manager: on. Waits for visitors in Europe and the UK to accept at least one kind of cookie. Loads straight away for everyone else.",
		);
		expect(toolStatus(europe, "cloudflare")).toBe(
			"Cloudflare Web Analytics: on. Counts visitors without cookies, so it does not wait.",
		);
		const everyone = config({ tools: { ga4: "G-AB12CD34EF" }, banner: { audience: "everyone" } });
		expect(toolStatus(everyone, "ga4")).toBe(
			"Google Analytics: on. Waits for every visitor to accept Analytics cookies.",
		);
		const none = config({ tools: { ga4: "G-AB12CD34EF" }, banner: { audience: "none" } });
		expect(toolStatus(none, "ga4")).toBe(
			"Google Analytics: on. Loads for every visitor without asking.",
		);
	});

	it("warns about a missing policy link, double counting and early loading", () => {
		const titles = (raw: unknown) => warnings(config(raw)).map((warning) => warning.title);
		expect(titles({})).toEqual([]);
		expect(titles({ tools: { cloudflare: "0123456789abcdef0123456789abcdef" } })).toEqual([]);
		expect(titles({ tools: { ga4: "G-AB12CD34EF" } })).toEqual([
			"The banner has no link to your privacy policy",
		]);
		expect(
			titles({
				tools: { ga4: "G-AB12CD34EF", gtm: "GTM-AB12CD3" },
				banner: { policyUrl: "/privacy" },
				gtmLoading: "immediate",
			}),
		).toEqual([
			"Google Tag Manager loads before visitors answer",
			"Google Analytics may be counting twice",
		]);
		expect(titles({ tools: { ga4: "G-AB12CD34EF" }, banner: { audience: "none" } })).toEqual([
			"Your tools load without asking anyone",
		]);
	});

	it("shows the 30-day answers once the banner is in use", async () => {
		const fake = fakeContext({
			[CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" }, banner: { policyUrl: "/privacy" } },
		});
		fake.rows.set("a1", { at: new Date().toISOString(), choice: "all" });
		fake.rows.set("a2", { at: new Date().toISOString(), choice: "none" });
		fake.rows.set("a3", { at: new Date().toISOString(), choice: "none" });
		const stats = flatten((await load(fake)).blocks).find((block) => block.type === "stats");
		expect(stats?.type === "stats" && stats.items.map((item) => [item.label, item.value])).toEqual([
			["Accepted all", 1],
			["Rejected all", 2],
			["Chose some", 0],
		]);
	});
});
