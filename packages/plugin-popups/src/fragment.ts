// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PageFragmentContribution } from "emdash";
import clientCode from "virtual:client-script";

import { styles } from "./client/css.js";
import { CLOSE } from "./client/icons.js";
import type { ClientConfig, ClientItem } from "./client/types.js";
import {
	AGAIN_DAYS,
	buttonText,
	DECLINE_LABEL,
	isLive,
	showsOn,
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
export function tagLink(link: string, popup: Pick<Popup, "handle" | "kind">, siteOrigin: string): string {
	if (!/^https?:\/\//i.test(link)) return link;
	try {
		const url = new URL(link);
		if (siteOrigin && url.origin === siteOrigin) return link;
		if ([...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith("utm_"))) return link;
		url.searchParams.set("utm_source", "popups");
		url.searchParams.set("utm_medium", popup.kind === "bar" ? "top-bar" : popup.kind === "slide" ? "slide-in" : "popup");
		url.searchParams.set("utm_campaign", popup.handle);
		return url.href;
	} catch {
		return link;
	}
}

/** What the browser needs to know about one popup, and nothing else. */
export function clientItem(popup: Popup, siteOrigin: string): ClientItem | null {
	if (popup.kind === "inline") return null;
	const c: ClientItem["c"] = { h: popup.heading, x: popup.text, no: popup.decline === "none" ? "" : DECLINE_LABEL[popup.decline] };
	if (popup.picture) {
		c.img = { u: popup.picture.url, a: popup.picture.alt };
		if (popup.picture.width) c.img.w = popup.picture.width;
		if (popup.picture.height) c.img.h = popup.picture.height;
	}
	if (popup.contains === "form" && popup.form && popup.kind !== "bar") {
		c.form = popup.form;
		c.ty = popup.thanks || "Thank you";
	} else if (popup.buttonLabel && popup.buttonUrl) {
		c.b = { l: popup.buttonLabel, u: tagLink(popup.buttonUrl, popup, siteOrigin) };
	}
	const item: ClientItem = {
		i: popup.id,
		n: popup.handle,
		k: popup.kind,
		t: popup.kind === "bar" ? "load" : popup.trigger === "load" ? "read" : popup.trigger,
		d: popup.devices === "desktop" ? 1 : popup.devices === "phone" ? 2 : 0,
		a: AGAIN_DAYS[popup.again],
		c,
	};
	if (popup.firstPage && popup.kind === "modal") item.f = 1;
	if (popup.start !== null) item.s = popup.start;
	if (popup.end !== null) item.e = popup.end;
	return item;
}

export function clientConfig(settings: Settings, items: ClientItem[], pluginId: string): ClientConfig {
	const out: ClientConfig = {
		api: `/_emdash/api/plugins/${pluginId}/`,
		forms: FORMS_API,
		sc: settings.scheme,
		items,
		t: TEXT,
	};
	if (settings.custom && settings.colors.background && settings.colors.text && settings.colors.accent) {
		const { background: g, text: f, accent: x } = settings.colors;
		out.col = { g, f, x, y: buttonText(x) };
	}
	if (settings.corner === "left") out.left = 1;
	return out;
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

const esc = (text: string) =>
	text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * A top bar as server HTML, in a declarative shadow root, so it is on screen
 * at first paint and reserves its height: nothing moves. The head script
 * hides it before the page draws when this visitor closed it, or it is out of
 * its dates or on the wrong device.
 */
export function barHtml(item: ClientItem, config: ClientConfig): string {
	const link = item.c.b ? ` <a href="${esc(item.c.b.u)}" data-pp-go>${esc(item.c.b.l)}</a>` : "";
	const words = esc(item.c.h) + (item.c.x ? ` ${esc(item.c.x)}` : "");
	return (
		`<div id="popups-bar-${item.i}" data-popups-bar="${item.i}" style="display:block">` +
		`<template shadowrootmode="open"><style>${styles(config.sc, config.col)}</style>` +
		`<div class="pp bar" role="region" aria-label="Announcement"><div class="i">${words}${link}</div>` +
		`<button type="button" class="x" data-pp-close aria-label="${esc(config.t.close)}">${CLOSE}</button></div>` +
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

/** True for a link from the admin's "Preview on your site". */
export function isPopupPreview(url: string): boolean {
	return /[?&]popups_preview=[a-z0-9]{4,40}(&|#|$)/.test(url);
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
		.filter((popup) => isLive(popup, now) && showsOn(popup, { path: page.path, collection: page.collection }))
		.map((popup) => clientItem(popup, origin))
		.filter((item): item is ClientItem => item !== null);
	const preview = isPopupPreview(page.url);
	if (items.length === 0 && !preview) return [];
	const config = clientConfig(store.settings, items, pluginId);
	const out: PageFragmentContribution[] = [
		{ kind: "inline-script", placement: "head", key: `${pluginId}:boot`, code: clientScriptFor(config) },
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
