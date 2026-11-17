// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import type { SandboxedPlugin } from "emdash/plugin";

import { approve, ask, mayApproveAsAgent, sendBack, type Decision } from "./actions.js";
import { isApprover, loadLists, visible } from "./admin.js";
import { isHeldRole, loadConfig, ROLE, type Config } from "./config.js";
import type { UserInfo } from "./requests.js";
import {
	collectionInfo,
	copyOf,
	nameNow,
	readDraft,
	titleOf,
	UNNAMED,
	requestKey,
	requests,
	type ApprovalRequest,
	type Draft,
} from "./requests.js";
import { describeTextChange } from "./text.js";
import { canDecide } from "./views.js";

/**
 * MCP tools. queue and status (read-only): what the Approvals page and the editor's Approval
 * panel show, for the person whose key the AI tool uses. changes (read-only), approve and
 * send_back: for a reviewer that is an AI tool; approve and send_back act only when an Admin has
 * switched on "AI tools may approve". ask_approval: ask without a publish. EmDash checks the
 * route's permission and the token's scope first; the handlers then apply the plugin's own rules.
 */

export const QUEUE_ROUTE = "mcp/queue";
export const STATUS_ROUTE = "mcp/status";
export const CHANGES_ROUTE = "mcp/changes";
export const APPROVE_ROUTE = "mcp/approve";
export const SEND_BACK_ROUTE = "mcp/send-back";
export const ASK_ROUTE = "mcp/ask";

const HISTORY_LINES = 10;
/** Requests stored as "Untitled" by an earlier release that queue names per call (one read each). */
const QUEUE_NAMED = 10;

/** The entry: a content type and an id, or a request id from the queue ("pages:01J…"). */
const TARGET = {
	collection: {
		type: "string",
		minLength: 1,
		description: "The content type's slug, for example pages or posts.",
	},
	id: { type: "string", minLength: 1, description: "The entry's id." },
	request: {
		type: "string",
		minLength: 3,
		description: "Instead of collection and id: the request id, collection:id.",
	},
};

type McpTool = NonNullable<SandboxedPlugin["mcp"]>["tools"][string];

/**
 * Plain JSON Schema: `emdash-plugin build` copies it into the manifest as it is, so no schema
 * library is bundled. The type says Zod; EmDash accepts either.
 */
const schema = (value: Record<string, unknown>) => value as unknown as McpTool["input"];

export const tools: Record<string, McpTool> = {
	queue: {
		description:
			"List the pages waiting for approval on this site: the ones waiting for you to approve, and your own that wait for someone else. For each: title, content type, entry id, who asked, when, and whether it is to publish or to schedule. Read-only.",
		route: QUEUE_ROUTE,
		input: schema({ type: "object", properties: {}, additionalProperties: false }),
		destructive: false,
	},
	status: {
		description:
			"Show the approval state of one entry, as its Approval panel does: whether publishing it needs approval, whether a request is waiting, approved, sent back or published, by whom and when, and the latest history lines. Read-only.",
		route: STATUS_ROUTE,
		input: schema({
			type: "object",
			properties: {
				collection: {
					type: "string",
					minLength: 1,
					description: "The content type's slug, for example pages or posts.",
				},
				id: { type: "string", minLength: 1, description: "The entry's id." },
			},
			required: ["collection", "id"],
			additionalProperties: false,
		}),
		destructive: false,
	},
	changes: {
		description:
			"Show what a request waiting for approval would change on one entry, field by field: the text live now and the text that would go live, or every filled-in field when the entry is not live yet. Give collection and id, or the request id. Also returns the version to pass to approve. A field longer than 2,000 characters is truncated to the part that changed and marked truncated: true with its full length. Compares the entry's own fields only: not its SEO panel, categories, tags, bylines or menus; pictures and files are named as changed, not shown. Only for an entry that has a request. Read-only.",
		route: CHANGES_ROUTE,
		input: schema({ type: "object", properties: TARGET, additionalProperties: false }),
		destructive: false,
	},
	approve: {
		description:
			'Approve a page that waits for approval, for the person whose key you use, and publish it now (publish: false approves only; it then goes live when someone presses Publish). With publish true, a request to schedule is published now, not at its time; pass publish: false to leave the scheduling to its writer. The result says whether it was published. Call changes first and pass its version: only that version is approved. Works only when the site\'s Admin has switched on "AI tools may approve"; otherwise it refuses and says where. Recorded as approved by an AI tool acting for that person; the writer is told. Never deletes anything.',
		route: APPROVE_ROUTE,
		input: schema({
			type: "object",
			properties: {
				...TARGET,
				version: {
					type: "string",
					minLength: 1,
					description: "The version from changes (required): refused if the page changed since.",
				},
				publish: {
					type: "boolean",
					description: "Publish now (default true), or approve only.",
				},
			},
			required: ["version"],
			additionalProperties: false,
		}),
		destructive: true,
	},
	send_back: {
		description:
			'Send a page that waits for approval back to its writer, with a reason saying what should change. Works only when the site\'s Admin has switched on "AI tools may approve"; otherwise it refuses and says where. Recorded as sent back by an AI tool acting for the person whose key you use; the writer gets the reason. Nothing is published or deleted.',
		route: SEND_BACK_ROUTE,
		input: schema({
			type: "object",
			properties: {
				...TARGET,
				reason: { type: "string", minLength: 1, description: "What should change." },
			},
			required: ["reason"],
			additionalProperties: false,
		}),
		destructive: true,
	},
	ask_approval: {
		description:
			"Ask for approval of a saved draft without trying to publish it, for example when you have finished writing it. The approvers are told; a person, or an AI tool where the site allows it, then approves and publishes it. Give collection and id. Never publishes.",
		route: ASK_ROUTE,
		input: schema({
			type: "object",
			properties: { collection: TARGET.collection, id: TARGET.id },
			required: ["collection", "id"],
			additionalProperties: false,
		}),
		destructive: false,
	},
};

const EMAIL = /[^\s"'<>(),;:]+@[^\s"'<>(),;:]+\.[^\s"'<>(),;:]+/g;

/** A name as stored, never an email address: a person without a name is stored by address. */
function nameOnly(name: string | undefined | null): string | null {
	if (!name) return null;
	return name.replace(EMAIL, "") === name ? name : "Someone";
}

/** Any text with email addresses taken out. */
function noEmail(text: string): string {
	return text.replace(EMAIL, "someone");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function thingsToCheck(config: Config | null, request: ApprovalRequest): string[] {
	if (!config || config.checks === "off" || !request.checks) return [];
	return [
		...(request.checks.description ? ["search description"] : []),
		...(request.checks.picture ? ["sharing picture"] : []),
	];
}

function asked(request: ApprovalRequest) {
	return {
		askedBy: nameOnly(request.requestedBy?.name),
		fromAiTool: request.ai,
		askedAt: request.requestedAt,
		kind: request.wants,
		...(request.scheduledAt ? { scheduledAt: request.scheduledAt } : {}),
	};
}

/** The waiting pages, as the Approvals page's Waiting tab lists them for this person. 3 calls. */
export async function queueTool(ctx: PluginContext, user: UserInfo | undefined) {
	const config = await loadConfig(ctx);
	const lists = await loadLists(ctx);
	const collections = (await ctx.schema?.listCollections()) ?? [];
	const names = new Map(collections.map((c) => [c.slug, c.label]));
	const approver = isApprover(config, user);
	const waiting = visible(config, user, lists.waiting);
	const sentBack = visible(config, user, lists.sentBack);
	const forYou = config ? waiting.filter((r) => canDecide(config, r, user)) : [];
	const yours = waiting.filter((r) => !forYou.includes(r));
	// Requests an earlier release stored as "Untitled": named from their entry, a few per call.
	const titleFields = new Map(collections.map((c) => [c.slug, c.titleField]));
	const unnamed = [...forYou, ...yours].filter((r) => r.title === UNNAMED).slice(0, QUEUE_NAMED);
	for (const request of unnamed)
		request.title = await nameNow(ctx, request, titleFields.get(request.collection) ?? null);
	const row = (request: ApprovalRequest) => ({
		title: noEmail(request.title),
		collection: request.collection,
		collectionLabel: names.get(request.collection) ?? request.collection,
		id: request.entryId,
		...asked(request),
		thingsToCheck: thingsToCheck(config, request),
	});
	return {
		approvalOn: config !== null,
		...(approver || !config ? { forYou: forYou.map(row) } : {}),
		yours: yours.map(row),
		counts: approver
			? { forYou: forYou.length, yours: yours.length, sentBack: sentBack.length }
			: { yours: yours.length, sentBack: sentBack.length },
	};
}

const NOT_YOURS = { error: "You can see the approval of your own pages only." };

/** One entry's approval, as its Approval panel shows it. 5 calls at most. */
export async function statusTool(ctx: PluginContext, user: UserInfo | undefined, input: unknown) {
	const raw = isRecord(input) ? input : {};
	const collection = typeof raw.collection === "string" ? raw.collection.trim() : "";
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!collection || !id)
		return { error: "Give the content type (collection) and the entry's id." };
	// The panel opens for people who can read drafts (Contributors and up).
	if (!user || user.role < ROLE.contributor) return NOT_YOURS;

	const config = await loadConfig(ctx);
	const request = await requests(ctx).get(requestKey(collection, id));
	let draft: Draft | null = null;
	try {
		draft = await readDraft(ctx, collection, id);
	} catch {
		draft = null;
	}
	if (!draft) return { error: `No entry "${noEmail(id)}" in ${noEmail(collection)}.` };
	// Below Editor, only one's own pages, as on the Approvals page.
	if (
		user.role < ROLE.editor &&
		draft.item.authorId !== user.id &&
		request?.requestedBy?.id !== user.id
	)
		return NOT_YOURS;
	const info = await collectionInfo(ctx, collection);

	const typeHeld = Boolean(config?.collections.includes(collection));
	const youHeld = typeHeld && isHeldRole(config!.preset, user.role);
	// A request an earlier release stored as "Untitled" is named as the page names it now.
	const title =
		request && request.title !== UNNAMED
			? request.title
			: titleOf(info, draft.data, draft.slug, id);
	const base = {
		collection,
		collectionLabel: info.label,
		id,
		title: noEmail(title),
		approvalOn: typeHeld,
		needsApproval: {
			whenYouPublish: youHeld,
			whenAnAiToolPublishes: Boolean(config && (config.ai || youHeld)),
		},
	};
	if (!request) return { ...base, state: "none" };
	const state =
		request.status === "closed" ? (request.withdrawn ? "withdrawn" : "closed") : request.status;
	const approval = request.approval;
	return {
		...base,
		state,
		...asked(request),
		...(request.note ? { note: noEmail(request.note) } : {}),
		...(request.status === "waiting" && config
			? { youMayDecide: canDecide(config, request, user) }
			: {}),
		...(approval
			? {
					approvedBy: nameOnly(approval.by.name),
					approvedAt: approval.at,
					...(approval.override !== undefined
						? { approvedWithoutReview: noEmail(approval.override) }
						: {}),
					changedSinceApproval: approval.fingerprint !== draft.fingerprint,
				}
			: {}),
		...(request.sentBack
			? {
					sentBack: {
						by: nameOnly(request.sentBack.by.name),
						at: request.sentBack.at,
						note: noEmail(request.sentBack.note),
					},
				}
			: {}),
		...(request.publishedAt ? { publishedAt: request.publishedAt } : {}),
		...(request.withdrawn ? { withdrawnAt: request.withdrawn.at } : {}),
		history: request.history
			.slice(0, HISTORY_LINES)
			.map((event) => ({ at: event.at, text: noEmail(event.text) })),
	};
}

/** The entry a tool is about: collection and id, or a request id "collection:id". */
function target(input: unknown): { collection: string; id: string } | null {
	const raw = isRecord(input) ? input : {};
	const request = typeof raw.request === "string" ? raw.request.trim() : "";
	if (request) {
		const at = request.indexOf(":");
		if (at > 0 && at < request.length - 1)
			return { collection: request.slice(0, at), id: request.slice(at + 1) };
		return null;
	}
	const collection = typeof raw.collection === "string" ? raw.collection.trim() : "";
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	return collection && id ? { collection, id } : null;
}

const NO_TARGET = {
	error:
		"Give the content type (collection) and the entry's id, or the request id (collection:id).",
};

/** Longest text returned for one field, before or after. */
const FIELD_CHARS = 2000;
/** Unchanged text kept on each side of a change in a long field. */
const CONTEXT_CHARS = 300;

interface FieldShown {
	before: string | null;
	after: string | null;
	change: string;
	/** Set when a text was longer than FIELD_CHARS and only part of it is returned. */
	truncated?: true;
	beforeLength?: number;
	afterLength?: number;
}

/** The start of the word at `at` (back to the last space). */
function wordStart(text: string, at: number): number {
	const space = text.lastIndexOf(" ", Math.max(0, at - 1));
	return space < 0 ? 0 : space + 1;
}

/** The end of the word at `at` (on to the next space). */
function wordEnd(text: string, at: number): number {
	const space = text.indexOf(" ", at);
	return space < 0 ? text.length : space;
}

/** A part of a text, marked with "…" where it was cut. */
function part(text: string, from: number, to: number): string {
	const end = Math.min(to, from + FIELD_CHARS);
	return `${from > 0 ? "…" : ""}${text.slice(from, end)}${end < text.length ? "…" : ""}`;
}

/**
 * One changed text field. Short texts come back whole. A text longer than FIELD_CHARS comes back
 * as the part that changed, with some unchanged text around it, cut with "…", and says so
 * (truncated, and both full lengths), so a reviewer always knows when it has not seen everything.
 */
export function shownChange(old: string, now: string): FieldShown {
	if (old.length <= FIELD_CHARS && now.length <= FIELD_CHARS) {
		return {
			before: old === "" ? null : old,
			after: now === "" ? null : now,
			change: `${describeTextChange(old, now, "future")}.`,
		};
	}
	let same = 0;
	const shortest = Math.min(old.length, now.length);
	while (same < shortest && old[same] === now[same]) same++;
	let tail = 0;
	while (tail < shortest - same && old[old.length - 1 - tail] === now[now.length - 1 - tail])
		tail++;
	const start = wordStart(old, same);
	const oldEnd = wordEnd(old, old.length - tail);
	const nowEnd = wordEnd(now, now.length - tail);
	const from = wordStart(old, Math.max(0, start - CONTEXT_CHARS));
	return {
		before: old === "" ? null : part(old, from, oldEnd + CONTEXT_CHARS),
		after: now === "" ? null : part(now, from, nowEnd + CONTEXT_CHARS),
		change: `${describeTextChange(old.slice(start, oldEnd), now.slice(start, nowEnd), "future")}.`,
		truncated: true,
		beforeLength: old.length,
		afterLength: now.length,
	};
}

function clip(text: string): { text: string; truncated?: true; length?: number } {
	return text.length > FIELD_CHARS
		? { text: `${text.slice(0, FIELD_CHARS)}…`, truncated: true, length: text.length }
		: { text };
}

export const NOT_SHOWN =
	"Compares the entry's own fields as text. A field longer than 2,000 characters is truncated: only the part that changed is returned, with some text around it, marked truncated: true with the full lengths (beforeLength, afterLength); open the entry to read all of it. Not shown: the SEO panel (search title, description, sharing picture), categories, tags, bylines and menus; pictures and files are named as changed, not shown; formatting and link addresses inside rich text are left out, only its words are shown.";

/**
 * What a request would change, field by field. 5 calls: settings, the request, the page (2),
 * its content type.
 */
export async function changesTool(ctx: PluginContext, user: UserInfo | undefined, input: unknown) {
	const where = target(input);
	if (!where) return NO_TARGET;
	const { collection, id } = where;
	if (!user || user.role < ROLE.contributor) return NOT_YOURS;
	const config = await loadConfig(ctx);
	const request = await requests(ctx).get(requestKey(collection, id));
	let draft: Draft | null = null;
	try {
		draft = await readDraft(ctx, collection, id);
	} catch {
		draft = null;
	}
	if (!draft) return { error: `No entry "${noEmail(id)}" in ${noEmail(collection)}.` };
	if (
		user.role < ROLE.editor &&
		draft.item.authorId !== user.id &&
		request?.requestedBy?.id !== user.id
	)
		return NOT_YOURS;
	if (!request) return { error: "Nothing waits for approval on this entry: it has no request." };
	const info = await collectionInfo(ctx, collection);
	const after = copyOf(info, draft.data);
	const before = draft.live ? new Map(copyOf(info, draft.live.data).map((f) => [f.slug, f])) : null;
	const fields: Array<{ field: string; label: string } & FieldShown> = [];
	for (const field of after) {
		const was = before?.get(field.slug);
		before?.delete(field.slug);
		if (!before) {
			if (field.text !== "") {
				const shown = clip(field.text);
				fields.push({
					field: field.slug,
					label: field.label,
					before: null,
					after: shown.text,
					change: "new",
					...(shown.truncated ? { truncated: true, afterLength: shown.length } : {}),
				});
			}
			continue;
		}
		if (field.picture) {
			if ((was?.value ?? "") !== (field.value ?? ""))
				fields.push({
					field: field.slug,
					label: field.label,
					before: was?.text || null,
					after: field.text || null,
					change: "picture or file changed",
				});
			continue;
		}
		const old = was?.text ?? "";
		if (old === field.text) continue;
		fields.push({ field: field.slug, label: field.label, ...shownChange(old, field.text) });
	}
	for (const gone of before?.values() ?? []) {
		if (gone.text !== "") {
			const shown = clip(gone.text);
			fields.push({
				field: gone.slug,
				label: gone.label,
				before: shown.text,
				after: null,
				change: "removed.",
				...(shown.truncated ? { truncated: true, beforeLength: shown.length } : {}),
			});
		}
	}
	const waiting = request?.status === "waiting";
	return {
		collection,
		collectionLabel: info.label,
		id,
		title: noEmail(
			request && request.title !== UNNAMED
				? request.title
				: titleOf(info, draft.data, draft.slug, id),
		),
		state: request ? request.status : "none",
		liveNow: draft.live !== null,
		comparedWith: draft.live ? "the live page" : "nothing: the entry is not live",
		version: draft.fingerprint,
		...(waiting && config
			? {
					youMayDecide: canDecide(config, request, user) || mayApproveAsAgent(config, user),
					aiMayDecide: config.aiApprove,
				}
			: {}),
		fields,
		notShown: NOT_SHOWN,
	};
}

export const AI_OFF =
	"AI tools may not approve or send back on this site. An Admin can switch this on in Approvals > Settings: AI tools may approve.";
const NOT_MCP =
	"This works only through an AI tool connected with MCP. People decide on the Approvals page.";

/** Whether EmDash's MCP server made this call: it passes on the request it got, at /_emdash/api/mcp. */
export function viaMcp(request: { url?: string } | undefined): boolean {
	try {
		return /\/_emdash\/api\/mcp\/?$/.test(new URL(request?.url ?? "").pathname);
	} catch {
		return false;
	}
}

/**
 * Approve (and publish) or send back, for an AI tool acting for `user`. The same checks as the
 * Approvals page, except that the person may decide their own requests, when an Admin has
 * switched on "AI tools may approve". At most 9 calls: settings, then approve() or sendBack().
 */
export async function decideTool(
	ctx: PluginContext,
	user: UserInfo | undefined,
	input: unknown,
	request: { url?: string } | undefined,
	kind: "approve" | "send_back",
) {
	const config = await loadConfig(ctx);
	if (!config) return { error: "Approval is off on this site: nothing waits for approval." };
	if (!config.aiApprove) return { error: AI_OFF };
	if (!viaMcp(request)) return { error: NOT_MCP };
	const where = target(input);
	if (!where) return NO_TARGET;
	const raw = isRecord(input) ? input : {};
	const key = requestKey(where.collection, where.id);
	let decision: Decision;
	if (kind === "approve") {
		const version = typeof raw.version === "string" ? raw.version.trim() : "";
		if (!version)
			return {
				error:
					"Give the version: call changes first and pass its version, so only what you checked is approved.",
			};
		decision = await approve(ctx, config, user, key, {
			seen: version,
			publish: raw.publish !== false,
			agent: true,
		});
	} else {
		const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
		if (!reason) return { error: "Give the reason: what should change." };
		decision = await sendBack(ctx, config, user, key, reason, undefined, true);
	}
	const state = decision.request?.status;
	const title = decision.request ? noEmail(decision.request.title) : undefined;
	if (!decision.ok)
		return {
			error: noEmail(decision.message),
			...(state ? { state } : {}),
			...(title ? { title } : {}),
		};
	const published = state === "published";
	const scheduleNote =
		kind === "approve" && decision.request?.wants === "schedule"
			? published
				? " This was a request to schedule; it is published now."
				: " This was a request to schedule; its writer can schedule it now."
			: "";
	return {
		ok: true,
		message: `${noEmail(decision.message)}${scheduleNote}`,
		...(state ? { state } : {}),
		...(kind === "approve" ? { published } : {}),
		...(title ? { title } : {}),
	};
}

/** Ask for approval without a publish, as from an AI tool. At most 9 calls (see ask()). */
export async function askTool(
	ctx: PluginContext,
	user: UserInfo | undefined,
	input: unknown,
	request: { url?: string } | undefined,
) {
	if (!viaMcp(request)) return { error: NOT_MCP };
	const raw = isRecord(input) ? input : {};
	const collection = typeof raw.collection === "string" ? raw.collection.trim() : "";
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!collection || !id)
		return { error: "Give the content type (collection) and the entry's id." };
	const toast = await ask(ctx, await loadConfig(ctx), user, collection, id, true);
	return { ok: toast.type !== "error", message: noEmail(toast.message) };
}
