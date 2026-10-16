// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { CloudflareError, type CloudflareClient } from "./cloudflare.js";
import {
	activitySince,
	groupChanges,
	hasCheckMark,
	latestUpgrade,
	leadDeliveryRows,
	lostText,
	people,
	personName,
	pluginLabel,
	putBackRows,
	timeZone,
	LEAD_DELIVERY_PLUGIN,
	type ChangeGroup,
	type Enquiry,
	type Person,
	type Query,
	type StoredRow,
} from "./site-data.js";
import {
	allMoments,
	allRestores,
	client,
	emails,
	KEY_SETTING,
	loadConnection,
	loadKey,
	LOCK_MS,
	notify,
	peopleAt,
	siteQuery,
	snapshotPeople,
	type Connection,
	type Lock,
	type Moment,
	type PeopleSnapshot,
	type Reach,
	type RestoreRecord,
} from "./state.js";
import { DAY, MINUTE, moment as formatMoment, validTimeZone } from "./time.js";

export interface Me {
	id: string;
	name: string;
	createdAt: string;
}

// ------------------------------------------------------------------ connect and check

export type ConnectProblem = "refused" | "no-access" | "not-found" | "network";

export type ConnectResult =
	| { ok: true; connection: Connection }
	| { ok: false; problem: ConnectProblem; reachable?: number };

async function findSite(
	ctx: PluginContext,
	api: CloudflareClient,
): Promise<
	| {
			ok: true;
			reach: Reach[];
			site: { accountId: string; accountName: string; databaseId: string; databaseName: string };
	  }
	| { ok: false; problem: ConnectProblem; reachable?: number }
> {
	let accounts;
	try {
		accounts = await api.accounts();
	} catch (error) {
		return {
			ok: false,
			problem:
				error instanceof CloudflareError && error.problem === "network" ? "network" : "refused",
		};
	}
	if (accounts.length === 0) return { ok: false, problem: "refused" };

	const found: Array<{ accountId: string; accountName: string; uuid: string; name: string }> = [];
	let allowed = 0;
	for (const account of accounts.slice(0, 10)) {
		try {
			const list = await api.databases(account.id);
			allowed++;
			for (const db of list)
				found.push({
					accountId: account.id,
					accountName: account.name,
					uuid: db.uuid,
					name: db.name,
				});
		} catch {
			// This account's databases are out of the key's reach.
		}
	}
	if (allowed === 0) return { ok: false, problem: "no-access" };

	// A fresh check mark in this site's own storage, looked for in every database the key reaches.
	const mark = crypto.randomUUID();
	await ctx.kv.set("check", mark);
	const name = { plugin: ctx.plugin.id, key: "check" };
	let site: (typeof found)[number] | undefined;
	for (const db of found.slice(0, 50)) {
		try {
			if (
				await hasCheckMark(
					(sql, params) => api.query(db.accountId, db.uuid, sql, params ?? []),
					name,
					mark,
				)
			) {
				site = db;
				break;
			}
		} catch {
			// Not an EmDash database, or not readable: not this site.
		}
	}
	const reach = found.map((db) => ({
		name: db.name,
		account: db.accountName,
		isSite: db === site,
	}));
	if (!site) return { ok: false, problem: "not-found", reachable: found.length };
	return {
		ok: true,
		reach,
		site: {
			accountId: site.accountId,
			accountName: site.accountName,
			databaseId: site.uuid,
			databaseName: site.name,
		},
	};
}

export async function connect(
	ctx: PluginContext,
	key: string,
	now: number,
): Promise<ConnectResult> {
	const api = client(ctx, key);
	const found = await findSite(ctx, api);
	if (!found.ok) return found;
	const { site, reach } = found;
	const query: Query = (sql, params) =>
		api.query(site.accountId, site.databaseId, sql, params ?? []);

	// 30 days on Workers Paid, 7 on Free: a moment 8 days back is only accepted on Paid.
	let windowDays = 7;
	try {
		await api.pointAt(site.accountId, site.databaseId, new Date(now - 8 * DAY).toISOString());
		windowDays = 30;
	} catch {
		// Stays at 7.
	}
	const expiresOn = await api.expiresOn(site.accountId).catch(() => null);
	const zone = validTimeZone(await timeZone(query).catch(() => null));
	const previous = await loadConnection(ctx);
	const setupAt =
		previous && previous.databaseId === site.databaseId
			? previous.setupAt
			: new Date(now).toISOString();
	const connection: Connection = {
		...site,
		setupAt,
		windowDays,
		reach,
		zone,
		expiresOn,
		lastCheck: { at: new Date(now).toISOString(), ok: true },
	};
	await ctx.settings.set(KEY_SETTING, key);
	await ctx.kv.set("connection", connection);
	if ((await emails(ctx)).length === 0) {
		const team = await people(query).catch(() => [] as Person[]);
		const admins = team.filter((p) => p.role >= 50 && !p.disabled && p.email).map((p) => p.email);
		if (admins.length > 0) await ctx.kv.set("emails", admins.slice(0, 20));
	}
	await snapshotPeople(ctx, query, now).catch(() => undefined);
	return { ok: true, connection };
}

/** Is the key still accepted and this site's database still found? */
export async function check(ctx: PluginContext, now: number): Promise<Connection | null> {
	const connection = await loadConnection(ctx);
	const key = await loadKey(ctx);
	if (!connection) return null;
	let result: Connection["lastCheck"];
	let reach = connection.reach;
	let expiresOn = connection.expiresOn;
	if (!key) result = { at: new Date(now).toISOString(), ok: false, problem: "refused" };
	else {
		const found = await findSite(ctx, client(ctx, key));
		if (found.ok && found.site.databaseId === connection.databaseId) {
			reach = found.reach;
			result = { at: new Date(now).toISOString(), ok: true };
			expiresOn = await client(ctx, key)
				.expiresOn(connection.accountId)
				.catch(() => expiresOn);
		} else {
			result = {
				at: new Date(now).toISOString(),
				ok: false,
				problem: found.ok ? "not-found" : found.problem,
			};
		}
	}
	const next = { ...connection, reach, expiresOn, lastCheck: result };
	await ctx.kv.set("connection", next);
	if (!result.ok && result.problem !== "network") {
		await notify(
			ctx,
			"stopped",
			"Restore has stopped working",
			"Cloudflare no longer accepts the key Restore uses, or this site's data can no longer be found with it, so the site can't be put back until this is fixed.\n\nOpen Restore in the site's admin and press \"Replace the key\".",
			connection.zone,
			now,
		);
	} else if (result.ok && expiresOn && Date.parse(expiresOn) - now < 14 * DAY) {
		await notify(
			ctx,
			"expires",
			`the Cloudflare key for Restore expires on ${formatMoment(expiresOn, connection.zone)}`,
			"After that the site can't be put back until a new key is added. Open Restore in the site's admin and press \"Replace the key\".",
			connection.zone,
			now,
		);
	}
	return next;
}

// ------------------------------------------------------------------ review

export type Refusal =
	| { reason: "before-setup"; setupAt: string }
	| { reason: "before-account" }
	| { reason: "before-upgrade"; upgradedAt: string }
	| { reason: "too-old"; days: number }
	| { reason: "future" }
	| { reason: "running"; byName: string; at: string }
	| { reason: "too-soon" };

export interface ReviewGroup extends ChangeGroup {
	whoName: string;
}

export interface Review {
	moment: string;
	/** "Just before ..." line, when picked from the list. */
	picked?: { what: string; whoName: string; at: string };
	skip?: { from: string; to: string; who: string | null; collection?: string };
	counts: { changes: number; added: number; fromTrash: number; enquiries: number };
	groups: ReviewGroup[];
	enquiries: Enquiry[];
	pluginRecords: Array<{ plugin: string; count: number }>;
	leadRecords: number;
	lost: Array<{ how: string; title: string; text: string }>;
	editors: string[];
	regain: string[];
	lose: string[];
	pictures: number;
	computedAt: string;
}

export interface ReviewState {
	review: Review;
	byId: string;
	/** The enquiries were downloaded or reached the owner. */
	ack: boolean;
	/** The confirmation tick. */
	ticked: boolean;
}

export async function refusal(
	ctx: PluginContext,
	connection: Connection,
	query: Query,
	at: string,
	me: Me,
	now: number,
): Promise<Refusal | null> {
	const ms = Date.parse(at);
	if (ms > now) return { reason: "future" };
	if (ms < Date.parse(connection.setupAt))
		return { reason: "before-setup", setupAt: connection.setupAt };
	if (ms < now - connection.windowDays * DAY)
		return { reason: "too-old", days: connection.windowDays };
	if (me.createdAt && ms < Date.parse(me.createdAt)) return { reason: "before-account" };
	const upgradedAt = await latestUpgrade(query).catch(() => null);
	if (upgradedAt && ms < Date.parse(upgradedAt)) return { reason: "before-upgrade", upgradedAt };
	return busy(ctx, now);
}

async function busy(ctx: PluginContext, now: number): Promise<Refusal | null> {
	const lock = await ctx.kv.get<Lock>("lock");
	if (lock && Date.parse(lock.at) > now - LOCK_MS)
		return { reason: "running", byName: lock.byName, at: lock.at };
	const [last] = await allRestores(ctx);
	if (last && Date.parse(last.at) > now - MINUTE) return { reason: "too-soon" };
	return null;
}

export async function buildReview(
	ctx: PluginContext,
	query: Query,
	at: string,
	me: Me,
	now: number,
	picked?: { from: string; to: string; who: string | null; collection?: string; what: string },
): Promise<Review> {
	const team = await snapshotPeople(ctx, query, now);
	const byId = new Map(team.map((person) => [person.id, person]));
	const name = (id: string | null) =>
		id === null ? "Someone" : id === me.id ? "You" : personName(byId.get(id));
	const activity = await activitySince(query, at, ctx.plugin.id, byId);
	const groups = groupChanges(activity.changes).map((group) => ({
		...group,
		whoName: group.kind === "enquiry" ? "A visitor" : name(group.who),
	}));
	for (const group of groups) {
		if (group.count > 1)
			group.what = `${group.count} ${groupLabel(activity, group)} changed at once`;
	}
	const skip = picked
		? { from: picked.from, to: picked.to, who: picked.who, collection: picked.collection }
		: undefined;
	const lost = lostText(activity, byId, me.id, skip).map(({ how, title, text }) => ({
		how,
		title,
		text,
	}));

	// People: who regains access and who loses it, by name.
	const snapshots = (await ctx.kv.get<PeopleSnapshot[]>("people")) ?? [];
	const then = peopleAt(snapshots, at);
	const regain: string[] = [];
	for (const was of then) {
		const current = byId.get(was.id);
		if (!was.disabled && (!current || current.disabled)) {
			regain.push(`${personName(was)} (${current ? "switched off" : "removed"} since then)`);
		}
	}
	const lose = team
		.filter((p) => Date.parse(p.createdAt) > Date.parse(at))
		.map((p) => personName(p));
	const editors = [
		...new Set(
			activity.changes
				.filter((c) => (c.kind === "edited" || c.kind === "added") && c.who && c.who !== me.id)
				.map((c) => name(c.who)),
		),
	];
	const leadRecords =
		activity.pluginRecords.find((r) => r.plugin === LEAD_DELIVERY_PLUGIN)?.count ?? 0;
	return {
		moment: at,
		...(picked
			? { picked: { what: picked.what, whoName: name(picked.who), at: picked.to }, skip }
			: {}),
		counts: {
			changes: activity.changes.length,
			added: activity.entries.filter((e) => e.added).length,
			fromTrash: activity.entries.filter((e) => e.trashed && !e.added).length,
			enquiries: activity.enquiries.length,
		},
		groups: groups.slice(0, 50),
		enquiries: activity.enquiries.slice(0, 50),
		pluginRecords: activity.pluginRecords.map((r) => ({
			plugin: pluginLabel(r.plugin),
			count: r.count,
		})),
		leadRecords,
		lost,
		editors,
		regain,
		lose,
		pictures: activity.pictures.length,
		computedAt: new Date(now).toISOString(),
	};
}

function groupLabel(
	activity: Awaited<ReturnType<typeof activitySince>>,
	group: ChangeGroup,
): string {
	const entry = activity.entries.find((e) => e.collection.slug === group.collection);
	return entry ? entry.collection.plural.toLowerCase() : "items";
}

/** Recent changes since setup, for the main page. */
export async function recentChanges(
	ctx: PluginContext,
	query: Query,
	connection: Connection,
	me: Me,
	now: number,
): Promise<ReviewGroup[]> {
	const team = await snapshotPeople(ctx, query, now);
	const byId = new Map(team.map((person) => [person.id, person]));
	const name = (id: string | null) =>
		id === null ? "Someone" : id === me.id ? "You" : personName(byId.get(id));
	const activity = await activitySince(query, connection.setupAt, ctx.plugin.id, byId);
	return groupChanges(activity.changes)
		.map((group) => ({
			...group,
			whoName: group.kind === "enquiry" ? "A visitor" : name(group.who),
			what:
				group.count > 1
					? `${group.count} ${groupLabel(activity, group)} changed at once`
					: group.what,
		}))
		.slice(0, 25);
}

/** "Just before" a change: the end of the minute before it, so the button can say "11:04". */
export function justBefore(iso: string): string {
	const ms = Date.parse(iso);
	return new Date(Math.floor(ms / MINUTE) * MINUTE - 1).toISOString();
}

// ------------------------------------------------------------------ restore

export type RestoreOutcome =
	| { kind: "refused"; refusal: Refusal }
	| { kind: "problem"; message: string }
	| { kind: "nothing-changed"; message: string }
	| { kind: "unconfirmed"; record: RestoreRecord; marker: string }
	| {
			kind: "done";
			record: RestoreRecord;
			historySaved: boolean;
			leadRows: number;
			emailed: string[];
	  };

interface Carry {
	connection: Connection;
	key: string;
	emails: string[];
	people: PeopleSnapshot[];
	restores: RestoreRecord[];
	moments: Array<Moment & { id: string }>;
}

/** Everything the plugin keeps, read before a restore so it can be written back after. */
async function carry(ctx: PluginContext, connection: Connection, key: string): Promise<Carry> {
	return {
		connection,
		key,
		emails: await emails(ctx),
		people: (await ctx.kv.get<PeopleSnapshot[]>("people")) ?? [],
		restores: await allRestores(ctx),
		moments: await allMoments(ctx),
	};
}

async function writeBack(
	ctx: PluginContext,
	saved: Carry,
	record: RestoreRecord,
	lead: StoredRow[],
) {
	await ctx.settings.set(KEY_SETTING, saved.key);
	await ctx.kv.set("connection", saved.connection);
	await ctx.kv.set("emails", saved.emails);
	await ctx.kv.set("people", saved.people);
	await ctx.storage.restores!.putMany(
		[...saved.restores, record].map((item) => ({ id: item.id, data: item })),
	);
	if (saved.moments.length > 0) {
		await ctx.storage.moments!.putMany(saved.moments.map(({ id, ...data }) => ({ id, data })));
	}
	await ctx.kv.set("carry", { restoreId: record.id, rows: lead });
	await ctx.kv.delete("lock");
	await ctx.kv.delete("review");
}

export interface Target {
	/** Go back to this moment (a new restore), or ... */
	moment?: string;
	/** ... restore this exact point (an undo). */
	point?: string;
	pointTo?: string;
	undid?: string;
}

export async function putBack(
	ctx: PluginContext,
	target: Target,
	me: Me,
	now: number,
): Promise<RestoreOutcome> {
	const connection = await loadConnection(ctx);
	const key = await loadKey(ctx);
	if (!connection || !key)
		return { kind: "problem", message: "Restore is not connected. Nothing was changed." };
	const api = client(ctx, key);
	const query = siteQuery(api, connection);

	if (target.moment) {
		const refused = await refusal(ctx, connection, query, target.moment, me, now).catch(() => null);
		if (refused) return { kind: "refused", refusal: refused };
	} else {
		const refused = await busy(ctx, now);
		if (refused) return { kind: "refused", refusal: refused };
	}

	// Right database, every time: a fresh check mark, read back seconds before the restore.
	const mark = crypto.randomUUID();
	await ctx.kv.set("check", mark);
	try {
		if (!(await hasCheckMark(query, { plugin: ctx.plugin.id, key: "check" }, mark))) {
			return {
				kind: "problem",
				message: "The key no longer reaches this site's data. Nothing was changed.",
			};
		}
	} catch (error) {
		return { kind: "problem", message: `${explain(error)} Nothing was changed.` };
	}

	await ctx.kv.set("lock", {
		byId: me.id,
		byName: me.name,
		at: new Date(now).toISOString(),
	} satisfies Lock);
	const release = () => ctx.kv.delete("lock").catch(() => false);
	let saved: Carry;
	let lead: StoredRow[] = [];
	let point: string;
	let undoPoint: string;
	try {
		saved = await carry(ctx, connection, key);
		const to = target.moment ?? target.pointTo ?? "";
		if (to) lead = await leadDeliveryRows(query, to).catch(() => []);
		// The exact moment reviewed, resolved once into Cloudflare's restore point.
		point =
			target.point ??
			(await api.pointAt(connection.accountId, connection.databaseId, target.moment ?? ""));
		// The undo point, taken now, so undo works even if Cloudflare's answer is lost.
		undoPoint = await api.pointAt(
			connection.accountId,
			connection.databaseId,
			new Date(now).toISOString(),
		);
	} catch (error) {
		await release();
		return { kind: "problem", message: `${explain(error)} Nothing was changed.` };
	}

	// A marker written after the moment: if it is gone afterwards, the database moved.
	const marker = crypto.randomUUID();
	await ctx.kv.set("marker", marker);
	const started = Date.now();
	const record: RestoreRecord = {
		id: `r${now.toString(36)}${marker.slice(0, 6)}`,
		at: new Date(now).toISOString(),
		to: target.moment ?? target.pointTo ?? "",
		byId: me.id,
		byName: me.name,
		result: "done",
		undoPoint,
		undoTo: new Date(now).toISOString(),
		tookMs: 0,
		...(target.undid ? { undid: target.undid } : {}),
	};
	try {
		const result = await api.restore(connection.accountId, connection.databaseId, point);
		if (result.previousBookmark) record.undoPoint = result.previousBookmark;
	} catch (error) {
		const moved = await markerGone(query, ctx, marker);
		if (moved === false) {
			await release();
			return { kind: "nothing-changed", message: `${explain(error)} Nothing was changed.` };
		}
		if (moved === null) {
			record.result = "unconfirmed";
			record.tookMs = Date.now() - started;
			return { kind: "unconfirmed", record, marker };
		}
	}
	record.tookMs = Date.now() - started;
	return finish(ctx, saved, record, lead, connection, now);
}

async function finish(
	ctx: PluginContext,
	saved: Carry,
	record: RestoreRecord,
	lead: StoredRow[],
	connection: Connection,
	now: number,
): Promise<RestoreOutcome> {
	let historySaved = true;
	try {
		await writeBack(ctx, saved, record, lead);
	} catch (error) {
		historySaved = false;
		ctx.log.warn("could not write the history back after a restore", { error: String(error) });
	}
	const emailed = await notify(
		ctx,
		"restored",
		`the site was put back to ${formatMoment(record.to, connection.zone)}`,
		`${record.byName} put the site back to ${formatMoment(record.to, connection.zone)} (${connection.zone}) on ${formatMoment(record.at, connection.zone)}.\n\nTo undo it, open Restore in the site's admin and press "Undo this restore".`,
		connection.zone,
		now,
	);
	return { kind: "done", record, historySaved, leadRows: lead.length, emailed };
}

/** After an unclear answer: true if the database moved, false if not, null if we can't tell. */
async function markerGone(
	query: Query,
	ctx: PluginContext,
	marker: string,
): Promise<boolean | null> {
	try {
		return !(await hasCheckMark(query, { plugin: ctx.plugin.id, key: "marker" }, marker));
	} catch {
		return null;
	}
}

/** "Check" after an unconfirmed restore. */
export async function confirmRestore(
	ctx: PluginContext,
	record: RestoreRecord,
	marker: string,
	now: number,
): Promise<RestoreOutcome> {
	const connection = await loadConnection(ctx);
	const key = await loadKey(ctx);
	if (!connection || !key) return { kind: "problem", message: "Restore is not connected." };
	const query = siteQuery(client(ctx, key), connection);
	const moved = await markerGone(query, ctx, marker);
	if (moved === false) {
		await ctx.kv.delete("lock");
		return { kind: "nothing-changed", message: "The site did not go back." };
	}
	if (moved === null) return { kind: "unconfirmed", record, marker };
	const saved = await carry(ctx, connection, key);
	return finish(ctx, saved, { ...record, result: "done" }, [], connection, now);
}

/** Write Lead Delivery's records back after a restore. */
export async function putBackLeadRecords(ctx: PluginContext): Promise<number> {
	const connection = await loadConnection(ctx);
	const key = await loadKey(ctx);
	const kept = await ctx.kv.get<{ restoreId: string; rows: StoredRow[] }>("carry");
	if (!connection || !key || !kept || kept.rows.length === 0) return 0;
	const written = await putBackRows(siteQuery(client(ctx, key), connection), kept.rows);
	await ctx.kv.set("carry", { ...kept, rows: [] });
	return written;
}

export function explain(error: unknown): string {
	if (error instanceof CloudflareError) {
		if (error.problem === "refused") return "Cloudflare did not accept the key.";
		if (error.problem === "forbidden") return "That key can't put sites back.";
		if (error.problem === "network") return "Cloudflare did not answer.";
		if (error.problem === "not-found") return "Cloudflare couldn't find this site's data.";
	}
	return "Something went wrong talking to Cloudflare.";
}

export function refusalText(refused: Refusal, zone: string): { title: string; text: string } {
	switch (refused.reason) {
		case "before-setup":
			return {
				title: "This page can't go back that far",
				text: `Restore was set up on ${formatMoment(refused.setupAt, zone)}, and it can only go back to moments after that. Pick a later moment.`,
			};
		case "before-account":
			return {
				title: "You didn't have an account then",
				text: "Going back to before your account existed would lock you out. Pick a later moment.",
			};
		case "before-upgrade":
			return {
				title: "The site was upgraded after that moment",
				text: `The site was upgraded on ${formatMoment(refused.upgradedAt, zone)}. Going back before that isn't safe yet. Pick a moment after it.`,
			};
		case "too-old":
			return {
				title: "That is too long ago",
				text: `Cloudflare keeps the last ${refused.days} days. Pick a more recent moment.`,
			};
		case "future":
			return { title: "That moment hasn't happened yet", text: "Pick a moment in the past." };
		case "running":
			return {
				title: "A restore is already running",
				text: `${refused.byName} started one at ${formatMoment(refused.at, zone)}. Wait for it to finish.`,
			};
		case "too-soon":
			return {
				title: "The site was put back a moment ago",
				text: "Wait a minute, then try again, so the two don't overlap.",
			};
	}
}
