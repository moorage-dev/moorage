// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import type { OpeningHours } from "./config.js";

export const DAYS = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;

// "9", "9:00", "09.30" then a dash, then the same again.
const RANGE = /^(\d{1,2})(?:[:.](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[:.](\d{2}))?$/;
const MAX_RANGES = 2;

function clock(hour: string, minute: string | undefined): string | null {
	const h = Number(hour);
	const m = Number(minute ?? "0");
	if (h > 24 || m > 59 || (h === 24 && m !== 0)) return null;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Parse one day's hours as an owner types them: "9:00-17:00", or two ranges
 * for a split shift, "12:00-14:30, 18:00-22:00". Empty means closed. Returns
 * null when the text cannot be read, so the form can say which day to fix.
 */
export function parseDayHours(day: string, value: string): OpeningHours[] | null {
	const input = value.trim();
	if (input === "" || input.toLowerCase() === "closed") return [];

	const parts = input.split(/\s*[,;]\s*|\s+and\s+/i).filter((part) => part !== "");
	if (parts.length > MAX_RANGES) return null;

	const ranges: OpeningHours[] = [];
	for (const part of parts) {
		const match = RANGE.exec(part);
		if (!match) return null;
		const opens = clock(match[1] ?? "", match[2]);
		const closes = clock(match[3] ?? "", match[4]);
		if (!opens || !closes) return null;
		ranges.push({ days: [day], opens, closes });
	}
	return ranges;
}

/** The text an owner typed for a day, rebuilt from stored hours. */
export function formatDayHours(day: string, hours: OpeningHours[]): string {
	return hours
		.filter((range) => range.days.includes(day))
		.map((range) => `${range.opens}-${range.closes}`)
		.join(", ");
}
