// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { parseUrl } from "./url.js";

/** Where a home page says "do not list me": a tag in the page, or a header from the server. */
export type Noindex = "meta" | "header";

const META_TAG = /<meta\b[^>]*>/gi;
const ATTRIBUTE = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const NOINDEX = /(^|[\s,])(noindex|none)([\s,]|$)/i;
/** Only the head is read: a tag later on is not one search engines see as the page's. */
const HEAD_LIMIT = 50_000;

function attributes(tag: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const match of tag.matchAll(ATTRIBUTE)) {
		const name = match[1]?.toLowerCase();
		if (name) found.set(name, match[2] ?? match[3] ?? match[4] ?? "");
	}
	return found;
}

/**
 * Does the home page tell Google, or every search engine, not to list it? A
 * `robots` or `googlebot` meta tag, or an `X-Robots-Tag` header for everyone or
 * for Googlebot. Another crawler's own instruction is its owner's choice.
 */
export function homeNoindex(headers: Headers | undefined, body: string): Noindex | null {
	// Several values come joined by commas: "googlebot: noindex, otherbot: noarchive".
	for (const value of (headers?.get("x-robots-tag") ?? "").split(/,(?=\s*[a-z][\w-]*\s*:)/i)) {
		const named = /^\s*([a-z][\w-]*)\s*:\s*(.*)$/i.exec(value);
		const agent = named?.[1]?.toLowerCase();
		// "unavailable_after: <date>" is a rule, not a crawler's name.
		const forOne = named !== null && agent !== "unavailable_after";
		if (forOne && agent !== "googlebot") continue;
		if (NOINDEX.test(forOne ? (named[2] ?? "") : value)) return "header";
	}
	const end = body.search(/<body\b/i);
	const head = body.slice(0, end >= 0 ? Math.min(end, HEAD_LIMIT) : HEAD_LIMIT);
	for (const [tag] of head.matchAll(META_TAG)) {
		const attrs = attributes(tag);
		const name = attrs.get("name")?.trim().toLowerCase();
		if (name !== "robots" && name !== "googlebot") continue;
		if (NOINDEX.test(attrs.get("content") ?? "")) return "meta";
	}
	return null;
}

export interface Robots {
	/** Googlebot may open no page: its own group, or the one for everyone when it has none. */
	google: boolean;
	/** The group for every crawler (`*`) lets none in. */
	all: boolean;
	/** Googlebot is kept out, but a narrower `Allow` (`/blog`) lets a few addresses in. */
	googleSome: boolean;
	/** The same for every crawler. */
	allSome: boolean;
	/** The lists of pages it names, as full addresses. */
	sitemaps: string[];
}

interface Group {
	agents: string[];
	disallowAll: boolean;
	/** An `Allow` of the whole site (`/`, `/*` or `/$`); one file or folder is not. */
	allowsAll: boolean;
	/** An `Allow` of one file or folder. */
	allowsSome: boolean;
}

/** Kept out of everything, a few addresses allowed back. */
function blocksMost(groups: Group[]): boolean {
	return blocksAll(groups) && groups.some((g) => g.allowsSome);
}

/** The `Allow` values that cancel a `Disallow: /` in the same group. */
const ALLOWS_ALL = new Set(["/", "/*", "/$"]);

function blocksAll(groups: Group[]): boolean {
	return groups.some((g) => g.disallowAll) && !groups.some((g) => g.allowsAll);
}

/**
 * robots.txt, one group of crawlers at a time. Stacked `User-agent` lines share a
 * group; a crawler with a group of its own ignores the one for everyone. A group
 * keeps everything out when it disallows `/` (or `/*`) and does not allow the
 * whole site back (`Allow: /favicon.ico` lets one file in, not the site).
 */
export function readRobots(text: string, origin = ""): Robots {
	const groups: Group[] = [];
	const sitemaps: string[] = [];
	let current: Group | null = null;
	let rules = false;
	// A file saved with a byte-order mark starts with one.
	for (const raw of text.replace(/^﻿/, "").split(/\r?\n|\r/)) {
		const line = raw.replace(/#.*/, "").trim();
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const field = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (field === "sitemap") {
			const url = parseUrl(value, origin || undefined);
			if (url && /^https?:$/.test(url.protocol)) sitemaps.push(url.href);
			continue;
		}
		if (field === "user-agent") {
			if (!current || rules) {
				current = { agents: [], disallowAll: false, allowsAll: false, allowsSome: false };
				groups.push(current);
				rules = false;
			}
			current.agents.push(value.toLowerCase());
			continue;
		}
		if (!current) continue;
		if (field === "disallow") {
			rules = true;
			if (value === "/" || value === "/*") current.disallowAll = true;
		} else if (field === "allow") {
			rules = true;
			if (ALLOWS_ALL.has(value)) current.allowsAll = true;
			else if (value !== "") current.allowsSome = true;
		}
	}
	const named = (agent: string) => groups.filter((g) => g.agents.includes(agent));
	const everyone = named("*");
	const googlebot = named("googlebot");
	const google = googlebot.length > 0 ? googlebot : everyone;
	return {
		google: blocksAll(google),
		all: blocksAll(everyone),
		googleSome: blocksMost(google),
		allSome: blocksMost(everyone),
		sitemaps,
	};
}

/** A list of pages (`<urlset>`) or a list of such lists (`<sitemapindex>`), as search engines read them. */
export function isSitemap(body: string | undefined): boolean {
	if (!body) return false;
	const start = body
		.slice(0, 2000)
		.replace(/^﻿/, "")
		.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, "")
		.trimStart();
	return /^<(?:[a-z]+:)?(urlset|sitemapindex)[\s>]/i.test(start);
}
