// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Popup } from "./config.js";
import { KEEP_DAYS, rate, totals, type CountRow, type Totals } from "./stats.js";
import { addDays, daysFrom, monthEnd, shortDay, zoneDay } from "./time.js";

/**
 * Results: which days a period covers, the numbers for a popup's own page and
 * for "How your popups compare", in one set of words. Pure: the route reads the
 * rows, this only adds them up. Days are the site's time zone days, the same
 * days the count rows are kept by.
 */

export const PERIODS = ["start", "this-month", "last-month", "30-days"] as const;
export type Period = (typeof PERIODS)[number];

/** A popup's page and comparing both open on the last 30 days, so the two tell the same story. */
export const POPUP_PERIOD: Period = "30-days";
export const COMPARE_PERIOD: Period = "30-days";

/** From this many views a rate means something; under it, it swings too much. */
export const ENOUGH_VIEWS = 100;

/** A chart longer than this shows a bar a week, so it stays readable and small. */
const DAILY_BARS_UP_TO = 62;

export function periodLabel(period: Period, one: boolean): string {
	switch (period) {
		case "start":
			return one ? "Since it started" : "Since they started";
		case "this-month":
			return "This month";
		case "last-month":
			return "Last month";
		case "30-days":
			return "Last 30 days";
	}
}

export function isPeriod(value: unknown): value is Period {
	return typeof value === "string" && (PERIODS as readonly string[]).includes(value);
}

export interface Days {
	from: string;
	to: string;
}

export interface PeriodDays extends Days {
	/** The period before, as long, to compare with; null for "since it started". */
	before: Days | null;
	/** Counts older than 400 days are gone: "since it started" begins later than the popup did. */
	cut: boolean;
}

/**
 * The days a period covers in the site's time zone, today included.
 *
 * - This month: the 1st to today; before it, the same days of last month.
 * - Last month: the whole month; before it, the month before.
 * - Last 30 days: today and the 29 days before; before it, the 30 days before those.
 * - Since it started: the day the popup was made (or, comparing, the oldest kept day) to today.
 */
export function periodDays(
	period: Period,
	now: number,
	zone: string,
	started?: string,
): PeriodDays {
	const today = zoneDay(now, zone);
	const oldest = addDays(today, -(KEEP_DAYS - 1));
	const firstOf = (day: string) => `${day.slice(0, 8)}01`;
	const clamp = (days: Days): Days => ({
		from: days.from < oldest ? oldest : days.from,
		to: days.to,
	});
	if (period === "this-month") {
		const from = firstOf(today);
		const lastMonth = firstOf(addDays(from, -1));
		const sameDay = addDays(lastMonth, Number(today.slice(8)) - 1);
		const end = monthEnd(lastMonth);
		return {
			from,
			to: today,
			before: { from: lastMonth, to: sameDay > end ? end : sameDay },
			cut: false,
		};
	}
	if (period === "last-month") {
		const to = addDays(firstOf(today), -1);
		const from = firstOf(to);
		const beforeTo = addDays(from, -1);
		return { from, to, before: { from: firstOf(beforeTo), to: beforeTo }, cut: false };
	}
	if (period === "30-days") {
		const from = addDays(today, -29);
		return {
			from,
			to: today,
			before: clamp({ from: addDays(from, -30), to: addDays(from, -1) }),
			cut: false,
		};
	}
	const began = started && started <= today ? started : started ? today : oldest;
	return {
		from: began < oldest ? oldest : began,
		to: today,
		before: null,
		cut: !!started && started < oldest,
	};
}

/** The day a popup was made, in the site's time zone; undefined when it is not known. */
export function startedOn(popup: Popup, zone: string): string | undefined {
	const made = Date.parse(popup.createdAt);
	return Number.isFinite(made) && made > 0 ? zoneDay(made, zone) : undefined;
}

/** "1 Oct to 24 Oct" (or one day), with the year only when it is not this year. */
export function daysText(days: Days, today: string): string {
	const from = shortDay(days.from, today);
	return days.from === days.to ? from : `${from} to ${shortDay(days.to, today)}`;
}

export function isForm(popup: Pick<Popup, "contains" | "kind">): boolean {
	return popup.contains === "form" && popup.kind !== "bar";
}

/** Sign-ups for a popup with a form, button clicks for one with a button. */
export function responses(popup: Pick<Popup, "contains" | "kind">, t: Totals): number {
	return isForm(popup) ? t.sent : t.clicked;
}

const empty = (): Totals => ({ seen: 0, sent: 0, clicked: 0, closed: 0, phone: 0, since: null });

/** Every row within the days added up (the caller passes one popup's rows). */
export function sum(rows: CountRow[], days: Days): Totals {
	const t = empty();
	for (const row of rows) {
		if (row.day < days.from || row.day > days.to) continue;
		t.seen += row.seen || 0;
		t.sent += row.sent || 0;
		t.clicked += row.clicked || 0;
		t.closed += row.closed || 0;
		t.phone += row.phone || 0;
		if (!t.since || row.day < t.since) t.since = row.day;
	}
	return t;
}

const num = (n: number) => n.toLocaleString("en");

/** The share of views on phones, from 100 views like any rate. */
export function phoneShare(t: Totals): number | null {
	return rate(t.phone, t.seen);
}

export interface Tile {
	label: string;
	value: string;
	description?: string;
	trend?: "up" | "down" | "neutral";
}

/**
 * The change against the period before, when both had 100 views. Closed has no
 * arrow: a green arrow for more people closing it would read as good news.
 */
function change(now: number, then: number, text: string, arrow: boolean): Partial<Tile> {
	const word = now > then ? "up from" : now < then ? "down from" : "no change from";
	return {
		description: `${word} ${text}`,
		...(arrow ? { trend: now > then ? "up" : now < then ? "down" : "neutral" } : {}),
	};
}

/** The four tiles of a popup's page: Seen, Sign-ups (or Button clicks), Rate, Closed. */
export function popupTiles(popup: Popup, current: Totals, before: Totals | null): Tile[] {
	const compare = !!before && before.seen >= ENOUGH_VIEWS && current.seen >= ENOUGH_VIEWS;
	const got = responses(popup, current);
	const had = before ? responses(popup, before) : 0;
	const r = rate(got, current.seen);
	const was = before ? rate(had, before.seen) : null;
	const tiles: Tile[] = [
		{
			label: "Seen",
			value: num(current.seen),
			...(compare ? change(current.seen, before.seen, num(before.seen), true) : {}),
		},
		{
			label: isForm(popup) ? "Sign-ups" : "Button clicks",
			value: num(got),
			...(compare ? change(got, had, num(had), true) : {}),
		},
		r === null
			? { label: "Rate", value: "–", description: "(needs 100 views)" }
			: {
					label: "Rate",
					value: `${r}%`,
					...(compare && was !== null ? change(r, was, `${was}%`, true) : {}),
				},
		popup.kind === "inline"
			? { label: "Closed", value: "–", description: "a box has no close" }
			: {
					label: "Closed",
					value: num(current.closed),
					...(compare ? change(current.closed, before.closed, num(before.closed), false) : {}),
				},
	];
	return tiles;
}

/** "[noon of the day, count]" for each day (or week) of the period, empty days as 0. */
export function responseBars(
	popup: Popup,
	rows: CountRow[],
	days: Days,
): { weekly: boolean; data: [number, number][] } {
	const byDay = new Map<string, number>();
	for (const row of rows) {
		if (row.day < days.from || row.day > days.to) continue;
		const n = isForm(popup) ? row.sent || 0 : row.clicked || 0;
		byDay.set(row.day, (byDay.get(row.day) ?? 0) + n);
	}
	const length = daysFrom(days.from, days.to);
	const weekly = length > DAILY_BARS_UP_TO;
	const step = weekly ? 7 : 1;
	const data: [number, number][] = [];
	for (let i = 0; i < length; i += step) {
		const first = addDays(days.from, i);
		let n = 0;
		for (let j = 0; j < step && i + j < length; j++) n += byDay.get(addDays(first, j)) ?? 0;
		// Noon UTC of the site's day: shown as that date in any browser from UTC-11 to UTC+11.
		data.push([Date.parse(`${first}T12:00:00Z`), n]);
	}
	return { weekly, data };
}

// ── Comparing all popups ───────────────────────────────────

export type SortKey = "seen" | "rate";
export interface Sort {
	key: SortKey;
	dir: "asc" | "desc";
}

export function parseSort(value: unknown): Sort | null {
	const sort = (value as { sort?: { key?: unknown; dir?: unknown } } | null)?.sort;
	if (!sort || (sort.key !== "seen" && sort.key !== "rate")) return null;
	return { key: sort.key, dir: sort.dir === "desc" ? "desc" : "asc" };
}

export interface CompareRow {
	name: string;
	seen: string;
	responses: string;
	rate: string;
	closed: string;
	phones: string;
}

interface Line {
	row: CompareRow;
	seen: number;
	rate: number | null;
	order: number;
	deleted: boolean;
}

export interface Compared {
	rows: CompareRow[];
	/** The same rows added up, deleted popups included, so the tiles always match the table. */
	total: { seen: number; sent: number; clicked: number; closed: number };
}

function plural(n: number, one: string, many: string): string {
	return `${num(n)} ${n === 1 ? one : many}`;
}

/**
 * One row per popup (finished, or with counts in the period), then one
 * "Deleted popups" row for counts of popups that no longer exist. Sorted by
 * Seen or Rate when asked; a row without a rate (under 100 views) goes last
 * either way, and deleted popups always last of all.
 */
export function compare(
	popups: Popup[],
	rows: CountRow[],
	days: Days,
	sort: Sort | null,
): Compared {
	const inPeriod = rows.filter((row) => row.day >= days.from && row.day <= days.to);
	const sums = totals(inPeriod);
	const known = new Set(popups.map((p) => p.id));
	const total = { seen: 0, sent: 0, clicked: 0, closed: 0 };
	for (const t of sums.values()) {
		total.seen += t.seen;
		total.sent += t.sent;
		total.clicked += t.clicked;
		total.closed += t.closed;
	}
	const line = (name: string, t: Totals, popup: Popup | null, order: number): Line => {
		const got = popup ? responses(popup, t) : t.sent + t.clicked;
		const r = rate(got, t.seen);
		const phones = phoneShare(t);
		const said = popup
			? isForm(popup)
				? plural(got, "sign-up", "sign-ups")
				: plural(got, "button click", "button clicks")
			: [
					t.sent ? plural(t.sent, "sign-up", "sign-ups") : "",
					t.clicked ? plural(t.clicked, "button click", "button clicks") : "",
				]
					.filter(Boolean)
					.join(", ") || "0";
		return {
			row: {
				name,
				seen: t.seen ? num(t.seen) : "–",
				responses: t.seen || got ? said : "–",
				rate: r === null ? "–" : `${r}%`,
				closed: popup?.kind === "inline" || !t.seen ? "–" : num(t.closed),
				phones: phones === null ? "–" : `${phones}%`,
			},
			seen: t.seen,
			// Sorted by the exact share, so 4.6% and 5.4% (both "5%") still come out in order.
			rate: r === null ? null : got / t.seen,
			order,
			deleted: !popup,
		};
	};
	const lines = popups
		.map((popup, i) => ({ popup, i }))
		.filter(({ popup }) => popup.step >= 4 || sums.has(popup.id))
		.map(({ popup, i }) => line(popup.name, sums.get(popup.id) ?? empty(), popup, i));
	const gone = empty();
	let anyGone = false;
	for (const [id, t] of sums) {
		if (known.has(id)) continue;
		anyGone = true;
		gone.seen += t.seen;
		gone.sent += t.sent;
		gone.clicked += t.clicked;
		gone.closed += t.closed;
		gone.phone += t.phone;
	}
	if (sort) {
		const sign = sort.dir === "asc" ? 1 : -1;
		lines.sort((a, b) => {
			const x = sort.key === "seen" ? a.seen : a.rate;
			const y = sort.key === "seen" ? b.seen : b.rate;
			if (x === null && y === null) return a.order - b.order;
			if (x === null) return 1;
			if (y === null) return -1;
			return (x - y) * sign || a.order - b.order;
		});
	}
	if (anyGone) lines.push(line("Deleted popups", gone, null, lines.length));
	return { rows: lines.map((l) => l.row), total };
}
