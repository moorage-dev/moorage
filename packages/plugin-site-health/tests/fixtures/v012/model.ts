// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Vendored unchanged except this line: the type was imported from ./extract.js.
type Use = "link" | "embed" | "image";

/** What a row stands for: a link on this site or another, an insecure item, or a page of this site. */
export type Kind = "internal" | "external" | "insecure" | "page";

/**
 * Where a row stands. Only `broken` is counted. `pending` is not checked yet,
 * `look` works but takes a detour, `unknown` could not be checked, `fine`
 * was marked as fine by someone.
 */
export type State = "pending" | "ok" | "look" | "broken" | "unknown" | "fine";

export type Reason =
	// broken
	| "missing"
	| "draft"
	| "gone"
	| "no-site"
	| "page-error"
	| "insecure-active"
	| "server"
	// worth a look
	| "redirect"
	| "moved"
	| "insecure-image"
	// could not check
	| "refuses"
	| "slow"
	| "timeout"
	| "trouble"
	| "error"
	| "no-live";

/** How bad a broken row is: on every page, on one page, or one link. */
export type Group = "site" | "page" | "link";

/** Where an address was found. `p` is the page's address on the site. */
export interface Source {
	/** Collection and entry id, when found in an entry's content. */
	c?: string;
	id?: string;
	/** Title shown to the owner. */
	t: string;
	p: string;
	/** Found in the site menu or footer (every page). */
	menu?: boolean;
}

export interface LinkRow {
	kind: Kind;
	/** `/path` on this site, or a full address on another. */
	url: string;
	host: string;
	use?: Use;
	/** First places it was found (at most MAX_SOURCES). */
	sources: Source[];
	/** How many places it was found. */
	count: number;
	/** Found in the site menu or footer. */
	menu: boolean;
	/** Found in an entry's content, so an Editor can fix it. */
	content: boolean;
	/** Editors see this row (links, and insecure items inside content). */
	editor: boolean;
	/** The full check that last found it. */
	pass: number;
	state: State;
	reason?: Reason;
	/** Where it now goes, for detours. */
	detail?: string;
	group?: Group;
	/** When it became broken. */
	since?: string;
	fails?: number;
	firstFailAt?: string;
	checkedAt?: string;
	/** When it is next checked from outside ("9999" = only with the next full check). */
	due: string;
	fine?: { by: string; at: string };
	/** The site refuses HEAD requests; ask it with GET. */
	get?: boolean;
}

export interface PageRow {
	/** "redirect" rows are redirect sources, not entries. */
	status: string;
	path: string;
	title: string;
	collection?: string;
	id?: string;
	/** Where a redirect goes. */
	dest?: string;
	pass: number;
	/** Rows found in this entry's content. */
	links?: string[];
}

export const MAX_SOURCES = 10;
export const NEVER = "9999";

export function groupOf(row: Pick<LinkRow, "kind" | "menu" | "url">): Group {
	if (row.menu) return "site";
	if (row.kind === "page") return row.url === "/" ? "site" : "page";
	if (row.kind === "insecure") return "page";
	return "link";
}

/** The words for one row, as the owner reads them. */
export function describe(
	row: Pick<LinkRow, "kind" | "reason" | "detail" | "url">,
	short: string,
): string {
	switch (row.reason) {
		case "missing":
			return `${short} goes to a page that does not exist.`;
		case "draft":
			return `${short} goes to a page that is not published yet.`;
		case "gone":
			return `${short}: that other website has removed this page.`;
		case "no-site":
			return `${short}: that website no longer exists.`;
		case "server":
			return `${short}: that website has shown an error for a week.`;
		case "page-error":
			return `${short}: this page is broken; visitors see an error.`;
		case "insecure-active":
			return `${short} is loaded over an insecure connection. Browsers block it, so visitors see an empty box.`;
		case "redirect":
		case "moved":
			return `${short} now goes on to ${row.detail ?? "another address"}.${row.kind === "internal" && row.detail ? ` Linking to ${row.detail} directly saves a step.` : ""}`;
		case "insecure-image":
			return `${short} is a picture shown over an insecure connection. Browsers fix this themselves for now.`;
		case "refuses":
			return `${short}: that website turns away automatic checkers.`;
		case "slow":
			return `${short}: that website asked us to slow down. Trying again tomorrow.`;
		case "timeout":
			return `${short} did not answer within 8 seconds.`;
		case "trouble":
			return `${short}: that website had a problem when we checked. Trying again.`;
		case "no-live":
			return `${short}: we could not open your site to check this address.`;
		default:
			return `${short}: we could not open it.`;
	}
}

/** "Found on: Site menu (every page), Home, Wholesale and 3 more." */
export function foundOn(row: Pick<LinkRow, "sources" | "count" | "menu" | "kind">): string {
	if (row.kind === "page") return "";
	const names: string[] = [];
	if (row.menu) names.push("Site menu (every page)");
	for (const source of row.sources) {
		if (source.menu) continue;
		if (names.length >= 4) break;
		names.push(source.t);
	}
	const shown = names.length - (row.menu ? 1 : 0);
	const rest = row.count - (row.menu ? row.sources.filter((s) => s.menu).length : 0) - shown;
	if (names.length === 0) return "";
	return ` Found on: ${names.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`;
}
