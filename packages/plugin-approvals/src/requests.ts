// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

/** A person, as the plugin context returns them. */
export type UserInfo = NonNullable<Awaited<ReturnType<NonNullable<PluginContext["users"]>["get"]>>>;
type ContentItem = NonNullable<Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>>;

import { approverRole, type Config } from "./config.js";
import { fingerprint, textCopy, type FieldInfo, type FieldText } from "./text.js";

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
	/** When the approvers were last emailed about this request (at most once a day). */
	emailedAt?: string;
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
}

/**
 * Rebuild the version a publish would make live, the same way EmDash builds the publish
 * hook's content: draft revision data over the live data, `_` keys dropped, the draft's
 * address. The fingerprint must match the one the hook computes, or every approval is lost.
 */
export async function readDraft(ctx: PluginContext, collection: string, id: string): Promise<Draft | null> {
	const item = await ctx.content?.get(collection, id);
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

export function titleOf(info: CollectionInfo, data: Record<string, unknown>, fallback: string): string {
	const value = info.title ? data[info.title.slug] : data.title;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

export function copyOf(info: CollectionInfo, data: Record<string, unknown>): FieldText[] {
	return textCopy(info.fields, data, info.title);
}

export function personName(user: Pick<UserInfo, "name" | "email"> | null | undefined): string {
	return user?.name?.trim() || user?.email || "Someone";
}

/** Everyone who may approve under the settings, admins first. Excludes the person given. */
export async function approvers(ctx: PluginContext, config: Config, except?: string | null): Promise<UserInfo[]> {
	if (!ctx.users) return [];
	const min = approverRole(config.preset);
	const found: UserInfo[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 5; page++) {
		const result = await ctx.users.list({ limit: 100, ...(cursor ? { cursor } : {}) });
		for (const user of result.items) {
			if (user.role >= min && user.id !== except) found.push(user);
		}
		cursor = result.nextCursor;
		if (!cursor) break;
	}
	return found.sort((a, b) => b.role - a.role || personName(a).localeCompare(personName(b)));
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

/** "16 Oct, 10:42" in UTC: the plugin cannot know the reader's time zone. */
export function when(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const mm = String(date.getUTCMinutes()).padStart(2, "0");
	return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}, ${hh}:${mm}`;
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
