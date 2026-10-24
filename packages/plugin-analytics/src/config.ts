// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { checkId, TOOL_NAMES, type ToolId } from "./ids.js";

/** Everything the plugin stores about its settings lives under this one key, so a page costs one read. */
export const CONFIG_KEY = "config";

export const TOOL_IDS: readonly ToolId[] = [
	"ga4",
	"gtm",
	"ads",
	"meta",
	"clarity",
	"hubspot",
	"cloudflare",
];

export type Audience = "europe" | "europe-india" | "everyone" | "none";
export type Position = "bar" | "left" | "right";
export type Side = "left" | "right";
export type Scheme = "auto" | "light" | "dark";
export type GtmLoading = "choice" | "immediate";

export interface AnalyticsConfig {
	/** One ID per tool. An empty string means the tool is off. */
	tools: Record<ToolId, string>;
	/** HubSpot accounts hosted in the EU load from a different address. */
	hubspotEu: boolean;
	/** Cloudflare Web Analytics sets no cookies, so it normally does not wait for consent. */
	cloudflareWait: boolean;
	/** Count phone and email link clicks and sent forms as enquiries. */
	enquiries: boolean;
	banner: {
		audience: Audience;
		/** A path on this site ("/privacy") or a full https link. Empty means no link. */
		policyUrl: string;
		title: string;
		message: string;
		position: Position;
		scheme: Scheme;
		/** Show the small "Cookies" button after a choice was made (it steps aside while a link to #cookie-settings is on screen). */
		settingsButton: boolean;
		/** Which bottom corner that button sits in. */
		settingsSide: Side;
		/** Banner background, text and button colour, each "#rrggbb" or "" for the default (or the theme's CSS variables). */
		colors: { background: string; text: string; accent: string };
		/** Use `darkColors` when the visitor's device is in dark mode. */
		darkOn: boolean;
		darkColors: { background: string; text: string; accent: string };
		/** Ask again after this many months. */
		months: 6 | 12;
	};
	/** Address prefixes that are never tracked, e.g. "/thank-you". */
	exclude: string[];
	gtmLoading: GtmLoading;
	/** The admin's choice to hide the help line at the foot of the page (shown by default). */
	hideHelpLine: boolean;
}

export const DEFAULT_TITLE = "Can we use cookies?";
/** An empty message means the default text, written from the kinds of tools in use (see `defaultMessage`). */
export const DEFAULT_MESSAGE = "";
/** The defaults before 0.2.0. A site that still has them gets the new ones. */
const OLD_TITLE = "Cookies on this site";
const OLD_MESSAGE =
	"We would like to use cookies to see how this site is used and to improve our marketing. You choose which ones we use, and you can change your mind at any time.";

/**
 * The default banner text. It names the purposes actually in use, because consent
 * is only informed when the visitor knows what each kind of cookie is for.
 */
export function defaultMessage(config: AnalyticsConfig): string {
	const analytics = vendorNames(config, "analytics").length > 0;
	const marketing = vendorNames(config, "marketing").length > 0;
	const uses = [
		analytics && "analytics cookies to see how this site is used",
		marketing && "marketing cookies to measure our ads",
	].filter(Boolean);
	const want = uses.length ? `We would like to use ${uses.join(", and ")}. ` : "";
	return `${want}Essential cookies are always on.`;
}

export const NO_COLORS = { background: "", text: "", accent: "" } as const;

export const DEFAULT_CONFIG: AnalyticsConfig = {
	tools: { ga4: "", gtm: "", ads: "", meta: "", clarity: "", hubspot: "", cloudflare: "" },
	hubspotEu: false,
	cloudflareWait: false,
	enquiries: true,
	banner: {
		audience: "europe",
		policyUrl: "",
		title: DEFAULT_TITLE,
		message: DEFAULT_MESSAGE,
		position: "bar",
		scheme: "auto",
		settingsButton: true,
		settingsSide: "left",
		colors: { ...NO_COLORS },
		darkOn: false,
		darkColors: { ...NO_COLORS },
		months: 6,
	},
	exclude: [],
	gtmLoading: "choice",
	hideHelpLine: false,
};

const MAX_EXCLUDES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function replaceOld(value: string, old: string, current: string): string {
	return value === old ? current : value;
}

/** "#rrggbb" in lower case, or "" for anything else ("#abc" is expanded). */
export function cleanColor(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value.trim().toLowerCase();
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
	if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
	return /^#[0-9a-f]{6}$/.test(text) ? text : "";
}

/** Relative luminance (WCAG 2.2). */
function luminance(hex: string): number {
	const channel = (index: number) => {
		const value = parseInt(hex.slice(index, index + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contrast ratio between two "#rrggbb" colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light! + 0.05) / (dark! + 0.05);
}

/** The banner's own colours: background and text set together, and readable (4.5:1), or not at all. */
export function cleanColors(value: unknown): AnalyticsConfig["banner"]["colors"] {
	const source = isRecord(value) ? value : {};
	let background = cleanColor(source.background);
	let text = cleanColor(source.text);
	if (!background || !text || contrast(background, text) < 4.5) background = text = "";
	return { background, text, accent: cleanColor(source.accent) };
}

/**
 * Problems with colours an owner typed, in plain words, or none. The rules keep the
 * banner fair and readable: one colour for both answer buttons (there is no setting to
 * style them apart), text at 4.5:1 or more against the banner.
 */
export function colorProblems(colors: Record<"background" | "text" | "accent", string>): string[] {
	const problems: string[] = [];
	for (const [key, label] of [
		["background", "Background"],
		["text", "Text"],
		["accent", "Buttons"],
	] as const) {
		if (colors[key] !== "" && cleanColor(colors[key]) === "")
			problems.push(
				`${label} colour: type it as # and six digits or letters, for example #1f6f43.`,
			);
	}
	if (problems.length) return problems;
	const background = cleanColor(colors.background);
	const text = cleanColor(colors.text);
	if ((background === "") !== (text === ""))
		problems.push("Background and text colours go together: set both, or neither.");
	else if (background && contrast(background, text) < 4.5) {
		problems.push(
			`The text is hard to read on that background (contrast ${contrast(background, text).toFixed(1)}:1, at least 4.5:1 is needed). Choose a darker text or a lighter background, or the other way round.`,
		);
	}
	return problems;
}

function isControl(code: number): boolean {
	return code < 32 || code === 127;
}

/** One line of visible text: no control characters, trimmed, capped. */
export function cleanText(value: unknown, max: number, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const text = Array.from(value, (ch) => (isControl(ch.charCodeAt(0)) ? " " : ch))
		.join("")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
	return text === "" ? fallback : text;
}

/**
 * A policy link the banner may show: a path on this site or an http(s) link.
 * Anything else (including `javascript:`) becomes "no link".
 */
export function cleanPolicyUrl(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value.trim();
	if (text === "" || text.length > 500 || /[\s"'<>\\]/.test(text)) return "";
	if (text.startsWith("/") && !text.startsWith("//")) return text;
	try {
		const url = new URL(text);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
	} catch {
		return "";
	}
}

/**
 * "Don't track these pages": one address prefix per line. Full links are
 * reduced to their path; lines that cannot be a path are dropped.
 */
export function parseExcludes(value: unknown): string[] {
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
		if (seen.size >= MAX_EXCLUDES) break;
	}
	return [...seen];
}

/** True when `path` is at or under one of the "don't track" prefixes. */
export function isExcluded(path: string, exclude: readonly string[]): boolean {
	return exclude.some((prefix) => {
		const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
		return path === base || path.startsWith(`${base}/`) || path.startsWith(prefix);
	});
}

/**
 * Turn whatever is in storage into a complete, safe config. Used on every
 * read, so a hand-edited or older value can never reach the page: IDs that do
 * not pass the strict check are dropped, unknown choices fall back to defaults.
 */
export function normalizeConfig(raw: unknown): AnalyticsConfig {
	const source = isRecord(raw) ? raw : {};
	const rawTools = isRecord(source.tools) ? source.tools : {};
	const rawBanner = isRecord(source.banner) ? source.banner : {};
	const defaults = DEFAULT_CONFIG;

	const tools = { ...defaults.tools };
	for (const tool of TOOL_IDS) {
		const checked = checkId(tool, rawTools[tool]);
		tools[tool] = checked.ok ? checked.value : "";
	}

	return {
		tools,
		hubspotEu: bool(source.hubspotEu, defaults.hubspotEu),
		cloudflareWait: bool(source.cloudflareWait, defaults.cloudflareWait),
		enquiries: bool(source.enquiries, defaults.enquiries),
		banner: {
			audience: oneOf(
				rawBanner.audience,
				["europe", "europe-india", "everyone", "none"],
				defaults.banner.audience,
			),
			policyUrl: cleanPolicyUrl(rawBanner.policyUrl),
			title: replaceOld(cleanText(rawBanner.title, 80, DEFAULT_TITLE), OLD_TITLE, DEFAULT_TITLE),
			message: replaceOld(
				cleanText(rawBanner.message, 400, DEFAULT_MESSAGE),
				OLD_MESSAGE,
				DEFAULT_MESSAGE,
			),
			position: oneOf(rawBanner.position, ["bar", "left", "right"], defaults.banner.position),
			scheme: oneOf(rawBanner.scheme, ["auto", "light", "dark"], defaults.banner.scheme),
			settingsButton: bool(rawBanner.settingsButton, defaults.banner.settingsButton),
			settingsSide: oneOf(rawBanner.settingsSide, ["left", "right"], defaults.banner.settingsSide),
			colors: cleanColors(rawBanner.colors),
			darkOn: bool(rawBanner.darkOn, defaults.banner.darkOn),
			darkColors: cleanColors(rawBanner.darkColors),
			months: rawBanner.months === 12 || rawBanner.months === "12" ? 12 : 6,
		},
		exclude: parseExcludes(source.exclude),
		gtmLoading: oneOf(source.gtmLoading, ["choice", "immediate"], defaults.gtmLoading),
		hideHelpLine: source.hideHelpLine === true,
	};
}

/** The consent category a tool waits for. `none` loads without asking. */
export type Category = "analytics" | "marketing" | "none";

/**
 * Which category each tool belongs to. Google Tag Manager is a container: what
 * it does depends on the tags inside, so it is listed under both.
 */
export function toolCategories(config: AnalyticsConfig, tool: ToolId): Category[] {
	switch (tool) {
		case "ga4":
		case "clarity":
			return ["analytics"];
		case "ads":
		case "meta":
		case "hubspot":
			return ["marketing"];
		case "gtm":
			return ["analytics", "marketing"];
		case "cloudflare":
			return config.cloudflareWait ? ["analytics"] : ["none"];
	}
}

export function enabledTools(config: AnalyticsConfig): ToolId[] {
	return TOOL_IDS.filter((tool) => config.tools[tool] !== "");
}

/** Names shown to visitors under one category in the banner's second layer. */
export function vendorNames(config: AnalyticsConfig, category: Category): string[] {
	return enabledTools(config)
		.filter((tool) => toolCategories(config, tool).includes(category))
		.map((tool) => TOOL_NAMES[tool]);
}

/** True when at least one tool waits for the visitor's answer. */
export function needsConsent(config: AnalyticsConfig): boolean {
	return enabledTools(config).some((tool) => !toolCategories(config, tool).includes("none"));
}

/**
 * A short code for the set of tools in use. It is stored with each visitor's
 * choice; when the set changes the code changes and visitors are asked again,
 * because they agreed to a different list.
 */
export function bannerVersion(config: AnalyticsConfig): string {
	return shortHash(
		enabledTools(config)
			.map((tool) => `${tool}:${toolCategories(config, tool).join("+")}`)
			.join(","),
	);
}

/** A short, stable code for a piece of text (djb2, base 36). Not for secrets. */
export function shortHash(text: string): string {
	let hash = 5381;
	for (let index = 0; index < text.length; index++) {
		hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
	}
	return hash.toString(36);
}
