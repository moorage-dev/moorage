// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import {
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
