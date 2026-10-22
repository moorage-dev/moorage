// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { loadForms, PING_KEY, randomString, routeUrl, saveForms } from "./config.js";
import type { FieldInfo, KnownForm, ReachResult } from "./types.js";

export type Lookup =
	| { kind: "found"; name: string; slug: string; fields: FieldInfo[] }
	| { kind: "missing" }
	| { kind: "unreachable" };

const SHORT_NAME = /^[a-z][a-z0-9-]{0,99}$/;

export function isShortName(value: string): boolean {
	return SHORT_NAME.test(value);
}

function fieldsFromPages(pages: unknown): FieldInfo[] {
	if (!Array.isArray(pages)) return [];
	const fields: FieldInfo[] = [];
	for (const page of pages) {
		const list = (page as { fields?: unknown }).fields;
		if (!Array.isArray(list)) continue;
		for (const field of list) {
			const f = field as { name?: unknown; label?: unknown; type?: unknown };
			if (typeof f.name !== "string" || typeof f.label !== "string") continue;
			if (f.type === "hidden" && !/^(utm_|page_url)/.test(f.name)) continue;
			fields.push({
				key: f.name,
				label: f.label,
				...(typeof f.type === "string" ? { type: f.type } : {}),
			});
		}
	}
	return fields;
}

/**
 * Look a form up through the forms plugin's public definition route. On a site that cannot
 * call its own address (or on localhost) the call fails, which is "unreachable", not "missing".
 */
export async function lookUpForm(ctx: PluginContext, origin: string, id: string): Promise<Lookup> {
	if (!ctx.http || !origin) return { kind: "unreachable" };
	try {
		const response = await ctx.http.fetch(`${origin}/_emdash/api/plugins/emdash-forms/definition`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		if (response.status === 404) return { kind: "missing" };
		if (!response.ok) return { kind: "unreachable" };
		const body = (await response.json()) as { data?: Record<string, unknown> };
		const data = body.data;
		if (!data || typeof data.name !== "string" || typeof data.slug !== "string") {
			return { kind: "unreachable" };
		}
		return { kind: "found", name: data.name, slug: data.slug, fields: fieldsFromPages(data.pages) };
	} catch {
		return { kind: "unreachable" };
	}
}

export type FoundForm =
	| { error: string }
	| { slug: string; name: string; fields: FieldInfo[]; checked: boolean };

/**
 * A form named by its short name in New delivery ("Another form"), or one already known.
 * A form the site cannot look up (it cannot call its own address) is accepted unchecked.
 */
export async function findForm(
	ctx: PluginContext,
	origin: string,
	input: string,
	known: Record<string, KnownForm>,
): Promise<FoundForm> {
	const slug = input.trim().toLowerCase();
	const have = known[slug] ?? known[input];
	if (have) return { slug: have.slug, name: have.name, fields: have.fields, checked: true };
	if (!isShortName(slug)) {
		return {
			error:
				"A short name has only small letters, numbers and dashes, like contact or wedding-cakes. Forms lists it under each form's name.",
		};
	}
	const found = await lookUpForm(ctx, origin, slug);
	if (found.kind === "missing") {
		return { error: `There is no form called "${slug}". Copy its short name from Forms.` };
	}
	if (found.kind === "found") {
		return { slug: found.slug, name: found.name, fields: found.fields, checked: true };
	}
	return { slug, name: slug, fields: [], checked: false };
}

/** Remember a form named in New delivery, so "Which form?" lists it from then on. */
export async function rememberForm(
	ctx: PluginContext,
	form: { slug: string; name: string; fields: FieldInfo[] },
) {
	const forms = await loadForms(ctx);
	if (forms[form.slug]) return;
	forms[form.slug] = {
		slug: form.slug,
		name: form.name,
		fields: form.fields,
		source: form.fields.length ? "definition" : "enquiry",
		addedAt: new Date().toISOString(),
		days: [],
	};
	await saveForms(ctx, forms);
}

/** Mark a form connected (by hand, from the Connect step). */
export async function markConnected(ctx: PluginContext, slug: string, keySetAt?: string) {
	const forms = await loadForms(ctx);
	const form = forms[slug];
	if (!form) return;
	const at = [form.connectedAt, form.lastAt]
		.filter((x): x is string => Boolean(x))
		.sort()
		.at(-1);
	if (at && (!keySetAt || at > keySetAt)) return;
	forms[slug] = { ...form, connectedAt: new Date().toISOString(), connectedWay: "by hand" };
	await saveForms(ctx, forms);
}

/** Refresh every form's fields from its definition, when the site can look them up. */
export async function refreshDefinitions(ctx: PluginContext, origin: string) {
	const forms = await loadForms(ctx);
	let changed = false;
	for (const form of Object.values(forms)) {
		if (form.slug.includes(" ")) continue;
		const found = await lookUpForm(ctx, origin, form.slug);
		if (found.kind !== "found") return;
		forms[form.slug] = { ...form, name: found.name, fields: found.fields, source: "definition" };
		changed = true;
	}
	if (changed) await saveForms(ctx, forms);
}

/** Can this site call its own address? Asks its own ping route for a one-time code. */
export async function checkReach(ctx: PluginContext, origin: string): Promise<ReachResult> {
	const code = randomString(24);
	await ctx.kv.set(PING_KEY, code);
	let self = false;
	if (ctx.http && origin) {
		try {
			const response = await ctx.http.fetch(`${routeUrl(origin, "ping")}?code=${code}`);
			self = response.ok && (await response.text()).trim() === `lead-delivery:${code}`;
		} catch {
			self = false;
		}
	}
	await ctx.kv.delete(PING_KEY);
	if (self) return "self";
	return ctx.email ? "email" : "none";
}
