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
const VIMEO_ID = /^\d{6,12}$/;
const YOUTUBE_HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"youtube-nocookie.com",
	"www.youtube-nocookie.com",
	"youtu.be",
]);
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
	if (!YOUTUBE_HOSTS.has(url.hostname)) return undefined;
	const parts = url.pathname.split("/").filter(Boolean);
	const id =
		url.hostname === "youtu.be"
			? parts[0]
			: (url.searchParams.get("v") ??
				(["embed", "shorts", "live", "v"].includes(parts[0] ?? "") ? parts[1] : undefined));
	return id && YOUTUBE_ID.test(id) ? id : undefined;
}

/** @param {URL} url */
function vimeoId(url) {
	if (!VIMEO_HOSTS.has(url.hostname)) return undefined;
	const parts = url.pathname.split("/").filter(Boolean);
	const id = url.hostname === "player.vimeo.com" ? parts[1] : parts.find((p) => VIMEO_ID.test(p));
	return id && VIMEO_ID.test(id) ? id : undefined;
}

/** @param {URL} url */
function isGoogleMap(url) {
	const host = url.hostname;
	const google = /^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host);
	if (google && /^\/maps\/(?:embed|d\/embed)/.test(url.pathname)) return true;
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
					if (p && button && link) {
						p.textContent = text.text;
						button.textContent = text.load;
						link.textContent = text.open;
					}
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
