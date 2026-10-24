// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * A signed download link for a results spreadsheet: all popups (the Results
 * tab) or one popup (its own page), for the days on screen.
 *
 * EmDash refuses a signed-in plugin route unless the request carries the
 * `X-EmDash-Request: 1` header, and a plain link in the admin cannot send one.
 * Block Kit has no download element, and a native plugin's React page would
 * replace the whole Block Kit page. So the admin page (itself a signed-in
 * request) signs a link for the dates on screen, and the public export route
 * serves only a link it signed in the last ten minutes, for exactly those dates.
 *
 * The signature is HMAC-SHA256 over the dates and the expiry, with a secret
 * made once and kept in the plugin's own store. The spreadsheet holds daily
 * counts per popup and the popups' names: no visitor data.
 */

import type { PluginContext } from "emdash";

const SECRET_KEY = "export-secret";
/** How long a download link works. */
export const EXPORT_LINK_MS = 10 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POPUP = /^[a-z0-9]{4,40}$/;
const DIGITS = /^\d{1,13}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

type Kv = Pick<PluginContext["kv"], "getVersioned" | "compareAndSet">;

export interface ExportRange {
	/** YYYY-MM-DD; "" only in links signed before 0.2.0 (since the start). */
	from: string;
	/** YYYY-MM-DD; "" only in links signed before 0.2.0 (today). */
	to: string;
	/** One popup's id, or "" for every popup. */
	popup?: string;
}

function toB64url(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!B64URL.test(text)) return null;
	try {
		const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
		const out = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/** What is signed. Minting and checking both build it here, so they never disagree. */
function signedText(range: ExportRange, expires: number): Uint8Array<ArrayBuffer> {
	return encoder.encode(
		`popups-export:v2|${range.from}|${range.to}|${range.popup ?? ""}|${expires}`,
	);
}

function secretBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
	const raw = typeof value === "string" ? fromB64url(value) : null;
	return raw && raw.length >= 32 ? raw : null;
}

/**
 * The site's signing key. The first time, it is made with a compare-and-set, so
 * two admin pages opening at once agree on one secret: the one that loses reads
 * and uses the winner's.
 */
async function key(kv: Kv, create: boolean): Promise<CryptoKey | null> {
	let raw: Uint8Array<ArrayBuffer> | null = null;
	for (let attempt = 0; attempt < 3 && !raw; attempt++) {
		const stored = await kv.getVersioned<string>(SECRET_KEY);
		raw = secretBytes(stored?.value);
		if (raw || !create) break;
		const fresh = crypto.getRandomValues(new Uint8Array(32));
		const written = await kv.compareAndSet(SECRET_KEY, stored?.revision ?? null, toB64url(fresh));
		if (written.applied) raw = fresh;
	}
	if (!raw) return null;
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

/** The query string for a download link: the dates, when it expires and the signature. */
export async function signExport(kv: Kv, range: ExportRange, now: number): Promise<string> {
	const clean = {
		from: DAY.test(range.from) ? range.from : "",
		to: DAY.test(range.to) ? range.to : "",
		popup: POPUP.test(range.popup ?? "") ? range.popup : "",
	};
	const expires = now + EXPORT_LINK_MS;
	const secret = await key(kv, true);
	if (!secret) throw new Error("Could not store the download signing secret");
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", secret, signedText(clean, expires)),
	);
	const query = new URLSearchParams();
	if (clean.from) query.set("from", clean.from);
	if (clean.to) query.set("to", clean.to);
	if (clean.popup) query.set("popup", clean.popup);
	query.set("expires", String(expires));
	query.set("sig", toB64url(signature));
	return query.toString();
}

/**
 * The dates a download link was signed for, or null when it is not a link this
 * site signed, has been changed, or has expired. The comparison is the Web
 * Crypto verify, which takes the same time whatever the signature.
 */
export async function checkExport(
	kv: Kv,
	params: URLSearchParams,
	now: number,
): Promise<ExportRange | null> {
	const range = {
		from: params.get("from") ?? "",
		to: params.get("to") ?? "",
		popup: params.get("popup") ?? "",
	};
	if ((range.from && !DAY.test(range.from)) || (range.to && !DAY.test(range.to))) return null;
	if (range.popup && !POPUP.test(range.popup)) return null;
	const expiresText = params.get("expires") ?? "";
	if (!DIGITS.test(expiresText)) return null;
	const expires = Number(expiresText);
	if (expires < now || expires > now + EXPORT_LINK_MS) return null;
	const signature = fromB64url(params.get("sig") ?? "");
	if (!signature || signature.length !== 32) return null;
	const secret = await key(kv, false);
	if (!secret) return null;
	const good = await crypto.subtle.verify("HMAC", secret, signature, signedText(range, expires));
	return good ? range : null;
}
