// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

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
