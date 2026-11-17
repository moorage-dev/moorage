// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

/** A person, as the plugin context returns them. */
export type UserInfo = NonNullable<Awaited<ReturnType<NonNullable<PluginContext["users"]>["get"]>>>;
type ContentItem = NonNullable<Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>>;

import { approverRole, ROLE, type Config } from "./config.js";
import type { MailJob } from "./notify.js";
import {
	changedFields,
	fieldHashes,
	fingerprint,
	textCopy,
	type FieldInfo,
	type FieldText,
} from "./text.js";

export type Status = "waiting" | "sent_back" | "approved" | "published" | "closed";

export interface Person {
	id: string;
	name: string;
}

export interface HistoryEvent {
	at: string;
	text: string;
}

export interface Approval {
	by: Person;
	at: string;
	fingerprint: string;
	/** Storage id of the text copy in `versions`. */
	versionId: string;
	/** "Approve without review": the reason given. */
	override?: string;
	/** Published in the same step. */
	published?: boolean;
}

export interface ApprovalRequest {
	collection: string;
	entryId: string;
	title: string;
	status: Status;
	/** Who asked. Null when a scheduled run or another plugin made the request. */
	requestedBy: Person | null;
	requestedAt: string;
	/** Published by an AI tool: the person whose key it used may approve it. */
	ai: boolean;
	wants: "publish" | "schedule";
	scheduledAt?: string;
	/** The writer's note for the approver. */
	note?: string;
	/** The version waiting for approval. */
	fingerprint: string;
	/** Per-field hashes of that version, to name what a later save changed. */
	fields?: Record<string, string>;
	/** Approvers' edits while it waited. */
	edits?: Array<{ by: Person; at: string; fields: string[] }>;
	approval?: Approval;
	sentBack?: { by: Person; at: string; note: string };
	publishedAt?: string;
	/** The person who asked took the request back (status "closed"). */
	withdrawn?: { by: Person; at: string };
	/**
	 * When the approvers were last emailed about this request (at most once a day): set when
	 * the email task is queued, cleared by that task if the request was withdrawn before it ran.
	 */
	emailedAt?: string;
	/**
	 * What the waiting version lacks in the SEO panel, noted when it was saved or held, so the
	 * Approvals list can show "things to check" without reading every page.
	 */
	checks?: { description: boolean; picture: boolean };
	/**
	 * What the waiting version changes, noted when it was held or saved, so the Waiting list can
	 * say it without reading every page: not live before (a new page), or the fields (slugs) that
	 * differ from the live page. Missing on requests made before 0.5.0.
	 */
	changed?: { live: boolean; fields: string[] };
	/** An earlier release stored it as "Untitled" and its entry could not be read to name it. */
	nameTried?: boolean;
	/**
	 * "Approve and publish" pressed: the publish that follows records "Published by" and sends
	 * these emails (content:afterPublish), so the button itself stays within its calls.
	 */
	publishing?: { by: Person; at: string; jobs: MailJob[] };
	history: HistoryEvent[];
	updatedAt: string;
}

export interface ApprovedVersion {
	requestKey: string;
	at: string;
	by: string;
	title: string;
	fields: FieldText[];
}

const HISTORY_KEPT = 50;

export function requestKey(collection: string, id: string): string {
	return `${collection}:${id}`;
}

export function requests(ctx: PluginContext): StorageCollection<ApprovalRequest> {
	return ctx.storage.requests as StorageCollection<ApprovalRequest>;
}

export function versions(ctx: PluginContext): StorageCollection<ApprovedVersion> {
	return ctx.storage.versions as StorageCollection<ApprovedVersion>;
}

export function addHistory(request: ApprovalRequest, at: string, text: string): void {
	request.history = [{ at, text }, ...request.history].slice(0, HISTORY_KEPT);
	request.updatedAt = at;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface Draft {
	item: ContentItem;
	/** What would go live: the draft's data over the live data, and the draft's address. */
	data: Record<string, unknown>;
	slug: string | null;
	fingerprint: string;
	/** The live version, when the page is published. */
	live: { data: Record<string, unknown> } | null;
	/** The page's revision token for publishing, when read with `forPublish`. */
	rev?: string;
}

/**
 * Rebuild the version a publish would make live, the same way EmDash builds the publish
 * hook's content: draft revision data over the live data, `_` keys dropped, the draft's
 * address. The fingerprint must match the one the hook computes, or every approval is lost.
 *
 * `forPublish` reads the page with its revision token (getVersioned) instead of a plain read,
 * so publishing needs no further read. That read carries no SEO panel; `item.seo` is then
 * missing.
 */
export async function readDraft(
	ctx: PluginContext,
	collection: string,
	id: string,
	{ forPublish = false }: { forPublish?: boolean } = {},
): Promise<Draft | null> {
	let item: ContentItem | null | undefined;
	let rev: string | undefined;
	if (forPublish && ctx.content?.getVersioned) {
		const versioned = await ctx.content.getVersioned(collection, id);
		item = versioned?.item;
		rev = versioned?._rev;
	} else {
		item = await ctx.content?.get(collection, id);
	}
	if (!item) return null;
	const liveData = isRecord(item.data) ? item.data : {};
	let data: Record<string, unknown> = { ...liveData };
	let slug = item.slug;
	if (item.draftRevisionId && ctx.content?.getRevision) {
		const revision = await ctx.content.getRevision(collection, id, item.draftRevisionId);
		if (revision && isRecord(revision.data)) {
			for (const [key, value] of Object.entries(revision.data)) {
				if (!key.startsWith("_")) data[key] = value;
			}
			if (typeof revision.data._slug === "string") slug = revision.data._slug;
		}
	}
	data = Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith("_")));
	return {
		item,
		data,
		slug,
		fingerprint: await fingerprint(data, slug),
		live: item.status === "published" ? { data: liveData } : null,
		...(rev ? { rev } : {}),
	};
}

/**
 * What the SEO panel is missing on a version. EmDash includes `seo` with a page only when its
 * content type has the SEO panel; without it nothing is missing.
 */
export function seoGaps(
	seo: { description?: string | null; image?: unknown } | null | undefined,
	data: Record<string, unknown>,
): { description: boolean; picture: boolean } {
	if (!seo) return { description: false, picture: false };
	const excerpt = typeof data.excerpt === "string" && data.excerpt.trim() !== "";
	return {
		description: !(seo.description?.trim() || excerpt),
		picture: !seo.image,
	};
}

export interface CollectionInfo {
	label: string;
	fields: FieldInfo[];
	title: { slug: string; label: string } | null;
	/** Saves stay in a draft until Publish. Without it every save is live. */
	keepsDrafts: boolean;
	hasSeo: boolean;
}

export async function collectionInfo(ctx: PluginContext, slug: string): Promise<CollectionInfo> {
	const info = await ctx.schema?.getCollection(slug);
	if (!info) return { label: slug, fields: [], title: null, keepsDrafts: true, hasSeo: false };
	const fields = [...info.fields]
		.sort((a, b) => a.sortOrder - b.sortOrder)
		.map((f) => ({ slug: f.slug, label: f.label, type: f.type }));
	const titleSlug = info.titleField ?? (fields.some((f) => f.slug === "title") ? "title" : null);
	const titleField = fields.find((f) => f.slug === titleSlug);
	return {
		label: info.label,
		fields,
		title: titleSlug ? { slug: titleSlug, label: titleField?.label ?? "Title" } : null,
		keepsDrafts: info.supports.includes("revisions"),
		hasSeo: info.hasSeo,
	};
}

/** Text a field holds that can name an entry: a non-empty string, or a number. */
function nameText(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

/**
 * What an entry is called in lists, reviews and emails: its content type's declared title
 * field, else a field named title or name, else its slug, else its id. Never "Untitled": a
 * content type such as Releases may name its entries by a version and have no title at all.
 */
export function entryName(
	titleField: string | null | undefined,
	data: Record<string, unknown>,
	slug: string | null | undefined,
	id: string,
): string {
	return (
		(titleField ? nameText(data[titleField]) : null) ??
		nameText(data.title) ??
		nameText(data.name) ??
		(slug?.trim() || null) ??
		id
	);
}

/** An entry's name from its content type's info (see entryName). */
export function titleOf(
	info: Pick<CollectionInfo, "title">,
	data: Record<string, unknown>,
	slug: string | null | undefined,
	id: string,
): string {
	return entryName(info.title?.slug, data, slug, id);
}

/** The name an earlier release stored for an entry it could not name. */
export const UNNAMED = "Untitled";

/**
 * A request's name, read from its entry when an earlier release stored it as "Untitled": the
 * entry (one call) and, unless `titleField` is given, its content type (one more). The stored
 * name otherwise, or when the entry cannot be read.
 */
export async function nameNow(
	ctx: PluginContext,
	request: Pick<ApprovalRequest, "title" | "collection" | "entryId">,
	titleField?: string | null,
): Promise<string> {
	if (request.title !== UNNAMED || !ctx.content) return request.title;
	try {
		const item = await ctx.content.get(request.collection, request.entryId);
		if (!item) return request.title;
		const field =
			titleField !== undefined
				? titleField
				: (await ctx.schema?.getCollection(request.collection))?.titleField;
		return entryName(field, item.data ?? {}, item.slug, request.entryId);
	} catch {
		return request.title;
	}
}

export function copyOf(info: CollectionInfo, data: Record<string, unknown>): FieldText[] {
	return textCopy(info.fields, data, info.title);
}

/** A name inside a sentence: "an AI tool acting for Ellen Marsh", a person's name as it is. */
export function inSentence(name: string): string {
	return name.startsWith("An AI tool ") ? `a${name.slice(1)}` : name;
}

export function personName(user: Pick<UserInfo, "name" | "email"> | null | undefined): string {
	return user?.name?.trim() || user?.email || "Someone";
}

export interface ApproverPage {
	people: UserInfo[];
	/** More people to read after these, from this cursor. */
	next?: string;
}

/**
 * One page (up to 100) of the people who may approve under the settings, admins first,
 * without the person given. One call to the site. Under "Others need my OK" only admins are
 * read, so the page holds every approver on any site with up to 100 admins; under "I need
 * someone else's OK" it is the first 100 people. Emails read the further pages (notify.ts).
 */
export async function approverPage(
	ctx: PluginContext,
	config: Pick<Config, "preset">,
	except?: string | null,
	cursor?: string,
): Promise<ApproverPage> {
	return approverPageFor(ctx, approverRole(config.preset), except, cursor);
}

export async function approverPageFor(
	ctx: PluginContext,
	min: number,
	except?: string | null,
	cursor?: string,
): Promise<ApproverPage> {
	if (!ctx.users) return { people: [] };
	const result = await ctx.users.list({
		limit: 100,
		...(min >= ROLE.admin ? { role: ROLE.admin } : {}),
		...(cursor ? { cursor } : {}),
	});
	const people = result.items
		.filter((user) => user.role >= min && user.id !== except)
		.sort((a, b) => b.role - a.role || personName(a).localeCompare(personName(b)));
	return { people, ...(result.nextCursor ? { next: result.nextCursor } : {}) };
}

/** The approvers on the first page (see approverPage). One call to the site. */
export async function approvers(
	ctx: PluginContext,
	config: Pick<Config, "preset">,
	except?: string | null,
): Promise<UserInfo[]> {
	return (await approverPage(ctx, config, except)).people;
}

/** Whether this person may decide on this request. */
export function mayApprove(
	config: Config,
	request: Pick<ApprovalRequest, "requestedBy" | "ai">,
	user: { id: string; role: number } | undefined,
): boolean {
	if (!user || user.role < approverRole(config.preset)) return false;
	// Nobody approves their own request, except work from an AI tool on their key.
	return request.ai || request.requestedBy?.id !== user.id;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "16 Oct, 10:42 UTC". EmDash keeps the site's time zone (`site:timezone`) but does not pass
 * it to plugins (`ctx.site` has the name, address and locale only), so times are in UTC and
 * say so.
 */
export function when(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const mm = String(date.getUTCMinutes()).padStart(2, "0");
	return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

/** "4 hours ago", "1 day ago". */
export function ago(iso: string, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	const days = Math.round(hours / 24);
	return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** What a version changes against the live page's data (null: not live). */
export function liveChange(
	live: Record<string, unknown> | null,
	data: Record<string, unknown>,
): { live: boolean; fields: string[] } {
	if (!live) return { live: false, fields: [] };
	return { live: true, fields: changedFields(fieldHashes(live), fieldHashes(data)) };
}
