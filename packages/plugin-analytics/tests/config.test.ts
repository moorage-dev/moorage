// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import {
	bannerVersion,
	cleanPolicyUrl,
	DEFAULT_CONFIG,
	DEFAULT_MESSAGE,
	DEFAULT_TITLE,
	defaultMessage,
	isExcluded,
	needsConsent,
	normalizeConfig,
	parseExcludes,
	vendorNames,
} from "../src/config.js";

describe("config", () => {
	it("gives complete defaults for nothing, and for nonsense", () => {
		expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig("x")).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig({ tools: [], banner: 4, exclude: 9 })).toEqual(DEFAULT_CONFIG);
	});

	it("drops stored IDs that fail the strict check", () => {
		const config = normalizeConfig({
			tools: { ga4: "G-AB12CD34EF", gtm: `GTM-X";alert(1)//`, meta: "<script>" },
		});
		expect(config.tools.ga4).toBe("G-AB12CD34EF");
		expect(config.tools.gtm).toBe("");
		expect(config.tools.meta).toBe("");
	});

	it("falls back on unknown choices and keeps known ones", () => {
		const config = normalizeConfig({
			banner: { audience: "mars", position: "right", scheme: "dark", months: 12, title: "  " },
			gtmLoading: "immediate",
			enquiries: false,
		});
		expect(config.banner.audience).toBe("europe");
		expect(config.banner.position).toBe("right");
		expect(config.banner.scheme).toBe("dark");
		expect(config.banner.months).toBe(12);
		expect(config.banner.title).toBe(DEFAULT_CONFIG.banner.title);
		expect(config.banner.message).toBe(DEFAULT_MESSAGE);
		expect(config.gtmLoading).toBe("immediate");
		expect(config.enquiries).toBe(false);
	});

	it("accepts a policy page on this site or a web link, nothing else", () => {
		expect(cleanPolicyUrl("/privacy")).toBe("/privacy");
		expect(cleanPolicyUrl("https://example.com/privacy")).toBe("https://example.com/privacy");
		expect(cleanPolicyUrl("javascript:alert(1)")).toBe("");
		expect(cleanPolicyUrl("//evil.example")).toBe("");
		expect(cleanPolicyUrl(`/x"><script>`)).toBe("");
		expect(cleanPolicyUrl("privacy")).toBe("");
	});

	it("reads the don't-track list one prefix per line", () => {
		expect(
			parseExcludes(
				"/thank-you\n  internal/ \nhttps://example.com/landing/a?x=1\n/\n/bad path\n/thank-you",
			),
		).toEqual(["/thank-you", "/internal/", "/landing/a"]);
		expect(isExcluded("/thank-you", ["/thank-you"])).toBe(true);
		expect(isExcluded("/thank-you/now", ["/thank-you"])).toBe(true);
		expect(isExcluded("/internal", ["/internal/"])).toBe(true);
		expect(isExcluded("/internal/x", ["/internal/"])).toBe(true);
		expect(isExcluded("/pricing", ["/thank-you", "/internal/"])).toBe(false);
	});

	it("sorts tools into the categories visitors see", () => {
		const config = normalizeConfig({
			tools: {
				ga4: "G-AB12CD34EF",
				clarity: "ab12cd34ef",
				meta: "123456789012345",
				hubspot: "12345678",
				cloudflare: "0123456789abcdef0123456789abcdef",
			},
		});
		expect(vendorNames(config, "analytics")).toEqual(["Google Analytics", "Microsoft Clarity"]);
		expect(vendorNames(config, "marketing")).toEqual(["Meta Pixel", "HubSpot"]);
		expect(vendorNames({ ...config, cloudflareWait: true }, "analytics")).toContain(
			"Cloudflare Web Analytics",
		);
	});

	it("needs no consent for cookie-free visitor counts alone", () => {
		const only = normalizeConfig({ tools: { cloudflare: "0123456789abcdef0123456789abcdef" } });
		expect(needsConsent(only)).toBe(false);
		expect(needsConsent({ ...only, cloudflareWait: true })).toBe(true);
		expect(needsConsent(normalizeConfig({ tools: { gtm: "GTM-AB12CD3" } }))).toBe(true);
		expect(needsConsent(DEFAULT_CONFIG)).toBe(false);
	});

	it("changes the banner version only when the set of tools changes", () => {
		const one = normalizeConfig({ tools: { ga4: "G-AB12CD34EF" } });
		const sameToolNewId = normalizeConfig({ tools: { ga4: "G-ZZ99ZZ99ZZ" } });
		const newText = normalizeConfig({ tools: { ga4: "G-AB12CD34EF" }, banner: { title: "Hi" } });
		const two = normalizeConfig({ tools: { ga4: "G-AB12CD34EF", meta: "123456789012345" } });
		expect(bannerVersion(one)).toMatch(/^[a-z0-9]+$/);
		expect(bannerVersion(sameToolNewId)).toBe(bannerVersion(one));
		expect(bannerVersion(newText)).toBe(bannerVersion(one));
		expect(bannerVersion(two)).not.toBe(bannerVersion(one));
	});
});

describe("banner text", () => {
	const withTools = (tools: Record<string, string>) =>
		normalizeConfig({ tools: { ...DEFAULT_CONFIG.tools, ...tools } });

	it("names only the purposes in use", () => {
		expect(defaultMessage(withTools({ ga4: "G-ABC123DEF4" }))).toBe(
			"We would like to use analytics cookies to see how this site is used. Essential cookies are always on.",
		);
		expect(defaultMessage(withTools({ ga4: "G-ABC123DEF4", meta: "123456789012345" }))).toBe(
			"We would like to use analytics cookies to see how this site is used, and marketing cookies to measure our ads. Essential cookies are always on.",
		);
	});

	it("moves sites that still have the old standard wording to the new one, and keeps an owner's own text", () => {
		const old = normalizeConfig({
			banner: {
				title: "Cookies on this site",
				message:
					"We would like to use cookies to see how this site is used and to improve our marketing. You choose which ones we use, and you can change your mind at any time.",
			},
		});
		expect(old.banner.title).toBe(DEFAULT_TITLE);
		expect(old.banner.message).toBe(DEFAULT_MESSAGE);
		const own = normalizeConfig({ banner: { title: "Hello", message: "Our own words." } });
		expect(own.banner).toMatchObject({ title: "Hello", message: "Our own words." });
	});

	it("drops colours that would be hard to read", () => {
		expect(
			normalizeConfig({
				banner: { colors: { background: "#fff", text: "#eee", accent: "#1f6f43" } },
			}).banner.colors,
		).toEqual({
			background: "",
			text: "",
			accent: "#1f6f43",
		});
	});
});
