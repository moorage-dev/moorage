// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import { parseUrl } from "./url.js";

/** Where EmDash serves a locally stored media file: this prefix plus its storage key. */
const MEDIA_PATH = "/_emdash/api/media/file/";
// Storage keys are a ULID plus the file extension; an id is the ULID alone.
const STORAGE_KEY = /^[0-9A-HJKMNP-TV-Z]{26}(\.[A-Za-z0-9]+)?$/i;
/** Images remembered per entry. */
export const MAX_IMAGES = 10;
const MAX_DEPTH = 12;

/**
 * An image found in an entry's own fields, with the size EmDash recorded for
 * it. `keys` are every way the same file can be named: "file:" plus a storage
 * key or media id, or "url:" plus the address of an image hosted elsewhere.
 */
export interface EntryImage {
	keys: string[];
	width: number;
	height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function size(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 1
		? Math.round(value)
		: undefined;
}

/** The storage key in a media file address, or undefined when it is not one. */
function fileKey(pathname: string): string | undefined {
	if (!pathname.startsWith(MEDIA_PATH)) return undefined;
	let key = pathname.slice(MEDIA_PATH.length);
	try {
		key = decodeURIComponent(key);
	} catch {
		return undefined;
	}
	return key !== "" && !key.includes("/") ? key : undefined;
}

/**
 * The keys an image address can be matched on. None when the address has a
 * query string or goes through an image resizer: that picture is not the size
 * of the original, so its size is not known.
 */
export function imageKeys(url: string, siteUrl: string): string[] {
	const parsed = parseUrl(url, `${siteUrl.replace(/\/+$/, "")}/`);
	if (!parsed || !/^https?:$/.test(parsed.protocol)) return [];
	if (parsed.search !== "") return [];
	const { pathname } = parsed;
	if (pathname === "/_image" || pathname.includes("/cdn-cgi/image/")) return [];

	const local = fileKey(pathname);
	if (local) return [`file:${local}`];
	const keys = [`url:${parsed.origin}${pathname}`];
	// Storage with a public address serves the file as "<address>/<storage key>".
	const only = pathname.slice(1);
	if (STORAGE_KEY.test(only)) keys.push(`file:${only}`);
	return keys;
}

/** Keys for an address stored inside an entry (an image's `src` or `asset.url`). */
function storedUrlKeys(value: unknown): string[] {
	if (typeof value !== "string" || value === "") return [];
	if (value.startsWith("/")) {
		const local = value.includes("?") ? undefined : fileKey(value);
		return local ? [`file:${local}`] : [];
	}
	if (!/^https?:\/\//i.test(value)) return [];
	// The site's address plays no part: the value is absolute.
	return imageKeys(value, "http://localhost").filter((key) => key.startsWith("url:"));
}

function token(value: unknown): string[] {
	return typeof value === "string" && value !== "" && !value.includes("/") ? [`file:${value}`] : [];
}

/** An image field's value, or an image block in rich text, as one remembered image. */
function asImage(node: Record<string, unknown>): EntryImage | undefined {
	const width = size(node.width);
	const height = size(node.height);
	if (width === undefined || height === undefined) return undefined;
	if (typeof node.mimeType === "string" && !node.mimeType.startsWith("image/")) return undefined;

	const keys: string[] = [];
	if (node._type === "image" && isRecord(node.asset)) {
		keys.push(...token(node.asset._ref), ...storedUrlKeys(node.asset.url));
	} else if (typeof node.id === "string") {
		// A file kept elsewhere (an external provider) is known by its address only.
		if (node.provider === undefined || node.provider === "local") {
			const meta = isRecord(node.meta) ? node.meta : {};
			keys.push(...token(meta.storageKey), ...token(node.id));
		}
		keys.push(...storedUrlKeys(node.src));
	}
	const unique = [...new Set(keys)];
	return unique.length > 0 ? { keys: unique, width, height } : undefined;
}

/**
 * The images in an entry's own fields that carry a size: image fields at any
 * depth (blocks, repeaters) and image blocks in rich text. The first few only.
 */
export function collectImages(data: Record<string, unknown>): EntryImage[] {
	const found: EntryImage[] = [];
	const seen = new Set<string>();
	const visit = (value: unknown, depth: number) => {
		if (found.length >= MAX_IMAGES || depth > MAX_DEPTH) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		if (!isRecord(value)) return;
		const image = asImage(value);
		if (image && !image.keys.some((key) => seen.has(key))) {
			for (const key of image.keys) seen.add(key);
			found.push(image);
		}
		for (const child of Object.values(value)) visit(child, depth + 1);
	};
	for (const [key, value] of Object.entries(data)) {
		if (key !== "json_ld") visit(value, 0);
	}
	return found.slice(0, MAX_IMAGES);
}

/**
 * The recorded size of the picture at `url`, when it is certainly one of the
 * entry's images. Undefined otherwise: a wrong size is worse than none.
 */
export function findImageSize(
	images: EntryImage[] | undefined,
	url: string,
	siteUrl: string,
): { width: number; height: number } | undefined {
	if (!images || images.length === 0) return undefined;
	const keys = imageKeys(url, siteUrl);
	if (keys.length === 0) return undefined;
	const match = images.find((image) => image.keys.some((key) => keys.includes(key)));
	return match ? { width: match.width, height: match.height } : undefined;
}
