// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Yoast and Rank Math values brought over by EmDash's WordPress Exporter import.
 *
 * The import (EmDash 1.4.0, `api/import/wordpress-plugin/execute.ts`) writes each post's SEO
 * title and description into two content fields, `seo_title` and `seo_description`, not into
 * the entry's SEO panel. Nothing reads those fields: the page's title tag and meta description
 * come from the SEO panel (or the theme), so the values are lost until someone copies them.
 * This file reads them for the checks, which tell the owner what still has to be copied into the
 * SEO panel by hand.
 */

/** The content fields the WordPress import writes. */
export const IMPORTED_TITLE_FIELD = "seo_title";
export const IMPORTED_DESCRIPTION_FIELD = "seo_description";

// A value whose Yoast (%%title%%) or Rank Math (%title%) variables were never filled in.
const VARIABLE = /%%[a-z0-9_]+%%|%[a-z][a-z0-9_]*%/i;
// The separators Yoast and Rank Math offer between a page's title and the site's name.
const SEPARATORS = "-–—:·•*⋆|~«»<>/";

/** A usable imported value: trimmed text with no unfilled variables, else "". */
export function importedValue(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return VARIABLE.test(text) ? "" : text;
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A WordPress title without the site's name at its end ("Our story | Harbour Bakery" becomes
 * "Our story"). The site adds its own name after the SEO title, so keeping it would show the
 * name twice ("Our story | Harbour Bakery | Harbour Bakery").
 */
export function stripSiteName(title: string, siteNames: string | string[] | undefined): string {
	const names = (Array.isArray(siteNames) ? siteNames : [siteNames ?? ""])
		.map((name) => name.trim())
		.filter((name) => name !== "");
	const separators = SEPARATORS.split("").map(escape).join("");
	for (const name of names) {
		const ending = new RegExp(`\\s*[${separators}]\\s*${escape(name)}\\s*$`, "i");
		const stripped = title.replace(ending, "").trim();
		if (stripped !== "" && stripped !== title.trim()) return stripped;
	}
	return title.trim();
}

const same = (a: string, b: string) =>
	a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** What copying one entry's imported values into its SEO panel would do. */
export interface CopyPlan {
	/** The title to write into the panel's SEO Title, when the panel has none. */
	title?: string;
	/** The description to write into the panel's Meta Description, when the panel has none. */
	description?: string;
	/** The panel already has its own, different value for something imported: it is kept. */
	own: boolean;
}

export interface PlanInput {
	data: Record<string, unknown>;
	/** Absent when the collection has no SEO panel: there is nowhere to copy to. */
	seo?: { title: string | null; description: string | null } | null;
	/** The entry's own title. */
	title: string;
	/** Names the site goes by (the SEO settings' and EmDash's), any of which may end a title. */
	siteName?: string | string[];
}

/**
 * What copying would write for one entry, never over a value already in the SEO panel. A title
 * that is only the page's own title (with the site's name) adds nothing and is left out. Null
 * when there is nothing imported, or no SEO panel to copy into.
 */
export function planCopy(input: PlanInput): CopyPlan | null {
	if (!input.seo) return null;
	const description = importedValue(input.data[IMPORTED_DESCRIPTION_FIELD]);
	const rawTitle = importedValue(input.data[IMPORTED_TITLE_FIELD]);
	const title = rawTitle === "" ? "" : stripSiteName(rawTitle, input.siteName);
	const useful = title !== "" && !same(title, input.title);
	if (description === "" && !useful) return null;

	const panelTitle = input.seo.title?.trim() ?? "";
	const panelDescription = input.seo.description?.trim() ?? "";
	const plan: CopyPlan = { own: false };
	if (useful) {
		if (panelTitle === "") plan.title = title;
		else if (!same(panelTitle, title)) plan.own = true;
	}
	if (description !== "") {
		if (panelDescription === "") plan.description = description;
		else if (!same(panelDescription, description)) plan.own = true;
	}
	return plan;
}
