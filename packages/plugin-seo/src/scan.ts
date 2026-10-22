// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import type { SeoConfig } from "./config.js";
import {
	entryKey,
	entryStore,
	isDuplicate,
	isOlder,
	makeRecord,
	setDuplicate,
	type EntryRecord,
} from "./record.js";

/** KV keys for the site-wide check and its cached results. */
export const SCAN_KEY = "scan";
export const STATS_KEY = "stats";
/** Name of the background task that continues a site-wide check. */
export const SCAN_TASK = "seo-scan";

// Entries checked per request. The sandbox allows only a handful of
// operations and a few milliseconds of CPU per request, so a site is checked
// in small batches, continued by a background task.
const BATCH = 20;
const TITLE_PAGE = 100;
// Collections without published pages that one request may pass over.
const MAX_EMPTY_READS = 5;
/** Rows in the "To fix" table. */
export const FIX_ROWS = 10;

export interface ScanState {
	status: "running" | "done";
	/** Collections still to read; the first is in progress. */
	collections: string[];
	cursor?: string;
	/** After the entries, titles are compared across the whole site. */
	phase: "entries" | "titles";
	titleCursor?: string;
	/** Last title seen on the previous page of the title pass. */
	lastTitle?: { key: string; id: string; flagged: boolean };
	checked: number;
	/** Running totals, so a check never has to recount what it just wrote. */
	tally: Stats;
	startedAt: string;
	finishedAt?: string;
}

export interface Stats {
	checked: number;
	fix: number;
	hidden: number;
	/** First rows of the "To fix" table. */
	rows: Array<{ collection: string; id: string; title: string; issues: string[] }>;
	more: boolean;
	/** First pages with advice only ("Worth a look"). */
	look?: Array<{ collection: string; id: string; title: string; issues: string[] }>;
	/** Titles of the first pages hidden from search. */
	hiddenTitles?: string[];
}

export async function loadScan(ctx: PluginContext): Promise<ScanState | null> {
	return ctx.kv.get<ScanState>(SCAN_KEY);
}

/** Start checking every published page of the given collections. */
export async function startScan(
	ctx: PluginContext,
	collections: string[],
	config: SeoConfig,
): Promise<ScanState> {
	const state: ScanState = {
		status: "running",
		collections,
		phase: "entries",
		checked: 0,
		tally: { checked: 0, fix: 0, hidden: 0, rows: [], more: false },
		startedAt: new Date().toISOString(),
	};
	try {
		await ctx.cron?.schedule(SCAN_TASK, { schedule: "* * * * *" });
	} catch (error) {
		ctx.log.warn("could not schedule background check", { error: String(error) });
	}
	return scanStep(ctx, state, config);
}

async function entriesStep(ctx: PluginContext, state: ScanState, config: SeoConfig) {
	const collection = state.collections[0];
	if (collection === undefined) {
		state.phase = "titles";
		return;
	}
	const page = await ctx.content?.list(collection, {
		limit: BATCH,
		cursor: state.cursor,
		where: { status: "published" },
	});
	const entries = page?.items ?? [];
	if (entries.length > 0) {
		const store = entryStore(ctx);
		const ids = entries.map((entry) => entry.id);
		const [credits, previous] = await Promise.all([
			ctx.bylines?.getEntriesBylines(collection, ids) ?? [],
			store.getMany(ids.map((id) => entryKey(collection, id))),
		]);
		const authors = new Map(credits.map((credit) => [credit.entryId, credit.bylines]));
		// Records a save wrote after this check read its entries stay as they are: the save read
		// a newer version of the entry. Only the flag may still change on them, below.
		const kept = new Set<string>();
		const records = entries.map((entry) => {
			const id = entryKey(collection, entry.id);
			const before = previous.get(id) ?? null;
			if (before && isOlder(entry.updatedAt, before.updatedAt)) {
				kept.add(id);
				return { id, data: before };
			}
			return {
				id,
				data: makeRecord({
					hasPages: true,
					collection,
					entry,
					authors: (authors.get(entry.id) ?? []).map(({ byline }) => ({
						name: byline.displayName,
						...(byline.websiteUrl ? { url: byline.websiteUrl } : {}),
					})),
					previous: before,
					config,
					siteUrl: ctx.site.url,
					// Kept as it was; the title pass below settles it for the whole site.
					duplicateTitle: before ? isDuplicate(before) : false,
				}),
			};
		});
		// A small site read in one go needs no second pass: shared titles are
		// visible right here, so the check can finish in this request.
		const whole = state.cursor === undefined && state.checked === 0 && !page?.hasMore;
		if (whole && state.collections.length === 1) {
			const seen = new Map<string, number>();
			for (const { data } of records) {
				if (data.titleKey) seen.set(data.titleKey, (seen.get(data.titleKey) ?? 0) + 1);
			}
			for (const item of records) {
				const duplicate = (seen.get(item.data.titleKey ?? "") ?? 0) > 1;
				if (kept.has(item.id) && isDuplicate(item.data) !== duplicate) kept.delete(item.id);
				item.data = setDuplicate(item.data, duplicate);
			}
			state.status = "done";
			state.finishedAt = new Date().toISOString();
		}
		const writes = records.filter((item) => !kept.has(item.id));
		if (writes.length > 0) await store.putMany(writes);
		for (const { data } of records) count(state.tally, data, 1);
		state.checked += entries.length;
	}
	if (page?.hasMore && page.cursor) state.cursor = page.cursor;
	else {
		state.cursor = undefined;
		state.collections = state.collections.slice(1);
		if (state.collections.length === 0 && (state as ScanState).status !== "done") {
			state.phase = "titles";
		}
	}
}

/** Walk records in title order; neighbours with the same title are duplicates. */
async function titlesStep(ctx: PluginContext, state: ScanState) {
	const store = entryStore(ctx);
	const page = await store.query({
		orderBy: { titleKey: "asc" },
		limit: TITLE_PAGE,
		cursor: state.titleCursor,
	});
	const items = page.items.filter((item) => (item.data.titleKey ?? "") !== "");
	// What this pass read, by id, and the flags it would change.
	const read = new Map(items.map((item) => [item.id, item.data]));
	const flips = new Map<string, boolean>();
	const flag = (id: string, data: EntryRecord, duplicate: boolean) => {
		if (isDuplicate(data) !== duplicate) flips.set(id, duplicate);
	};

	let last = state.lastTitle;
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item) continue;
		const key = item.data.titleKey ?? "";
		const next = items[index + 1];
		const sameAsLast = last?.key === key;
		const sameAsNext = next?.data.titleKey === key;
		// The last record of the previous page turns out to share this title.
		if (sameAsLast && last && !last.flagged && index === 0) {
			const earlier = await store.get(last.id);
			if (earlier) {
				read.set(last.id, earlier);
				flag(last.id, earlier, true);
			}
		}
		const duplicate = sameAsLast || sameAsNext;
		flag(item.id, item.data, duplicate);
		last = { key, id: item.id, flagged: duplicate };
	}

	if (flips.size > 0) {
		// A save may have changed one of these pages since they were read: renamed it, or
		// flagged it itself. Read the titles with a change again just before writing, and
		// leave any title with a page that changed to that save, which reads the pages with
		// its old and new title after writing and settles both.
		const titles = new Set([...flips.keys()].map((id) => read.get(id)?.titleKey ?? ""));
		const ids = [...read].filter(([, data]) => titles.has(data.titleKey ?? "")).map(([id]) => id);
		const current = await store.getMany(ids);
		for (const id of ids) {
			const was = read.get(id);
			const now = current.get(id);
			if (!was || now?.checkedAt !== was.checkedAt || now?.titleKey !== was.titleKey) {
				titles.delete(was?.titleKey ?? "");
			}
		}
		const writes: Array<{ id: string; data: EntryRecord }> = [];
		for (const [id, duplicate] of flips) {
			const data = read.get(id);
			if (!data || !titles.has(data.titleKey ?? "")) continue;
			const changed = setDuplicate(data, duplicate);
			writes.push({ id, data: changed });
			count(state.tally, data, -1);
			count(state.tally, changed, 1);
		}
		if (writes.length > 0) await store.putMany(writes);
	}

	state.lastTitle = last;
	if (page.hasMore && page.cursor) state.titleCursor = page.cursor;
	else {
		state.status = "done";
		state.finishedAt = new Date().toISOString();
		state.titleCursor = undefined;
		state.lastTitle = undefined;
	}
}

function row(data: EntryRecord, level: "fix" | "look" = "fix"): Stats["rows"][number] {
	return {
		collection: data.collection ?? "",
		id: data.entryId ?? "",
		title: data.title || "(no title)",
		issues: (data.issues ?? [])
			.filter((issue) => issue.level === level)
			.map((issue) => issue.message),
	};
}

/** Add (+1) or take away (-1) one record from the running totals. */
function count(tally: Stats, data: EntryRecord, sign: 1 | -1): void {
	if (!data.status || data.status === "draft" || data.status === "skip") return;
	tally.checked += sign;
	if (data.status === "hidden") {
		tally.hidden += sign;
		const titles = tally.hiddenTitles ?? [];
		const title = data.title || "(no title)";
		tally.hiddenTitles =
			sign === 1 ? [...titles, title].slice(0, FIX_ROWS) : titles.filter((t) => t !== title);
	}
	if (data.status === "look") {
		const look = tally.look ?? [];
		tally.look =
			sign === 1
				? [...look, row(data, "look")].slice(0, FIX_ROWS)
				: look.filter((entry) => entry.id !== data.entryId);
	}
	if (data.status !== "fix") return;
	tally.fix += sign;
	if (sign === 1) {
		if (tally.rows.length < FIX_ROWS) tally.rows.push(row(data));
		else tally.more = true;
	} else {
		tally.rows = tally.rows.filter((entry) => entry.id !== data.entryId);
	}
}

/** Do one batch of a running check and save where it got to. */
export async function scanStep(
	ctx: PluginContext,
	current: ScanState,
	config: SeoConfig,
): Promise<ScanState> {
	const state: ScanState = {
		...current,
		collections: [...current.collections],
		tally: { ...current.tally, rows: [...current.tally.rows] },
	};
	if (state.status === "done") return state;

	if (state.phase === "entries") {
		// An empty collection costs one read, so several can be passed in one
		// request; the first one with pages uses up the rest of the budget.
		for (let reads = 0; reads < MAX_EMPTY_READS && state.phase === "entries"; reads += 1) {
			const before = state.checked;
			await entriesStep(ctx, state, config);
			if (state.checked !== before || (state as ScanState).status === "done") break;
		}
		// Nothing published anywhere: there is nothing to compare, so the check is complete.
		if ((state as ScanState).phase === "titles" && state.checked === 0) {
			state.status = "done";
			state.finishedAt = new Date().toISOString();
		}
	} else await titlesStep(ctx, state);

	// The step above may have finished the check; TypeScript cannot see that.
	if ((state as ScanState).status === "done") {
		try {
			await ctx.cron?.cancel(SCAN_TASK);
		} catch {
			// The task also stops itself the next time it runs.
		}
	}
	await ctx.kv.set(SCAN_KEY, state);
	return state;
}

/** Count pages by status and read the first pages to fix. */
export async function readStats(ctx: PluginContext): Promise<Stats> {
	const store = entryStore(ctx);
	const [checked, fix, list, look, hidden] = await Promise.all([
		store.count({ status: { in: ["ready", "look", "fix", "hidden"] } }),
		store.count({ status: "fix" }),
		store.query({ where: { status: "fix" }, limit: FIX_ROWS }),
		store.query({ where: { status: "look" }, limit: FIX_ROWS }),
		store.query({ where: { status: "hidden" }, limit: FIX_ROWS }),
	]);
	return {
		checked,
		fix,
		// Hidden pages are few; the first page of them is the count unless there are more.
		hidden: hidden.hasMore ? FIX_ROWS + 1 : hidden.items.length,
		rows: list.items.map(({ data }) => row(data)),
		more: list.hasMore,
		look: look.items.map(({ data }) => row(data, "look")),
		hiddenTitles: hidden.items.map(({ data }) => data.title || "(no title)"),
	};
}
