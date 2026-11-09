// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { parseUrl, sameSite } from "./url.js";

/**
 * What a move from WordPress leaves in an entry, read from the entry's saved data
 * alone (the full check already has it): shortcodes shown as plain text, empty HTML
 * blocks, links to WordPress addresses, a slug in WordPress's coded form, and
 * pictures without alt text.
 */
export type LeftType = "shortcode" | "empty-html" | "old-link" | "encoded-slug" | "no-alt";

export interface Leftover {
	type: LeftType;
	/** Unique per entry and per row: the same shortcode on two pages is one row. */
	key: string;
	/** What the owner sees: the shortcode, the address, the slug or the picture's name. */
	text: string;
	/** The WordPress block an empty block came from; "featured" for a featured image. */
	detail?: string;
	/** The old site's name, for a link to it. */
	host?: string;
}

export interface LeftContext {
	siteUrl: string;
	/** Sites known to be the old WordPress site (seen with WordPress-only addresses). */
	oldHosts: readonly string[];
	/** This site's own entries live at dated addresses (`/{year}/{month}/…`). */
	datedOwn: boolean;
}

const LINK_KEY = /^(href|url|link|src)$|(_url|Url|_href|Href|_link|Link)$/;
/** Keys that hold no words a visitor reads. */
const META_KEY = /^(_type|_key|_ref|style|listItem|language|marks|provider|mimeType|id)$/;
const IMAGE_KEY = /image|photo|picture|thumbnail|avatar|logo|cover|banner|hero|icon/i;
const MAX_NODES = 5000;
const MAX_TEXT = 20_000;
const MAX_FOUND = 20;

/**
 * `[name attr="…"]`, `[name]`, `[/name]`. Lower-case names only, as WordPress
 * registers them; never followed by `(` (a Markdown link).
 */
const SHORTCODE = /\[(\/?)([a-z][a-z0-9_-]*)((?:\s[^[\]]*)?)\](?!\()/g;
/** Shortcodes a WordPress site commonly has, matched even with nothing inside. */
const KNOWN =
	/^(gallery|caption|wp_caption|embed|audio|video|playlist|contact-form-7|contact-form|wpforms|gravityforms?|ninja_forms?|formidable|mc4wp_form|products?|add_to_cart|recent_posts|instagram-feed|(et_pb|vc|fusion|av|cs|su)_[a-z0-9_-]+)$/;
const ATTRIBUTE = /\s[a-z_][\w-]*\s*=/i;

/** Addresses only WordPress serves, on any site. */
const WP_PATH = /^\/(wp-content|wp-includes|wp-admin|wp-json)(\/|$)|^\/wp-login\.php$/;
/** WordPress's dated post addresses: /2024/05/slug/ or /2024/05/12/slug/. */
const DATED = /^\/\d{4}\/\d{2}\/(\d{2}\/)?[^/]+\/?$/;

const HTML_LINK = /\b(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const MEDIA_TAG =
	/<(img|iframe|video|audio|embed|object|svg|canvas|form|input|script|picture|hr)\b/i;

function bare(host: string): string {
	return host.toLowerCase().replace(/^www\./, "");
}

/** `/?p=12`, `/?page_id=7`, `/index.php?p=3`: WordPress's plain addresses. */
function isWordPressQuery(url: URL): boolean {
	if (url.pathname !== "/" && !url.pathname.endsWith("/index.php")) return false;
	for (const name of ["p", "page_id", "cat", "attachment_id"]) {
		if (/^\d+$/.test(url.searchParams.get(name) ?? "")) return true;
	}
	return false;
}

interface Classified {
	/** Another site (its name), or this site (""). */
	host: string;
	/** An address only WordPress serves: names the old site by itself. */
	strong: boolean;
	dated: boolean;
}

/** Could this address be a WordPress one at all? A cheap look before parsing it. */
const MAYBE_WP = /wp-|\?|\/\d{4}\/\d{2}\//;

/**
 * What an address is, for WordPress's purposes. `anyHost`: other sites' addresses
 * matter whatever their path (an old site is known); otherwise only addresses that
 * could be WordPress's are parsed, which keeps a page of ordinary links cheap.
 */
function classify(raw: string, site: URL | null, anyHost: boolean): Classified | null {
	const value = raw.trim();
	if (value === "" || value.length > 2000) return null;
	const absolute = /^https?:\/\//i.test(value) || value.startsWith("//");
	if (!absolute && !value.startsWith("/") && !value.startsWith("?")) return null;
	if (!MAYBE_WP.test(value) && !(absolute && anyHost)) return null;
	const url = parseUrl(value.startsWith("//") ? `https:${value}` : value, "https://site.invalid/");
	if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
	const own = !absolute || (site !== null && sameSite(url.hostname.toLowerCase(), site.hostname));
	return {
		host: own ? "" : bare(url.hostname),
		strong: isWordPressQuery(url) || WP_PATH.test(url.pathname),
		dated: DATED.test(url.pathname),
	};
}

/** Is this address a WordPress one: on this site, or on the old WordPress site? */
function oldLink(raw: string, context: LeftContext, site: URL | null): Leftover | null {
	const found = classify(raw, site, context.oldHosts.length > 0);
	if (!found) return null;
	const value = raw.trim();
	const hit =
		found.host === ""
			? found.strong || (found.dated && !context.datedOwn)
			: found.strong || context.oldHosts.includes(found.host);
	if (!hit) return null;
	return {
		type: "old-link",
		key: `old-link|${value}`,
		text: value,
		...(found.host ? { host: found.host } : {}),
	};
}

/** "core/latest-posts" -> "Latest Posts". */
function blockName(name: string): string {
	const last = name.split("/").pop() ?? name;
	return last
		.split(/[-_]/)
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join(" ");
}

function isEmptyHtml(html: string): boolean {
	const text = html.replace(/<!-{2}[\s\S]*?-{2}>/g, "");
	if (MEDIA_TAG.test(text)) return false;
	return (
		text
			.replace(/<[^>]*>/g, "")
			.replace(/&nbsp;|&#160;/gi, " ")
			.trim() === ""
	);
}

function shortcodesIn(text: string, add: (item: Leftover) => void): void {
	if (!text.includes("[")) return;
	const closing = new Set<string>();
	for (const match of text.matchAll(SHORTCODE)) if (match[1]) closing.add(match[2]!);
	for (const match of text.matchAll(SHORTCODE)) {
		if (match[1]) continue;
		const name = match[2]!;
		const inside = (match[3] ?? "").replace(/\s+/g, " ").trimEnd();
		if (!KNOWN.test(name) && !ATTRIBUTE.test(inside) && !closing.has(name)) continue;
		const shown = `[${name}${inside}]`;
		// One row per shortcode: a blog's hundred captions are one thing to tidy up, found on each page.
		add({ type: "shortcode", key: `shortcode|${name}`, text: shown });
	}
}

function fileName(value: unknown): string {
	if (typeof value !== "string" || value === "") return "";
	const path = value.split(/[?#]/)[0] ?? "";
	return decodeSafe(path.split("/").pop() ?? "");
}

function decodeSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function hasAlt(record: Record<string, unknown>): boolean {
	return typeof record.alt === "string" && record.alt.trim() !== "";
}

/** A media field's value: a picture picked from the library (or a legacy address). */
function isPictureValue(key: string, record: Record<string, unknown>): boolean {
	if (typeof record._type === "string") return false;
	if (typeof record.id !== "string" && typeof record.src !== "string") return false;
	if (!("src" in record || "provider" in record || "filename" in record)) return false;
	const type = typeof record.mimeType === "string" ? record.mimeType : "";
	return type ? type.startsWith("image/") : IMAGE_KEY.test(key);
}

/** Everything left over from WordPress in one entry, in the order it appears. */
export function leftoversIn(
	entry: { slug: string | null; data: unknown },
	context: LeftContext,
): Leftover[] {
	const site = parseUrl(context.siteUrl);
	const found = new Map<string, Leftover>();
	const add = (item: Leftover) => {
		if (found.size < MAX_FOUND && !found.has(item.key)) found.set(item.key, item);
	};
	if (entry.slug && /%[0-9a-f]{2}/i.test(entry.slug)) {
		add({ type: "encoded-slug", key: `encoded-slug|${entry.slug}`, text: entry.slug });
	}
	let nodes = 0;
	const walk = (value: unknown, key: string, depth: number) => {
		nodes += 1;
		if (nodes > MAX_NODES || depth > 30 || value === null) return;
		if (typeof value === "string") {
			if (LINK_KEY.test(key)) {
				const link = oldLink(value, context, site);
				if (link) add(link);
			} else if (!META_KEY.test(key) && value.length <= MAX_TEXT) shortcodesIn(value, add);
			return;
		}
		if (typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, key, depth + 1);
			return;
		}
		const record = value as Record<string, unknown>;
		const type = typeof record._type === "string" ? record._type : "";
		if (type === "code" || type === "codeBlock") return;
		if (type === "htmlBlock") {
			const html = typeof record.html === "string" ? record.html.slice(0, MAX_TEXT) : "";
			if (isEmptyHtml(html)) {
				const from =
					typeof record.originalBlockName === "string"
						? record.originalBlockName
						: (/<!-{2}\s*wp:([a-z0-9/-]+)/.exec(html)?.[1] ?? "");
				const detail = from ? blockName(from) : "";
				add({
					type: "empty-html",
					key: `empty-html|${detail}`,
					text: "",
					...(detail ? { detail } : {}),
				});
				return;
			}
			shortcodesIn(html, add);
			for (const match of html.matchAll(HTML_LINK)) {
				const link = oldLink((match[2] ?? match[3] ?? "").replaceAll("&amp;", "&"), context, site);
				if (link) add(link);
			}
			return;
		}
		if (type === "image") {
			const asset = (record.asset ?? {}) as Record<string, unknown>;
			const ref = typeof asset._ref === "string" ? asset._ref : "";
			if (!hasAlt(record)) {
				const name = fileName(asset.url) || fileName(record.src);
				add({
					type: "no-alt",
					key: `no-alt|${ref || name || nodes}`,
					text: name || "on this page",
				});
			}
			for (const [childKey, child] of Object.entries(record)) {
				if (childKey !== "asset" && childKey !== "alt") walk(child, childKey, depth + 1);
			}
			return;
		}
		if (isPictureValue(key, record)) {
			if (!hasAlt(record)) {
				const name =
					(typeof record.filename === "string" ? record.filename : "") || fileName(record.src);
				add({
					type: "no-alt",
					key: `no-alt|${typeof record.id === "string" ? record.id : name}`,
					text: name || "on this page",
					...(key === "featured_image" ? { detail: "featured" } : {}),
				});
			}
			return;
		}
		for (const [childKey, child] of Object.entries(record)) walk(child, childKey, depth + 1);
	};
	walk(entry.data, "", 0);
	return [...found.values()];
}

/** Other sites linked with addresses only WordPress serves: the old site, by its own addresses. */
export function oldHostsIn(data: unknown, siteUrl: string): string[] {
	const hosts = new Set<string>();
	const site = parseUrl(siteUrl);
	let nodes = 0;
	const check = (raw: string) => {
		const found = classify(raw, site, false);
		if (found && found.host && found.strong) hosts.add(found.host);
	};
	const walk = (value: unknown, key: string, depth: number) => {
		nodes += 1;
		if (nodes > MAX_NODES || depth > 30 || value === null) return;
		if (typeof value === "string") {
			if (LINK_KEY.test(key)) check(value);
			else if (key === "html" && value.length <= MAX_TEXT) {
				for (const match of value.matchAll(HTML_LINK))
					check((match[2] ?? match[3] ?? "").replaceAll("&amp;", "&"));
			}
			return;
		}
		if (typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, key, depth + 1);
			return;
		}
		for (const [childKey, child] of Object.entries(value as Record<string, unknown>))
			walk(child, childKey, depth + 1);
	};
	walk(data, "", 0);
	return [...hosts];
}

/** WordPress addresses in the site menu and footer, as the home page shows them. */
export function oldLinksIn(hrefs: readonly string[], context: LeftContext): Leftover[] {
	const found = new Map<string, Leftover>();
	const site = parseUrl(context.siteUrl);
	for (const href of hrefs) {
		const link = oldLink(href, context, site);
		if (link && !found.has(link.key)) found.set(link.key, link);
	}
	return [...found.values()];
}

/** Old sites named in the menu by their WordPress-only addresses. */
export function oldHostsOf(hrefs: readonly string[], siteUrl: string): string[] {
	const hosts = new Set<string>();
	const site = parseUrl(siteUrl);
	for (const href of hrefs) {
		const found = classify(href, site, false);
		if (found && found.host && found.strong) hosts.add(found.host);
	}
	return [...hosts];
}
