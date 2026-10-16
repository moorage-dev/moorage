// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, PluginStorageConfig, StorageCollection } from "emdash";

import { isLive, type Popup } from "./config.js";
import { utcDay } from "./time.js";

/**
 * Results: one row per popup per day (UTC), holding daily totals and nothing
 * about any visitor. The route that adds to them is public, so it is bounded:
 * a fixed shape, only popups that are live, and a daily ceiling per popup.
 */

export const COUNTS = "counts";
export const STORAGE = { [COUNTS]: { indexes: ["popup", "day", ["popup", "day"]] } } satisfies PluginStorageConfig;
export const DESCRIPTOR_STORAGE = { [COUNTS]: { indexes: ["popup", "day"] } };

export const EVENTS = ["seen", "sent", "clicked", "closed"] as const;
export type CountEvent = (typeof EVENTS)[number];
/** No popup is seen this often in a day on a real small site; beyond it, counts stop for the day. */
export const DAILY_CEILING = 50_000;
export const KEEP_DAYS = 400;
export const PRUNE_TASK = "prune-counts";
const DAY_MS = 86_400_000;

export interface CountRow {
	popup: string;
	day: string;
	seen: number;
	sent: number;
	clicked: number;
	closed: number;
	/** Of the views, how many were on a phone. */
	phone: number;
}

export interface CountInput {
	popup: string;
	event: CountEvent;
	phone: boolean;
}

/** Only the exact shape the browser sends: `{p, e, m}`. */
export function parseCount(input: unknown): CountInput | null {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
	const body = input as Record<string, unknown>;
	if (Object.keys(body).sort().join() !== "e,m,p") return null;
	if (typeof body.p !== "string" || !/^[a-z0-9]{4,40}$/.test(body.p)) return null;
	if (!EVENTS.includes(body.e as CountEvent)) return null;
	if (typeof body.m !== "boolean") return null;
	return { popup: body.p, event: body.e as CountEvent, phone: body.m };
}

function table(ctx: PluginContext): StorageCollection<CountRow> | undefined {
	return ctx.storage[COUNTS] as StorageCollection<CountRow> | undefined;
}

export type CountOutcome = "counted" | "not-live" | "full" | "unavailable";

export async function addCount(
	ctx: PluginContext,
	popups: Popup[],
	input: CountInput,
	now: number,
): Promise<CountOutcome> {
	const rows = table(ctx);
	if (!rows) return "unavailable";
	const popup = popups.find((p) => p.id === input.popup);
	if (!popup || !isLive(popup, now) || (popup.start !== null && now < popup.start - 60_000)) {
		return "not-live";
	}
	const day = utcDay(now);
	const id = `${popup.id}:${day}`;
	const delta: Partial<Record<keyof CountRow, { inc: number }>> = { [input.event]: { inc: 1 } };
	if (input.event === "seen" && input.phone) delta.phone = { inc: 1 };
	for (let attempt = 0; attempt < 3; attempt++) {
		const done = await rows.updateIf(id, {
			where: { [input.event]: { lt: DAILY_CEILING } },
			delta,
		});
		if (done.applied) return "counted";
		const existing = await rows.get(id);
		if (existing) return "full";
		const first: CountRow = { popup: popup.id, day, seen: 0, sent: 0, clicked: 0, closed: 0, phone: 0 };
		first[input.event] = 1;
		if (input.event === "seen" && input.phone) first.phone = 1;
		const created = await rows.compareAndSet(id, null, first);
		if (created.applied) return "counted";
		// Someone else made the row first; add to it.
	}
	return "full";
}

export interface Totals {
	seen: number;
	sent: number;
	clicked: number;
	closed: number;
	phone: number;
	/** The first day with a row, "2026-10-03". */
	since: string | null;
}

const empty = (): Totals => ({ seen: 0, sent: 0, clicked: 0, closed: 0, phone: 0, since: null });

/** Every row in a range of days (inclusive; null for no limit), oldest first. */
export async function readRows(
	ctx: PluginContext,
	from: string | null,
	to: string | null,
): Promise<CountRow[]> {
	const rows = table(ctx);
	if (!rows) return [];
	const range: Record<string, string> = {};
	if (from) range.gte = from;
	if (to) range.lte = to;
	const where = from || to ? { day: range } : undefined;
	const out: CountRow[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 100; page++) {
		const found = await rows.query({ where, limit: 100, cursor, orderBy: { day: "asc" } });
		for (const item of found.items) out.push(item.data);
		if (!found.hasMore || !found.cursor) break;
		cursor = found.cursor;
	}
	return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export function totals(rows: CountRow[]): Map<string, Totals> {
	const out = new Map<string, Totals>();
	for (const row of rows) {
		const t = out.get(row.popup) ?? empty();
		t.seen += row.seen || 0;
		t.sent += row.sent || 0;
		t.clicked += row.clicked || 0;
		t.closed += row.closed || 0;
		t.phone += row.phone || 0;
		if (!t.since || row.day < t.since) t.since = row.day;
		out.set(row.popup, t);
	}
	return out;
}

/** A whole percent, only from 100 views; smaller numbers swing too much to mean anything. */
export function rate(part: number, seen: number): number | null {
	return seen >= 100 ? Math.round((part / seen) * 100) : null;
}

function cell(value: string | number): string {
	const text = String(value);
	// A spreadsheet treats a leading = + - @ as a formula; names never start with one after this.
	const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
	return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One row per popup per day, for a spreadsheet. */
export function toCsv(rows: CountRow[], names: Map<string, string>): string {
	const lines = [["Day", "Popup", "Seen", "Signed up", "Clicked", "Closed", "Seen on phones"].join(",")];
	for (const row of rows) {
		lines.push(
			[row.day, names.get(row.popup) ?? "(deleted popup)", row.seen, row.sent, row.clicked, row.closed, row.phone]
				.map(cell)
				.join(","),
		);
	}
	return `${lines.join("\r\n")}\r\n`;
}

/** Delete rows older than 400 days, a batch at a time. */
export async function pruneCounts(ctx: PluginContext, now: number): Promise<number> {
	const rows = table(ctx);
	if (!rows) return 0;
	const before = utcDay(now - KEEP_DAYS * DAY_MS);
	let removed = 0;
	for (let batch = 0; batch < 50; batch++) {
		const old = await rows.query({ where: { day: { lt: before } }, limit: 100 });
		if (old.items.length === 0) break;
		removed += await rows.deleteMany(old.items.map((item) => item.id));
		if (!old.hasMore) break;
	}
	return removed;
}

export async function ensurePruneScheduled(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) return;
	const tasks = await ctx.cron.list();
	if (tasks.some((task) => task.name === PRUNE_TASK)) return;
	await ctx.cron.schedule(PRUNE_TASK, { schedule: "@daily" });
}
