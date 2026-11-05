// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RouteContext } from "emdash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { heldEmbed, heldIframe, heldKind, placeholderWords, reveal } from "../astro/held.mjs";
import { CONFIG_KEY } from "../src/config.js";
import { analyticsPlugin, createPlugin } from "../src/index.js";
import { fakeContext } from "./helpers.js";

describe("what is held back", () => {
	it("knows YouTube, Vimeo and Google Maps addresses, as the editor and pasted codes make them", () => {
		expect(heldKind("https://www.youtube.com/embed/dQw4w9WgXcQ")).toEqual({
			kind: "video",
			name: "YouTube",
			link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			player: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
		});
		for (const url of [
			"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=10",
			"https://youtu.be/dQw4w9WgXcQ",
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://m.youtube.com/shorts/dQw4w9WgXcQ",
		]) {
			expect(heldKind(url)?.name, url).toBe("YouTube");
		}
		expect(heldKind("https://player.vimeo.com/video/76979871")).toMatchObject({
			kind: "video",
			name: "Vimeo",
			link: "https://vimeo.com/76979871",
		});
		expect(heldKind("https://vimeo.com/76979871")?.name).toBe("Vimeo");
		const map = "https://www.google.com/maps/embed?pb=!1m18!1m12";
		expect(heldKind(map)).toEqual({ kind: "map", name: "Google Maps", link: map });
		expect(heldKind("https://maps.google.de/maps?q=Berlin&output=embed")?.kind).toBe("map");
	});

	it("leaves everything else alone", () => {
		for (const url of [
			"https://www.youtube.com/channel/abc",
			"http://www.youtube.com/embed/dQw4w9WgXcQ",
			"https://evil.test/www.youtube.com/embed/dQw4w9WgXcQ",
			"https://www.google.com/search?q=maps",
			"https://maps.google.com/maps?q=Berlin",
			"https://open.spotify.com/embed/track/1",
			"https://example.com/",
			"javascript:alert(1)",
			"",
			undefined,
			42,
		]) {
			expect(heldKind(url), String(url)).toBeUndefined();
		}
	});

	it("says so in the page's language", () => {
		const yt = { kind: "video", name: "YouTube", link: "" } as const;
		expect(placeholderWords("en", yt)).toEqual({
			text: "This video is shown by YouTube, which may set cookies.",
			load: "Load the video",
			open: "Open it on YouTube",
		});
		expect(placeholderWords("de-AT", { kind: "map", name: "Google Maps", link: "" }).load).toBe(
			"Karte laden",
		);
		expect(placeholderWords("pl", yt).load).toBe("Load the video");
	});
});

describe("everything EmDash renders as a player is held", () => {
	it("an embed block whose address EmDash's own patterns play, whatever the scheme or host", () => {
		for (const [url, name] of [
			["http://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube"],
			["www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube"],
			["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube"],
			["youtu.be/dQw4w9WgXcQ", "YouTube"],
			// EmDash's patterns are not anchored: this plays YouTube too.
			["https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ", "YouTube"],
			["https://vimeo.com/1234", "Vimeo"],
			["http://vimeo.com/76979871", "Vimeo"],
		] as const) {
			expect(heldEmbed({ url }), url).toMatchObject({ kind: "video", name });
		}
		// The link opens the same video when its ID is known.
		expect(heldEmbed({ url: "https://music.youtube.com/watch?v=dQw4w9WgXcQ" })?.link).toBe(
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		);
		expect(heldEmbed({ url: "https://vimeo.com/1234" })?.link).toBe("https://vimeo.com/1234");
	});

	it("an embed block whose oEmbed code holds a YouTube or Vimeo player, however its address is written", () => {
		const page = "https://www.youtube.com/playlist?list=PL123";
		for (const [html, name] of [
			['<iframe src="https://www.youtube.com/embed/videoseries?list=PL123"></iframe>', "YouTube"],
			["<IFRAME SRC='//www.youtube.com/embed/videoseries?list=PL123'></IFRAME>", "YouTube"],
			['<iframe src="https&#58;//www.youtube.com/embed/x"></iframe>', "YouTube"],
			[
				'<iframe src="https&colon;&sol;&sol;www&period;youtube&period;com/embed/x"></iframe>',
				"YouTube",
			],
			['<iframe src="&#x68;ttps://player&#46;vimeo&#46;com/video/1"></iframe>', "Vimeo"],
			['<p>x</p><iframe width="560" src=https://player.vimeo.com/video/12></iframe>', "Vimeo"],
			['<iframe src="https://www.google.com/maps/embed?pb=1"></iframe>', "Google Maps"],
		] as const) {
			expect(heldEmbed({ url: page, html }), html).toMatchObject({ name });
		}
		// An iframe whose address cannot be read is held all the same.
		expect(heldEmbed({ url: page, html: '<iframe src="&bogus;youtube"></iframe>' })?.name).toBe(
			"YouTube",
		);
	});

	it("leaves links, self-hosted media and other embeds alone", () => {
		for (const node of [
			{ url: "https://www.youtube.com/channel/abc" },
			{ url: "https://example.com/watch" },
			{ url: "https://cdn.test/v.mp4", provider: "video" },
			{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", provider: "audio" },
			{ url: "https://x.com/a/status/1", html: "<blockquote>post</blockquote>" },
			{
				url: "https://example.com/",
				html: '<iframe src="https://open.spotify.com/embed/1"></iframe>',
			},
			{},
			undefined,
		]) {
			expect(heldEmbed(node), JSON.stringify(node)).toBeUndefined();
		}
	});

	it("an iframe block on a YouTube, Vimeo or Google address, whatever the path", () => {
		const watch = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
		for (const [src, name, link] of [
			["https://www.youtube.com/embed/videoseries?list=PL123", "YouTube", undefined],
			["https://www.youtube-nocookie.com/embed?listType=playlist&list=PL1", "YouTube", undefined],
			["https://music.youtube.com/embed/dQw4w9WgXcQ", "YouTube", watch],
			["https://www.youtube.com/embed/dQw4w9WgXcQ", "YouTube", watch],
			["https://player.vimeo.com/video/1234", "Vimeo", "https://vimeo.com/1234"],
			["https://vimeo.com/showcase/123/embed", "Vimeo", undefined],
			["https://player.vimeo.com/video/76979871", "Vimeo", "https://vimeo.com/76979871"],
			[
				"https://www.google.com/maps/d/u/0/embed?mid=1",
				"Google Maps",
				"https://www.google.com/maps/d/u/0/embed?mid=1",
			],
			["https://maps.google.com/maps?q=Berlin", "Google Maps", undefined],
		] as const) {
			const held = heldIframe(src);
			expect(held?.name, src).toBe(name);
			// No link when the address names no video or map.
			expect(held?.link || undefined, src).toBe(link);
		}
		for (const src of [
			"https://open.spotify.com/embed/track/1",
			"https://evil.test/www.youtube.com/embed/dQw4w9WgXcQ",
			"https://youtube.com.evil.test/embed/x",
			// EmDash renders nothing for an iframe that is not https.
			"http://www.youtube.com/embed/dQw4w9WgXcQ",
			"",
			undefined,
		]) {
			expect(heldIframe(src), String(src)).toBeUndefined();
		}
	});
});

describe("the block components", () => {
	it("are wired up through the plugin's descriptor, for EmDash's own iframe and embed blocks", () => {
		expect(analyticsPlugin().componentsEntry).toBe("@moorage/plugin-analytics/astro");
		// The .astro files are compiled by the site's Astro, so the list is read as text here.
		const entry = readFileSync(join(import.meta.dirname, "../astro/index.mjs"), "utf8");
		const keys = /blockComponents = \{([^}]*)\}/.exec(entry)?.[1]?.match(/\w+(?=:)/g);
		expect(keys?.sort()).toEqual(["embed", "iframe"]);
	});

	it("ask the plugin's embeds route, which holds back only where the banner can ask", async () => {
		const ask = async (stored: unknown) => {
			const fake = fakeContext(stored === undefined ? {} : { [CONFIG_KEY]: stored });
			return createPlugin().routes.embeds!.handler({
				...fake.ctx,
				input: undefined,
				request: new Request("https://acme.test/_emdash/api/plugins/analytics-consent/embeds"),
			} as unknown as RouteContext);
		};
		expect(createPlugin().routes.embeds!.public).toBe(true);
		expect(await ask({ tools: { ga4: "G-AB12CD34EF" } })).toEqual({ hold: true });
		expect(await ask(undefined)).toEqual({ hold: false });
		expect(await ask({ tools: { cloudflare: "0123456789abcdef0123456789abcdef" } })).toEqual({
			hold: false,
		});
		expect(await ask({ tools: { ga4: "G-AB12CD34EF" }, banner: { audience: "none" } })).toEqual({
			hold: false,
		});
	});
});

describe("in the browser", () => {
	const w = window as unknown as Window & {
		cookieConsent?: { analytics: boolean; marketing: boolean };
	};
	const PLAYER =
		'<div class="emdash-iframe"><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe></div>';
	const box = (kind = "video", name = "YouTube") =>
		`<div class="cc-held" data-cc-held="${kind}" data-cc-name="${name}"><div class="cc-held-ask" hidden><p class="cc-held-text">x</p><button type="button" data-cc-load>Load</button><a class="cc-held-link" href="#">open</a></div><template>${PLAYER}</template></div>`;
	const frames = () => document.querySelectorAll("iframe").length;
	const asking = () => document.querySelector<HTMLElement>(".cc-held-ask")!;
	let state: { analytics: boolean; marketing: boolean } | undefined;
	const tell = (next: typeof state) => {
		state = next;
		document.dispatchEvent(new CustomEvent("cookie-consent:change", { detail: next }));
	};

	beforeEach(() => {
		state = undefined;
		Object.defineProperty(window, "cookieConsent", { configurable: true, get: () => state });
		document.body.innerHTML = box();
		document.documentElement.setAttribute("data-cookie-consent", "pending");
		document.documentElement.setAttribute("lang", "en");
	});
	afterEach(() => {
		document.documentElement.removeAttribute("data-cookie-consent");
		document.documentElement.removeAttribute("lang");
		delete (window as { cookieConsent?: unknown }).cookieConsent;
	});

	it("shows the player at once where nobody is asked", () => {
		document.documentElement.removeAttribute("data-cookie-consent");
		reveal(document, w);
		expect(frames()).toBe(1);
		expect(document.querySelector("[data-cc-held]")).toBeNull();
		expect(document.querySelector(".cc-held-open")).not.toBeNull();
	});

	it("stays plain until the visitor's rule is known, then asks", () => {
		reveal(document, w);
		expect(frames()).toBe(0);
		expect(asking().hidden).toBe(true);
		tell({ analytics: false, marketing: false });
		expect(frames()).toBe(0);
		expect(asking().hidden).toBe(false);
		expect(asking().textContent).toContain(
			"This video is shown by YouTube, which may set cookies.",
		);
	});

	it("shows the player once Marketing is allowed", () => {
		reveal(document, w);
		tell({ analytics: false, marketing: false });
		tell({ analytics: true, marketing: true });
		expect(frames()).toBe(1);
	});

	it("Load shows this one player only, and saves nothing", () => {
		document.body.innerHTML = box() + box("map", "Google Maps");
		reveal(document, w);
		tell({ analytics: false, marketing: false });
		document.querySelector<HTMLElement>("[data-cc-load]")!.click();
		expect(frames()).toBe(1);
		expect(document.querySelectorAll("[data-cc-held]")).toHaveLength(1);
		expect(document.cookie).not.toContain("cookie_consent");
	});

	it("speaks the page's language", () => {
		document.documentElement.setAttribute("lang", "fr");
		document.body.innerHTML = box("map", "Google Maps");
		reveal(document, w);
		tell({ analytics: false, marketing: false });
		expect(document.querySelector("[data-cc-load]")!.textContent).toBe("Charger la carte");
		expect(document.querySelector(".cc-held-text")!.textContent).toBe(
			"Cette carte est fournie par Google Maps, qui peut déposer des cookies.",
		);
	});

	it("speaks the page's language in a box with no link to open, as for a playlist", () => {
		document.documentElement.setAttribute("lang", "de");
		document.body.innerHTML = box().replace(/<a class="cc-held-link"[^>]*>open<\/a>/, "");
		reveal(document, w);
		tell({ analytics: false, marketing: false });
		expect(document.querySelector("[data-cc-load]")!.textContent).toBe("Video laden");
		expect(document.querySelector(".cc-held-text")!.textContent).toBe(
			"Dieses Video wird von YouTube angezeigt, das Cookies setzen kann.",
		);
	});

	it("follows Astro's <ClientRouter /> to the next page", () => {
		reveal(document, w);
		tell({ analytics: true, marketing: true });
		document.body.innerHTML = box();
		document.dispatchEvent(new Event("astro:page-load"));
		expect(frames()).toBe(1);
	});
});
