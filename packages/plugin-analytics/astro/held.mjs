// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Videos and maps held back until the visitor agrees to Marketing cookies.
 *
 * The page is rendered once and cached for everyone, so the server cannot know
 * a visitor's answer. Where the cookie banner can ask, an embedded YouTube or
 * Vimeo video or Google map is therefore rendered as a placeholder, with the
 * player kept inert inside a <template>; `reveal` (in the browser) puts the
 * player in once Marketing is allowed, or when the visitor presses Load.
 *
 * Used on the server by the block components and in the browser by
 * `Held.astro`'s script, so it has no imports.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

/** @param {unknown} value */
function https(value) {
	try {
		const url = new URL(typeof value === "string" ? value.trim() : "");
		return url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

/** @param {URL} url */
function youtubeId(url) {
	if (providerOf(url.hostname)?.name !== "YouTube") return undefined;
	const parts = url.pathname.split("/").filter(Boolean);
	const id =
		url.hostname === "youtu.be"
			? parts[0]
			: (url.searchParams.get("v") ??
				(["embed", "shorts", "live", "v"].includes(parts[0] ?? "") ? parts[1] : undefined));
	// "videoseries" is the playlist player, not a video.
	return id && id !== "videoseries" && YOUTUBE_ID.test(id) ? id : undefined;
}

/** @param {URL} url */
function vimeoId(url) {
	if (!VIMEO_HOSTS.has(url.hostname)) return undefined;
	const parts = url.pathname.split("/").filter(Boolean);
	// vimeo.com/123, /channels/name/123, /groups/name/videos/123; player.vimeo.com/video/123.
	const id =
		url.hostname === "player.vimeo.com"
			? parts[0] === "video"
				? parts[1]
				: undefined
			: parts[0] === "channels"
				? parts[2]
				: parts[0] === "groups" && parts[2] === "videos"
					? parts[3]
					: parts[0];
	return id && VIMEO_ID.test(id) ? id : undefined;
}

/** @param {URL} url */
function isGoogleMap(url) {
	const host = url.hostname;
	const google = /^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host);
	if (google && /^\/maps\/(?:embed|d\/(?:u\/\d+\/)?embed)/.test(url.pathname)) return true;
	return (
		/^maps\.google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host) &&
		url.searchParams.get("output") === "embed"
	);
}

/**
 * @typedef {{ kind: "video" | "map"; name: string; link: string; player?: string }} Held
 */

/**
 * What an address embeds, when it is one this plugin holds back: a YouTube or
 * Vimeo video, or a Google map. Anything else is undefined and renders as before.
 * `link` opens the same thing on its own site; `player` is the embed address
 * this plugin would use itself (YouTube's privacy-enhanced one).
 * @param {unknown} value
 * @returns {Held | undefined}
 */
export function heldKind(value) {
	const url = https(value);
	if (!url) return undefined;
	const yt = youtubeId(url);
	if (yt) {
		return {
			kind: "video",
			name: "YouTube",
			link: `https://www.youtube.com/watch?v=${yt}`,
			player: `https://www.youtube-nocookie.com/embed/${yt}`,
		};
	}
	const vimeo = vimeoId(url);
	if (vimeo) {
		return {
			kind: "video",
			name: "Vimeo",
			link: `https://vimeo.com/${vimeo}`,
			player: `https://player.vimeo.com/video/${vimeo}?dnt=1`,
		};
	}
	if (isGoogleMap(url)) return { kind: "map", name: "Google Maps", link: url.href };
	return undefined;
}

const GOOGLE_HOST = /^(?:[a-z0-9-]+\.)*google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

/**
 * Who shows a page on this host, when it is one this plugin holds back: any
 * address on YouTube, Vimeo or Google, whatever the path.
 * @param {string} host
 * @returns {Held | undefined}
 */
function providerOf(host) {
	const name = host.toLowerCase().replace(/\.$/, "");
	const on = (/** @type {string} */ domain) => name === domain || name.endsWith(`.${domain}`);
	if (on("youtube.com") || on("youtube-nocookie.com") || on("youtu.be")) {
		return { kind: "video", name: "YouTube", link: "" };
	}
	if (on("vimeo.com")) return { kind: "video", name: "Vimeo", link: "" };
	if (GOOGLE_HOST.test(name)) return { kind: "map", name: "Google Maps", link: "" };
	return undefined;
}

/**
 * The provider of a page, and the link to it when its address names the video or map.
 * @param {Held} provider
 * @param {URL | undefined} url
 * @returns {Held}
 */
function withLink(provider, url) {
	const known = url ? heldKind(url.href) : undefined;
	return known?.name === provider.name
		? known
		: { kind: provider.kind, name: provider.name, link: "" };
}

/**
 * What EmDash's iframe block shows, when it is held: any https address on
 * YouTube, Vimeo or Google (playlists and other players included; EmDash
 * renders nothing for other schemes). `link` is empty when no video ID or map
 * address can be read from it.
 * @param {unknown} src
 * @returns {Held | undefined}
 */
export function heldIframe(src) {
	const url = https(src);
	const provider = url && providerOf(url.hostname);
	return provider ? withLink(provider, url) : undefined;
}

// EmDash's Embed.astro: what it renders as a YouTube or Vimeo player. Not anchored, on purpose.
const EMDASH_YOUTUBE = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const EMDASH_VIMEO = /vimeo\.com\/(\d+)/;

const NAMED = /** @type {Record<string, string>} */ ({
	amp: "&",
	colon: ":",
	sol: "/",
	bsol: "\\",
	period: ".",
	quest: "?",
	equals: "=",
	num: "#",
	percnt: "%",
	lowbar: "_",
	dash: "-",
	hyphen: "-",
	quot: '"',
	apos: "'",
	Tab: "",
	NewLine: "",
});

/**
 * An attribute value as an HTML parser reads it. Unknown named entities are
 * kept as written, so the address cannot be read and the iframe is held anyway.
 * @param {string} value
 */
function decode(value) {
	return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi, (whole, dec, hex, name) => {
		if (dec || hex) {
			const code = parseInt(dec ?? hex, dec ? 10 : 16);
			return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
		}
		return NAMED[name] ?? whole;
	});
}

const IFRAME = /<iframe\b([^>]*)>/gi;
const SRC = /(?:^|[\s"'/])src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * What EmDash's embed block shows, when it is held: an address its own two
 * patterns render as a YouTube or Vimeo player, whatever the scheme or host
 * (as EmDash plays it), or oEmbed code with an iframe from YouTube, Vimeo or
 * Google (EmDash's sanitiser lets YouTube and Vimeo players through). An iframe
 * whose address cannot be read is held too. Self-hosted video and audio, links
 * and other code are left alone.
 * @param {unknown} node  the block: `{ url, provider, html }`
 * @returns {Held | undefined}
 */
export function heldEmbed(node) {
	const block = /** @type {{ url?: unknown; provider?: unknown; html?: unknown }} */ (node ?? {});
	if (block.provider === "video" || block.provider === "audio") return undefined;
	const url = typeof block.url === "string" ? block.url : "";
	if (!url) return undefined;
	const yt = EMDASH_YOUTUBE.exec(url)?.[1];
	if (yt) {
		const link = yt === "videoseries" ? "" : `https://www.youtube.com/watch?v=${yt}`;
		return { kind: "video", name: "YouTube", link };
	}
	const vimeo = EMDASH_VIMEO.exec(url)?.[1];
	if (vimeo) return { kind: "video", name: "Vimeo", link: `https://vimeo.com/${vimeo}` };
	if (typeof block.html !== "string") return undefined;
	for (const [, attributes = ""] of block.html.matchAll(IFRAME)) {
		const found = SRC.exec(attributes);
		const src = decode(found?.[1] ?? found?.[2] ?? found?.[3] ?? "").trim();
		let address;
		try {
			address = new URL(src, "https://invalid.invalid/");
		} catch {
			address = undefined;
		}
		if (address && address.hostname !== "invalid.invalid") {
			const provider = providerOf(address.hostname);
			if (provider) return withLink(provider, address);
			continue;
		}
		// Not readable: held, named after what the code mentions.
		const text = decode(block.html);
		const name = /vimeo/i.test(text) ? "Vimeo" : /google/i.test(text) ? "Google Maps" : "YouTube";
		return { kind: name === "Google Maps" ? "map" : "video", name, link: "" };
	}
	return undefined;
}

/** The placeholder's words. `{name}` is YouTube, Vimeo or Google Maps. */
export const WORDS = {
	en: {
		video: "This video is shown by {name}, which may set cookies.",
		map: "This map is shown by {name}, which may set cookies.",
		loadVideo: "Load the video",
		loadMap: "Load the map",
		open: "Open it on {name}",
	},
	de: {
		video: "Dieses Video wird von {name} angezeigt, das Cookies setzen kann.",
		map: "Diese Karte wird von {name} angezeigt, das Cookies setzen kann.",
		loadVideo: "Video laden",
		loadMap: "Karte laden",
		open: "Auf {name} öffnen",
	},
	fr: {
		video: "Cette vidéo est fournie par {name}, qui peut déposer des cookies.",
		map: "Cette carte est fournie par {name}, qui peut déposer des cookies.",
		loadVideo: "Charger la vidéo",
		loadMap: "Charger la carte",
		open: "Ouvrir sur {name}",
	},
	es: {
		video: "Este vídeo lo muestra {name}, que puede usar cookies.",
		map: "Este mapa lo muestra {name}, que puede usar cookies.",
		loadVideo: "Cargar el vídeo",
		loadMap: "Cargar el mapa",
		open: "Abrir en {name}",
	},
	it: {
		video: "Questo video è fornito da {name}, che può usare cookie.",
		map: "Questa mappa è fornita da {name}, che può usare cookie.",
		loadVideo: "Carica il video",
		loadMap: "Carica la mappa",
		open: "Apri su {name}",
	},
	nl: {
		video: "Deze video wordt getoond door {name}, dat cookies kan plaatsen.",
		map: "Deze kaart wordt getoond door {name}, dat cookies kan plaatsen.",
		loadVideo: "Video laden",
		loadMap: "Kaart laden",
		open: "Openen op {name}",
	},
	pt: {
		video: "Este vídeo é apresentado pelo {name}, que pode usar cookies.",
		map: "Este mapa é apresentado pelo {name}, que pode usar cookies.",
		loadVideo: "Carregar o vídeo",
		loadMap: "Carregar o mapa",
		open: "Abrir no {name}",
	},
};

/**
 * The placeholder's three lines in one language.
 * @param {string | undefined} lang  the page's `<html lang>`
 * @param {Held} held
 */
export function placeholderWords(lang, held) {
	const code = /^(de|fr|es|it|nl|pt)\b/i.exec(lang ?? "")?.[1]?.toLowerCase() ?? "en";
	const words = WORDS[/** @type {keyof typeof WORDS} */ (code)];
	const fill = (/** @type {string} */ text) => text.replace("{name}", held.name);
	return {
		text: fill(held.kind === "map" ? words.map : words.video),
		load: held.kind === "map" ? words.loadMap : words.loadVideo,
		open: fill(words.open),
	};
}

/**
 * In the browser: show each held player once Marketing is allowed, or as soon
 * as the page loads where nobody is asked (no `data-cookie-consent` on <html>:
 * no banner on this site or this page, a preview, an excluded page). While the
 * visitor has not allowed Marketing, the placeholder says why and offers Load,
 * for this one video or map only. Follows Astro's <ClientRouter /> page changes.
 * @param {Document} d
 * @param {Window & { cookieConsent?: { marketing: boolean } }} w
 */
export function reveal(d, w) {
	const html = d.documentElement;
	/** @param {Element | null} box */
	const open = (box) => {
		const frame = box?.querySelector("template");
		if (!box || !frame) return;
		box.replaceChildren(frame.content.cloneNode(true));
		box.removeAttribute("data-cc-held");
		box.classList.add("cc-held-open");
	};
	const check = () => {
		const state = w.cookieConsent;
		for (const box of d.querySelectorAll("[data-cc-held]")) {
			if (!html.hasAttribute("data-cookie-consent") || state?.marketing) open(box);
			// Until the visitor's rule is known the box stays plain, so nobody who is not asked sees it flash.
			else if (state) {
				const ask = /** @type {HTMLElement | null} */ (box.querySelector(".cc-held-ask"));
				if (ask && ask.hidden) {
					const held = /** @type {Held} */ ({
						kind: box.getAttribute("data-cc-held") === "map" ? "map" : "video",
						name: box.getAttribute("data-cc-name") ?? "",
						link: "",
					});
					const text = placeholderWords(html.lang, held);
					const [p, button, link] = [".cc-held-text", "[data-cc-load]", ".cc-held-link"].map((s) =>
						box.querySelector(s),
					);
					// A playlist has no link to open: each part is set on its own.
					if (p) p.textContent = text.text;
					if (button) button.textContent = text.load;
					if (link) link.textContent = text.open;
					ask.hidden = false;
				}
			}
		}
	};
	d.addEventListener("click", (event) => {
		const target = /** @type {Element} */ (event.target);
		const button = target.closest?.("[data-cc-load]");
		if (button) open(button.closest(".cc-held"));
	});
	d.addEventListener("cookie-consent:change", check);
	d.addEventListener("astro:page-load", check);
	check();
}
