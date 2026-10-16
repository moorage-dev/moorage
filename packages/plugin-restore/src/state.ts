// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { createCloudflareClient, type CloudflareClient, type Fetch } from "./cloudflare.js";
import { people, type Person, type Query } from "./site-data.js";
import { localDay } from "./time.js";

export const KEY_SETTING = "token";

export interface Reach {
	name: string;
	account: string;
	isSite: boolean;
}

export interface Connection {
	accountId: string;
	accountName: string;
	databaseId: string;
	databaseName: string;
	/** When Restore was set up: the furthest back it can ever go. */
	setupAt: string;
	windowDays: number;
	reach: Reach[];
	zone: string;
	expiresOn: string | null;
	lastCheck: { at: string; ok: boolean; problem?: string };
}

export interface RestoreRecord {
	id: string;
	/** When the restore was made. */
	at: string;
	/** The moment the site went back to. */
	to: string;
	byId: string;
	byName: string;
	result: "done" | "unconfirmed";
	/** Restoring this point undoes the restore. */
	undoPoint: string;
	/** The moment the undo goes back to (just before the restore). */
	undoTo: string;
	tookMs: number;
	/** Set when this restore undid another one. */
	undid?: string;
}

export interface Moment {
	name: string;
	at: string;
	byName: string;
}

export interface PeopleSnapshot {
	at: string;
	people: Array<Pick<Person, "id" | "name" | "email" | "role" | "disabled">>;
}

export interface Lock {
	byId: string;
	byName: string;
	at: string;
}

export const LOCK_MS = 5 * 60_000;

export async function loadConnection(ctx: PluginContext): Promise<Connection | null> {
	return ctx.kv.get<Connection>("connection");
}

export async function loadKey(ctx: PluginContext): Promise<string | null> {
	try {
		const key = await ctx.settings.get<string>(KEY_SETTING);
		return typeof key === "string" && key !== "" ? key : null;
	} catch {
		return null;
	}
}

export function client(ctx: PluginContext, key: string): CloudflareClient {
	if (!ctx.http) throw new Error("network access is not available");
	const http = ctx.http;
	const fetch: Fetch = (url, init) => http.fetch(url, init);
	return createCloudflareClient(fetch, key);
}

export function siteQuery(api: CloudflareClient, connection: Connection): Query {
	return (sql, params) => api.query(connection.accountId, connection.databaseId, sql, params ?? []);
}

/** The option name EmDash stores this plugin's key-value entry under. */
export function optionName(ctx: PluginContext, key: string): string {
	return `plugin:${ctx.plugin.id}:${key}`;
}

export async function emails(ctx: PluginContext): Promise<string[]> {
	return (await ctx.kv.get<string[]>("emails")) ?? [];
}

export function parseEmails(text: string): string[] | null {
	const list = text
		.split(/[\s,;]+/)
		.map((part) => part.trim())
		.filter(Boolean);
	if (list.some((address) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address))) return null;
	return [...new Set(list)].slice(0, 20);
}

/** Keep a list of who could sign in, so the review can name people removed since a moment. */
export async function snapshotPeople(
	ctx: PluginContext,
	query: Query,
	now: number,
): Promise<Person[]> {
	const team = await people(query);
	const list = (await ctx.kv.get<PeopleSnapshot[]>("people")) ?? [];
	const current = team.map(({ id, name, email, role, disabled }) => ({
		id,
		name,
		email,
		role,
		disabled,
	}));
	const last = list[list.length - 1];
	if (!last || JSON.stringify(last.people) !== JSON.stringify(current)) {
		list.push({ at: new Date(now).toISOString(), people: current });
		await ctx.kv.set("people", list.slice(-60));
	}
	return team;
}

/** Who had access at a moment, from the newest list taken at or before it (or the oldest). */
export function peopleAt(list: PeopleSnapshot[], at: string): PeopleSnapshot["people"] {
	const before = list.filter((snapshot) => Date.parse(snapshot.at) <= Date.parse(at));
	return (before[before.length - 1] ?? list[0])?.people ?? [];
}

export async function allRestores(ctx: PluginContext): Promise<RestoreRecord[]> {
	const result = await ctx.storage.restores!.query({ orderBy: { at: "desc" }, limit: 100 });
	return result.items.map((item) => item.data as RestoreRecord);
}

export async function allMoments(ctx: PluginContext): Promise<Array<Moment & { id: string }>> {
	const result = await ctx.storage.moments!.query({ orderBy: { at: "desc" }, limit: 100 });
	return result.items.map((item) => ({ id: item.id, ...(item.data as Moment) }));
}

/** Send one email of a kind at most once a day, to everyone on the list. */
export async function notify(
	ctx: PluginContext,
	kind: "restored" | "stopped" | "expires",
	subject: string,
	text: string,
	zone: string,
	now: number,
): Promise<string[]> {
	const to = await emails(ctx);
	if (!ctx.email || to.length === 0) return [];
	const today = localDay(new Date(now).toISOString(), zone);
	const key = `mailed:${kind}`;
	if ((await ctx.kv.get<string>(key)) === today) return [];
	try {
		const [first, ...rest] = to as [string, ...string[]];
		const site = ctx.site.name || "Your site";
		await ctx.email.send({
			to: first,
			...(rest.length > 0 ? { cc: rest } : {}),
			subject: `${site}: ${subject}`,
			text,
		});
		await ctx.kv.set(key, today);
		return to;
	} catch (error) {
		ctx.log.warn("could not send the email", { kind, error: String(error) });
		return [];
	}
}
