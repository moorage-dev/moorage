// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import type { Config, KnownForm, Place } from "./types.js";

export const CONFIG_KEY = "config";
export const FORMS_KEY = "forms";
export const ALERTS_KEY = "alerts";
export const TICK_KEY = "tick";
export const PING_KEY = "ping";

/** Plugin id as EmDash mounts it: `/_emdash/api/plugins/<id>/<route>`. */
export const PLUGIN_ID = "lead-delivery";
/** The email way's private addresses all end with this; nothing is ever sent there. */
export const PRIVATE_DOMAIN = "lead-delivery.invalid";

const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function randomString(length: number, chars = KEY_CHARS): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const byte of bytes) out += chars[byte % chars.length];
	return out;
}

export function newKey(): string {
	return randomString(32);
}

export function newId(): string {
	return randomString(10, "abcdefghijkmnopqrstuvwxyz23456789");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeConfig(raw: unknown): Config {
	const value = isRecord(raw) ? raw : {};
	return {
		places: Array.isArray(value.places) ? (value.places as Place[]) : [],
		alertTo: Array.isArray(value.alertTo)
			? value.alertTo.filter((a): a is string => typeof a === "string")
			: [],
		key: typeof value.key === "string" && value.key.length >= 32 ? value.key : "",
		...(isRecord(value.reach) ? { reach: value.reach as Config["reach"] } : {}),
		...(typeof value.testedAt === "string" ? { testedAt: value.testedAt } : {}),
	};
}

/** The config, with a private key made on first use. */
export async function loadConfig(ctx: PluginContext): Promise<Config> {
	const config = normalizeConfig(await ctx.kv.get(CONFIG_KEY));
	if (!config.key) {
		config.key = newKey();
		await ctx.kv.set(CONFIG_KEY, config);
	}
	return config;
}

export async function saveConfig(ctx: PluginContext, config: Config): Promise<void> {
	await ctx.kv.set(CONFIG_KEY, config);
}

export async function loadForms(ctx: PluginContext): Promise<Record<string, KnownForm>> {
	const raw = await ctx.kv.get<Record<string, KnownForm>>(FORMS_KEY);
	return isRecord(raw) ? raw : {};
}

export async function saveForms(ctx: PluginContext, forms: Record<string, KnownForm>) {
	await ctx.kv.set(FORMS_KEY, forms);
}

/** The private email address the email way uses. */
export function privateEmail(key: string): string {
	return `enquiries-${key}@${PRIVATE_DOMAIN}`;
}

/** The site's own origin: the site address, or the admin request's origin when it is empty. */
export function siteOrigin(ctx: PluginContext, requestUrl?: string): string {
	for (const candidate of [ctx.site.url, requestUrl]) {
		if (!candidate) continue;
		try {
			const url = new URL(candidate);
			if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
		} catch {
			// not an address
		}
	}
	return "";
}

export function routeUrl(origin: string, route: string): string {
	return `${origin}/_emdash/api/plugins/${PLUGIN_ID}/${route}`;
}

export function inboundUrl(origin: string, key: string): string {
	return `${routeUrl(origin, "inbound")}?key=${key}`;
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/;

export function isEmail(value: string): boolean {
	return EMAIL_RE.test(value);
}

/** "a@x.com, b@y.com" → addresses, or the first one that is not an address. */
export function parseAddresses(text: string): { list: string[] } | { bad: string } {
	const list = text
		.split(/[,;\s]+/)
		.map((part) => part.trim())
		.filter(Boolean);
	const bad = list.find((address) => !isEmail(address));
	if (bad) return { bad };
	return { list: [...new Set(list.map((a) => a.toLowerCase()))] };
}

export function siteName(ctx: PluginContext): string {
	return ctx.site.name?.trim() || "Your website";
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "just now", "12 min ago", "2 hours ago", "yesterday", "3 days ago". */
export function ago(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "";
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (!Number.isFinite(minutes)) return "";
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

/** "in 24 min", "in 2 hours". */
export function inTime(iso: string, now = Date.now()): string {
	const minutes = Math.max(1, Math.round((Date.parse(iso) - now) / 60_000));
	if (minutes < 60) return `in ${minutes} min`;
	const hours = Math.round(minutes / 60);
	return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "since Monday" within a week, otherwise "since 3 October". */
export function since(iso: string, now = Date.now()): string {
	const date = new Date(iso);
	if (now - date.getTime() < 6 * 86_400_000) return `since ${WEEKDAYS[date.getUTCDay()]}`;
	return `since ${date.getUTCDate()} ${date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })}`;
}

export function day(iso: string): string {
	return iso.slice(0, 10);
}
