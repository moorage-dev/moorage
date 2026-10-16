// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * The save-time check of a form's short name. A plugin route cannot read
 * another plugin's data, so the server asks the forms plugin's public
 * `definition` route on its own address, as any visitor's browser would.
 */

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
		const response = await fetchImpl(`${origin}${FORMS_API}definition`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: form }),
			signal: controller.signal,
		});
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
