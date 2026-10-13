// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

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

export type Audience = "europe" | "everyone" | "none";
export type Position = "bar" | "left" | "right";
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
		/** Show the small "Cookie settings" button after a choice was made. */
		settingsButton: boolean;
		/** Ask again after this many months. */
		months: 6 | 12;
	};
	/** Address prefixes that are never tracked, e.g. "/thank-you". */
	exclude: string[];
	gtmLoading: GtmLoading;
}

export const DEFAULT_TITLE = "Cookies on this site";
export const DEFAULT_MESSAGE =
	"We would like to use cookies to see how this site is used and to improve our marketing. You choose which ones we use, and you can change your mind at any time.";

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
		months: 6,
	},
	exclude: [],
	gtmLoading: "choice",
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
			audience: oneOf(rawBanner.audience, ["europe", "everyone", "none"], defaults.banner.audience),
			policyUrl: cleanPolicyUrl(rawBanner.policyUrl),
			title: cleanText(rawBanner.title, 80, DEFAULT_TITLE),
			message: cleanText(rawBanner.message, 400, DEFAULT_MESSAGE),
			position: oneOf(rawBanner.position, ["bar", "left", "right"], defaults.banner.position),
			scheme: oneOf(rawBanner.scheme, ["auto", "light", "dark"], defaults.banner.scheme),
			settingsButton: bool(rawBanner.settingsButton, defaults.banner.settingsButton),
			months: rawBanner.months === 12 || rawBanner.months === "12" ? 12 : 6,
		},
		exclude: parseExcludes(source.exclude),
		gtmLoading: oneOf(source.gtmLoading, ["choice", "immediate"], defaults.gtmLoading),
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
