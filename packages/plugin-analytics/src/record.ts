// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, PluginStorageConfig, StorageCollection } from "emdash";

/**
 * The consent record: one row per answer a visitor gave to the banner.
 *
 * It exists so a site owner can show that consent was asked for and given. It
 * holds no IP address, no browser details and nothing that identifies a
 * person: a random reference the browser made up, the time, the answer, which
 * tool list it was for, and the country.
 *
 * The route that writes it is open to the public, so everything about it is
 * bounded: a fixed shape, short enumerated values, a limit on rows per day, and
 * a daily job that deletes rows older than a year.
 */

export const CONSENTS = "consents";

/** Storage declaration for the plugin itself. The composite index serves the 30-day counts. */
export const STORAGE = {
	[CONSENTS]: { indexes: ["at", "choice", ["choice", "at"]] },
} satisfies PluginStorageConfig;

/** The same for the descriptor in `astro.config.mjs`, which takes single-field indexes only. */
export const DESCRIPTOR_STORAGE = { [CONSENTS]: { indexes: ["at", "choice"] } };

/**
 * Refuse new rows beyond this many in one day (UTC). A daily limit rather than
 * a total: the check only reads today's rows, and a flood of made-up answers
 * can fill one day at most, not lock the record until rows expire a year later.
 */
export const MAX_ROWS_PER_DAY = 2000;
/** Rows are kept for this many days. */
export const KEEP_DAYS = 365;
export const PRUNE_TASK = "prune-consents";
const PRUNE_BATCH = 100;
const PRUNE_MAX_BATCHES = 50;
const DAY_MS = 86_400_000;

export type ChoiceKind = "all" | "none" | "some";

export interface ConsentRow {
	/** When the answer arrived, ISO 8601. */
	at: string;
	choice: ChoiceKind;
	analytics: boolean;
	marketing: boolean;
	/** Banner version: which list of tools the answer was for. */
	version: string;
	/** Two-letter country, or null when unknown. */
	country: string | null;
}

export interface ConsentInput {
	id: string;
	analytics: boolean;
	marketing: boolean;
	version: string;
	country: string | null;
}

const KEYS = ["a", "country", "id", "m", "v"];

/**
 * Check what the browser sent. Only the exact shape the banner sends is
 * accepted; anything extra, missing, long or oddly typed is refused.
 */
export function parseConsent(input: unknown): ConsentInput | null {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
	const body = input as Record<string, unknown>;
	if (Object.keys(body).sort().join() !== KEYS.join()) return null;
	const { id, a, m, v, country } = body;
	if (typeof id !== "string" || !/^[a-z0-9]{8,40}$/.test(id)) return null;
	if (typeof a !== "boolean" || typeof m !== "boolean") return null;
	if (typeof v !== "string" || !/^[a-z0-9]{1,16}$/.test(v)) return null;
	if (country !== null && (typeof country !== "string" || !/^[A-Z]{2}$/.test(country))) return null;
	return { id, analytics: a, marketing: m, version: v, country };
}

function rows(ctx: PluginContext): StorageCollection<ConsentRow> | undefined {
	return ctx.storage[CONSENTS] as StorageCollection<ConsentRow> | undefined;
}

export type SaveOutcome = "saved" | "full" | "unavailable";

/** Store one answer. The same reference sent twice replaces the first row instead of adding one. */
export async function saveConsent(
	ctx: PluginContext,
	input: ConsentInput,
	now: Date,
): Promise<SaveOutcome> {
	const table = rows(ctx);
	if (!table) return "unavailable";
	const today = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
	if ((await table.count({ at: { gte: today } })) >= MAX_ROWS_PER_DAY) return "full";
	await table.put(input.id, {
		at: now.toISOString(),
		choice:
			input.analytics && input.marketing
				? "all"
				: input.analytics || input.marketing
					? "some"
					: "none",
		analytics: input.analytics,
		marketing: input.marketing,
		version: input.version,
		country: input.country,
	});
	return "saved";
}

export interface ConsentCounts {
	all: number;
	none: number;
	some: number;
}

/** How visitors answered in the last `days` days. */
export async function countConsents(
	ctx: PluginContext,
	now: Date,
	days = 30,
): Promise<ConsentCounts | null> {
	const table = rows(ctx);
	if (!table) return null;
	const since = new Date(now.getTime() - days * DAY_MS).toISOString();
	const [all, none, some] = await Promise.all(
		(["all", "none", "some"] as const).map((choice) => table.count({ choice, at: { gte: since } })),
	);
	return { all: all ?? 0, none: none ?? 0, some: some ?? 0 };
}

export interface ConsentDay {
	/** YYYY-MM-DD, UTC. */
	day: string;
	all: number;
	none: number;
}

export interface ConsentSummary extends ConsentCounts {
	/** One entry per day, oldest first, today last. */
	days: ConsentDay[];
	/** When the newest answer arrived, ISO 8601, or null before the first. */
	lastAt: string | null;
}

/**
 * The Status tab's numbers: answers per day for the last `days` days (UTC,
 * today included), their totals, and when the last one came in. Counts only,
 * served by the (choice, at) index: two per day, one for "some", one read for
 * the newest row, all at once.
 */
export async function consentSummary(
	ctx: PluginContext,
	now: Date,
	days = 30,
): Promise<ConsentSummary | null> {
	const table = rows(ctx);
	if (!table) return null;
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const starts = Array.from({ length: days + 1 }, (_, index) =>
		new Date(today - (days - 1 - index) * DAY_MS).toISOString(),
	);
	const count = async (choice: ChoiceKind, gte: string, lt?: string) =>
		(await table.count({ choice, at: lt ? { gte, lt } : { gte } })) ?? 0;
	const [perDay, some, newest] = await Promise.all([
		Promise.all(
			starts.slice(0, days).map(async (start, index) => {
				const end = starts[index + 1]!;
				const [all, none] = await Promise.all([
					count("all", start, end),
					count("none", start, end),
				]);
				return { day: start.slice(0, 10), all, none };
			}),
		),
		count("some", starts[0]!),
		table.query({ orderBy: { at: "desc" }, limit: 1 }),
	]);
	return {
		all: perDay.reduce((sum, day) => sum + day.all, 0),
		none: perDay.reduce((sum, day) => sum + day.none, 0),
		some,
		days: perDay,
		lastAt: newest.items[0]?.data.at ?? null,
	};
}

/** How many answers one spreadsheet download holds at most: 100 reads of 100 rows. */
export const EXPORT_MAX_ROWS = 10_000;

/** The newest answers kept, up to `max`, and whether there are more. */
export async function readConsentLog(
	ctx: PluginContext,
	max = EXPORT_MAX_ROWS,
): Promise<{ rows: Array<{ id: string; data: ConsentRow }>; more: boolean }> {
	const table = rows(ctx);
	if (!table) return { rows: [], more: false };
	const out: Array<{ id: string; data: ConsentRow }> = [];
	let cursor: string | undefined;
	let more = false;
	while (out.length < max) {
		const page = await table.query({
			orderBy: { at: "desc" },
			limit: Math.min(100, max - out.length),
			...(cursor ? { cursor } : {}),
		});
		out.push(...page.items);
		more = page.hasMore;
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}
	return { rows: out, more };
}

const ANSWER: Record<ChoiceKind, string> = {
	all: "Accepted all",
	none: "Rejected all",
	some: "Chose some",
};

function cell(value: string): string {
	// A spreadsheet treats a leading = + - @ as a formula.
	const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The consent log for a spreadsheet: one line per answer, with exactly what is
 * stored. The reference is the random one the visitor's own browser keeps in
 * its cookie, so one answer can be matched to one visitor who asks.
 */
export function consentCsv(list: Array<{ id: string; data: ConsentRow }>, more = false): string {
	const lines = ["Date and time (UTC),Country,Answer,Analytics,Marketing,Banner version,Reference"];
	for (const { id, data } of list) {
		lines.push(
			[
				String(data.at).slice(0, 19).replace("T", " "),
				data.country ?? "",
				ANSWER[data.choice] ?? "",
				data.analytics ? "yes" : "no",
				data.marketing ? "yes" : "no",
				String(data.version ?? ""),
				id,
			]
				.map(cell)
				.join(","),
		);
	}
	if (more) {
		lines.push(
			`Only the newest ${list.length.toLocaleString("en")} answers are in this file. Older ones are still kept on the site.`,
		);
	}
	return `${lines.join("\r\n")}\r\n`;
}

/** Delete rows older than a year, a batch at a time. Returns how many went. */
export async function pruneConsents(ctx: PluginContext, now: Date): Promise<number> {
	const table = rows(ctx);
	if (!table) return 0;
	const before = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString();
	let removed = 0;
	for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
		const old = await table.query({ where: { at: { lt: before } }, limit: PRUNE_BATCH });
		if (old.items.length === 0) break;
		removed += await table.deleteMany(old.items.map((item) => item.id));
		if (!old.hasMore) break;
	}
	return removed;
}

/** Make sure the daily clean-up is scheduled. Safe to call often: it only writes when the task is missing. */
export async function ensurePruneScheduled(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) return;
	const tasks = await ctx.cron.list();
	if (tasks.some((task) => task.name === PRUNE_TASK)) return;
	await ctx.cron.schedule(PRUNE_TASK, { schedule: "@daily" });
}
