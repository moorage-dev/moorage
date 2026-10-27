// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Ready-made colour sets, shared by Analytics & Cookies and Popups so the
 * cookie banner and the popups can match. The same file is in each plugin that
 * uses it; keep the copies identical (a test in each package compares them).
 *
 * Each set has a light and a dark version: the dark one is used when the
 * visitor's device is in dark mode (or the plugin is set to always dark).
 * Every pair reads at 4.5:1 or more, text on background and button words on
 * the button (white or near-black, whichever reads better); tests check it.
 */

export interface SetColours {
	background: string;
	text: string;
	/** The button colour. */
	accent: string;
}

export interface ColourSet {
	id: string;
	label: string;
	light: SetColours;
	dark: SetColours;
}

/** The theme's own colours (its CSS variables), else calm neutral ones. The default. */
export const THEME_COLOURS = "theme";
/** The colours the owner types in. */
export const OWN_COLOURS = "own";

export const COLOUR_SETS: readonly ColourSet[] = [
	{
		id: "cream-brown",
		label: "Warm cream with brown buttons",
		light: { background: "#fbf7f0", text: "#2b2420", accent: "#8a3b12" },
		dark: { background: "#2a2420", text: "#f5ede3", accent: "#e0a872" },
	},
	{
		id: "white-blue",
		label: "Clean white with blue buttons",
		light: { background: "#ffffff", text: "#1a1a1a", accent: "#1d4ed8" },
		dark: { background: "#111827", text: "#f3f4f6", accent: "#93c5fd" },
	},
	{
		id: "grey-green",
		label: "Soft grey with green buttons",
		light: { background: "#f2f3f2", text: "#1f2a24", accent: "#1f6f43" },
		dark: { background: "#1c211e", text: "#eef2ef", accent: "#7cc49a" },
	},
	{
		id: "pink-plum",
		label: "Pale pink with plum buttons",
		light: { background: "#fdf4f5", text: "#3a2230", accent: "#7a2e58" },
		dark: { background: "#2a1c24", text: "#f8eef2", accent: "#e3a6c6" },
	},
	{
		id: "dark-gold",
		label: "Dark with gold buttons (dark on every device)",
		light: { background: "#1a1a1a", text: "#f4f1ea", accent: "#d4a537" },
		dark: { background: "#1a1a1a", text: "#f4f1ea", accent: "#d4a537" },
	},
];

/** The options of the "Colours" choice, in the order shown. */
export const COLOUR_OPTIONS: readonly { value: string; label: string }[] = [
	{ value: THEME_COLOURS, label: "Your theme's colours (recommended)" },
	...COLOUR_SETS.map((set) => ({ value: set.id, label: set.label })),
	{ value: OWN_COLOURS, label: "My own colours" },
];

/** The stored choice if it is one of the options, else `fallback`. */
export function cleanColourChoice(value: unknown, fallback: string): string {
	return COLOUR_OPTIONS.some((option) => option.value === value) ? (value as string) : fallback;
}

/** The set with this id, or undefined for the theme's colours, the owner's own, or anything else. */
export function colourSet(id: string): ColourSet | undefined {
	return COLOUR_SETS.find((set) => set.id === id);
}
