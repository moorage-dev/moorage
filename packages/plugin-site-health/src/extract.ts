// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { toTarget, type Target } from "./url.js";

/** What a found address is used for on the page. */
export type Use = "link" | "embed" | "image";

export interface Found extends Target {
	use: Use;
}

const LINK_KEY = /^(href|url|link|src)$|(_url|Url|_href|Href|_link|Link)$/;
const EMBED_TYPE = /iframe|embed|video|map|script|audio|form/i;
const IMAGE_TYPE = /image|picture|photo/i;
// A bound on the walk: an entry with more than this is not a page people read.
const MAX_NODES = 5000;

/**
 * Every address in an entry's saved data: Portable Text link marks, block
 * fields that hold an address (`primary_cta_url`, `href`, `src`), embeds and
 * pictures. One result per address and use.
 */
export function linksInData(data: unknown, siteUrl: string): Found[] {
	const found = new Map<string, Found>();
	let nodes = 0;
	const add = (value: string, use: Use) => {
		const target = toTarget(value, siteUrl);
		if (!target) return;
		found.set(`${use}|${target.url}`, { ...target, use });
	};
	const walk = (value: unknown, parentType: string, depth: number) => {
		nodes += 1;
		if (nodes > MAX_NODES || depth > 30 || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, parentType, depth + 1);
			return;
		}
		const record = value as Record<string, unknown>;
		const type = typeof record._type === "string" ? record._type : parentType;
		for (const [key, child] of Object.entries(record)) {
			if (typeof child === "string") {
				if (!LINK_KEY.test(key) || child.length > 2000) continue;
				const use: Use =
					key === "src" || key.endsWith("Src") || key.endsWith("_src")
						? IMAGE_TYPE.test(type)
							? "image"
							: EMBED_TYPE.test(type)
								? "embed"
								: "link"
						: "link";
				add(child, use);
			} else if (child && typeof child === "object") walk(child, type, depth + 1);
		}
	};
	walk(data, "", 0);
	return [...found.values()];
}

/** Pages are read up to this size; menus and embeds sit near the top. */
export const HTML_LIMIT = 200_000;

const HREF = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi;
const REGION = /<(header|nav|footer)\b[\s\S]*?<\/\1\s*>/gi;
const ACTIVE =
	/<(iframe|script|embed|object|video|audio|source)\b[^>]*?\bsrc\s*=\s*("http:[^"]*"|'http:[^']*')|<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet)[^>]*?\bhref\s*=\s*("http:[^"]*"|'http:[^']*')|<form\b[^>]*?\baction\s*=\s*("http:[^"]*"|'http:[^']*')/gi;
const PASSIVE = /<img\b[^>]*?\bsrc\s*=\s*("http:[^"]*"|'http:[^']*')/gi;

function unquote(value: string): string {
	return value.slice(1, -1).replaceAll("&amp;", "&");
}

export interface PageScan {
	/** Links in the site menu and footer (header, nav and footer elements). */
	menu: Target[];
	/** Maps, scripts, styles and forms loaded over an insecure connection. */
	active: string[];
	/** Pictures over an insecure connection (browsers upgrade these). */
	passive: string[];
}

/** Read what a rendered page shows every visitor, with a string scan (no DOM). */
export function scanHtml(html: string, siteUrl: string): PageScan {
	const text = html.length > HTML_LIMIT ? html.slice(0, HTML_LIMIT) : html;
	const menu = new Map<string, Target>();
	for (const region of text.matchAll(REGION)) {
		for (const match of region[0].matchAll(HREF)) {
			const target = toTarget((match[2] ?? match[3] ?? "").replaceAll("&amp;", "&"), siteUrl);
			if (target) menu.set(target.url, target);
		}
	}
	const active = new Set<string>();
	for (const match of text.matchAll(ACTIVE)) {
		const raw = match[2] ?? match[3] ?? match[4];
		if (raw) active.add(unquote(raw));
	}
	const passive = new Set<string>();
	for (const match of text.matchAll(PASSIVE)) {
		if (match[1]) passive.add(unquote(match[1]));
	}
	return { menu: [...menu.values()], active: [...active], passive: [...passive] };
}

/** How a content type's entries are addressed, as EmDash builds the path. */
export function entryPath(
	pattern: string | null,
	collection: string,
	entry: { slug: string | null; id: string; publishedAt?: string | null },
): string | null {
	if (!entry.slug) return null;
	const base = pattern ?? `/${encodeURIComponent(collection)}/{slug}`;
	const date = entry.publishedAt ? new Date(entry.publishedAt) : null;
	const pad = (n: number) => String(n).padStart(2, "0");
	const parts: Record<string, string> =
		date && !Number.isNaN(date.getTime())
			? {
					year: String(date.getUTCFullYear()),
					month: pad(date.getUTCMonth() + 1),
					day: pad(date.getUTCDate()),
					hour: pad(date.getUTCHours()),
					minute: pad(date.getUTCMinutes()),
					second: pad(date.getUTCSeconds()),
				}
			: {};
	let path = base
		.replaceAll("{slug}", encodeURIComponent(entry.slug))
		.replaceAll("{id}", encodeURIComponent(entry.id))
		.replace(
			/\{(year|month|day|hour|minute|second)\}/g,
			(match, key: string) => parts[key] ?? match,
		);
	if (path.includes("{")) return null;
	path = path.replace(/\/{2,}/g, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}
