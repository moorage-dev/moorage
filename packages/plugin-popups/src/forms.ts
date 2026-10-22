// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * The forms list for step 2, and the save-time check of a form's short name. A plugin route cannot read
 * another plugin's data, so the server asks the forms plugin's public
 * `definition` route on its own address, as any visitor's browser would.
 */

import { fetchOwnSite } from "./self-fetch.js";

export const FORMS_API = "/_emdash/api/plugins/emdash-forms/";

export type FormCheck =
	| { result: "ok"; name: string }
	| { result: "paused" }
	| { result: "missing" }
	| { result: "turnstile" }
	| { result: "files" }
	| { result: "unchecked" };

interface Definition {
	name?: unknown;
	pages?: Array<{ fields?: Array<{ type?: unknown }> }>;
	settings?: { spamProtection?: unknown };
}

/** What a definition means for a popup of this kind. Turnstile and files only work in a box in a page. */
export function judgeDefinition(definition: Definition, overlay: boolean): FormCheck {
	const pages = Array.isArray(definition.pages) ? definition.pages : [];
	if (overlay && definition.settings?.spamProtection === "turnstile")
		return { result: "turnstile" };
	if (overlay && pages.some((page) => (page.fields ?? []).some((field) => field.type === "file"))) {
		return { result: "files" };
	}
	return { result: "ok", name: typeof definition.name === "string" ? definition.name : "" };
}

export async function checkForm(
	origin: string | undefined,
	form: string,
	overlay: boolean,
	fetchImpl: typeof fetch = fetch,
): Promise<FormCheck> {
	if (!origin) return { result: "unchecked" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3000);
	try {
		const response = await fetchOwnSite(
			origin,
			`${FORMS_API}definition`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: form }),
				signal: controller.signal,
			},
			fetchImpl,
		);
		if (response.status === 404) {
			// A 404 without the plugin's error envelope means Forms is not installed at all.
			return { result: "missing" };
		}
		if (response.status === 410) return { result: "paused" };
		if (!response.ok) return { result: "unchecked" };
		const body = (await response.json()) as { data?: Definition };
		return body.data ? judgeDefinition(body.data, overlay) : { result: "unchecked" };
	} catch {
		return { result: "unchecked" };
	} finally {
		clearTimeout(timer);
	}
}

export interface FormOption {
	slug: string;
	name: string;
	paused: boolean;
}

/**
 * The site's forms, for step 2's dropdown. Block Kit plugin pages do not load
 * a select's options from a route (`optionsRoute` works only in block and field
 * widgets), and a plugin cannot read another plugin's storage, so the server
 * asks the forms plugin's own admin list as the signed-in person, exactly as
 * the Forms page does. Null when Forms is missing or does not answer in time:
 * the admin then shows a box to type the short name in.
 */
export async function listForms(
	origin: string | undefined,
	cookie: string,
	fetchImpl: typeof fetch = fetch,
): Promise<FormOption[] | null> {
	if (!origin) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2000);
	try {
		const response = await fetchOwnSite(
			origin,
			`${FORMS_API}forms/list`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
					cookie,
				},
				body: "{}",
				signal: controller.signal,
			},
			fetchImpl,
		);
		if (!response.ok) return null;
		const body = (await response.json()) as { data?: { items?: unknown } };
		const items = body.data?.items;
		if (!Array.isArray(items)) return null;
		const out: FormOption[] = [];
		for (const item of items as Array<Record<string, unknown>>) {
			if (typeof item?.slug !== "string" || !item.slug) continue;
			out.push({
				slug: item.slug,
				name: typeof item.name === "string" && item.name ? item.name : item.slug,
				paused: item.status === "paused",
			});
		}
		return out;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** The plain sentence the owner reads about a check, and whether the save is refused. */
export function describeCheck(
	check: FormCheck,
	form: string,
): { refuse: boolean; text: string } | null {
	switch (check.result) {
		case "ok":
			return null;
		case "missing":
			return {
				refuse: true,
				text: `There is no form called "${form}". Open Forms, copy the short name from the list, and paste it here.`,
			};
		case "turnstile":
			return {
				refuse: true,
				text: "This form uses Cloudflare Turnstile, which cannot show inside a popup yet. Put it in a box in a page instead, or choose a form without it.",
			};
		case "files":
			return {
				refuse: true,
				text: "This form asks for a file upload, which cannot work inside a popup yet. Put it in a box in a page instead, or choose a form without it.",
			};
		case "paused":
			return {
				refuse: false,
				text: "This form is paused under Forms, so the popup will not open until it is turned back on.",
			};
		case "unchecked":
			return {
				refuse: false,
				text: "The form could not be checked just now; it is checked again when a visitor's browser opens the popup.",
			};
	}
}
