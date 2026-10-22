// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Outcome } from "./hubspot.js";
import { appLabel } from "./names.js";
import type { Delivery, Enquiry } from "./types.js";

export { APPS, appLabel } from "./names.js";

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function newSecret(): string {
	return `whsec_${toBase64(crypto.getRandomValues(new Uint8Array(24)))}`;
}

/** Standard Webhooks: `v1,` + base64 HMAC-SHA256 of `id.timestamp.body` with the decoded secret. */
export async function sign(secret: string, id: string, timestamp: number, body: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		fromBase64(secret.replace(/^whsec_/, "")),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${id}.${timestamp}.${body}`),
	);
	return `v1,${toBase64(new Uint8Array(mac))}`;
}

/** The flat JSON another app receives. */
export function appPayload(id: string, enquiry: Enquiry, test: boolean): Record<string, unknown> {
	const fields: Record<string, string> = {};
	const labels: Record<string, string> = {};
	for (const field of enquiry.fields) {
		fields[field.key] = field.value;
		labels[field.key] = field.label;
	}
	return {
		id,
		event: "enquiry",
		form: enquiry.formId,
		formName: enquiry.formName,
		receivedAt: enquiry.receivedAt,
		name: enquiry.name ?? null,
		email: enquiry.email ?? null,
		fields,
		labels,
		pageUrl: enquiry.pageUrl ?? null,
		utm: enquiry.utm ?? {},
		marks: marksOf(enquiry),
		...(enquiry.repeatAfterMs !== undefined
			? { repeatAfterMinutes: Math.floor(enquiry.repeatAfterMs / 60_000) }
			: {}),
		// Kept for apps built on 0.1; `marks` says the same and more.
		throwaway: enquiry.throwaway,
		test,
	};
}

/** The marks an enquiry carries, as apps receive them. */
export function marksOf(enquiry: Enquiry): Array<"throwaway" | "repeat" | "spam"> {
	const marks: Array<"throwaway" | "repeat" | "spam"> = [];
	if (enquiry.throwaway) marks.push("throwaway");
	if (enquiry.repeatAfterMs !== undefined) marks.push("repeat");
	if (enquiry.spam) marks.push("spam");
	return marks;
}

export async function appRequest(place: Delivery, id: string, enquiry: Enquiry, test: boolean) {
	const body = JSON.stringify(appPayload(id, enquiry, test));
	const timestamp = Math.floor(Date.now() / 1000);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"user-agent": "EmDash Lead Delivery",
		"webhook-id": id,
		"webhook-timestamp": String(timestamp),
	};
	if (place.secret) headers["webhook-signature"] = await sign(place.secret, id, timestamp, body);
	return { url: place.url ?? "", init: { method: "POST", headers, body } };
}

const path = (u: URL) => u.pathname.replace(/\/$/, "");

function sameTarget(a: string, b: string): boolean {
	try {
		const [x, y] = [new URL(a), new URL(b)];
		return x.origin === y.origin && path(x) === path(y) && x.search === y.search;
	} catch {
		return a === b;
	}
}

/** What another app's answer means. */
export function classifyApp(
	place: Delivery,
	status: number,
	finalUrl: string,
	bodyText: string,
): Outcome {
	const app = appLabel(place.app);
	const raw = `${app} answered ${status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`;
	if (status >= 200 && status < 300) {
		if (finalUrl && place.url && !sameTarget(finalUrl, place.url)) {
			return {
				kind: "fixing",
				raw: `Sent on to ${finalUrl}`,
				plain: `${app} sent the enquiry on to a different address, usually a sign-in page, so it did not arrive. Check the address in Lead delivery → ${place.name} → Edit.`,
			};
		}
		return { kind: "delivered" };
	}
	if (status === 408 || status === 429 || status >= 500) return { kind: "retry", raw };
	if (status === 404 || status === 410) {
		return {
			kind: "fixing",
			raw,
			plain: `That address no longer exists at ${app}${place.app === "zapier" ? ": the Zap may be off or deleted" : ""}. Check the address, then try again.`,
		};
	}
	return {
		kind: "fixing",
		raw,
		plain: `${app} refused the enquiry${bodyText.trim() ? ". Its own words are below" : ` without saying why (it answered ${status})`}. Check the address and the app, then press Send again.`,
	};
}
