// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { toolStatus, warnings } from "../src/admin.js";
import { CONFIG_KEY, DEFAULT_MESSAGE, DEFAULT_TITLE, normalizeConfig } from "../src/config.js";
import type { AnalyticsConfig } from "../src/config.js";
import { HELP_LINE, HIDE_ACTION } from "../src/help-line.js";
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
		request: new Request("https://acme.test/_emdash/api/plugins/analytics-consent/admin"),
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

	it("keeps every screen valid Block Kit, with the company name only in the admin's help line", async () => {
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
			const rest = screen.blocks.filter((block) => block.block_id !== HELP_LINE);
			expect(JSON.stringify({ ...screen, blocks: rest })).not.toMatch(/moorage|gosi/i);
		}
	});

	it("makes sure the daily clean-up is scheduled when an admin opens the page", async () => {
		const fake = fakeContext();
		await load(fake);
		await load(fake);
		expect(fake.scheduled).toEqual([{ name: PRUNE_TASK, schedule: "@daily" }]);
	});
});

describe("the help line", () => {
	const line = (response: BlockResponse) =>
		response.blocks.find((block) => block.type === "actions" && block.block_id === HELP_LINE);

	it("ends an admin's page, under every tab, with the guide, the plugins and the maker", async () => {
		const response = await load(fakeContext());
		expectValid(response);
		expect(response.blocks.at(-1)).toEqual({
			type: "actions",
			block_id: HELP_LINE,
			elements: [
				{
					type: "link",
					label: "Help",
					target: {
						kind: "external",
						url: "https://moorage.dev/guides/add-google-analytics-and-a-cookie-banner-to-emdash",
					},
				},
				{
					type: "link",
					label: "More free plugins",
					target: { kind: "external", url: "https://moorage.dev/plugins" },
				},
				{
					type: "link",
					label: "by Moorage",
					target: { kind: "external", url: "https://moorage.dev" },
				},
			],
		});
		const after = await submit(fakeContext(), "save_advanced", { exclude: "/a" });
		expect(after.blocks.filter((block) => block.block_id === HELP_LINE)).toHaveLength(1);
	});

	it("never shows to an editor or anyone below", async () => {
		for (const role of [EDITOR, 30, 20]) {
			expect(JSON.stringify(await load(fakeContext(), role))).not.toMatch(/moorage/i);
		}
	});

	it("hides with the switch under Advanced, keeps it through other saves, and shows again", async () => {
		const fake = fakeContext();
		const page = await load(fake);
		expect(
			flatten(page.blocks).some(
				(block) => block.type === "form" && block.submit?.action_id === HIDE_ACTION,
			),
		).toBe(true);
		const hidden = await submit(fake, HIDE_ACTION, { hide_help_line: true });
		expect(line(hidden)).toBeUndefined();
		expect(hidden.toast).toEqual({ type: "success", message: "Saved. The help line is hidden." });
		expect(saved(fake).hideHelpLine).toBe(true);
		expect(line(await load(fake))).toBeUndefined();

		await submit(fake, "save_advanced", { exclude: "/a" });
		await submit(fake, "save_tools", { ga4: "G-AB12CD34EF" });
		await submit(fake, HIDE_ACTION, {});
		expect(saved(fake).hideHelpLine).toBe(true);
		expect(line(await load(fake))).toBeUndefined();

		expect(line(await submit(fake, HIDE_ACTION, { hide_help_line: false }))).toBeDefined();
	});

	it("shows on a site whose settings were saved before the switch existed", async () => {
		expect(line(await load(fakeContext({ [CONFIG_KEY]: { exclude: ["/a"] } })))).toBeDefined();
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
			settingsSide: "left",
			colors: { background: "", text: "", accent: "" },
			darkOn: false,
			darkColors: { background: "", text: "", accent: "" },
			months: 12,
		});
	});

	it("saves colours for the banner, and the corner of the Cookies button", async () => {
		const fake = fakeContext();
		await submit(fake, "save_banner", {
			settings_side: "right",
			color_background: "#FBF7F0",
			color_text: "#3b2a1a",
			color_accent: "#1f6f43",
		});
		expect(saved(fake).banner).toMatchObject({
			settingsSide: "right",
			colors: { background: "#fbf7f0", text: "#3b2a1a", accent: "#1f6f43" },
		});
	});

	it("refuses colours that are hard to read, half set, or not colours", async () => {
		for (const [values, words] of [
			[{ color_background: "#ffffff", color_text: "#cccccc" }, "hard to read"],
			[{ color_background: "#ffffff", color_text: "" }, "go together"],
			[{ color_accent: "green" }, "six digits"],
		] as const) {
			const fake = fakeContext();
			const response = await submit(fake, "save_banner", values);
			expect(response.toast?.type).toBe("error");
			expect(JSON.stringify(response)).toContain(words);
		}
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

describe("what a save says about visitors", () => {
	const LATER = "Saved. It can take a few minutes to reach visitors.";
	const withGa = { tools: { ga4: "G-AB12CD34EF" } };

	it("says only Saved when no tool is on, so visitors see nothing either way", async () => {
		const fake = fakeContext();
		const response = await submit(fake, "save_banner", { title: "Cookies?" });
		expect(response.toast).toEqual({ type: "success", message: "Saved." });
		expect(saved(fake).banner.title).toBe("Cookies?");
		const advanced = await submit(fake, "save_advanced", { exclude: "/thank-you" });
		expect(advanced.toast).toEqual({ type: "success", message: "Saved." });
	});

	it("says only Saved when a change has no effect on the page, such as an option for a tool that is off", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: withGa });
		const response = await submit(fake, "save_tools", { hubspot_eu: true });
		expect(response.toast).toEqual({ type: "success", message: "Saved." });
		expect(saved(fake).hubspotEu).toBe(true);
	});

	it("says it can take a few minutes when visitors see the change", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: withGa });
		const banner = await submit(fake, "save_banner", { title: "Cookies?" });
		expect(banner.toast).toEqual({ type: "success", message: LATER });
		const added = await submit(fakeContext(), "save_tools", { ga4: "G-AB12CD34EF" });
		expect(added.toast).toEqual({ type: "success", message: LATER });
	});

	it("says it can take a few minutes when the last tool is turned off", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: withGa });
		const response = await submit(fake, "save_tools", { ga4: "" });
		expect(response.toast).toEqual({ type: "success", message: LATER });
	});

	it("adds the few minutes to putting the original text back only when visitors see it", async () => {
		const quiet = fakeContext({ [CONFIG_KEY]: { banner: { title: "Mine" } } });
		const none = await call(quiet, { type: "block_action", action_id: "reset_text" });
		expect(none.toast).toEqual({
			type: "success",
			message: "The original heading and text are back.",
		});
		const live = fakeContext({ [CONFIG_KEY]: { ...withGa, banner: { title: "Mine" } } });
		const seen = await call(live, { type: "block_action", action_id: "reset_text" });
		expect(seen.toast).toEqual({
			type: "success",
			message:
				"The original heading and text are back. It can take a few minutes to reach visitors.",
		});
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
			"Google Analytics: on. Waits for visitors in Europe and the UK to accept Analytics cookies. Loads for everyone else without asking.",
		);
		expect(toolStatus(europe, "meta")).toBe(
			"Meta Pixel: on. Waits for visitors in Europe and the UK to accept Marketing cookies. Loads for everyone else without asking.",
		);
		expect(toolStatus(europe, "gtm")).toBe(
			"Google Tag Manager: on. Waits for visitors in Europe and the UK to accept at least one kind of cookie. Loads for everyone else without asking.",
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
		const early = config({ tools: { gtm: "GTM-AB12CD3" }, gtmLoading: "immediate" });
		expect(toolStatus(early, "gtm")).toBe(
			"Google Tag Manager: on. Loads for every visitor, before they answer.",
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

describe("dark mode colours and the preview", () => {
	it("saves dark mode colours only when they are turned on and readable", async () => {
		const fake = fakeContext();
		await submit(fake, "save_banner", {
			dark_colors: true,
			dark_background: "#1c1c1c",
			dark_text: "#f2f2f2",
			dark_accent: "#f5a0c5",
		});
		expect(saved(fake).banner).toMatchObject({
			darkOn: true,
			darkColors: { background: "#1c1c1c", text: "#f2f2f2", accent: "#f5a0c5" },
		});
		const refused = await submit(fakeContext(), "save_banner", {
			dark_colors: true,
			dark_background: "#1c1c1c",
			dark_text: "#333333",
		});
		expect(refused.toast?.type).toBe("error");
		expect(JSON.stringify(refused)).toContain("Dark mode: The text is hard to read");
	});

	it("links to a preview of the banner on the site's home page, in light and dark", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" } } });
		const response = await load(fake);
		expectValid(response);
		const text = JSON.stringify(response);
		expect(text).toContain("https://acme.test/?cookie_preview=light");
		expect(text).toContain("https://acme.test/?cookie_preview=dark");
	});

	it("points to the Tracking tools tab when there is no tool to preview", async () => {
		const response = await load(fakeContext());
		expectValid(response);
		const text = JSON.stringify(response);
		expect(text).toContain(
			"Add a tool on the Tracking tools tab to preview the banner on your site.",
		);
		expect(text).not.toContain("cookie_preview=");
	});
});

describe("who is asked", () => {
	it("suggests asking everyone when a tool records visits or advertises", async () => {
		const asksEurope = await load(
			fakeContext({ [CONFIG_KEY]: { tools: { clarity: "ab12cd34ef" } } }),
		);
		expect(JSON.stringify(asksEurope)).toContain("Consider asking every visitor");
		expect(JSON.stringify(asksEurope)).toContain("Microsoft Clarity records visits");
		const asksEveryone = await load(
			fakeContext({
				[CONFIG_KEY]: { tools: { clarity: "ab12cd34ef" }, banner: { audience: "everyone" } },
			}),
		);
		expect(JSON.stringify(asksEveryone)).not.toContain("Consider asking every visitor");
		const onlyAnalytics = await load(
			fakeContext({ [CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" } } }),
		);
		expect(JSON.stringify(onlyAnalytics)).not.toContain("Consider asking every visitor");
	});

	it("says beside each choice what it is for", async () => {
		const text = JSON.stringify(await load(fakeContext()));
		expect(text).toContain("recommended if you use Clarity, Meta Pixel or Google Ads");
		expect(text).toContain("for example in the US");
	});
});
