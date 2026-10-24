// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * A signed download link for the consent log spreadsheet.
 *
 * EmDash refuses a signed-in plugin route unless the request carries the
 * `X-EmDash-Request: 1` header, and a plain link in the admin cannot send one.
 * Block Kit has no download element. So the admin page (itself a signed-in
 * request, and only for an Admin) signs a link, and the public export route
 * serves only a link this site signed in the last ten minutes.
 *
 * The signature is HMAC-SHA256 over the expiry, with a secret made once and
 * kept in the plugin's own store. The text signed starts with its own name, so
 * a link signed for anything else can never pass here. The same way of signing
 * is used by Popups for its Numbers spreadsheet.
 */

import type { PluginContext } from "emdash";

const SECRET_KEY = "export-secret";
/** How long a download link works. */
export const EXPORT_LINK_MS = 10 * 60 * 1000;
const DIGITS = /^\d{1,13}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

type Kv = Pick<PluginContext["kv"], "getVersioned" | "compareAndSet">;

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
function signedText(expires: number): Uint8Array<ArrayBuffer> {
	return encoder.encode(`consent-export:v1|${expires}`);
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

/** The query string for a download link: when it expires and the signature. */
export async function signExport(kv: Kv, now: number): Promise<string> {
	const expires = now + EXPORT_LINK_MS;
	const secret = await key(kv, true);
	if (!secret) throw new Error("Could not store the download signing secret");
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", secret, signedText(expires)));
	const query = new URLSearchParams();
	query.set("expires", String(expires));
	query.set("sig", toB64url(signature));
	return query.toString();
}

/**
 * True for a download link this site signed that has not expired. The
 * comparison is the Web Crypto verify, which takes the same time whatever the
 * signature.
 */
export async function checkExport(kv: Kv, params: URLSearchParams, now: number): Promise<boolean> {
	const expiresText = params.get("expires") ?? "";
	if (!DIGITS.test(expiresText)) return false;
	const expires = Number(expiresText);
	if (expires < now || expires > now + EXPORT_LINK_MS) return false;
	const signature = fromB64url(params.get("sig") ?? "");
	if (!signature || signature.length !== 32) return false;
	const secret = await key(kv, false);
	if (!secret) return false;
	return crypto.subtle.verify("HMAC", secret, signature, signedText(expires));
}
