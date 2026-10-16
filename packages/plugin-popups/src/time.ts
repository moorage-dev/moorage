// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Dates and times in the site's time zone. The owner picks a day and a
 * half-hour; it is stored as an exact moment so the browser only compares
 * numbers, whatever the visitor's own time zone.
 */

export function validZone(zone: unknown): string {
	if (typeof zone !== "string" || zone === "") return "UTC";
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return zone;
	} catch {
		return "UTC";
	}
}

interface Parts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

function partsIn(ms: number, zone: string): Parts {
	const format = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	const out: Record<string, number> = {};
	for (const part of format.formatToParts(new Date(ms))) {
		if (part.type !== "literal") out[part.type] = Number(part.value);
	}
	return {
		year: out.year!,
		month: out.month!,
		day: out.day!,
		hour: out.hour! % 24,
		minute: out.minute!,
	};
}

/** How far the zone is ahead of UTC at that moment, in milliseconds. */
function offset(ms: number, zone: string): number {
	const p = partsIn(ms, zone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/**
 * "2026-11-01" and "09:00" in Europe/London -> the exact moment. On the night
 * the clocks go forward a time that does not exist is moved on by the gap; on
 * the night they go back the first of the two moments is used.
 */
export function toMoment(date: string, clock: string, zone: string): number | null {
	const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
	const t = /^(\d{1,2}):(\d{2})$/.exec(clock.trim() || "00:00");
	if (!d || !t) return null;
	const [year, month, day, hour, minute] = [+d[1]!, +d[2]!, +d[3]!, +t[1]!, +t[2]!];
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	const check = new Date(wall);
	if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return null;
	// The zone's offset half a day either side covers both sides of any change of the clocks.
	const candidates = [wall - offset(wall - 43_200_000, zone), wall - offset(wall + 43_200_000, zone)];
	const wanted = `${date.trim()} ${pad(hour)}:${pad(minute)}`;
	const real = candidates.filter((ms) => {
		const found = fromMoment(ms, zone);
		return `${found.date} ${found.clock}` === wanted;
	});
	// Twice on the night the clocks go back: the first. Never on the night they go forward: moved on.
	return real.length ? Math.min(...real) : Math.max(...candidates);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The day ("2026-11-01") and half-hour ("09:00") of a moment in the zone. */
export function fromMoment(ms: number, zone: string): { date: string; clock: string } {
	const p = partsIn(ms, zone);
	return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, clock: `${pad(p.hour)}:${pad(p.minute)}` };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Nov, 09:00" (or "1 Nov 2027, 09:00" when not this year; no time at midnight). */
export function describeMoment(ms: number, zone: string, now: number): string {
	const p = partsIn(ms, zone);
	const thisYear = partsIn(now, zone).year;
	const day = `${p.day} ${MONTHS[p.month - 1]}${p.year === thisYear ? "" : ` ${p.year}`}`;
	return p.hour === 0 && p.minute === 0 ? day : `${day}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Every half hour of the day, for the time list. */
export const HALF_HOURS: string[] = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);

/** The UTC day "2026-11-01" of a moment, used for count rows. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}
