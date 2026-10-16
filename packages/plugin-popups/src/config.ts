// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * What is stored: every popup and the site-wide settings, in one document, so
 * the page hook reads once. Everything here is pure and tested on its own.
 */

export const STORE_KEY = "popups";
export const PROBLEMS_KEY = "problems";
export const MAX_POPUPS = 20;
export const MAX_HEADING = 60;
export const MAX_TEXT = 240;
const MAX_PATHS = 30;
const MAX_EMAILS = 10;

export type Kind = "bar" | "slide" | "modal" | "inline";
export type Trigger = "read" | "click" | "exit" | "load";
export type Where = "all" | "prefix" | "collections";
export type Devices = "all" | "desktop" | "phone";
export type Again = "week" | "month" | "never";
export type Decline = "no-thanks" | "not-now" | "none";
export type Contains = "button" | "form";

export interface Picture {
	id: string;
	url: string;
	alt: string;
	width: number | null;
	height: number | null;
}

export interface Popup {
	id: string;
	/** Simplified name: in `#popup-<handle>` links and campaign tags. Unique on the site. */
	handle: string;
	name: string;
	kind: Kind;
	heading: string;
	text: string;
	picture: Picture | null;
	contains: Contains;
	buttonLabel: string;
	buttonUrl: string;
	/** The form's short name (or id) under Forms. */
	form: string;
	thanks: string;
	decline: Decline;
	trigger: Trigger;
	where: Where;
	prefixes: string[];
	collections: string[];
	exclude: string[];
	devices: Devices;
	again: Again;
	/** A centred popup may open on the first page of a visit, on computers only. */
	firstPage: boolean;
	/** Exact moments, in milliseconds since 1970; null for "now" and "no end". */
	start: number | null;
	end: number | null;
	on: boolean;
	/** The furthest step of "New popup" that was saved: 1 to 4. 4 means finished. */
	step: number;
	/** Set by the save-time form check: the form was paused or could not be checked. */
	formNote: "" | "paused" | "unchecked";
	createdAt: string;
}

export interface Colors {
	background: string;
	text: string;
	accent: string;
}

export interface Settings {
	scheme: "auto" | "light" | "dark";
	custom: boolean;
	colors: Colors;
	corner: "right" | "left";
	emails: string[];
}

export interface Store {
	popups: Popup[];
	settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
	scheme: "auto",
	custom: false,
	colors: { background: "", text: "", accent: "" },
	corner: "right",
	emails: [],
};

export const KIND_LABEL: Record<Kind, string> = {
	bar: "Top bar",
	slide: "Slide-in",
	modal: "Popup",
	inline: "Box in a page",
};

export const DECLINE_LABEL: Record<Decline, string> = {
	"no-thanks": "No thanks",
	"not-now": "Not now",
	none: "Only the close button",
};

export const AGAIN_DAYS: Record<Again, number> = { week: 7, month: 30, never: 0 };

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.includes(value as T) ? (value as T) : fallback;

const str = (value: unknown, max: number): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

const time = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;

/** "Monthly letter!" -> "monthly-letter". */
export function simplify(name: string): string {
	const out = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return out || "popup";
}

/** A handle no other popup has: "offer", then "offer-2", "offer-3". */
export function uniqueHandle(name: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	const base = simplify(name);
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

function cleanPicture(value: unknown): Picture | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	const id = str(raw.id, 100);
	const url = str(raw.url, 1000);
	if (!id || !isSafeLink(url, false)) return null;
	const size = (n: unknown) => (typeof n === "number" && n > 0 ? Math.round(n) : null);
	return { id, url, alt: str(raw.alt, 300), width: size(raw.width), height: size(raw.height) };
}

export function normalizePopup(raw: unknown): Popup | null {
	if (typeof raw !== "object" || raw === null) return null;
	const p = raw as Record<string, unknown>;
	const id = str(p.id, 40);
	if (!/^[a-z0-9]{4,40}$/.test(id)) return null;
	const kind = pick(p.kind, ["bar", "slide", "modal", "inline"] as const, "modal");
	const trigger = pick(p.trigger, ["read", "click", "exit", "load"] as const, "read");
	return {
		id,
		handle: simplify(str(p.handle, 40) || str(p.name, 80)),
		name: str(p.name, 80) || "Untitled",
		kind,
		heading: str(p.heading, MAX_HEADING),
		text: str(p.text, MAX_TEXT),
		picture: cleanPicture(p.picture),
		contains: pick(p.contains, ["button", "form"] as const, "button"),
		buttonLabel: str(p.buttonLabel, 40),
		buttonUrl: str(p.buttonUrl, 1000),
		form: str(p.form, 100),
		thanks: str(p.thanks, MAX_HEADING),
		decline: pick(p.decline, ["no-thanks", "not-now", "none"] as const, "no-thanks"),
		// Only a top bar may open as the page opens.
		trigger: trigger === "load" && kind !== "bar" ? "read" : trigger,
		where: pick(p.where, ["all", "prefix", "collections"] as const, "all"),
		prefixes: parsePaths(p.prefixes),
		collections: Array.isArray(p.collections)
			? p.collections.filter((c): c is string => typeof c === "string").slice(0, 50)
			: [],
		exclude: parsePaths(p.exclude),
		devices: pick(p.devices, ["all", "desktop", "phone"] as const, "all"),
		again: pick(p.again, ["week", "month", "never"] as const, "month"),
		firstPage: kind === "modal" && p.firstPage === true,
		start: time(p.start),
		end: time(p.end),
		on: p.on === true,
		step: typeof p.step === "number" ? Math.min(4, Math.max(1, Math.round(p.step))) : 1,
		formNote: pick(p.formNote, ["", "paused", "unchecked"] as const, ""),
		createdAt: str(p.createdAt, 40) || new Date(0).toISOString(),
	};
}

export function cleanColor(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value.trim().toLowerCase();
	const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
	if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
	const long = /^#?([0-9a-f]{6})$/.exec(text);
	return long ? `#${long[1]}` : "";
}

export function normalizeSettings(raw: unknown): Settings {
	const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const colors = (typeof s.colors === "object" && s.colors !== null ? s.colors : {}) as Record<
		string,
		unknown
	>;
	return {
		scheme: pick(s.scheme, ["auto", "light", "dark"] as const, "auto"),
		custom: s.custom === true,
		colors: {
			background: cleanColor(colors.background),
			text: cleanColor(colors.text),
			accent: cleanColor(colors.accent),
		},
		corner: pick(s.corner, ["right", "left"] as const, "right"),
		emails: Array.isArray(s.emails)
			? s.emails.filter((e): e is string => typeof e === "string" && isEmail(e)).slice(0, MAX_EMAILS)
			: [],
	};
}

export function normalizeStore(raw: unknown): Store {
	const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const popups: Popup[] = [];
	const handles = new Set<string>();
	for (const item of Array.isArray(s.popups) ? s.popups : []) {
		const popup = normalizePopup(item);
		if (!popup || popups.some((p) => p.id === popup.id)) continue;
		popup.handle = uniqueHandle(popup.handle, handles);
		handles.add(popup.handle);
		popups.push(popup);
		if (popups.length >= MAX_POPUPS) break;
	}
	return { popups, settings: normalizeSettings(s.settings) };
}

// ── Checks ──────────────────────────────────────────────────

function luminance(hex: string): number {
	const channel = (index: number) => {
		const value = parseInt(hex.slice(index, index + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light! + 0.05) / (dark! + 0.05);
}

/** The text colour for a button: white or near-black, whichever reads better. */
export function buttonText(accent: string): string {
	return contrast(accent, "#ffffff") >= contrast(accent, "#141414") ? "#ffffff" : "#141414";
}

/** Plain reasons the owner's colours are refused, or none. */
export function colorProblems(colors: Colors): string[] {
	const problems: string[] = [];
	const { background, text, accent } = colors;
	if (!background || !text || !accent) {
		problems.push("Choose all three colours, written like #fbf8f3.");
		return problems;
	}
	if (contrast(background, text) < 4.5) {
		problems.push(
			`The text is hard to read on the background (contrast ${contrast(background, text).toFixed(1)} to 1; it needs at least 4.5). Make one of them lighter or darker.`,
		);
	}
	const label = buttonText(accent);
	if (contrast(accent, label) < 4.5) {
		problems.push(
			"No text colour is easy to read on that button colour. Choose a darker or lighter button.",
		);
	}
	return problems;
}

/** Links a popup may send visitors to: https, http, a page on this site, email or phone. */
export function isSafeLink(value: string, allowContact = true): boolean {
	if (allowContact && /^(mailto:[^@\s"'<>]+@[^@\s"'<>]+|tel:\+?[0-9 ()-]{3,30})$/i.test(value)) return true;
	if (!value || value.length > 1000 || /[\s"'<>\\]/.test(value)) return false;
	if (value.startsWith("/") && !value.startsWith("//")) return true;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

export function isEmail(value: string): boolean {
	return value.length <= 200 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value.trim());
}

/** One address per line (or comma); pasted links become their path; "/" alone is dropped. */
export function parsePaths(value: unknown): string[] {
	const lines = Array.isArray(value)
		? value.filter((line): line is string => typeof line === "string")
		: typeof value === "string"
			? value.split(/[\r\n,]+/)
			: [];
	const seen = new Set<string>();
	for (const line of lines) {
		let text = line.trim();
		if (text === "") continue;
		if (/^https?:\/\//i.test(text)) {
			try {
				text = new URL(text).pathname;
			} catch {
				continue;
			}
		}
		if (!text.startsWith("/")) text = `/${text}`;
		text = text.replace(/[?#].*$/, "").replace(/\*+$/, "");
		if (text === "/" || text.length > 200 || /[\s"'<>\\]/.test(text)) continue;
		seen.add(text);
		if (seen.size >= MAX_PATHS) break;
	}
	return [...seen];
}

export function parseEmails(value: unknown): { emails: string[]; wrong: string[] } {
	const lines = typeof value === "string" ? value.split(/[\r\n,;]+/) : [];
	const emails: string[] = [];
	const wrong: string[] = [];
	for (const line of lines) {
		const text = line.trim();
		if (!text) continue;
		if (isEmail(text)) {
			if (!emails.includes(text.toLowerCase())) emails.push(text.toLowerCase());
		} else wrong.push(text);
	}
	return { emails: emails.slice(0, MAX_EMAILS), wrong };
}

/** "/cakes/" covers every page under it; "/contact" covers itself and pages under it. */
export function pathMatches(path: string, prefix: string): boolean {
	const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	return path === base || path === prefix || path.startsWith(`${base}/`);
}

// ── What is live ────────────────────────────────────────────

export interface PageInfo {
	path: string;
	collection?: string;
}

/** True when the popup is turned on, finished, and inside its dates at `now`. */
export function isLive(popup: Popup, now: number): boolean {
	if (!popup.on || popup.step < 4) return false;
	if (popup.end !== null && now >= popup.end) return false;
	// A popup that starts later still goes into cached pages; the browser waits for its start.
	return true;
}

export function showsOn(popup: Popup, page: PageInfo): boolean {
	if (popup.exclude.some((prefix) => pathMatches(page.path, prefix))) return false;
	if (popup.where === "prefix") return popup.prefixes.some((p) => pathMatches(page.path, p));
	if (popup.where === "collections") {
		return !!page.collection && popup.collections.includes(page.collection);
	}
	return true;
}

/** Simple id for a new popup. */
export function newId(): string {
	return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 14);
}

/** The FNV-like short hash used to give Block Kit forms fresh ids after a save. */
export function shortHash(text: string): string {
	let hash = 5381;
	for (let index = 0; index < text.length; index++) {
		hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
	}
	return hash.toString(36);
}
