// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import {
	consentCsv,
	consentSummary,
	readConsentLog,
	countConsents,
	ensurePruneScheduled,
	KEEP_DAYS,
	MAX_ROWS_PER_DAY,
	parseConsent,
	PRUNE_TASK,
	pruneConsents,
	saveConsent,
} from "../src/record.js";
import { fakeContext } from "./helpers.js";

const GOOD = { id: "k3j2h1g0f9", a: true, m: false, v: "abc12", country: "DE" };
const NOW = new Date("2026-10-13T12:00:00.000Z");
const DAY = 86_400_000;

describe("checking a consent record", () => {
	it("accepts exactly what the banner sends", () => {
		expect(parseConsent(GOOD)).toEqual({
			id: "k3j2h1g0f9",
			analytics: true,
			marketing: false,
			version: "abc12",
			country: "DE",
		});
		expect(parseConsent({ ...GOOD, country: null })?.country).toBeNull();
	});

	it("refuses anything else", () => {
		const bad: unknown[] = [
			null,
			"text",
			[],
			{},
			{ ...GOOD, extra: 1 },
			{ ...GOOD, ip: "203.0.113.9" },
			{ id: GOOD.id, a: true, m: false, v: "abc12" },
			{ ...GOOD, id: "short" },
			{ ...GOOD, id: "x".repeat(41) },
			{ ...GOOD, id: "<script>alert(1)</script>" },
			{ ...GOOD, id: 12345678 },
			{ ...GOOD, a: "true" },
			{ ...GOOD, m: 1 },
			{ ...GOOD, v: "" },
			{ ...GOOD, v: "a".repeat(17) },
			{ ...GOOD, v: "ABC" },
			{ ...GOOD, country: "de" },
			{ ...GOOD, country: "DEU" },
			{ ...GOOD, country: "" },
			{ ...GOOD, country: 49 },
		];
		for (const input of bad) expect(parseConsent(input), JSON.stringify(input)).toBeNull();
	});
});

describe("keeping consent records", () => {
	it("stores the answer and the time, and nothing about the person", async () => {
		const fake = fakeContext();
		expect(await saveConsent(fake.ctx, parseConsent(GOOD)!, NOW)).toBe("saved");
		expect([...fake.rows.entries()]).toEqual([
			[
				"k3j2h1g0f9",
				{
					at: "2026-10-13T12:00:00.000Z",
					choice: "some",
					analytics: true,
					marketing: false,
					version: "abc12",
					country: "DE",
				},
			],
		]);
	});

	it("replaces a repeated reference instead of adding a row", async () => {
		const fake = fakeContext();
		const input = parseConsent(GOOD)!;
		await saveConsent(fake.ctx, input, NOW);
		await saveConsent(fake.ctx, { ...input, marketing: true }, NOW);
		expect(fake.rows.size).toBe(1);
		expect(fake.rows.get(GOOD.id)?.choice).toBe("all");
	});

	it("stops for the day at the daily limit, and starts again the next day", async () => {
		const fake = fakeContext();
		for (let index = 0; index < MAX_ROWS_PER_DAY; index++) {
			fake.rows.set(`spam${index}`, { at: "2026-10-13T00:00:01.000Z", choice: "all" });
		}
		const input = parseConsent(GOOD)!;
		expect(await saveConsent(fake.ctx, input, NOW)).toBe("full");
		expect(fake.rows.has(GOOD.id)).toBe(false);
		expect(await saveConsent(fake.ctx, input, new Date(NOW.getTime() + DAY))).toBe("saved");
	});

	it("counts the last 30 days by kind of answer", async () => {
		const fake = fakeContext();
		const add = async (id: string, a: boolean, m: boolean, daysAgo: number) =>
			saveConsent(
				fake.ctx,
				{ id, analytics: a, marketing: m, version: "v", country: null },
				new Date(NOW.getTime() - daysAgo * DAY),
			);
		await add("aaaaaaaa1", true, true, 1);
		await add("aaaaaaaa2", true, true, 29);
		await add("aaaaaaaa3", true, true, 31);
		await add("aaaaaaaa4", false, false, 2);
		await add("aaaaaaaa5", true, false, 3);
		await add("aaaaaaaa6", false, true, 3);
		expect(await countConsents(fake.ctx, NOW)).toEqual({ all: 2, none: 1, some: 2 });
	});

	it("deletes records older than a year and keeps the rest", async () => {
		const fake = fakeContext();
		for (let index = 0; index < 250; index++) {
			await saveConsent(
				fake.ctx,
				{
					id: `old${String(index).padStart(6, "0")}`,
					analytics: true,
					marketing: true,
					version: "v",
					country: null,
				},
				new Date(NOW.getTime() - (KEEP_DAYS + 1 + index) * DAY),
			);
		}
		await saveConsent(
			fake.ctx,
			{ id: "recent0001", analytics: true, marketing: true, version: "v", country: null },
			new Date(NOW.getTime() - (KEEP_DAYS - 1) * DAY),
		);
		expect(await pruneConsents(fake.ctx, NOW)).toBe(250);
		expect([...fake.rows.keys()]).toEqual(["recent0001"]);
		expect(await pruneConsents(fake.ctx, NOW)).toBe(0);
	});

	it("schedules the daily clean-up once", async () => {
		const fake = fakeContext();
		await ensurePruneScheduled(fake.ctx);
		await ensurePruneScheduled(fake.ctx);
		expect(fake.scheduled).toEqual([{ name: PRUNE_TASK, schedule: "@daily" }]);
	});
});

describe("the 30-day summary", () => {
	const add = async (
		fake: ReturnType<typeof fakeContext>,
		id: string,
		a: boolean,
		m: boolean,
		at: Date,
	) => saveConsent(fake.ctx, { id, analytics: a, marketing: m, version: "v", country: null }, at);

	it("counts each of the last 30 days, today included, and the time of the last answer", async () => {
		const fake = fakeContext();
		await add(fake, "aaaaaaaa1", true, true, new Date("2026-10-13T08:00:00.000Z"));
		await add(fake, "aaaaaaaa2", false, false, new Date("2026-10-13T09:30:00.000Z"));
		await add(fake, "aaaaaaaa3", true, true, new Date("2026-10-12T23:59:00.000Z"));
		await add(fake, "aaaaaaaa4", true, false, new Date("2026-10-12T10:00:00.000Z"));
		// The first of the 30 days, and the day before it.
		await add(fake, "aaaaaaaa5", false, false, new Date("2026-09-14T00:00:00.000Z"));
		await add(fake, "aaaaaaaa6", false, false, new Date("2026-09-13T23:59:00.000Z"));
		const summary = await consentSummary(fake.ctx, NOW);
		expect(summary).not.toBeNull();
		expect(summary!.days).toHaveLength(30);
		expect(summary!.days[0]).toEqual({ day: "2026-09-14", all: 0, none: 1 });
		expect(summary!.days.at(-2)).toEqual({ day: "2026-10-12", all: 1, none: 0 });
		expect(summary!.days.at(-1)).toEqual({ day: "2026-10-13", all: 1, none: 1 });
		expect(summary).toMatchObject({
			all: 2,
			none: 2,
			some: 1,
			lastAt: "2026-10-13T09:30:00.000Z",
		});
	});

	it("says there is no answer yet on a new site", async () => {
		expect(await consentSummary(fakeContext().ctx, NOW)).toMatchObject({
			all: 0,
			none: 0,
			some: 0,
			lastAt: null,
		});
	});
});

describe("the consent log as a spreadsheet", () => {
	it("lists every answer kept, newest first, with what is stored and nothing more", async () => {
		const fake = fakeContext();
		await saveConsent(
			fake.ctx,
			{ id: "older0001", analytics: false, marketing: false, version: "v1", country: null },
			new Date("2026-10-01T10:00:00.000Z"),
		);
		await saveConsent(
			fake.ctx,
			{ id: "newer0001", analytics: true, marketing: false, version: "v2", country: "DE" },
			new Date("2026-10-13T11:22:33.000Z"),
		);
		const { rows, more } = await readConsentLog(fake.ctx);
		expect(more).toBe(false);
		expect(consentCsv(rows)).toBe(
			[
				"Date and time (UTC),Country,Answer,Analytics,Marketing,Banner version,Reference",
				"2026-10-13 11:22:33,DE,Chose some,yes,no,v2,newer0001",
				"2026-10-01 10:00:00,,Rejected all,no,no,v1,older0001",
				"",
			].join("\r\n"),
		);
	});

	it("stops at the limit and says so at the end of the file", async () => {
		const fake = fakeContext();
		for (let index = 0; index < 250; index++) {
			fake.rows.set(`r${String(index).padStart(8, "0")}`, {
				at: new Date(NOW.getTime() - index * 60_000).toISOString(),
				choice: "all",
				analytics: true,
				marketing: true,
				version: "v",
				country: null,
			});
		}
		const { rows, more } = await readConsentLog(fake.ctx, 120);
		expect(rows).toHaveLength(120);
		expect(more).toBe(true);
		// Pages of at most 100.
		expect(fake.queries()).toBe(2);
		const csv = consentCsv(rows, more);
		expect(csv.trim().split("\r\n").at(-1)).toBe(
			"Only the newest 120 answers are in this file. Older ones are still kept on the site.",
		);
	});

	it("never lets a cell start a spreadsheet formula", () => {
		const csv = consentCsv([
			{
				id: "x",
				data: {
					at: "2026-10-13T00:00:00.000Z",
					choice: "all",
					analytics: true,
					marketing: true,
					version: "=cmd",
					country: null,
				},
			},
		]);
		expect(csv).toContain(",'=cmd,");
	});
});
