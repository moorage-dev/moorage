// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { FORGET_HELD_ACTION, NAME_HELD_ACTION } from "../src/admin.js";
import { bannerVersion, CONFIG_KEY, HELD_SEEN_KEY, normalizeConfig } from "../src/config.js";
import { clientConfig } from "../src/fragment.js";
import { createPlugin } from "../src/index.js";
import { wordsFor } from "../src/words.js";
import { fakeContext } from "./helpers.js";

const ADMIN = 50;
const EDITOR = 40;

/** The admin route, as the admin calls it. */
const admin = (fake: ReturnType<typeof fakeContext>, input: unknown, role = ADMIN) =>
	createPlugin().routes.admin!.handler({
		...fake.ctx,
		request: new Request("https://acme.test/_emdash/api/plugins/analytics-consent/admin"),
		input,
		user: { id: "u1", email: "a@acme.test", name: null, role, createdAt: "" },
	} as unknown as RouteContext);

/**
 * Consent for held videos and maps must be informed: once the site is known to
 * have them, the banner names them and Choose has a switch that releases them.
 */

const GA = { tools: { ga4: "G-AB12CD34EF" } };
const GA_META = { tools: { ga4: "G-AB12CD34EF", meta: "123456789012345" } };

describe("learning which videos and maps a site holds back", () => {
	const ask = async (fake: ReturnType<typeof fakeContext>, p?: string) =>
		createPlugin().routes.embeds!.handler({
			...fake.ctx,
			input: undefined,
			request: new Request(
				`https://acme.test/_emdash/api/plugins/analytics-consent/embeds${p ? `?p=${encodeURIComponent(p)}` : ""}`,
			),
		} as unknown as RouteContext);
	const seen = (fake: ReturnType<typeof fakeContext>) => fake.kv.get(HELD_SEEN_KEY) ?? [];
	const named = (fake: ReturnType<typeof fakeContext>) =>
		normalizeConfig(fake.kv.get(CONFIG_KEY)).heldEmbeds;

	it("notes each provider a held block names, once, in a fixed order, apart from the settings", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		const version = bannerVersion(normalizeConfig(GA));
		expect(await ask(fake, "Google Maps")).toMatchObject({ hold: true });
		expect(await ask(fake, "YouTube")).toMatchObject({ hold: true });
		await ask(fake, "YouTube");
		expect(seen(fake)).toEqual(["YouTube", "Google Maps"]);
		// This route is public: what it is told never changes the banner or its version.
		expect(fake.kv.get(CONFIG_KEY)).toEqual(GA);
		expect(named(fake)).toEqual([]);
		expect(bannerVersion(normalizeConfig(fake.kv.get(CONFIG_KEY)))).toBe(version);
	});

	it("keeps every name when several blocks on one page ask at once", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		await Promise.all(["Vimeo", "YouTube", "Google Maps"].map((name) => ask(fake, name)));
		expect(seen(fake)).toEqual(["YouTube", "Vimeo", "Google Maps"]);
	});

	it("notes nothing unknown, and nothing where nobody is asked", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		await ask(fake);
		const reads = fake.reads();
		await ask(fake, "<script>");
		await ask(fake, "Dailymotion");
		// An unknown name is turned away before anything is read for it.
		expect(fake.reads()).toBe(reads);
		expect(seen(fake)).toEqual([]);
		const quiet = fakeContext({ [CONFIG_KEY]: { ...GA, banner: { audience: "none" } } });
		expect(await ask(quiet, "YouTube")).toMatchObject({ hold: false });
		expect(seen(quiet)).toEqual([]);
	});

	it("names them in the banner only when an admin says so, and lets an admin take a name back", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		await ask(fake, "YouTube");
		await ask(fake, "Vimeo");
		const page = await admin(fake, { type: "page_load", page: "/settings" });
		expect(validateBlockResponse(page as never, { pluginPagePaths: ["/settings"] })).toEqual({
			valid: true,
			errors: [],
		});
		const status = JSON.stringify(page);
		expect(status).toContain("Your pages show videos or maps from YouTube and Vimeo");
		expect(status).toContain(NAME_HELD_ACTION);
		// An editor cannot.
		const refused = JSON.stringify(
			await admin(fake, { type: "block_action", action_id: NAME_HELD_ACTION }, EDITOR),
		);
		expect(refused).toContain("Only an administrator");
		expect(named(fake)).toEqual([]);
		const before = bannerVersion(normalizeConfig(fake.kv.get(CONFIG_KEY)));
		await admin(fake, { type: "block_action", action_id: NAME_HELD_ACTION });
		expect(named(fake)).toEqual(["YouTube", "Vimeo"]);
		expect(bannerVersion(normalizeConfig(fake.kv.get(CONFIG_KEY)))).not.toBe(before);
		const afterPage = await admin(fake, { type: "page_load", page: "/settings" });
		expect(
			validateBlockResponse(afterPage as never, { pluginPagePaths: ["/settings"] }).errors,
		).toEqual([]);
		const after = JSON.stringify(afterPage);
		expect(after).toContain(
			"Videos and maps from YouTube and Vimeo wait until visitors allow them",
		);
		expect(after).not.toContain(NAME_HELD_ACTION);
		// Taken back: no longer named, and no longer offered until a page shows it again.
		await admin(fake, { type: "block_action", action_id: `${FORGET_HELD_ACTION}Vimeo` });
		expect(named(fake)).toEqual(["YouTube"]);
		expect(seen(fake)).toEqual(["YouTube"]);
	});

	it("tells the block whether the banner names its provider, so Marketing releases only named ones", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		expect(await ask(fake, "YouTube")).toEqual({ hold: true, named: false });
		await admin(fake, { type: "block_action", action_id: NAME_HELD_ACTION });
		expect(await ask(fake, "YouTube")).toEqual({ hold: true, named: true });
		expect(await ask(fake, "Vimeo")).toEqual({ hold: true, named: false });
	});

	it("shows the prompt to name them above the tabs, to Admins only", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		await ask(fake, "Vimeo");
		const page = (await admin(fake, { type: "page_load", page: "/settings" })) as {
			blocks: Array<{ type: string; title?: string }>;
		};
		const notice = page.blocks.findIndex(
			(block) => block.type === "banner" && block.title?.includes("Your pages show"),
		);
		const tabs = page.blocks.findIndex((block) => block.type === "tab");
		expect(notice).toBeGreaterThan(-1);
		expect(notice).toBeLessThan(tabs);
		const editor = JSON.stringify(
			await admin(fake, { type: "page_load", page: "/settings" }, EDITOR),
		);
		expect(editor).not.toContain("Your pages show");
		expect(editor).not.toContain(NAME_HELD_ACTION);
	});

	it("two admin saves at the same moment both stick", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		await ask(fake, "Google Maps");
		await Promise.all([
			admin(fake, { type: "block_action", action_id: NAME_HELD_ACTION }),
			admin(fake, {
				type: "form_submit",
				action_id: "save_tools",
				values: { meta: "123456789012345" },
			}),
		]);
		const config = normalizeConfig(fake.kv.get(CONFIG_KEY));
		expect(config.heldEmbeds).toEqual(["Google Maps"]);
		expect(config.tools.meta).toBe("123456789012345");
	});

	it("keeps only known providers from storage", () => {
		expect(normalizeConfig({ heldEmbeds: ["Vimeo", "x", "YouTube", "Vimeo"] }).heldEmbeds).toEqual([
			"YouTube",
			"Vimeo",
		]);
		expect(normalizeConfig({}).heldEmbeds).toEqual([]);
	});

	it("asks visitors again when the list grows, never before", () => {
		const before = bannerVersion(normalizeConfig(GA));
		expect(bannerVersion(normalizeConfig({ ...GA, heldEmbeds: [] }))).toBe(before);
		const one = bannerVersion(normalizeConfig({ ...GA, heldEmbeds: ["YouTube"] }));
		expect(one).not.toBe(before);
		expect(bannerVersion(normalizeConfig({ ...GA, heldEmbeds: ["YouTube", "Vimeo"] }))).not.toBe(
			one,
		);
	});
});

describe("what the banner says about them", () => {
	it("names them in the standard text, in English and the other languages", () => {
		const withMarketing = normalizeConfig({
			...GA_META,
			heldEmbeds: ["YouTube", "Vimeo", "Google Maps"],
		});
		expect(wordsFor(withMarketing).text).toBe(
			"We would like to use analytics cookies to see how this site is used, and marketing cookies to measure our ads. Marketing also covers videos and maps from YouTube, Vimeo and Google Maps. Essential cookies are always on.",
		);
		const analyticsOnly = normalizeConfig({ ...GA, heldEmbeds: ["YouTube"] });
		expect(wordsFor(analyticsOnly).text).toBe(
			"We would like to use analytics cookies to see how this site is used. Videos and maps from YouTube set their own cookies, so they wait for your choice. Essential cookies are always on.",
		);
		expect(wordsFor(analyticsOnly, "de").text).toBe(
			"Wir möchten Statistik-Cookies verwenden, um zu sehen, wie diese Website genutzt wird. Videos und Karten von YouTube setzen eigene Cookies und warten deshalb auf Ihre Wahl. Notwendige Cookies sind immer aktiv.",
		);
		for (const lang of ["fr", "es", "it", "nl", "pt"]) {
			const text = wordsFor(
				normalizeConfig({ ...GA, heldEmbeds: ["YouTube", "Google Maps"] }),
				lang,
			).text;
			expect(text, lang).toContain("YouTube");
			expect(text, lang).toContain("Google Maps");
		}
	});

	it("leaves a text the owner typed as typed", () => {
		const own = normalizeConfig({ ...GA, heldEmbeds: ["YouTube"], banner: { message: "Hello." } });
		expect(wordsFor(own).text).toBe("Hello.");
	});

	it("lists them under Marketing in Choose", () => {
		const out = clientConfig(
			normalizeConfig({ ...GA_META, heldEmbeds: ["YouTube", "Google Maps"] }),
			"analytics-consent",
		);
		expect(out.mk).toEqual(["Meta Pixel", "YouTube", "Google Maps"]);
		expect(out.t.mk).toBe("Marketing");
	});

	it("without Marketing tools, offers a Videos and maps switch instead", () => {
		const out = clientConfig(
			normalizeConfig({ ...GA, heldEmbeds: ["Vimeo"] }),
			"analytics-consent",
		);
		expect(out.mk).toEqual(["Vimeo"]);
		expect(out.t.mk).toBe("Videos and maps");
		expect(out.t.mkText).toBe(
			"Shows videos and maps from other sites, which set their own cookies.",
		);
		expect(wordsFor(normalizeConfig({ ...GA, heldEmbeds: ["Vimeo"] }), "fr").mk).toBe(
			"Vidéos et cartes",
		);
	});

	it("changes nothing for a site without held videos or maps", () => {
		const plain = clientConfig(normalizeConfig(GA), "analytics-consent");
		expect(plain.mk).toEqual([]);
		expect(plain.t.mk).toBe("Marketing");
		// Not asking anyone: nothing is held, so nothing is named.
		const counts = normalizeConfig({
			tools: { cloudflare: "0123456789abcdef0123456789abcdef" },
			heldEmbeds: ["YouTube"],
		});
		expect(clientConfig(counts, "analytics-consent").mk).toEqual([]);
	});
});
