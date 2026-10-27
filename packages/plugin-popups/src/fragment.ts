// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PageFragmentContribution } from "emdash";
import clientCode from "virtual:client-script";

import { barInner } from "./client/bar.js";
import { styles } from "./client/css.js";
import type { ClientConfig, ClientItem } from "./client/types.js";
import { colourSet, OWN_COLOURS } from "./colour-sets.js";
import {
	AGAIN_DAYS,
	buttonText,
	DECLINE_LABEL,
	isLive,
	showsOn,
	type Colors,
	type Popup,
	type Settings,
	type Store,
} from "./config.js";
import { FORMS_API } from "./forms.js";

/** The name the browser bundle uses for its settings; swapped for JSON below. */
const PLACEHOLDER = "__PP_CONFIG__";
const BACKSLASH = String.fromCharCode(92);
const UNSAFE_IN_SCRIPT = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, "g");

export const TEXT: ClientConfig["t"] = {
	close: "Close",
	sending: "Sending…",
	failed: "That did not send. Please try again.",
	optional: "(optional)",
	required: "Please fill this in.",
};

/**
 * Campaign tags for a button link, so Google Analytics shows the visit as
 * coming from the popup. Only links to other websites: tags on a site's own
 * links would overwrite where the visitor really came from. Links that carry
 * their own tags are left alone.
 */
export function tagLink(
	link: string,
	popup: Pick<Popup, "handle" | "kind">,
	siteOrigin: string,
): string {
	if (!/^https?:\/\//i.test(link)) return link;
	try {
		const url = new URL(link);
		if (siteOrigin && url.origin === siteOrigin) return link;
		if ([...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith("utm_")))
			return link;
		url.searchParams.set("utm_source", "popups");
		url.searchParams.set(
			"utm_medium",
			popup.kind === "bar" ? "top-bar" : popup.kind === "slide" ? "slide-in" : "popup",
		);
		url.searchParams.set("utm_campaign", popup.handle);
		return url.href;
	} catch {
		return link;
	}
}

/** What the browser needs to know about one popup, and nothing else. Boxes in a page are drawn by the server. */
export function clientItem(popup: Popup, siteOrigin: string): ClientItem | null {
	return popup.kind === "inline" ? null : previewItem(popup, siteOrigin);
}

/** The same for any kind, a box in a page included: what "Preview on your site" draws. */
export function previewItem(popup: Popup, siteOrigin: string): ClientItem {
	const inline = popup.kind === "inline";
	const c: ClientItem["c"] = {
		h: popup.heading,
		x: popup.text,
		// A box in a page is part of the page: no way out to offer.
		no: popup.decline === "none" || inline ? "" : DECLINE_LABEL[popup.decline],
	};
	if (popup.picture) {
		c.img = { u: popup.picture.url, a: popup.picture.alt };
		if (popup.picture.width) c.img.w = popup.picture.width;
		if (popup.picture.height) c.img.h = popup.picture.height;
	}
	if (popup.contains === "form" && popup.form && popup.kind !== "bar") {
		c.form = popup.form;
		c.ty = popup.thanks || "Thank you";
	} else if (popup.buttonLabel && popup.buttonUrl) {
		// A box in a page links as written (its component adds no campaign tags).
		c.b = {
			l: popup.buttonLabel,
			u: inline ? popup.buttonUrl : tagLink(popup.buttonUrl, popup, siteOrigin),
		};
	}
	const item: ClientItem = {
		i: popup.id,
		n: popup.handle,
		k: popup.kind,
		t: popup.kind === "bar" || inline ? "load" : popup.trigger === "load" ? "read" : popup.trigger,
		// A box in a page shows on every device: it has no "On" choice.
		d: inline ? 0 : popup.devices === "desktop" ? 1 : popup.devices === "phone" ? 2 : 0,
		a: AGAIN_DAYS[popup.again],
		c,
	};
	if (popup.firstPage && popup.kind === "modal") item.f = 1;
	if (popup.start !== null) item.s = popup.start;
	if (popup.end !== null) item.e = popup.end;
	return item;
}

export function clientConfig(
	settings: Settings,
	items: ClientItem[],
	pluginId: string,
): ClientConfig {
	const out: ClientConfig = {
		api: `/_emdash/api/plugins/${pluginId}/`,
		forms: FORMS_API,
		sc: settings.scheme,
		items,
		t: TEXT,
	};
	const { light, dark } = lookColours(settings);
	if (light) out.col = forBrowser(light);
	if (dark) out.colDark = forBrowser(dark);
	if (settings.corner === "left") out.left = 1;
	return out;
}

/** Colours in the browser's short form, with the button's words chosen. */
const forBrowser = ({ background: g, text: f, accent: x }: Colors) => ({
	g,
	f,
	x,
	y: buttonText(x),
});

/** Colours with the button's words chosen, for a box in a page. */
const ready = (c: Colors | undefined) => (c ? { ...c, accentText: buttonText(c.accent) } : null);

/**
 * The colours the settings choose, as plain colours: a set's light and dark versions, the
 * owner's own (one version for every device), or none for the theme's colours.
 */
export function lookColours(settings: Settings): { light?: Colors; dark?: Colors } {
	const set = colourSet(settings.colourSet);
	if (set) return { light: set.light, dark: set.dark };
	const { background, text, accent } = settings.colors;
	if (settings.colourSet === OWN_COLOURS && background && text && accent)
		return { light: settings.colors };
	return {};
}

/**
 * A box in a page's colours, for the server's HTML: the one version the look picks, or a
 * light one and a dark one to swap in on a dark device. The button's words are chosen here.
 */
export function boxColours(settings: Settings): {
	colors: (Colors & { accentText: string }) | null;
	darkColors: (Colors & { accentText: string }) | null;
} {
	const { light, dark } = lookColours(settings);
	if (!light) return { colors: null, darkColors: null };
	if (!dark) return { colors: ready(light), darkColors: null };
	if (settings.scheme === "dark") return { colors: ready(dark), darkColors: null };
	if (settings.scheme === "light") return { colors: ready(light), darkColors: null };
	return { colors: ready(light), darkColors: ready(dark) };
}

/** JSON that is safe inside a `<script>`. */
export function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(UNSAFE_IN_SCRIPT, (ch) => {
		return `${BACKSLASH}u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}

export function clientScriptFor(config: ClientConfig): string {
	return clientCode.replace(PLACEHOLDER, () => scriptJson(config));
}

/**
 * A top bar as server HTML, in a declarative shadow root, so it is on screen
 * at first paint and reserves its height: nothing moves. The head script
 * hides it before the page draws when this visitor closed it, or it is out of
 * its dates or on the wrong device.
 */
export function barHtml(item: ClientItem, config: ClientConfig): string {
	return (
		`<div id="popups-bar-${item.i}" data-popups-bar="${item.i}" style="display:block">` +
		`<template shadowrootmode="open"><style>${styles(config.sc, config.col, config.colDark)}</style>` +
		barInner(item, config.t.close) +
		`</template></div>`
	);
}

export interface PageFacts {
	path: string;
	url: string;
	collection?: string;
	editMode: boolean;
	preview: boolean;
}

export function isQuiet(page: PageFacts): boolean {
	if (page.editMode || page.preview) return true;
	if (page.path === "/_emdash" || page.path.startsWith("/_emdash/")) return true;
	return /[?&]_preview=/.test(page.url);
}

/** The popup a link from the admin's "Preview on your site" shows, or undefined. */
export function previewIdOf(url: string): string | undefined {
	return /[?&]popups_preview=([a-z0-9]{4,40})(&|#|$)/.exec(url)?.[1];
}

/** True for a link from the admin's "Preview on your site". */
export function isPopupPreview(url: string): boolean {
	return previewIdOf(url) !== undefined;
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

/**
 * Everything the plugin adds to one public page: an inline script in the head
 * and any top bars at the start of the body, or nothing. Pure.
 */
export function pageFragments(
	store: Store,
	pluginId: string,
	page: PageFacts,
	now: number,
): PageFragmentContribution[] {
	if (isQuiet(page)) return [];
	const origin = originOf(page.url);
	const items = store.popups
		.filter(
			(popup) =>
				isLive(popup, now) && showsOn(popup, { path: page.path, collection: page.collection }),
		)
		.map((popup) => clientItem(popup, origin))
		.filter((item): item is ClientItem => item !== null);
	const previewId = previewIdOf(page.url);
	const preview = previewId !== undefined;
	if (items.length === 0 && !preview) return [];
	const config = clientConfig(store.settings, items, pluginId);
	// Only whether the previewed popup is set for this page; its words come from the private route.
	const previewed = store.popups.find((popup) => popup.id === previewId);
	if (
		previewed &&
		(previewed.kind === "inline" ||
			showsOn(previewed, { path: page.path, collection: page.collection }))
	)
		config.here = 1;
	const out: PageFragmentContribution[] = [
		{
			kind: "inline-script",
			placement: "head",
			key: `${pluginId}:boot`,
			code: clientScriptFor(config),
		},
	];
	const bars = preview ? [] : items.filter((item) => item.k === "bar");
	if (bars.length) {
		out.push({
			kind: "html",
			placement: "body:start",
			key: `${pluginId}:bars`,
			html: bars.map((bar) => barHtml(bar, config)).join(""),
		});
	}
	return out;
}
