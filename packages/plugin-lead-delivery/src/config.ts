// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { generatedName } from "./names.js";
import { pickSettings, type SettingsKeys, writeSettings } from "./settings-store.js";
import type { Config, Delivery, DeliveryKind, KnownForm, Repeat } from "./types.js";

export const CONFIG_KEY = "config";
export const FORMS_KEY = "forms";
/**
 * The setup and the known forms live in `ctx.settings`, the one place EmDash keeps for a plugin
 * both in-process and sandboxed (see settings-store.ts). 0.3.0 and earlier kept them under the
 * plain KV keys `config` and `forms`; those are read when the settings are empty and written on
 * every save an admin makes, kept for rollback until a later release (an arriving enquiry
 * updates the known forms in the settings only). Everything else this plugin keeps in KV
 * (approval codes, the site's origin, stats, alert days, the scheduler's tick and schedule, the
 * daily mark, the ping code, the unreadable-email note) is rebuilt or short-lived, so it stays
 * there.
 */
export const CONFIG_SETTINGS: SettingsKeys = { name: "config", legacy: CONFIG_KEY };
export const FORMS_SETTINGS: SettingsKeys = { name: "forms", legacy: FORMS_KEY };
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
		// The 0.1 setup, passed through untouched so 0.1.2 can still read it after a rollback.
		// Kept for rollback to 0.1.x until a later release.
		...(Array.isArray(value.places) ? { places: value.places as unknown[] } : {}),
		...(typeof value.testedAt === "string" ? { testedAt: value.testedAt } : {}),
		...(isRecord(value.accessLeft) &&
		typeof value.accessLeft.at === "string" &&
		typeof value.accessLeft.form === "string"
			? { accessLeft: { at: value.accessLeft.at, form: value.accessLeft.form } }
			: {}),
		...(value.hideHelpLine === true ? { hideHelpLine: true as const } : {}),
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

/** The every-minute task's schedule, as `ensureSchedule` records it. */
export const SCHEDULE_KEY = "schedule";
export const STATS_KEY = "stats";
export const DAILY_KEY = "daily";

export type Stats = Record<string, { r: number; d: number }>;

/**
 * Everything this plugin keeps in KV and settings, read with one `ctx.kv.list()`: on Cloudflare a
 * sandboxed plugin may make only 10 calls to the site per run (see meter.ts), so no path reads a
 * key on its own. The list holds the settings (`settings:config`, `settings:forms`), the plain
 * keys earlier releases used, and the short-lived keys (schedule, tick, origin, stats, alerts,
 * daily mark, unreadable note, approval codes).
 */
export interface State {
	entries: Map<string, unknown>;
	/** The setup. Its `key` is "" when none was ever made: only the admin page and activation make one. */
	config: Config;
	/** The setup changed on reading (moved from 0.1, or its key found under the plain key): save it. */
	dirty: boolean;
	forms: Record<string, KnownForm>;
}

export async function loadState(
	ctx: PluginContext,
	{ copy = false }: { copy?: boolean } = {},
): Promise<State> {
	const entries = new Map((await ctx.kv.list()).map((entry) => [entry.key, entry.value]));
	const rawForms = await pickSettings(ctx, entries, FORMS_SETTINGS, { copy });
	const forms = isRecord(rawForms) ? (rawForms as Record<string, KnownForm>) : {};
	const raw = await pickSettings(ctx, entries, CONFIG_SETTINGS, { copy });
	let config: Config;
	let dirty = false;
	if (isRecord(raw) && raw.version === 2) {
		config = normalizeConfig(raw);
	} else {
		config = migrate(raw, forms);
		dirty = raw !== null && raw !== undefined;
	}
	if (!config.key) {
		// The settings had no usable key: the plain key may still have one. A key made while an old
		// one is waiting would change every form's address and the private email address.
		const plain = entries.get(CONFIG_KEY);
		const kept = isRecord(plain) ? siteParts(plain) : null;
		if (kept?.key) {
			config.key = kept.key;
			if (kept.keySetAt) config.keySetAt = kept.keySetAt;
			dirty = true;
		}
	}
	return { entries, config, dirty, forms };
}

/** A value from the state's KV entries. */
export function kvOf<T>(state: State, key: string): T | undefined {
	const value = state.entries.get(key);
	return value === null || value === undefined ? undefined : (value as T);
}

/**
 * The setup with a private key, saved when reading changed it or a key had to be made. For the
 * admin page and activation only: the hot paths (an arriving enquiry, the scheduled runs) never
 * write the setup and never make a key (without one, nothing can arrive anyway).
 */
export async function ensureConfig(ctx: PluginContext, state: State): Promise<boolean> {
	let changed = state.dirty;
	if (!state.config.key) {
		state.config.key = newKey();
		changed = true;
	}
	if (changed) await saveConfig(ctx, state.config);
	state.dirty = false;
	return changed;
}

/** The setup, with a private key made on first use (see ensureConfig). */
export async function loadConfig(ctx: PluginContext): Promise<Config> {
	const state = await loadState(ctx, { copy: true });
	await ensureConfig(ctx, state);
	return state.config;
}

export interface SaveOptions {
	/**
	 * Also write the plain key 0.3.0 reads (kept for rollback): one more call. Admin saves do,
	 * unless the run has no call to spare for it.
	 */
	mirror?: boolean;
}

/** An admin's save of the setup. One call, two with the copy for 0.3.0. */
export async function saveConfig(
	ctx: PluginContext,
	config: Config,
	{ mirror = true }: SaveOptions = {},
): Promise<void> {
	if (mirror) await writeSettings(ctx, CONFIG_SETTINGS, config);
	else await ctx.settings.set(CONFIG_SETTINGS.name, config);
}

/** An admin's save of the known forms. One call, two with the copy for 0.3.0. */
export async function saveForms(
	ctx: PluginContext,
	forms: Record<string, KnownForm>,
	{ mirror = true }: SaveOptions = {},
) {
	if (mirror) await writeSettings(ctx, FORMS_SETTINGS, forms);
	else await ctx.settings.set(FORMS_SETTINGS.name, forms);
}

/**
 * The known forms, saved from a hot path (an arriving enquiry, the daily check): the settings
 * only, one call. 0.3.1 reads the settings first; 0.3.0 keeps the forms as an admin last saved them.
 */
export async function saveFormsQuietly(ctx: PluginContext, forms: Record<string, KnownForm>) {
	await ctx.settings.set(FORMS_SETTINGS.name, forms);
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

/**
 * The site's address as configured in EmDash (its site URL setting), never the request's Host.
 * One-click connect sends a full-admin token only here; with no configured address it is not
 * offered at all.
 */
export function configuredOrigin(ctx: PluginContext): string {
	if (!ctx.site.url) return "";
	try {
		const url = new URL(ctx.site.url);
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
	} catch {
		return "";
	}
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

/** `siteName` for runs without a request: the address remembered from the last admin visit or enquiry. */
export function siteLabel(ctx: PluginContext, state: State): string {
	return siteName(ctx, kvOf<string>(state, ORIGIN_KEY));
}

/** Remember the site's address from a request, for runs that have none. One call, only when it changed. */
export async function rememberOrigin(ctx: PluginContext, state: State, requestUrl: string) {
	const origin = siteOrigin(ctx, requestUrl);
	if (!origin || kvOf<string>(state, ORIGIN_KEY) === origin) return;
	await ctx.kv.set(ORIGIN_KEY, origin);
	state.entries.set(ORIGIN_KEY, origin);
}
