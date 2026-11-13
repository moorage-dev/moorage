// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { CollectionSchemaInfo, PluginContext, SiteInfo } from "emdash";

import { entryStore, type EntryRecord } from "./record.js";
import { SCAN_KEY, SCAN_REV, type ScanState } from "./scan.js";

/**
 * The `to_fix` MCP tool: the Overview's pages to fix, for the site owner's own AI assistant.
 * Read only: it never starts or continues the site-wide check and writes nothing.
 */
export const TO_FIX_ROUTE = "mcp/to-fix";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
// Records per storage read (EmDash's maximum), and reads of pages to fix per call: 1,000 pages
// to fix are put in order; past that, the order covers the first 1,000.
const PAGE_SIZE = 100;
const MAX_READS = 10;
/**
 * Calls to the host one call of the tool may make. EmDash 1.5.0 allows 30 per sandboxed
 * invocation (emdash-cms/emdash#4712); the tool keeps a few for a log line on an error.
 */
export const TO_FIX_CALLS = 25;
// EmDash role levels: the SEO page is for Editors (40) and Admins (50).
const EDITOR_ROLE = 40;

/** The tool's input, as plain JSON Schema (the build turns it into the manifest entry). */
export const TO_FIX_INPUT = {
	type: "object",
	properties: {
		limit: {
			type: "integer",
			minimum: 1,
			maximum: MAX_LIMIT,
			default: DEFAULT_LIMIT,
			description: "How many pages to return, 1 to 100. Default 25.",
		},
		collection: {
			type: "string",
			minLength: 1,
			description: 'Only pages of this content type, by its slug, for example "posts".',
		},
	},
	additionalProperties: false,
} as const;

export const TO_FIX_TOOL = {
	description:
		"List the pages of this site that have search problems to fix, as the SEO page's Overview shows them. " +
		"For each page: its content type, id, title, web address, and each problem as a code and a plain sentence. " +
		"Pages with the most problems come first. Pages hidden from search engines are left out. " +
		"Also returns the Overview's counts: pages checked, pages with nothing to fix, pages to fix, pages hidden from search. " +
		"Reads only; changes nothing.",
	route: TO_FIX_ROUTE,
	input: TO_FIX_INPUT,
	destructive: false,
};

interface Issue {
	code: string;
	message: string;
}

interface PageToFix {
	collection: string;
	id: string;
	title: string;
	/** The page's public address; null when it cannot be worked out. */
	address: string | null;
	issues: Issue[];
}

export type ToFixResult =
	| { error: string }
	| {
			state: "checking";
			counts: null;
			pages: [];
			more: false;
			checkedSoFar: number;
			message: string;
	  }
	| {
			state: "ready";
			counts: {
				pagesChecked: number;
				nothingToFix: number;
				toFix: number;
				hiddenFromSearch: number;
			};
			pages: PageToFix[];
			/** More pages to fix than returned. */
			more: boolean;
			lastFullCheck?: string;
	  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Check the input as the JSON Schema above does: the route can also be called directly. */
export function readToFixInput(
	input: unknown,
): { limit: number; collection?: string } | { error: string } {
	if (input === undefined || input === null) return { limit: DEFAULT_LIMIT };
	if (!isRecord(input)) return { error: "The input must be an object with limit and collection." };
	const extra = Object.keys(input).filter((key) => key !== "limit" && key !== "collection");
	if (extra.length > 0) {
		return { error: `Unknown input: ${extra.join(", ")}. Use limit and collection.` };
	}
	const { limit = DEFAULT_LIMIT, collection } = input;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		return { error: "limit must be a whole number from 1 to 100." };
	}
	if (collection === undefined) return { limit };
	if (typeof collection !== "string" || collection.trim() === "") {
		return { error: "collection must be the slug of a content type, for example posts." };
	}
	return { limit, collection: collection.trim() };
}

const pad = (value: number) => String(value).padStart(2, "0");

const DATE_TOKEN = /\{(year|month|day|hour|minute|second)\}/g;

/**
 * A page's path from its content type's URL pattern, as EmDash builds it (`interpolateUrlPattern`
 * and `resolveContentRoutePath` in emdash/src/i18n/resolve.ts): `{slug}`, `{id}` and the date
 * tokens, `/{collection}/{slug}` without a pattern, and the site's trailing slash rule. Without a
 * language prefix: pages in another language than the site's are looked up from EmDash instead.
 */
export function pagePath(
	pattern: string | null,
	collection: string,
	slug: string,
	id: string,
	publishedAt: string | null,
	trailingSlash: SiteInfo["trailingSlash"],
): string {
	let path = (pattern ?? `/${encodeURIComponent(collection)}/{slug}`)
		.replaceAll("{slug}", encodeURIComponent(slug))
		.replaceAll("{id}", encodeURIComponent(id));
	const date = publishedAt ? new Date(publishedAt) : null;
	if (date && !Number.isNaN(date.getTime())) {
		const parts: Record<string, string> = {
			year: String(date.getUTCFullYear()),
			month: pad(date.getUTCMonth() + 1),
			day: pad(date.getUTCDate()),
			hour: pad(date.getUTCHours()),
			minute: pad(date.getUTCMinutes()),
			second: pad(date.getUTCSeconds()),
		};
		path = path.replace(DATE_TOKEN, (match, key: string) => parts[key] ?? match);
	}
	path = path.replace(/\/{2,}/g, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	if (trailingSlash === "always" && path !== "/") path = `${path}/`;
	return path;
}

const fixIssues = (record: EntryRecord): Issue[] =>
	(record.issues ?? [])
		.filter((issue) => issue.level === "fix")
		.map((issue) => ({ code: issue.id, message: issue.message }));

/** Most things to fix first, then by title, then by id, so the order never changes by itself. */
function worstFirst(a: PageToFix, b: PageToFix): number {
	return (
		b.issues.length - a.issues.length ||
		a.title.localeCompare(b.title) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

/** Handle one call of the `to_fix` tool. `role` is the caller's EmDash role level. */
export async function handleToFix(
	input: unknown,
	role: number | undefined,
	ctx: PluginContext,
): Promise<ToFixResult> {
	const read = readToFixInput(input);
	if ("error" in read) return read;
	if ((role ?? 0) < EDITOR_ROLE) {
		return { error: "The pages to fix are for Editors and Admins, as the SEO page is." };
	}

	const store = entryStore(ctx);
	// Everything the answer needs in one round: 6 calls.
	const [scan, collections, checked, toFix, hidden, first] = await Promise.all([
		ctx.kv.get<ScanState>(SCAN_KEY),
		ctx.schema?.listCollections() ?? Promise.resolve([] as CollectionSchemaInfo[]),
		store.count({ status: { in: ["ready", "look", "fix"] } }),
		store.count({ status: "fix" }),
		store.count({ status: "hidden" }),
		store.query({ where: { status: "fix" }, limit: PAGE_SIZE }),
	]);
	let calls = 6;

	const routable = collections.filter((c) => c.routable && !c.hidden);
	if (read.collection !== undefined && !routable.some((c) => c.slug === read.collection)) {
		const known = routable.map((c) => c.slug).join(", ");
		return {
			error: `This site has no content type "${read.collection}" with pages of its own. Content types: ${known || "none"}.`,
		};
	}

	// As on the Overview: no numbers until every page has been checked once by this release.
	if (!scan || scan.status !== "done" || (scan.rev ?? 1) < SCAN_REV) {
		return {
			state: "checking",
			counts: null,
			pages: [],
			more: false,
			checkedSoFar: scan && scan.status === "running" ? scan.checked : 0,
			message:
				"The pages are being checked. This happens in the background and takes about a minute; opening the SEO page in the admin starts it if it has not started. Ask again shortly.",
		};
	}

	const records = [...first.items];
	let cursor = first.hasMore ? first.cursor : undefined;
	for (let reads = 1; cursor && reads < MAX_READS; reads += 1) {
		const next = await store.query({ where: { status: "fix" }, limit: PAGE_SIZE, cursor });
		calls += 1;
		records.push(...next.items);
		cursor = next.hasMore ? next.cursor : undefined;
	}

	const byslug = new Map(routable.map((c) => [c.slug, c]));
	const rows = records
		.map(({ data }) => data)
		.filter((data) => read.collection === undefined || data.collection === read.collection)
		.map((data) => ({
			data,
			page: {
				collection: data.collection ?? "",
				id: data.entryId ?? "",
				title: data.title || "(no title)",
				address: null as string | null,
				issues: fixIssues(data),
			},
		}))
		// A new array from map(); toSorted is not in this package's TypeScript lib.
		// oxlint-disable-next-line unicorn/no-array-sort
		.sort((a, b) => worstFirst(a.page, b.page));
	const shown = rows.slice(0, read.limit);

	const site = ctx.site.url.replace(/\/+$/, "");
	const lookups: Array<(typeof shown)[number]> = [];
	for (const row of shown) {
		const { data, page } = row;
		const collection = byslug.get(page.collection);
		const ownLanguage = !data.locale || data.locale === ctx.site.locale;
		if (collection && data.slug && ownLanguage) {
			page.address = `${site}${pagePath(collection.urlPattern, page.collection, data.slug, page.id, data.publishedAt, ctx.site.trailingSlash)}`;
		} else if (collection) lookups.push(row);
	}
	// Pages checked before this release kept no slug, and pages in another language need EmDash's
	// own prefix: EmDash gives their address, one call each, as many as the budget allows.
	const room = Math.max(0, TO_FIX_CALLS - calls - 1);
	const getUrl = ctx.content?.getPublicUrl?.bind(ctx.content);
	if (getUrl) {
		await Promise.all(
			lookups.slice(0, room).map(async ({ page }) => {
				try {
					page.address = await getUrl(page.collection, page.id);
				} catch {
					// Left without an address; the rest of the answer stands.
				}
			}),
		);
	}

	return {
		state: "ready",
		counts: {
			pagesChecked: checked,
			nothingToFix: checked - toFix,
			toFix,
			hiddenFromSearch: hidden,
		},
		pages: shown.map(({ page }) => page),
		more: rows.length > shown.length || cursor !== undefined,
		...(scan.finishedAt ? { lastFullCheck: scan.finishedAt } : {}),
	};
}
