// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// What happened on the site since a moment, read through the owner's Cloudflare key with
// read-only SELECTs on the site's own database. Only content, revisions, pictures, people
// (id, name, email, role, switched off, dates), form enquiries and plugin records are read;
// never passwords, sign-ins or keys. Moments are always passed as parameters and compared
// with julianday(), because core writes ISO times ("2026-10-16T11:04:00.000Z") and table
// defaults write "2026-10-16 11:04:00".

import type { Row } from "./cloudflare.js";

export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

export const FORMS_PLUGIN = "emdash-forms";
/** Lead Delivery keeps its own log; its rows are kept aside and offered back after a restore. */
export const LEAD_DELIVERY_PLUGIN = "lead-delivery";

const SAFE_SLUG = /^[a-z0-9_]+$/;
const AFTER = (column: string) => `julianday(${column}) > julianday(?)`;

export interface Person {
	id: string;
	name: string;
	email: string;
	role: number;
	disabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export type ChangeKind = "edited" | "added" | "trashed" | "picture" | "person" | "enquiry";

export interface Change {
	kind: ChangeKind;
	/** "Opening hours (page) edited" */
	what: string;
	who: string | null;
	at: string;
	collection?: string;
	entryId?: string;
}

/** One row of the recent-changes table: a single change or a burst ("31 products changed at once"). */
export interface ChangeGroup {
	what: string;
	who: string | null;
	/** The earliest change in the group. */
	from: string;
	/** The latest change in the group. */
	to: string;
	count: number;
	kind: ChangeKind;
	collection?: string;
}

export interface Enquiry {
	form: string;
	sender: string;
	at: string;
}

export interface LostText {
	title: string;
	text: string;
	how: string;
	who: string | null;
	at: string;
}

export interface StoredRow {
	plugin_id: string;
	collection: string;
	id: string;
	data: string;
	created_at: string | null;
	updated_at: string | null;
}

/** Turn either time format into ISO. */
export function iso(value: unknown): string {
	if (typeof value !== "string" || value === "") return "";
	const spaced = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value);
	const parsed = Date.parse(spaced ? `${spaced[1]}T${spaced[2]}Z` : value);
	return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function str(value: unknown): string {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

export async function timeZone(query: Query): Promise<string | null> {
	const rows = await query("SELECT value FROM options WHERE name = ?", ["site:timezone"]);
	const value = parseJson(rows[0]?.value);
	return typeof value === "string" ? value : null;
}

export async function latestUpgrade(query: Query): Promise<string | null> {
	const rows = await query("SELECT max(timestamp) AS at FROM _emdash_migrations");
	return iso(rows[0]?.at) || null;
}

export async function people(query: Query): Promise<Person[]> {
	const rows = await query(
		"SELECT id, name, email, role, disabled, created_at, updated_at FROM users ORDER BY created_at",
	);
	return rows.map((row) => ({
		id: str(row.id),
		name: str(row.name),
		email: str(row.email),
		role: Number(row.role ?? 0),
		disabled: Number(row.disabled ?? 0) === 1,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	}));
}

export function personName(person: Pick<Person, "name" | "email"> | undefined): string {
	if (!person) return "Someone";
	return person.name.trim() || person.email.split("@")[0] || "Someone";
}

/**
 * Look for one of the plugin's own key-value entries in this database. In-process plugins keep
 * them in `options` ("plugin:<id>:<key>"); sandboxed ones in `_plugin_storage` (collection "__kv").
 */
export async function hasCheckMark(
	query: Query,
	where: { plugin: string; key: string },
	mark: string,
): Promise<boolean> {
	const rows = await query(
		"SELECT value FROM options WHERE name = ? UNION ALL SELECT data AS value FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ?",
		[`plugin:${where.plugin}:${where.key}`, where.plugin, where.key],
	);
	return rows.some((row) => str(row.value).includes(mark));
}

interface Collection {
	slug: string;
	singular: string;
	plural: string;
}

async function collections(query: Query): Promise<Collection[]> {
	const rows = await query(
		"SELECT slug, label, label_singular FROM _emdash_collections ORDER BY slug",
	);
	return rows
		.map((row) => ({
			slug: str(row.slug),
			plural: str(row.label) || str(row.slug),
			singular: str(row.label_singular) || str(row.label) || str(row.slug),
		}))
		.filter((c) => SAFE_SLUG.test(c.slug));
}

const SYSTEM_COLUMNS = new Set([
	"id",
	"slug",
	"status",
	"author_id",
	"primary_byline_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	"locale",
	"translation_group",
]);

/** Plain text from a field: a string, or the text inside rich text blocks. */
function plainText(value: unknown): string {
	const parsed = parseJson(value);
	if (typeof parsed === "string") return parsed.trim();
	if (Array.isArray(parsed)) {
		return parsed
			.map((block) => {
				if (!block || typeof block !== "object") return "";
				const children = (block as { children?: unknown }).children;
				if (!Array.isArray(children)) return "";
				return children
					.map((child) => str((child as { text?: unknown } | null)?.text))
					.join("")
					.trim();
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function entryTitle(row: Row): string {
	return plainText(row.title) || plainText(row.name) || str(row.slug) || "Untitled";
}

function entryText(row: Row): string {
	const lines: string[] = [];
	for (const [column, value] of Object.entries(row)) {
		if (SYSTEM_COLUMNS.has(column) || column === "title") continue;
		const text = plainText(value);
		if (text && !/^[0-9A-Z]{26}$/.test(text) && !/^(\{|\[)/.test(text)) lines.push(text);
	}
	return lines.join("\n");
}

export interface Activity {
	changes: Change[];
	/** Entries added or edited since the moment, with their current text. */
	entries: Array<{ collection: Collection; row: Row; added: boolean; trashed: boolean }>;
	enquiries: Enquiry[];
	/** Records other plugins saved since the moment, by plugin. */
	pluginRecords: Array<{ plugin: string; count: number }>;
	pictures: string[];
}

/** Everything that changed after a moment, newest first. */
export async function activitySince(
	query: Query,
	after: string,
	ownPluginId: string,
	team: Map<string, Person>,
): Promise<Activity> {
	const [kinds, revisions, media, submissions, forms, records] = await Promise.all([
		collections(query),
		query(
			`SELECT collection, entry_id, author_id, created_at FROM revisions WHERE ${AFTER("created_at")} ORDER BY created_at DESC LIMIT 1000`,
			[after],
		),
		query(
			`SELECT id, filename, author_id, created_at FROM media WHERE ${AFTER("created_at")} ORDER BY created_at DESC LIMIT 500`,
			[after],
		),
		query(
			`SELECT id, data, created_at FROM _plugin_storage WHERE plugin_id = ? AND collection = 'submissions' AND ${AFTER("created_at")} ORDER BY created_at DESC LIMIT 500`,
			[FORMS_PLUGIN, after],
		),
		query("SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = 'forms'", [
			FORMS_PLUGIN,
		]),
		query(
			`SELECT plugin_id, count(*) AS n FROM _plugin_storage WHERE plugin_id NOT IN (?, ?) AND collection <> '__kv' AND (${AFTER("created_at")} OR ${AFTER("updated_at")}) GROUP BY plugin_id ORDER BY plugin_id`,
			[ownPluginId, FORMS_PLUGIN, after, after],
		),
	]);

	const who = (id: unknown) => (typeof id === "string" && id ? id : null);
	const changes: Change[] = [];
	const byKind = new Map(kinds.map((kind) => [kind.slug, kind]));
	const entries: Activity["entries"] = [];

	const rowsByCollection = await Promise.all(
		kinds.map(async (kind) => ({
			kind,
			rows: await query(
				`SELECT * FROM "ec_${kind.slug}" WHERE ${AFTER("created_at")} OR ${AFTER("updated_at")} OR ${AFTER("deleted_at")} LIMIT 500`,
				[after, after, after],
			).catch(() => [] as Row[]),
		})),
	);
	const entryRows = new Map<string, { kind: Collection; row: Row }>();
	for (const { kind, rows } of rowsByCollection) {
		for (const row of rows) entryRows.set(`${kind.slug}:${str(row.id)}`, { kind, row });
	}

	const revised = new Set<string>();
	// Revisions are oldest-last; the first one after the moment for a new entry is its creation.
	for (const revision of [...revisions].reverse()) {
		// oxlint-disable-line unicorn/no-array-reverse
		const kind = byKind.get(str(revision.collection));
		if (!kind) continue;
		const key = `${kind.slug}:${str(revision.entry_id)}`;
		const entry = entryRows.get(key);
		const added = entry ? Date.parse(iso(entry.row.created_at)) > Date.parse(after) : false;
		const title = entry ? entryTitle(entry.row) : "An entry";
		const first = !revised.has(key);
		revised.add(key);
		changes.push({
			kind: added && first ? "added" : "edited",
			what: `${title} (${kind.singular.toLowerCase()}) ${added && first ? "added" : "edited"}`,
			who: who(revision.author_id),
			at: iso(revision.created_at),
			collection: kind.slug,
			entryId: str(revision.entry_id),
		});
	}
	for (const [key, { kind, row }] of entryRows) {
		const created = iso(row.created_at);
		const updated = iso(row.updated_at);
		const deleted = iso(row.deleted_at);
		const added = Date.parse(created) > Date.parse(after);
		const trashed = deleted !== "" && Date.parse(deleted) > Date.parse(after);
		entries.push({ collection: kind, row, added, trashed });
		const title = entryTitle(row);
		if (trashed) {
			changes.push({
				kind: "trashed",
				what: `${title} (${kind.singular.toLowerCase()}) moved to the Trash`,
				who: null,
				at: deleted,
				collection: kind.slug,
				entryId: str(row.id),
			});
		}
		// Collections without revisions still show their changes.
		if (!revised.has(key) && !trashed) {
			changes.push({
				kind: added ? "added" : "edited",
				what: `${title} (${kind.singular.toLowerCase()}) ${added ? "added" : "edited"}`,
				who: added ? who(row.author_id) : null,
				at: added ? created : updated,
				collection: kind.slug,
				entryId: str(row.id),
			});
		}
	}

	const pictures: string[] = [];
	for (const item of media) {
		pictures.push(str(item.filename));
		changes.push({
			kind: "picture",
			what: `Picture ${str(item.filename)} uploaded`,
			who: who(item.author_id),
			at: iso(item.created_at),
		});
	}

	for (const person of team.values()) {
		if (Date.parse(person.createdAt) > Date.parse(after)) {
			changes.push({
				kind: "person",
				what: `${personName(person)} added`,
				who: null,
				at: person.createdAt,
			});
		} else if (Date.parse(person.updatedAt) > Date.parse(after)) {
			changes.push({
				kind: "person",
				what: person.disabled
					? `${personName(person)} switched off`
					: `${personName(person)}'s account changed`,
				who: null,
				at: person.updatedAt,
			});
		}
	}

	const formNames = new Map<string, string>();
	for (const form of forms) {
		const data = parseJson(form.data) as { name?: unknown; slug?: unknown } | null;
		formNames.set(str(form.id), str(data?.name) || str(data?.slug) || "a form");
		if (data?.slug) formNames.set(str(data.slug), str(data.name) || str(data.slug));
	}
	const enquiries: Enquiry[] = [];
	for (const submission of submissions) {
		const data = parseJson(submission.data) as {
			formId?: unknown;
			createdAt?: unknown;
			data?: Record<string, unknown>;
		} | null;
		const fields = data?.data ?? {};
		const name = str(fields.name) || str(fields.full_name) || str(fields.fullName);
		const email = str(fields.email);
		const sender = name && email ? `${name} (${email})` : name || email || "a visitor";
		const form = formNames.get(str(data?.formId)) ?? "a form";
		const at = iso(data?.createdAt) || iso(submission.created_at);
		enquiries.push({ form, sender, at });
		changes.push({
			kind: "enquiry",
			what: form === "a form" ? "Enquiry from a form" : `Enquiry from the ${form} form`,
			who: null,
			at,
		});
	}

	changes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); // oxlint-disable-line unicorn/no-array-sort
	return {
		changes,
		entries,
		enquiries,
		pictures,
		pluginRecords: records.map((row) => ({
			plugin: str(row.plugin_id),
			count: Number(row.n ?? 0),
		})),
	};
}

/** Bursts of the same kind of change by the same person within two minutes become one row. */
export function groupChanges(changes: Change[], minimum = 5): ChangeGroup[] {
	const groups: ChangeGroup[] = [];
	let run: Change[] = [];
	const flush = () => {
		if (run.length === 0) return;
		const first = run[0] as Change;
		const last = run[run.length - 1] as Change;
		if (run.length >= minimum) {
			groups.push({
				what: "",
				who: first.who,
				from: last.at,
				to: first.at,
				count: run.length,
				kind: first.kind,
				collection: first.collection,
			});
		} else {
			for (const change of run) {
				groups.push({
					what: change.what,
					who: change.who,
					from: change.at,
					to: change.at,
					count: 1,
					kind: change.kind,
					collection: change.collection,
				});
			}
		}
		run = [];
	};
	for (const change of changes) {
		const head = run[0];
		const fits =
			head &&
			(change.kind === "edited" || change.kind === "added") &&
			change.kind === head.kind &&
			change.who === head.who &&
			change.collection === head.collection &&
			Date.parse(head.at) - Date.parse(change.at) <= 2 * 60_000;
		if (!fits) flush();
		run.push(change);
	}
	flush();
	return groups;
}

/** The title and text of entries changed after the moment, to copy before going back. */
export function lostText(
	activity: Activity,
	team: Map<string, Person>,
	me: string,
	skip?: { from: string; to: string; who: string | null; collection?: string },
): LostText[] {
	const out: LostText[] = [];
	const inSkipped = (change: Change) =>
		skip !== undefined &&
		change.who === skip.who &&
		change.collection === skip.collection &&
		Date.parse(change.at) >= Date.parse(skip.from) &&
		Date.parse(change.at) <= Date.parse(skip.to);
	for (const { collection, row, added, trashed } of activity.entries) {
		if (trashed && !added) continue;
		const id = str(row.id);
		const edits = activity.changes.filter(
			(c) => c.collection === collection.slug && c.entryId === id,
		);
		const good = edits.filter((change) => !inSkipped(change));
		if (edits.length > 0 && good.length === 0) continue;
		const latest = good[0] ?? edits[0];
		const whoId = latest?.who ?? null;
		const name = whoId === me ? "you" : whoId ? personName(team.get(whoId)) : "someone";
		out.push({
			title: entryTitle(row),
			text: entryText(row),
			how: `${entryTitle(row)} (${collection.singular.toLowerCase()}), ${added ? "added" : "edited"} by ${name}`,
			who: whoId,
			at: latest?.at ?? iso(row.updated_at),
		});
	}
	return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Lead Delivery's rows saved since the moment, to put back after the restore. */
export async function leadDeliveryRows(query: Query, after: string): Promise<StoredRow[]> {
	const rows = await query(
		`SELECT plugin_id, collection, id, data, created_at, updated_at FROM _plugin_storage WHERE plugin_id = ? AND (${AFTER("created_at")} OR ${AFTER("updated_at")}) ORDER BY created_at LIMIT 1000`,
		[LEAD_DELIVERY_PLUGIN, after, after],
	);
	return rows.map((row) => ({
		plugin_id: str(row.plugin_id),
		collection: str(row.collection),
		id: str(row.id),
		data: str(row.data),
		created_at: typeof row.created_at === "string" ? row.created_at : null,
		updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
	}));
}

/** Write rows back; D1 allows 100 bound values per query, so 16 rows at a time. */
export async function putBackRows(query: Query, rows: StoredRow[]): Promise<number> {
	let written = 0;
	for (let i = 0; i < rows.length; i += 16) {
		const batch = rows.slice(i, i + 16);
		const values = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
		await query(
			`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES ${values} ` +
				"ON CONFLICT (plugin_id, collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
			batch.flatMap((row) => [
				row.plugin_id,
				row.collection,
				row.id,
				row.data,
				row.created_at,
				row.updated_at,
			]),
		);
		written += batch.length;
	}
	return written;
}

export function pluginLabel(id: string): string {
	return id
		.split(/[-_]/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}
