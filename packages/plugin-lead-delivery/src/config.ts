// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { generatedName } from "./names.js";
import type { Config, Delivery, DeliveryKind, KnownForm, Repeat } from "./types.js";

export const CONFIG_KEY = "config";
export const FORMS_KEY = "forms";
export const ALERTS_KEY = "alerts";
export const TICK_KEY = "tick";
export const PING_KEY = "ping";
export const ORIGIN_KEY = "origin";

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

const KINDS: DeliveryKind[] = ["email", "hubspot", "app"];
const REPEATS: Repeat[] = ["off", "24h", "7d"];

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function siteParts(value: Record<string, unknown>) {
	return {
		alertTo: strings(value.alertTo),
		key: typeof value.key === "string" && value.key.length >= 32 ? value.key : "",
		...(typeof value.keySetAt === "string" ? { keySetAt: value.keySetAt } : {}),
		...(isRecord(value.reach) ? { reach: value.reach as Config["reach"] } : {}),
	};
}

/** The settings a 0.1 place and a delivery share, copied as they are. */
function copied(value: Record<string, unknown>): Partial<Delivery> {
	const out: Record<string, unknown> = {};
	for (const key of [
		"to",
		"portalId",
		"formGuid",
		"mapping",
		"otherNames",
		"gdpr",
		"throwawayField",
		"app",
		"url",
		"secret",
		"testedAt",
		"testResult",
		"oldName",
	]) {
		if (value[key] !== undefined) out[key] = value[key];
	}
	return out as Partial<Delivery>;
}

function deliveryOf(value: unknown): Delivery | null {
	if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
	if (!KINDS.includes(value.kind as DeliveryKind)) return null;
	const forms = value.forms === "all" ? "all" : strings(value.forms);
	return {
		id: value.id,
		kind: value.kind as DeliveryKind,
		name: typeof value.name === "string" ? value.name : "",
		forms,
		on: value.on !== false,
		repeat: REPEATS.includes(value.repeat as Repeat) ? (value.repeat as Repeat) : "off",
		holdSpam: value.holdSpam === true,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
		...copied(value),
	};
}

/** A saved config of this version, cleaned of anything unexpected. */
export function normalizeConfig(raw: unknown): Config {
	const value = isRecord(raw) ? raw : {};
	if (value.version !== 2) return migrate(raw, {});
	return {
		version: 2,
		deliveries: (Array.isArray(value.deliveries) ? value.deliveries : [])
			.map(deliveryOf)
			.filter((d): d is Delivery => d !== null),
		...siteParts(value),
		...(value.notice === true ? { notice: true } : {}),
	};
}

/**
 * A 0.1 config ("places") as deliveries. Each place becomes one delivery with the same id, so
 * log rows, retries and HubSpot matching stay attached; it is named after its forms and where
 * it sends, and its old name is kept. Pure and deterministic, so two runs at once write the
 * same thing; it never throws, so an arriving enquiry is never lost to a damaged setup.
 */
export function migrate(raw: unknown, forms: Record<string, KnownForm>): Config {
	const value = isRecord(raw) ? raw : {};
	if (value.version === 2) return normalizeConfig(value);
	const deliveries: Delivery[] = [];
	for (const place of Array.isArray(value.places) ? value.places : []) {
		const base = deliveryOf({ ...(isRecord(place) ? place : {}), repeat: undefined });
		if (!base || !isRecord(place)) continue;
		const { name: oldName, ...rest } = base;
		deliveries.push({
			...rest,
			name: generatedName(base.forms, base, forms),
			...(oldName ? { oldName } : {}),
			repeat: place.noDuplicates === true ? "24h" : "off",
			holdSpam: false,
		});
	}
	return {
		version: 2,
		deliveries,
		...siteParts(value),
		...(deliveries.length > 0 ? { notice: true } : {}),
	};
}

/** The config, moved to deliveries on first read after the update, with a private key made on first use. */
export async function loadConfig(ctx: PluginContext): Promise<Config> {
	const raw = await ctx.kv.get(CONFIG_KEY);
	let config: Config;
	let changed = false;
	if (isRecord(raw) && raw.version === 2) {
		config = normalizeConfig(raw);
	} else {
		let forms: Record<string, KnownForm> = {};
		try {
			forms = await loadForms(ctx);
		} catch {
			// Names fall back to short names.
		}
		config = migrate(raw, forms);
		changed = raw !== null && raw !== undefined;
	}
	if (!config.key) {
		config.key = newKey();
		changed = true;
	}
	if (changed) await ctx.kv.set(CONFIG_KEY, config);
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

/** The site's name; when it has none, its address (crumbandco.uk), so a subject still says which site. */
export function siteName(ctx: PluginContext, requestUrl?: string): string {
	const name = ctx.site.name?.trim();
	if (name) return name;
	const origin = siteOrigin(ctx, requestUrl);
	return origin ? new URL(origin).host : "Your website";
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

/** Remember the site's address from a request, for runs that have none (scheduled tasks). */
export async function rememberOrigin(ctx: PluginContext, requestUrl: string) {
	const origin = siteOrigin(ctx, requestUrl);
	if (origin && (await ctx.kv.get<string>(ORIGIN_KEY)) !== origin)
		await ctx.kv.set(ORIGIN_KEY, origin);
}

/** `siteName` for code that runs without a request. */
export async function siteLabel(ctx: PluginContext): Promise<string> {
	return siteName(ctx, (await ctx.kv.get<string>(ORIGIN_KEY)) ?? undefined);
}
