// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { bannerVersion, CONFIG_KEY, normalizeConfig } from "../src/config.js";
import { clientConfig } from "../src/fragment.js";
import { createPlugin } from "../src/index.js";
import { wordsFor } from "../src/words.js";
import { fakeContext } from "./helpers.js";

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
	const stored = (fake: ReturnType<typeof fakeContext>) =>
		normalizeConfig(fake.kv.get(CONFIG_KEY)).heldEmbeds;

	it("notes each provider a held block names, once, in a fixed order", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		expect(await ask(fake, "Google Maps")).toEqual({ hold: true });
		expect(await ask(fake, "YouTube")).toEqual({ hold: true });
		await ask(fake, "YouTube");
		expect(stored(fake)).toEqual(["YouTube", "Google Maps"]);
	});

	it("keeps every name when several blocks on one page ask at once", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		await Promise.all(["Vimeo", "YouTube", "Google Maps"].map((name) => ask(fake, name)));
		expect(stored(fake)).toEqual(["YouTube", "Vimeo", "Google Maps"]);
	});

	it("notes nothing unknown, and nothing where nobody is asked", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: GA });
		await ask(fake, "<script>");
		await ask(fake);
		expect(stored(fake)).toEqual([]);
		const quiet = fakeContext({ [CONFIG_KEY]: { ...GA, banner: { audience: "none" } } });
		expect(await ask(quiet, "YouTube")).toEqual({ hold: false });
		expect(stored(quiet)).toEqual([]);
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
