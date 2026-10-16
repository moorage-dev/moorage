// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Parse a URL, or return null. `URL.canParse` is missing from the sandbox
 * runtime EmDash uses in development, so this is the only parser used here.
 */
export function parseUrl(value: string, base?: string): URL | null {
	try {
		return new URL(value, base);
	} catch {
		return null;
	}
}

/** A link as stored: a path for this site, a full address for another. */
export interface Target {
	/** `/menu` for this site, `https://example.com/page` for another. */
	url: string;
	internal: boolean;
	/** Host of another site; empty for this site. */
	host: string;
	/** The address used http, not https. */
	insecure: boolean;
}

const SKIP_SCHEMES = /^(mailto|tel|sms|javascript|data|blob|about|ftp):/i;

/** Paths EmDash itself serves (media, admin, API): never page links. */
export function isSystemPath(path: string): boolean {
	return path.startsWith("/_emdash/") || path.startsWith("/_astro/") || path === "/_emdash";
}

/** Trim a path to the form pages are stored under: no query, fragment or trailing slash. */
export function normalizePath(path: string): string {
	let decoded = path;
	try {
		decoded = decodeURI(path);
	} catch {
		// Keep it as written.
	}
	const clean = decoded.replace(/\/{2,}/g, "/");
	if (clean.length > 1 && clean.endsWith("/")) return clean.slice(0, -1);
	return clean || "/";
}

/**
 * Work out what a link points at, relative to this site. Returns null for
 * links that are not web pages (email, phone, anchors on the same page) and
 * for EmDash's own media and admin addresses.
 */
export function toTarget(raw: string, siteUrl: string): Target | null {
	const value = raw.trim();
	if (value === "" || value.startsWith("#") || value.startsWith("?")) return null;
	if (SKIP_SCHEMES.test(value)) return null;
	if (/\s/.test(value) && !/^https?:\/\//i.test(value)) return null;
	const site = parseUrl(siteUrl);
	const isAbsolute = /^https?:\/\//i.test(value) || value.startsWith("//");
	if (!isAbsolute && !value.startsWith("/")) return null;
	const url = parseUrl(value.startsWith("//") ? `https:${value}` : value, "https://site.invalid");
	if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
	const host = url.hostname.toLowerCase();
	const ownHost =
		!isAbsolute ||
		(site !== null && host.replace(/^www\./, "") === site.hostname.replace(/^www\./, ""));
	if (ownHost) {
		const path = normalizePath(url.pathname);
		if (isSystemPath(path)) return null;
		return {
			url: path,
			internal: true,
			host: "",
			insecure: isAbsolute && url.protocol === "http:",
		};
	}
	url.hash = "";
	return { url: url.href, internal: false, host, insecure: url.protocol === "http:" };
}

/** A short, stable storage id for any address (FNV-1a, 52 bits, base 36). */
export function idFor(kind: string, url: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	const text = `${kind}|${url}`;
	for (let i = 0; i < text.length; i += 1) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
	}
	return `${kind[0]}${h1.toString(36)}${(h2 & 0xfffff).toString(36)}`;
}

/**
 * An address short enough for a phone: no scheme, no `www.`, at most `max`
 * characters with an ellipsis. Block Kit tables scroll sideways when a cell
 * holds a long unbroken word, which would push the Fix menu off screen.
 */
export function shorten(url: string, max = 30): string {
	const bare = url
		.replace(/^https?:\/\//i, "")
		.replace(/^www\./i, "")
		.replace(/\/$/, "");
	return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

/** The site's own origin, or null when the site has no public address yet. */
export function publicOrigin(siteUrl: string): string | null {
	const url = parseUrl(siteUrl);
	if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
	if (/^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
	if (host === "[::1]" || host.startsWith("[fc") || host.startsWith("[fd")) return null;
	return url.origin;
}
