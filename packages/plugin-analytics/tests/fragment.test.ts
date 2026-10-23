// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { gzipSync } from "node:zlib";

import type { PageFragmentContribution, PageFragmentEvent, PluginContext } from "emdash";
import { renderFragments } from "emdash/page";
import clientCode from "virtual:client-script";
import { describe, expect, it } from "vitest";

import type { ClientConfig } from "../src/client/types.js";
import { CONFIG_KEY, normalizeConfig } from "../src/config.js";
import {
	clientColors,
	clientConfig,
	clientScriptFor,
	pageFragments,
	scriptJson,
} from "../src/fragment.js";
import { createPlugin, PLUGIN_ID } from "../src/index.js";
import { fakeContext } from "./helpers.js";

const ALL_TOOLS = {
	ga4: "G-AB12CD34EF",
	gtm: "GTM-AB12CD3",
	ads: "AW-123456789",
	meta: "123456789012345",
	clarity: "ab12cd34ef",
	hubspot: "12345678",
	cloudflare: "0123456789abcdef0123456789abcdef",
};

type Hook = (
	event: PageFragmentEvent,
	ctx: PluginContext,
) => Promise<PageFragmentContribution | PageFragmentContribution[] | null>;

/** The real hook, as EmDash will call it. */
function hook(): Hook {
	return createPlugin().hooks["page:fragments"]!.handler as Hook;
}

function event(path: string, query = ""): PageFragmentEvent {
	return {
		page: {
			url: `https://acme.test${path}${query}`,
			path,
			locale: null,
			kind: "custom",
			pageType: "website",
			title: "Acme",
			description: null,
			canonical: null,
			image: null,
		},
	};
}

/** The settings object that the emitted script was given. */
function configIn(code: string): ClientConfig {
	const start = code.indexOf('{"v":');
	let depth = 0;
	for (let index = start; index < code.length; index++) {
		if (code[index] === "{") depth++;
		if (code[index] === "}" && --depth === 0) {
			return JSON.parse(code.slice(start, index + 1)) as ClientConfig;
		}
	}
	throw new Error("no config in script");
}

describe("the page hook", () => {
	it("adds nothing until a tool is set", async () => {
		const { ctx } = fakeContext();
		expect(await hook()(event("/"), ctx)).toBeNull();
	});

	it("adds one inline script to the head, and reads storage once", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" } } });
		const result = await hook()(event("/pricing"), fake.ctx);
		expect(fake.reads()).toBe(1);
		expect(Array.isArray(result)).toBe(false);
		const fragment = result as PageFragmentContribution;
		expect(fragment).toMatchObject({
			kind: "inline-script",
			placement: "head",
			key: `${PLUGIN_ID}:bootstrap`,
		});

		// No external script, no HTML, nothing for the body.
		const head = renderFragments([fragment], "head");
		expect(head.startsWith("<script>")).toBe(true);
		expect(head.endsWith("</script>")).toBe(true);
		expect(head.match(/<script/g)).toHaveLength(1);
		expect(head).not.toContain("<noscript");
		expect(head).not.toContain("<script src");
		expect(renderFragments([fragment], "body:start")).toBe("");
		expect(renderFragments([fragment], "body:end")).toBe("");
	});

	it("gives the same script every time it runs for a page", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { tools: ALL_TOOLS } });
		const runs = await Promise.all([1, 2, 3].map(() => hook()(event("/"), fake.ctx)));
		expect(runs[1]).toEqual(runs[0]);
		expect(runs[2]).toEqual(runs[0]);
		// EmDash keeps one of several fragments with the same key.
		expect(
			renderFragments(runs as PageFragmentContribution[], "head").match(/<script/g),
		).toHaveLength(1);
	});

	it("adds nothing to the admin, preview links or pages the owner excluded", async () => {
		const { ctx } = fakeContext({
			[CONFIG_KEY]: { tools: ALL_TOOLS, exclude: ["/thank-you", "/internal/"] },
		});
		const run = hook();
		expect(await run(event("/_emdash/admin"), ctx)).toBeNull();
		expect(await run(event("/_emdash"), ctx)).toBeNull();
		expect(await run(event("/", "?_preview=token"), ctx)).toBeNull();
		expect(await run(event("/blog/post", "?a=1&_preview=token"), ctx)).toBeNull();
		expect(await run(event("/thank-you"), ctx)).toBeNull();
		expect(await run(event("/internal/report"), ctx)).toBeNull();
		expect(await run(event("/thanks"), ctx)).not.toBeNull();
		expect(await run(event("/_emdashboard"), ctx)).not.toBeNull();
	});

	it("adds nothing in the visual editor or on a verified preview", () => {
		const config = normalizeConfig({ tools: ALL_TOOLS });
		const page = { path: "/", url: "https://acme.test/", editMode: false, preview: false };
		expect(pageFragments(config, PLUGIN_ID, page)).not.toBeNull();
		expect(pageFragments(config, PLUGIN_ID, { ...page, editMode: true })).toBeNull();
		expect(pageFragments(config, PLUGIN_ID, { ...page, preview: true })).toBeNull();
	});

	it("ignores stored IDs that are not IDs", async () => {
		const { ctx } = fakeContext({
			[CONFIG_KEY]: { tools: { ga4: `G-X";alert(1);//`, gtm: "GTM-AB12CD3" } },
		});
		const fragment = (await hook()(event("/"), ctx)) as { code: string };
		expect(fragment.code).not.toContain("alert(1)");
		expect(configIn(fragment.code)).toMatchObject({ gtm: "GTM-AB12CD3" });
		expect(configIn(fragment.code).ga).toBeUndefined();
	});
});

describe("what the browser is told", () => {
	it("carries each tool's ID and the banner settings", () => {
		const config = normalizeConfig({
			tools: ALL_TOOLS,
			hubspotEu: true,
			banner: { audience: "everyone", policyUrl: "/privacy", position: "right", months: 12 },
			gtmLoading: "immediate",
		});
		expect(clientConfig(config, PLUGIN_ID)).toMatchObject({
			who: 2,
			days: 365,
			api: "/_emdash/api/plugins/analytics-consent/",
			ga: "G-AB12CD34EF",
			gtm: "GTM-AB12CD3",
			aw: "AW-123456789",
			fb: "123456789012345",
			cl: "ab12cd34ef",
			hs: "12345678",
			hsEu: 1,
			cf: "0123456789abcdef0123456789abcdef",
			gtmNow: 1,
			ev: 1,
			rec: 1,
			btn: 1,
			pos: "right",
			policy: "/privacy",
			an: ["Google Analytics", "Google Tag Manager", "Microsoft Clarity"],
			mk: ["Google Tag Manager", "Google Ads", "Meta Pixel", "HubSpot"],
		});
	});

	it("asks no one when nothing waits for consent, or another tool is in charge", () => {
		const counts = normalizeConfig({ tools: { cloudflare: ALL_TOOLS.cloudflare } });
		expect(clientConfig(counts, PLUGIN_ID)).toMatchObject({ who: 0 });
		expect(clientConfig(counts, PLUGIN_ID).rec).toBeUndefined();
		expect(clientConfig(counts, PLUGIN_ID).btn).toBeUndefined();

		const other = normalizeConfig({ tools: { ga4: ALL_TOOLS.ga4 }, banner: { audience: "none" } });
		expect(clientConfig(other, PLUGIN_ID)).toMatchObject({ who: 0 });
		expect(
			clientConfig(normalizeConfig({ tools: { ga4: ALL_TOOLS.ga4 } }), PLUGIN_ID),
		).toMatchObject({ who: 1, days: 183 });
	});

	it("cannot be broken out of by banner text", () => {
		const config = normalizeConfig({
			tools: { ga4: ALL_TOOLS.ga4 },
			banner: { title: `</script><script>alert(1)</script>`, message: `<!-- "quoted" \\ -->` },
		});
		const code = clientScriptFor(clientConfig(config, PLUGIN_ID));
		expect(code).not.toContain("</script>");
		expect(code).not.toContain("<!--");
		// The text survives the trip exactly.
		expect(configIn(code).t.title).toBe(`</script><script>alert(1)</script>`);
		expect(configIn(code).t.text).toBe(`<!-- "quoted" \\ -->`);
		expect(scriptJson({ a: "<" })).toBe(`{"a":"${String.fromCharCode(92)}u003c"}`);
		// It is still one valid program.
		expect(() => new Function(code)).not.toThrow();
	});
});

describe("the browser script", () => {
	const full = clientScriptFor(
		clientConfig(
			normalizeConfig({ tools: ALL_TOOLS, banner: { policyUrl: "/privacy-policy" } }),
			PLUGIN_ID,
		),
	);

	it("is one self-contained function with the settings put in", () => {
		expect(clientCode).toContain("__CC_CONFIG__");
		expect(clientCode.match(/__CC_CONFIG__/g)).toHaveLength(1);
		expect(full).not.toContain("__CC_CONFIG__");
		expect(clientCode.startsWith("(function(){")).toBe(true);
	});

	it("stays under 6.25 KB gzipped with every tool switched on", () => {
		const size = gzipSync(full, { level: 9 }).length;
		// Printed so the number is in the test log.
		console.log(`inline script: ${full.length} bytes, ${size} bytes gzipped (budget 6400)`);
		expect(size).toBeLessThan(6400);
	});

	it("never names the company behind the plugin, and has no noscript fallback", () => {
		expect(full).not.toMatch(/moorage/i);
		expect(full).not.toMatch(/gosi/i);
		expect(full).not.toContain("noscript");
	});

	it("only ever names the hosts of the tools it can load", () => {
		const hosts = [...full.matchAll(/https:\/\/[a-z0-9.-]+/g)].map((match) => match[0]);
		expect([...new Set(hosts)].sort()).toEqual([
			"https://connect.facebook.net",
			"https://js",
			"https://static.cloudflareinsights.com",
			"https://www.clarity.ms",
			"https://www.googletagmanager.com",
		]);
	});
});

describe("the owner's colours", () => {
	it("picks readable button text and adds an edge to a button that would not stand out", () => {
		expect(clientColors({ background: "", text: "", accent: "" })).toBeUndefined();
		expect(clientColors({ background: "#fbf7f0", text: "#3b2a1a", accent: "#1f6f43" })).toEqual({
			g: "#fbf7f0",
			f: "#3b2a1a",
			x: "#1f6f43",
			y: "#ffffff",
		});
		expect(
			clientColors({ background: "#ffffff", text: "#141414", accent: "#ffe066" }),
		).toMatchObject({
			y: "#141414",
			z: "#141414",
		});
	});
});
