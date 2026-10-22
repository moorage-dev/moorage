// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { AppKind, Delivery, DeliveryKind, KnownForm } from "./types.js";

/** The apps offered for "Another app", in the order shown. */
export const APPS: Array<{ value: AppKind; label: string; hint: string }> = [
	{ value: "zapier", label: "Zapier", hint: 'Zapier: use "Webhooks by Zapier", Catch Hook.' },
	{ value: "make", label: "Make", hint: "Make: Custom webhook." },
	{ value: "n8n", label: "n8n", hint: "n8n: Webhook node." },
	{ value: "other", label: "Another app", hint: "Any service that accepts a web address." },
];

export function appLabel(app: AppKind | undefined): string {
	return APPS.find((a) => a.value === app)?.label ?? "Another app";
}

export function formName(slug: string, known: Record<string, KnownForm>): string {
	return known[slug]?.name || slug;
}

/** "All forms", "Contact form", "Contact form and Quote", "Contact form and 2 more". */
export function formsLabel(forms: "all" | string[], known: Record<string, KnownForm>): string {
	if (forms === "all") return "All forms";
	const names = forms.map((slug) => formName(slug, known));
	if (names.length === 0) return "No form";
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} and ${names.length - 1} more`;
}

const INBOX_WORDS = ["shop", "info", "hello", "enquiries", "contact", "sales"];

/** Where a delivery sends, as its name says it: "Shop inbox", "2 inboxes", "HubSpot", "Zapier", "your app". */
export function destinationLabel(d: Pick<Delivery, "kind"> & Partial<Delivery>): string {
	if (d.kind === "hubspot") return "HubSpot";
	if (d.kind === "app") return d.app === "other" || !d.app ? "your app" : appLabel(d.app);
	const to = d.to ?? [];
	if (to.length > 1) return `${to.length} inboxes`;
	const first = to[0] ?? "";
	const local = first.split("@")[0]?.toLowerCase() ?? "";
	const word = INBOX_WORDS.find((w) => local.startsWith(w));
	if (word) return `${word[0]!.toUpperCase()}${word.slice(1)} inbox`;
	return first || "Email";
}

/** The destination as step 2 first names it, before anything is typed. */
export function kindWord(kind: DeliveryKind): string {
	return kind === "email" ? "Email" : kind === "hubspot" ? "HubSpot" : "App";
}

export function generatedName(
	forms: "all" | string[],
	d: Pick<Delivery, "kind"> & Partial<Delivery>,
	known: Record<string, KnownForm>,
): string {
	return `${formsLabel(forms, known)} → ${destinationLabel(d)}`;
}

/** The type a row in the deliveries list shows after the name, unless the name already says it. */
export function typeLabel(d: Pick<Delivery, "kind" | "app">): string {
	if (d.kind === "email") return "Email";
	if (d.kind === "hubspot") return "HubSpot";
	return appLabel(d.app);
}

export function rowLabel(d: Pick<Delivery, "kind" | "app" | "name">): string {
	const type = typeLabel(d);
	return d.name.toLowerCase().includes(type.toLowerCase()) ? d.name : `${d.name} · ${type}`;
}
