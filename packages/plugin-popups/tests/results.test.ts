// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import {
	compare,
	daysText,
	periodDays,
	periodLabel,
	PERIODS,
	popupTiles,
	responseBars,
	sum,
	type Days,
} from "../src/results.js";
import type { CountRow } from "../src/stats.js";
import { popup } from "./helpers.js";

const row = (
	popupId: string,
	day: string,
	seen: number,
	more: Partial<CountRow> = {},
): CountRow => ({
	popup: popupId,
	day,
	seen,
	sent: 0,
	clicked: 0,
	closed: 0,
	phone: 0,
	...more,
});

describe("periods, in the site's time zone", () => {
	// 11:30 pm UTC on 31 October: already 1 November in Auckland, still 31 October in Los Angeles.
	const NOW = Date.UTC(2026, 9, 31, 23, 30);

	it("knows which month it is where the site is", () => {
		expect(periodDays("this-month", NOW, "Pacific/Auckland")).toMatchObject({
			from: "2026-11-01",
			to: "2026-11-01",
			before: { from: "2026-10-01", to: "2026-10-01" },
		});
		expect(periodDays("this-month", NOW, "America/Los_Angeles")).toMatchObject({
			from: "2026-10-01",
			to: "2026-10-31",
			// The same days of last month; September has only 30.
			before: { from: "2026-09-01", to: "2026-09-30" },
		});
	});

	it("takes last month whole, and the month before it to compare", () => {
		expect(periodDays("last-month", NOW, "America/Los_Angeles")).toMatchObject({
			from: "2026-09-01",
			to: "2026-09-30",
			before: { from: "2026-08-01", to: "2026-08-31" },
		});
		expect(periodDays("last-month", NOW, "Pacific/Auckland")).toMatchObject({
			from: "2026-10-01",
			to: "2026-10-31",
			before: { from: "2026-09-01", to: "2026-09-30" },
		});
		// January looks back into last year.
		expect(periodDays("last-month", Date.UTC(2027, 0, 10), "UTC")).toMatchObject({
			from: "2026-12-01",
			to: "2026-12-31",
			before: { from: "2026-11-01", to: "2026-11-30" },
		});
	});

	it("counts the last 30 days with today, and the 30 before them to compare", () => {
		expect(periodDays("30-days", NOW, "UTC")).toMatchObject({
			from: "2026-10-02",
			to: "2026-10-31",
			before: { from: "2026-09-02", to: "2026-10-01" },
		});
	});

	it("starts 'since it started' on the day the popup was made, and never before the 400 kept days", () => {
		expect(periodDays("start", NOW, "UTC", "2026-10-05")).toEqual({
			from: "2026-10-05",
			to: "2026-10-31",
			before: null,
			cut: false,
		});
		const old = periodDays("start", NOW, "UTC", "2024-01-01");
		expect(old).toMatchObject({ from: "2025-09-27", to: "2026-10-31", cut: true });
		// Comparing all popups: every kept day, and nothing is cut short.
		expect(periodDays("start", NOW, "UTC")).toMatchObject({ from: "2025-09-27", cut: false });
	});

	it("says the days in short words, with the year only when it is not this year", () => {
		expect(daysText({ from: "2026-10-01", to: "2026-10-24" }, "2026-10-24")).toBe(
			"1 Oct to 24 Oct",
		);
		expect(daysText({ from: "2025-12-30", to: "2026-01-02" }, "2026-01-02")).toBe(
			"30 Dec 2025 to 2 Jan",
		);
		expect(daysText({ from: "2026-10-24", to: "2026-10-24" }, "2026-10-24")).toBe("24 Oct");
	});

	it("words every period short enough for a phone's dropdown", () => {
		for (const p of PERIODS)
			for (const one of [true, false]) expect(periodLabel(p, one).length).toBeLessThan(20);
		expect(periodLabel("start", true)).toBe("Since it started");
		expect(periodLabel("start", false)).toBe("Since they started");
	});
});

describe("a popup's four tiles", () => {
	const days: Days = { from: "2026-10-01", to: "2026-10-31" };
	const before: Days = { from: "2026-09-01", to: "2026-09-30" };

	it("shows Seen, Sign-ups, Rate and Closed, and the change from the period before", () => {
		const rows = [
			row("abcd1234", "2026-09-10", 500, { sent: 9, closed: 100 }),
			row("abcd1234", "2026-10-10", 600, { sent: 18, closed: 80 }),
		];
		const tiles = popupTiles(
			popup({ contains: "form", form: "newsletter" }),
			sum(rows, days),
			sum(rows, before),
		);
		expect(tiles).toEqual([
			{ label: "Seen", value: "600", description: "up from 500", trend: "up" },
			{ label: "Sign-ups", value: "18", description: "up from 9", trend: "up" },
			{ label: "Rate", value: "3%", description: "up from 2%", trend: "up" },
			// More people closing it is not good news: no green arrow.
			{ label: "Closed", value: "80", description: "down from 100" },
		]);
	});

	it("says Button clicks for a popup with a button, and no change when the rate stayed", () => {
		const rows = [
			row("abcd1234", "2026-09-10", 200, { clicked: 10 }),
			row("abcd1234", "2026-10-10", 100, { clicked: 5 }),
		];
		const tiles = popupTiles(popup(), sum(rows, days), sum(rows, before));
		expect(tiles[1]).toMatchObject({ label: "Button clicks", value: "5", trend: "down" });
		expect(tiles[2]).toEqual({
			label: "Rate",
			value: "5%",
			description: "no change from 5%",
			trend: "neutral",
		});
	});

	it("shows no rate under 100 views, and compares nothing when either period had too few", () => {
		const rows = [
			row("abcd1234", "2026-09-10", 99, { clicked: 3 }),
			row("abcd1234", "2026-10-10", 400, { clicked: 4 }),
		];
		const few = popupTiles(popup(), sum(rows, before), null);
		expect(few[2]).toEqual({ label: "Rate", value: "–", description: "(needs 100 views)" });
		const tiles = popupTiles(popup(), sum(rows, days), sum(rows, before));
		expect(tiles.every((t) => !t.trend && !t.description?.includes("from"))).toBe(true);
		expect(tiles[2]).toEqual({ label: "Rate", value: "1%" });
	});

	it("keeps every tile's words short enough for a phone's half-width tile", () => {
		const rows = [
			row("abcd1234", "2026-09-10", 123_456, { clicked: 12_345, closed: 99_999 }),
			row("abcd1234", "2026-10-10", 234_567, { clicked: 23_456, closed: 88_888 }),
		];
		for (const t of popupTiles(popup(), sum(rows, days), sum(rows, before))) {
			expect(t.label.length).toBeLessThanOrEqual(13);
			expect((t.description ?? "").length).toBeLessThanOrEqual(18);
		}
		expect(popupTiles(popup({ kind: "inline" }), sum(rows, days), null)[3]).toEqual({
			label: "Closed",
			value: "–",
			description: "a box has no close",
		});
	});
});

describe("the daily bars", () => {
	it("has a bar for every day, empty days as 0, only sign-ups for a form", () => {
		const bars = responseBars(
			popup({ contains: "form", form: "newsletter" }),
			[
				row("abcd1234", "2026-10-02", 50, { sent: 3, clicked: 7 }),
				row("abcd1234", "2026-10-04", 50, { sent: 1 }),
			],
			{ from: "2026-10-01", to: "2026-10-05" },
		);
		expect(bars.weekly).toBe(false);
		expect(bars.data).toEqual([
			[Date.UTC(2026, 9, 1, 12), 0],
			[Date.UTC(2026, 9, 2, 12), 3],
			[Date.UTC(2026, 9, 3, 12), 0],
			[Date.UTC(2026, 9, 4, 12), 1],
			[Date.UTC(2026, 9, 5, 12), 0],
		]);
	});

	it("shows a bar a week for a long period, so the page stays small", () => {
		const bars = responseBars(popup(), [row("abcd1234", "2026-01-09", 50, { clicked: 2 })], {
			from: "2026-01-01",
			to: "2026-12-31",
		});
		expect(bars.weekly).toBe(true);
		expect(bars.data).toHaveLength(53);
		expect(bars.data[1]).toEqual([Date.UTC(2026, 0, 8, 12), 2]);
	});
});

describe("comparing all popups", () => {
	const days: Days = { from: "2026-10-01", to: "2026-10-31" };
	const popups = [
		popup({ id: "aaaa0001", name: "Letter", contains: "form", form: "newsletter" }),
		popup({ id: "bbbb0002", name: "Offer" }),
		popup({ id: "cccc0003", name: "Box", kind: "inline" }),
		popup({ id: "dddd0004", name: "Half made", step: 2, on: false }),
	];
	const rows = [
		row("aaaa0001", "2026-10-03", 300, { sent: 12, closed: 50, phone: 150 }),
		row("bbbb0002", "2026-10-03", 150, { clicked: 3, closed: 20, phone: 30 }),
		row("cccc0003", "2026-10-03", 40, { clicked: 2 }),
		row("gone0005", "2026-10-03", 200, { sent: 4, clicked: 1, closed: 10, phone: 100 }),
		// Outside the period: never counted.
		row("aaaa0001", "2026-09-30", 999, { sent: 99 }),
	];

	it("adds the totals up from exactly the rows shown, deleted popups in one row of their own", () => {
		const { rows: table, total } = compare(popups, rows, days, null);
		expect(table.map((r) => r.name)).toEqual(["Letter", "Offer", "Box", "Deleted popups"]);
		expect(total).toEqual({ seen: 690, sent: 16, clicked: 6, closed: 80 });
		const seen = table.reduce((n, r) => n + Number(r.seen.replace(/\D/g, "") || 0), 0);
		expect(seen).toBe(total.seen);
		expect(table[3]).toEqual({
			name: "Deleted popups",
			seen: "200",
			responses: "4 sign-ups, 1 button click",
			rate: "3%",
			closed: "10",
			phones: "50%",
		});
	});

	it("words each row with the same words as a popup's page, and the 100-view rule for phones too", () => {
		const { rows: table } = compare(popups, rows, days, null);
		expect(table[0]).toEqual({
			name: "Letter",
			seen: "300",
			responses: "12 sign-ups",
			rate: "4%",
			closed: "50",
			phones: "50%",
		});
		expect(table[1]).toMatchObject({ responses: "3 button clicks", rate: "2%", phones: "20%" });
		// Under 100 views: no rate and no share on phones; a box has no close.
		expect(table[2]).toEqual({
			name: "Box",
			seen: "40",
			responses: "2 button clicks",
			rate: "–",
			closed: "–",
			phones: "–",
		});
	});

	it("sorts by Seen or Rate either way, rows without a rate last, deleted popups always last", () => {
		const names = (key: "seen" | "rate", dir: "asc" | "desc") =>
			compare(popups, rows, days, { key, dir }).rows.map((r) => r.name);
		expect(names("seen", "desc")).toEqual(["Letter", "Offer", "Box", "Deleted popups"]);
		expect(names("seen", "asc")).toEqual(["Box", "Offer", "Letter", "Deleted popups"]);
		expect(names("rate", "desc")).toEqual(["Letter", "Offer", "Box", "Deleted popups"]);
		expect(names("rate", "asc")).toEqual(["Offer", "Letter", "Box", "Deleted popups"]);
	});

	it("lists finished popups with nothing counted, and leaves out a half-made one with nothing", () => {
		const { rows: table, total } = compare(popups, [], days, null);
		expect(table.map((r) => r.name)).toEqual(["Letter", "Offer", "Box"]);
		expect(table[0]).toMatchObject({ seen: "–", responses: "–", rate: "–", phones: "–" });
		expect(total.seen).toBe(0);
	});
});
