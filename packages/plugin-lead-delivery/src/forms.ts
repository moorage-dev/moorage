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

/** Add a form by its short name. The message is what the owner sees. */
export async function addForm(
	ctx: PluginContext,
	origin: string,
	input: string,
): Promise<{ ok: boolean; message: string }> {
	const slug = input.trim().toLowerCase();
	if (!isShortName(slug)) {
		return {
			ok: false,
			message:
				"A short name has only small letters, numbers and dashes, like contact or wedding-cakes. Check the Slug column under Forms.",
		};
	}
	const forms = await loadForms(ctx);
	const found = await lookUpForm(ctx, origin, slug);
	if (found.kind === "missing") {
		return {
			ok: false,
			message: `There is no form with the short name "${slug}". Check the Slug column under Forms.`,
		};
	}
	const now = new Date().toISOString();
	const known = forms[slug];
	if (found.kind === "found") {
		forms[slug] = {
			...(known ?? { addedAt: now, days: [] }),
			slug: found.slug,
			name: found.name,
			fields: found.fields,
			source: "definition",
		} as KnownForm;
		await saveForms(ctx, forms);
		return {
			ok: true,
			message: `Added ${found.name}. Found ${found.fields.length === 1 ? "1 field" : `${found.fields.length} fields`}.`,
		};
	}
	forms[slug] = known ?? {
		slug,
		name: slug,
		fields: [],
		source: "enquiry",
		addedAt: now,
		days: [],
	};
	await saveForms(ctx, forms);
	return {
		ok: true,
		message:
			"Saved. This site could not look the form up, so its fields will be learned from its first enquiry.",
	};
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
