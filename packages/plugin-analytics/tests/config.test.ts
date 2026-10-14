// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import {
	bannerVersion,
	cleanPolicyUrl,
	DEFAULT_CONFIG,
	DEFAULT_MESSAGE,
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
