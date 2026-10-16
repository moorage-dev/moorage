// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Times are stored in UTC (ISO) and always shown in the site's own time zone.

export const MINUTE = 60_000;
export const DAY = 86_400_000;

interface Parts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	weekday: string;
	monthName: string;
}

export function validTimeZone(zone: unknown): string {
	if (typeof zone !== "string" || zone === "") return "UTC";
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: zone });
		return zone;
	} catch {
		return "UTC";
	}
}

function parts(ms: number, zone: string): Parts {
	const format = new Intl.DateTimeFormat("en-GB", {
		timeZone: zone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	});
	const out: Record<string, string> = {};
	for (const part of format.formatToParts(new Date(ms))) out[part.type] = part.value;
	const monthName = new Intl.DateTimeFormat("en-GB", { timeZone: zone, month: "short" }).format(
		new Date(ms),
	);
	return {
		year: Number(out.year),
		month: Number(out.month),
		day: Number(out.day),
		hour: Number(out.hour) % 24,
		minute: Number(out.minute),
		weekday: out.weekday ?? "",
		monthName,
	};
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "11:04" */
export function clock(iso: string, zone: string): string {
	const p = parts(Date.parse(iso), zone);
	return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Thu 16 Oct, 11:04" */
export function moment(iso: string, zone: string): string {
	const p = parts(Date.parse(iso), zone);
	return `${p.weekday} ${p.day} ${p.monthName}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Thu 16 Oct" */
export function dayName(iso: string, zone: string): string {
	const p = parts(Date.parse(iso), zone);
	return `${p.weekday} ${p.day} ${p.monthName}`;
}

/** "today 14:32", "yesterday 09:10", or "Tue 14 Oct, 09:10". */
export function relative(iso: string, zone: string, now: number): string {
	const p = parts(Date.parse(iso), zone);
	const today = parts(now, zone);
	const yesterday = parts(now - DAY, zone);
	const same = (a: Parts, b: Parts) => a.year === b.year && a.month === b.month && a.day === b.day;
	if (same(p, today)) return `today ${pad(p.hour)}:${pad(p.minute)}`;
	if (same(p, yesterday)) return `yesterday ${pad(p.hour)}:${pad(p.minute)}`;
	return moment(iso, zone);
}

/** "3 h 30 min", "12 min", "2 days" */
export function since(fromIso: string, now: number): string {
	const minutes = Math.max(0, Math.round((now - Date.parse(fromIso)) / MINUTE));
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 48 * 60) {
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		return m === 0 ? `${h} h` : `${h} h ${m} min`;
	}
	return `${Math.floor(minutes / (24 * 60))} days`;
}

/** The site-local day ("2026-10-16") a moment falls on. */
export function localDay(iso: string, zone: string): string {
	const p = parts(Date.parse(iso), zone);
	return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The UTC instant for a wall-clock time in the site's zone, or null if the input is not a time. */
export function fromLocal(day: string, hour: number, minute: number, zone: string): string | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	const wanted = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute);
	let guess = wanted;
	// Two passes settle daylight-saving edges.
	for (let i = 0; i < 2; i++) {
		const p = parts(guess, zone);
		const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
		guess += wanted - shown;
	}
	return new Date(guess).toISOString();
}
