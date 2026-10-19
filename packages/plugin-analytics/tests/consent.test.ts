// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { COOKIE, decide, encodeChoice, mustAsk, readChoice } from "../src/client/consent.js";
import type { Choice } from "../src/client/types.js";

const RULE = { v: "abc", who: 1, days: 183 } as const;
const DAY = 20_000;

function choice(overrides: Partial<Choice> = {}): Choice {
	return { v: "abc", a: true, m: true, d: DAY, id: "k3j2h1", ...overrides };
}

describe("who is asked", () => {
	it("asks in the EU, the EEA, the UK and Switzerland", () => {
		for (const country of ["DE", "FR", "IE", "NO", "IS", "LI", "GB", "CH", "RE", "de"]) {
			expect(mustAsk(country, "America/New_York"), country).toBe(true);
		}
	});

	it("does not ask elsewhere, whatever the time zone says", () => {
		for (const country of ["US", "IN", "AU", "BR", "JP", "CA"]) {
			expect(mustAsk(country, "Europe/Berlin"), country).toBe(false);
		}
	});

	it("falls back to the time zone when the country is unknown", () => {
		expect(mustAsk("", "Europe/Paris")).toBe(true);
		expect(mustAsk(null, "Atlantic/Reykjavik")).toBe(true);
		expect(mustAsk(undefined, "Indian/Reunion")).toBe(true);
		expect(mustAsk("", "America/Chicago")).toBe(false);
		expect(mustAsk("", "Asia/Kolkata")).toBe(false);
	});

	it("asks when nothing is known", () => {
		expect(mustAsk("", undefined)).toBe(true);
		expect(mustAsk(undefined, "")).toBe(true);
	});
});

describe("asking in India too", () => {
	it("asks visitors in India only when the site chose Europe, the UK and India", () => {
		expect(mustAsk("IN", null)).toBe(false);
		expect(mustAsk("IN", null, true)).toBe(true);
		expect(mustAsk(null, "Asia/Kolkata", true)).toBe(true);
		expect(mustAsk(null, "Asia/Kolkata")).toBe(false);
		expect(mustAsk("DE", null, true)).toBe(true);
		expect(mustAsk("US", "America/New_York", true)).toBe(false);
	});
});

describe("the saved answer", () => {
	it("round-trips through the cookie", () => {
		const saved = choice({ a: true, m: false });
		const cookies = `theme=dark; ${COOKIE}=${encodeChoice(saved)}; other=1`;
		expect(readChoice(cookies)).toEqual(saved);
	});

	it("ignores a missing or damaged cookie", () => {
		expect(readChoice("")).toBeNull();
		expect(readChoice(`${COOKIE}=garbage`)).toBeNull();
		expect(readChoice(`${COOKIE}=abc.12.5.x`)).toBeNull();
		expect(readChoice(`not_${COOKIE}=abc.11.5.x`)).toBeNull();
	});
});

describe("the decision", () => {
	it("allows nothing and shows the banner to a new visitor who must be asked", () => {
		expect(decide(RULE, null, true, false, DAY)).toEqual({ a: false, m: false, ask: true });
	});

	it("allows everything without a banner where visitors are not asked", () => {
		expect(decide(RULE, null, false, false, DAY)).toEqual({ a: true, m: true, ask: false });
	});

	it("asks everyone when the site says so", () => {
		expect(decide({ ...RULE, who: 2 }, null, false, false, DAY).ask).toBe(true);
	});

	it("asks visitors in the asked places when the site chose Europe, the UK and India", () => {
		// The India choice asks the same people as the Europe choice, plus India: a visitor in an
		// asked place sees the banner and nothing loads; a visitor elsewhere is not asked.
		expect(decide({ ...RULE, who: 3 }, null, true, false, DAY)).toEqual({
			a: false,
			m: false,
			ask: true,
		});
		expect(decide({ ...RULE, who: 3 }, null, false, false, DAY)).toEqual({
			a: true,
			m: true,
			ask: false,
		});
	});

	it("asks no one when another consent tool is in charge", () => {
		expect(decide({ ...RULE, who: 0 }, null, true, false, DAY)).toEqual({
			a: true,
			m: true,
			ask: false,
		});
	});

	it("follows a saved answer, including a refusal", () => {
		expect(decide(RULE, choice({ a: true, m: false }), true, false, DAY + 10)).toEqual({
			a: true,
			m: false,
			ask: false,
		});
		expect(decide(RULE, choice({ a: false, m: false }), false, false, DAY + 10)).toEqual({
			a: false,
			m: false,
			ask: false,
		});
	});

	it("asks again when the tools changed or the answer is too old", () => {
		expect(decide(RULE, choice({ v: "old" }), true, false, DAY).ask).toBe(true);
		expect(decide(RULE, choice(), true, false, DAY + 182).ask).toBe(false);
		expect(decide(RULE, choice(), true, false, DAY + 183).ask).toBe(true);
	});

	it("refuses Marketing under Global Privacy Control, even after Accept all", () => {
		expect(decide(RULE, choice(), true, true, DAY)).toEqual({ a: true, m: false, ask: false });
		expect(decide(RULE, null, false, true, DAY)).toEqual({ a: true, m: false, ask: false });
		expect(decide({ ...RULE, who: 0 }, null, false, true, DAY).m).toBe(false);
	});
});
