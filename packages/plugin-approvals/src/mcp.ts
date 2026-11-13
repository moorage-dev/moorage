// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import type { SandboxedPlugin } from "emdash/plugin";

import { isApprover, loadLists, visible } from "./admin.js";
import { isHeldRole, loadConfig, ROLE, type Config } from "./config.js";
import type { UserInfo } from "./requests.js";
import {
	collectionInfo,
	readDraft,
	requestKey,
	requests,
	type ApprovalRequest,
	type Draft,
} from "./requests.js";
import { canDecide } from "./views.js";

/**
 * Two MCP tools, read-only: what the Approvals page and the editor's Approval panel show, for
 * the person whose key the AI tool uses. EmDash checks the route's permission and the token's
 * scope first; these handlers then show each role only what the plugin's own pages show it.
 */

export const QUEUE_ROUTE = "mcp/queue";
export const STATUS_ROUTE = "mcp/status";

const HISTORY_LINES = 10;

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
	const title = request?.title ?? (typeof draft.data.title === "string" ? draft.data.title : id);
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
