// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Outcome } from "./hubspot.js";
import type { AppKind, Enquiry, Place } from "./types.js";

export const APPS: Array<{ value: AppKind; label: string; hint: string }> = [
	{ value: "zapier", label: "Zapier", hint: 'Zapier: use "Webhooks by Zapier", Catch Hook.' },
	{ value: "make", label: "Make", hint: "Make: Custom webhook." },
	{ value: "n8n", label: "n8n", hint: "n8n: Webhook node." },
	{ value: "other", label: "Something else", hint: "Any service that accepts a web address." },
];

export function appLabel(app: AppKind | undefined): string {
	return APPS.find((a) => a.value === app)?.label ?? "Another app";
}

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
		throwaway: enquiry.throwaway,
		test,
	};
}

export async function appRequest(place: Place, id: string, enquiry: Enquiry, test: boolean) {
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
	place: Place,
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
				plain: `${app} sent the enquiry on to a different address, usually a sign-in page, so it did not arrive. Check the address under Where enquiries go.`,
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
