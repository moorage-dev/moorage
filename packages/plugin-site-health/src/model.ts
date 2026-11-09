// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Use } from "./extract.js";
import { shorten } from "./url.js";

/**
 * What a row stands for: a link on this site or another, an insecure item, a page of
 * this site, or something a move from WordPress left in the content.
 */
export type Kind = "internal" | "external" | "insecure" | "page" | "leftover";

/**
 * Where a row stands. Only `broken` is counted. `pending` is not checked yet,
 * `look` works but takes a detour, `unknown` could not be checked, `fine`
 * was marked as fine by someone, `left` is left over from WordPress.
 */
export type State = "pending" | "ok" | "look" | "broken" | "unknown" | "fine" | "left";

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
	| "no-live"
	// an address on this site that matches no page, on a site that is not public yet
	| "not-public"
	// left over from WordPress
	| "shortcode"
	| "empty-html"
	| "old-link"
	| "encoded-slug"
	| "no-alt";

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
	/** The HTTP status of the last request for it; none when it got no answer or was not asked. */
	code?: number;
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
	/**
	 * When the entry was last read. After a slug change the row at the old
	 * address stays until the next sweep; the newest row is the entry's.
	 */
	at?: string;
}

export const MAX_SOURCES = 10;
export const NEVER = "9999";

export function groupOf(row: Pick<LinkRow, "kind" | "menu" | "url">): Group {
	if (row.menu) return "site";
	if (row.kind === "page") return row.url === "/" ? "site" : "page";
	if (row.kind === "insecure") return "page";
	return "link";
}

/** A shortcode's name, and the block that does its job in EmDash. */
function blockFor(shortcode: string): string {
	const name = /^\[([a-z][a-z0-9_-]*)/.exec(shortcode)?.[1] ?? "";
	if (/form|wpforms|gravity|ninja|formidable|mc4wp|mailchimp/.test(name)) return "a form block";
	if (name === "gallery") return "a gallery block";
	if (name === "caption") return "a picture with a caption";
	if (/^(embed|video|audio|playlist|youtube|vimeo)$/.test(name)) return "an embed block";
	return "a block that does the same job";
}

const FIX_LINK = "Open the page and link those words to the page's address here.";

/**
 * How a row's address is shown: at most 30 characters with no unbroken word longer,
 * so a phone table keeps its Fix menu on screen. A shortcode keeps its spaces.
 */
export function shortFor(row: Pick<LinkRow, "kind" | "reason" | "url">): string {
	if (row.kind !== "leftover" || row.reason === "old-link") return shorten(row.url);
	const text = row.url.length > 60 ? `${row.url.slice(0, 59)}…` : row.url;
	return text
		.split(" ")
		.map((word) => (word.length > 30 ? `${word.slice(0, 29)}…` : word))
		.join(" ");
}

/**
 * Why an address on this site could not be checked, as things stand now: the site is
 * not public yet, or it could not open its own pages. A reason saved earlier (before
 * the check knew the site was private, or by 0.2.0) follows the current answer; any
 * other reason stays.
 */
export function openReason(reason: Reason | undefined, live: string | undefined): Reason {
	if (reason !== undefined && reason !== "no-live" && reason !== "not-public") return reason;
	return live === "not-public" ? "not-public" : "no-live";
}

/** The words for one row, as the owner reads them. */
export function describe(
	row: Pick<LinkRow, "kind" | "reason" | "detail" | "url"> & { menu?: boolean },
	short: string,
): string {
	const fixLink = row.menu
		? "Open Menus in the sidebar, under Manage, and point that item at the page's address here."
		: FIX_LINK;
	switch (row.reason) {
		case "not-public":
			return `${short} matches no page we know of. Your site is not public yet, so we cannot open the address to be sure; it is checked once the site has a public address.`;
		case "shortcode":
			return `${short} is a WordPress shortcode: visitors see it as plain text. Open the page and put ${blockFor(row.url)} in its place, or delete it.`;
		case "empty-html":
			return `An empty HTML block${row.detail ? `, left from WordPress's ${row.detail} block,` : ""} shows nothing. Open the page and delete the block.`;
		case "old-link":
			return row.url.startsWith("/") || row.url.startsWith("?")
				? `${short} is a WordPress address this site does not use, so it opens the wrong page or none. ${fixLink}`
				: `${short} looks like an address on your old WordPress site. If it is, ${fixLink[0]!.toLowerCase()}${fixLink.slice(1, -1)}: once that site is switched off, this link stops working.`;
		case "encoded-slug":
			return `This page's address ${short} is in WordPress's coded form of its letters, so it opens "Page not found". Open the page and type a new slug in plain letters, such as its title in Latin letters, then publish.`;
		case "no-alt":
			return `${row.detail === "featured" ? "The featured image" : "The picture"} ${short} has no alt text, which screen readers and search engines read. Open the page, select the picture and fill in its alt text.`;
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
