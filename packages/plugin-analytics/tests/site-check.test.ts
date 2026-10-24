// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";
import { clientScriptFor, clientConfig } from "../src/fragment.js";
import { checkSite, pagesToCheck, scanPage } from "../src/site-check.js";

const PLUGIN = "analytics-consent";
const ORIGIN = "https://bakery.test";

/** A page as EmDash serves it to a visitor: our own script in the head, then the body. */
function page(body: string, config = normalizeConfig({ tools: { ga4: "G-AB12CD34EF" } })): string {
	const ours = clientScriptFor(clientConfig(config, PLUGIN));
	return `<!doctype html><html><head><title>Bakery</title><script>${ours}</script></head><body>${body}</body></html>`;
}

const titles = (html: string, raw: unknown = { tools: { ga4: "G-AB12CD34EF" } }) =>
	scanPage(html, normalizeConfig(raw), PLUGIN).map((finding) => finding.title);

describe("what a page loads", () => {
	it("finds nothing on a page that has only this plugin's own script", () => {
		const every = normalizeConfig({
			tools: {
				ga4: "G-AB12CD34EF",
				gtm: "GTM-AB12CD3",
				ads: "AW-123456789",
				meta: "123456789012345",
				clarity: "ab12cd34ef",
				hubspot: "12345678",
				cloudflare: "0123456789abcdef0123456789abcdef",
			},
		});
		expect(scanPage(page("<p>Fresh bread daily.</p>", every), every, PLUGIN)).toEqual([]);
	});

	it("says a pasted Google tag with the same ID counts every visit twice", () => {
		const html = page(
			`<script async src="https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-AB12CD34EF');</script>`,
		);
		const [finding, ...rest] = scanPage(
			html,
			normalizeConfig({ tools: { ga4: "G-AB12CD34EF" } }),
			PLUGIN,
		);
		expect(rest).toEqual([]);
		expect(finding).toMatchObject({ kind: "twice", title: "Google Analytics is added twice" });
		expect(finding!.advice).toContain("Remove the pasted code");
		expect(finding!.advice).toContain("Analytics adds it for you");
	});

	it("says a pasted tag for an ID or tool not set here loads without waiting", () => {
		expect(
			titles(
				page(
					`<script async src="https://www.googletagmanager.com/gtag/js?id=G-OTHER12345"></script>`,
				),
			),
		).toEqual(["Google Analytics (G-OTHER12345) is pasted into your pages"]);
		expect(
			titles(
				page(
					`<script>(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "zz98yy76xx");</script>`,
				),
			),
		).toEqual(["Microsoft Clarity (zz98yy76xx) is pasted into your pages"]);
		expect(
			titles(
				page(
					`<script>!function(f,b,e,v,n,t,s){}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init', '998877665544332');</script><noscript><img src="https://www.facebook.com/tr?id=998877665544332&ev=PageView&noscript=1"/></noscript>`,
				),
			),
		).toEqual(["Meta Pixel (998877665544332) is pasted into your pages"]);
		expect(
			titles(
				page(
					`<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-PASTED1" height="0" width="0"></iframe></noscript>`,
				),
			),
		).toEqual(["Google Tag Manager (GTM-PASTED1) is pasted into your pages"]);
		expect(
			titles(page(`<script src="https://js-eu1.hs-scripts.com/87654321.js" async defer></script>`)),
		).toEqual(["HubSpot (87654321) is pasted into your pages"]);
	});

	it("names old Universal Analytics, other trackers and Google ads, each with its own advice", () => {
		const found = scanPage(
			page(
				`<script src="https://www.google-analytics.com/analytics.js"></script><script src="https://static.hotjar.com/c/hotjar-1.js"></script><script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>`,
			),
			normalizeConfig({ tools: { ga4: "G-AB12CD34EF" } }),
			PLUGIN,
		);
		expect(found.map((f) => f.title)).toEqual([
			"An old Google Analytics tag (Universal Analytics) is pasted into your pages",
			"Hotjar is pasted into your pages",
			"Google ads (AdSense) are on your pages",
		]);
		expect(found[0]!.advice).toContain("switched it off in 2023");
		expect(found[2]!.advice).toContain("certified");
	});

	it("finds embeds that set cookies before anyone is asked, with a plain fix for each", () => {
		const found = scanPage(
			page(
				[
					`<iframe src="https://www.youtube.com/embed/abc123" title="Video"></iframe>`,
					`<iframe src="https://player.vimeo.com/video/123456"></iframe>`,
					`<iframe src="https://www.google.com/maps/embed?pb=!1m18"></iframe>`,
					`<div class="calendly-inline-widget" data-url="https://calendly.com/bakery"></div><script src="https://assets.calendly.com/assets/external/widget.js"></script>`,
					`<blockquote class="instagram-media"></blockquote><script async src="//www.instagram.com/embed.js"></script>`,
					`<iframe src="https://form.typeform.com/to/abcdef"></iframe>`,
				].join(""),
			),
			normalizeConfig({ tools: { ga4: "G-AB12CD34EF" } }),
			PLUGIN,
		);
		expect(found.map((f) => [f.kind, f.title])).toEqual([
			["embed", "A YouTube video sets cookies before visitors answer"],
			["embed", "A Vimeo video tracks visitors"],
			["embed", "A Google map sets cookies before visitors answer"],
			["embed", "A Calendly booking box sets cookies before visitors answer"],
			["embed", "An Instagram post sets cookies before visitors answer"],
			["embed", "A Typeform form sets cookies before visitors answer"],
		]);
		expect(found[0]!.advice).toContain("youtube-nocookie.com");
		expect(found[1]!.advice).toContain("dnt=1");
	});

	it("leaves alone what is already fine: youtube-nocookie, Vimeo with dnt=1, a video only named in text or page data", () => {
		expect(
			titles(
				page(
					[
						`<iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe>`,
						`<iframe src="https://player.vimeo.com/video/123456?dnt=1"></iframe>`,
						`<p>Watch it at https://www.youtube.com/embed/abc123 or read about gtag/js?id=G-XYZ12345</p>`,
						`<script type="application/ld+json">{"@type":"VideoObject","embedUrl":"https://www.youtube.com/embed/abc123"}</script>`,
					].join(""),
				),
			),
		).toEqual([]);
	});

	it("says when this plugin's own script is missing from a page it should be on", () => {
		const html = `<!doctype html><html><head></head><body><p>Hi</p></body></html>`;
		expect(titles(html)).toEqual(["Analytics' own code is not on this page"]);
		// Nothing to load, nothing missing.
		expect(titles(html, {})).toEqual([]);
	});
});

describe("which pages are checked", () => {
	it("takes the home page's own links in order, without the admin, files or other sites, up to four", () => {
		const home = `<header><nav><a href="/">Home</a><a href="/about">About</a><a href="https://bakery.test/menu?x=1#top">Menu</a><a href="/about">About again</a></nav></header>
			<a href="https://elsewhere.test/page">Elsewhere</a><a href="/_emdash/admin">Admin</a><a href="/files/price-list.pdf">Prices</a>
			<a href="mailto:hi@bakery.test">Mail</a><a href="#main">Skip</a><a href="/contact">Contact</a><a href="/blog">Blog</a><a href="/blog/first">First</a>`;
		expect(pagesToCheck(home, ORIGIN)).toEqual(["/about", "/menu", "/contact", "/blog"]);
	});

	it("tops up from the sitemap when the home page has few links", () => {
		const sitemap = `<?xml version="1.0"?><urlset><url><loc>https://bakery.test/</loc></url><url><loc>https://bakery.test/about</loc></url><url><loc>https://bakery.test/cakes</loc></url><url><loc>https://other.test/x</loc></url></urlset>`;
		expect(pagesToCheck(`<a href="/about">About</a>`, ORIGIN, sitemap)).toEqual([
			"/about",
			"/cakes",
		]);
	});
});

describe("checking the site", () => {
	const config = normalizeConfig({ tools: { ga4: "G-AB12CD34EF" } });
	const html = (body: string) =>
		new Response(page(body, config), { headers: { "content-type": "text/html; charset=utf-8" } });
	const NOW = new Date("2026-10-24T10:00:00.000Z");

	it("fetches the home page and its links as a visitor, and gathers what it finds by page", async () => {
		const asked: Array<{ url: string; cookie: string | null; redirect: string | undefined }> = [];
		const fetchImpl = (async (input: string, init: RequestInit = {}) => {
			const headers = new Headers(init.headers);
			asked.push({ url: input, cookie: headers.get("cookie"), redirect: init.redirect });
			const path = new URL(input).pathname;
			if (path === "/") return html(`<a href="/about">About</a><a href="/visit">Visit</a>`);
			if (path === "/about") return html(`<iframe src="https://www.youtube.com/embed/a"></iframe>`);
			if (path === "/visit")
				return html(
					`<iframe src="https://www.youtube.com/embed/b"></iframe><iframe src="https://www.google.com/maps/embed?pb=1"></iframe>`,
				);
			return new Response("no", { status: 404 });
		}) as unknown as typeof fetch;
		const result = await checkSite(ORIGIN, config, PLUGIN, { fetchImpl, now: NOW });
		expect(result.problem).toBeUndefined();
		expect(result.at).toBe(NOW.toISOString());
		expect(result.pages.map((p) => [p.path, p.status])).toEqual([
			["/", 200],
			["/about", 200],
			["/visit", 200],
		]);
		expect(result.findings.map((f) => [f.title, f.pages])).toEqual([
			["A YouTube video sets cookies before visitors answer", ["/about", "/visit"]],
			["A Google map sets cookies before visitors answer", ["/visit"]],
		]);
		// As a visitor: no cookie. Only this site's address, redirects followed by hand.
		expect(asked.every((a) => a.cookie === null && a.redirect === "manual")).toBe(true);
		expect(asked.every((a) => a.url.startsWith(`${ORIGIN}/`))).toBe(true);
	});

	it("follows a redirect on the same site, never one to another site", async () => {
		const asked: string[] = [];
		const fetchImpl = (async (input: string) => {
			asked.push(input);
			const path = new URL(input).pathname;
			if (path === "/") return html(`<a href="/old">Old</a><a href="/away">Away</a>`);
			if (path === "/old")
				return new Response(null, { status: 301, headers: { location: "/new" } });
			if (path === "/new") return html("");
			if (path === "/away")
				return new Response(null, { status: 302, headers: { location: "https://evil.test/" } });
			return new Response("no", { status: 404 });
		}) as unknown as typeof fetch;
		const result = await checkSite(ORIGIN, config, PLUGIN, { fetchImpl, now: NOW });
		expect(asked.some((url) => url.startsWith("https://evil.test"))).toBe(false);
		expect(result.pages.map((p) => [p.path, p.status])).toEqual([
			["/", 200],
			["/old", 200],
			["/away", 302],
		]);
	});

	it("says plainly when the site cannot call its own address", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const result = await checkSite(ORIGIN, config, PLUGIN, { fetchImpl, now: NOW });
		expect(result.problem).toContain("could not open its own address (https://bakery.test)");
		expect(result.findings).toEqual([]);
	});

	it("gives up on a page that takes too long", async () => {
		const fetchImpl = ((_input: string, init: RequestInit = {}) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as unknown as typeof fetch;
		const result = await checkSite(ORIGIN, config, PLUGIN, { fetchImpl, now: NOW, timeoutMs: 20 });
		expect(result.problem).toContain("could not open its own address");
	});

	it("says when the home page answers with an error", async () => {
		const fetchImpl = (async () =>
			new Response("down", { status: 503 })) as unknown as typeof fetch;
		const result = await checkSite(ORIGIN, config, PLUGIN, { fetchImpl, now: NOW });
		expect(result.problem).toContain("Your home page answered with an error (503)");
	});
});
