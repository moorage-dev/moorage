// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
	cleanColourChoice,
	COLOUR_OPTIONS,
	COLOUR_SETS,
	colourSet,
	OWN_COLOURS,
	THEME_COLOURS,
} from "../src/colour-sets.js";
import { colorProblems, contrast } from "../src/config.js";
import { clientColors } from "../src/fragment.js";

describe("the shared colour sets", () => {
	it("are the same file in Analytics & Cookies and in Popups, so the banner and popups match", () => {
		const here = readFileSync(new URL("../src/colour-sets.ts", import.meta.url), "utf8");
		const there = readFileSync(
			new URL("../../plugin-popups/src/colour-sets.ts", import.meta.url),
			"utf8",
		);
		expect(there).toBe(here);
	});

	it("offer the theme's colours first, then each set, then the owner's own", () => {
		expect(COLOUR_OPTIONS[0]).toEqual({
			value: THEME_COLOURS,
			label: "Your theme's colours (recommended)",
		});
		expect(COLOUR_OPTIONS.at(-1)).toEqual({ value: OWN_COLOURS, label: "My own colours" });
		expect(COLOUR_OPTIONS.slice(1, -1).map((option) => option.value)).toEqual(
			COLOUR_SETS.map((set) => set.id),
		);
		const values = COLOUR_OPTIONS.map((option) => option.value);
		expect(new Set(values).size).toBe(values.length);
		expect(COLOUR_SETS.length).toBeGreaterThanOrEqual(4);
		expect(COLOUR_SETS.length).toBeLessThanOrEqual(5);
	});

	it("keep only a known choice", () => {
		expect(cleanColourChoice("cream-brown", THEME_COLOURS)).toBe("cream-brown");
		expect(cleanColourChoice(OWN_COLOURS, THEME_COLOURS)).toBe(OWN_COLOURS);
		expect(cleanColourChoice("purple", THEME_COLOURS)).toBe(THEME_COLOURS);
		expect(cleanColourChoice(undefined, OWN_COLOURS)).toBe(OWN_COLOURS);
		expect(colourSet("white-blue")?.label).toBe("Clean white with blue buttons");
		expect(colourSet(THEME_COLOURS)).toBeUndefined();
		expect(colourSet(OWN_COLOURS)).toBeUndefined();
	});

	for (const set of COLOUR_SETS) {
		for (const look of ["light", "dark"] as const) {
			it(`"${set.label}" reads well in ${look} mode`, () => {
				const colours = set[look];
				for (const value of Object.values(colours)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
				// The same rules the owner's own colours must pass.
				expect(colorProblems(colours)).toEqual([]);
				expect(contrast(colours.background, colours.text)).toBeGreaterThanOrEqual(4.5);
				// The button's words, as the banner picks them, on the button.
				const col = clientColors(colours, look === "dark")!;
				expect(col.y === "#ffffff" || col.y === "#141414").toBe(true);
				expect(contrast(colours.accent, col.y!)).toBeGreaterThanOrEqual(4.5);
				// Buttons stand out from the banner without needing an edge.
				expect(col.z).toBeUndefined();
			});
		}
	}
});
