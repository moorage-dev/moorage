// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";

import type { Config } from "./config.js";
import type { UserInfo } from "./requests.js";
import { ago, requestKey, when, type ApprovalRequest } from "./requests.js";
import { canDecide } from "./views.js";

/**
 * Deciding from the Waiting list without opening each review.
 *
 * - Each row: "Approve and publish" (EmDash's confirm dialog first) and Review.
 * - Above the rows, for two or more: "Approve and publish all N", one press and one confirm.
 *   The button carries the requests it was drawn with (key and version), so the press decides
 *   exactly those: one added in another tab since is not included, one changed is skipped.
 * - Under the rows: tick boxes and a note in one form. Block Kit gives a form one submit button
 *   and no confirm dialog, so Continue shows the ticked ones once, with "Approve and publish N"
 *   and, when a note was written, "Send back N".
 * The press decides what fits at once and sends the rest to the background (runs.ts, rows.ts),
 * with the same checks as a single decision: who may decide, still waiting, and unchanged since
 * the list was shown.
 */

export const BULK = {
	review: "bulk_review",
	go: "bulk_go",
	back: "bulk_back",
	all: "bulk_all",
	row: "row_approve",
} as const;

export type BulkDo = "publish" | "send_back";

/** One ticked request: its key and the version the list showed. */
export interface BulkItem {
	key: string;
	seen: string;
	title?: string;
}

/** The Waiting tab's form as it should open: what is ticked, and the choice made. */
export interface BulkState {
	ticked: Set<string>;
	do?: BulkDo;
	reason?: string;
}

/** Most requests one form carries: the Approvals page lists 200 at most. */
const MAX_ITEMS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A tick box's value: the request's key and the version shown ("pages:01J…@3fa2…"). */
export function optionValue(request: ApprovalRequest): string {
	return `${requestKey(request.collection, request.entryId)}@${request.fingerprint}`;
}

function readOption(value: unknown): BulkItem | null {
	if (typeof value !== "string") return null;
	const at = value.lastIndexOf("@");
	if (at <= 0 || at === value.length - 1) return null;
	return { key: value.slice(0, at), seen: value.slice(at + 1) };
}

export function readItems(value: unknown): BulkItem[] {
	const list = Array.isArray(value) ? value : [];
	const items: BulkItem[] = [];
	const keys = new Set<string>();
	for (const entry of list) {
		const item = isRecord(entry)
			? typeof entry.key === "string" && typeof entry.seen === "string"
				? { key: entry.key, seen: entry.seen }
				: null
			: readOption(entry);
		if (!item || keys.has(item.key)) continue;
		keys.add(item.key);
		items.push(item);
		if (items.length >= MAX_ITEMS) break;
	}
	return items;
}

export function readDo(value: unknown): BulkDo {
	return value === "send_back" ? "send_back" : "publish";
}

/** "new page", "changed: Content, Title and 2 more", or null when not known. */
export function changedText(
	request: ApprovalRequest,
	labels: Map<string, string> | undefined,
): string | null {
	const changed = request.changed;
	if (!changed) return null;
	if (!changed.live) return "new page";
	if (changed.fields.length === 0) return null;
	const names = changed.fields.map((slug) => labels?.get(slug) ?? slug);
	const shown = names.slice(0, 3);
	return `changed: ${shown.join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
}

export function askerText(request: ApprovalRequest): string {
	return request.ai
		? `from an AI tool (${request.requestedBy?.name ?? "someone"}'s key)`
		: `asked by ${request.requestedBy?.name ?? "a scheduled publish"}`;
}

export function wantsText(request: ApprovalRequest): string {
	return request.wants === "schedule"
		? `to schedule${request.scheduledAt ? ` for ${when(request.scheduledAt)}` : ""}`
		: "to publish";
}

export interface Names {
	/** Content type labels by slug. */
	types: Map<string, string>;
	/** Field labels by content type, then field slug. */
	fields: Map<string, Map<string, string>>;
}

/** One tick box's words: name · type · who, when · publish or schedule · what changed. */
function optionLabel(request: ApprovalRequest, names: Names): string {
	return [
		request.title,
		names.types.get(request.collection) ?? request.collection,
		`${askerText(request)}, ${ago(request.requestedAt)}`,
		wantsText(request),
		changedText(request, names.fields.get(request.collection)),
	]
		.filter(Boolean)
		.join(" · ");
}

let stamp = 0;

/** What the row's button says: a request to schedule is approved, not published. */
function rowVerb(request: ApprovalRequest): string {
	return request.wants === "schedule" ? "Approve" : "Approve and publish";
}

/** A row's buttons, for a request this person may decide: Approve and publish, and Review. */
export function rowActions(request: ApprovalRequest, reviewAction: string): Block {
	const key = requestKey(request.collection, request.entryId);
	const verb = rowVerb(request);
	return {
		type: "actions",
		elements: [
			{
				type: "button",
				action_id: BULK.row,
				label: verb,
				style: "primary",
				value: { key, seen: request.fingerprint },
				confirm: {
					title: `${verb} "${request.title}"?`,
					text:
						request.wants === "schedule"
							? "It is approved, not published: its writer then schedules it."
							: "It goes live now. If it changed since this list was drawn, nothing happens and you can review it again.",
					confirm: verb,
					deny: "Cancel",
				},
			},
			{ type: "button", action_id: reviewAction, label: "Review", value: { key } },
		],
	};
}

/** "Approve and publish all N", above the rows, for two or more waiting for this person. */
export function allBlocks(forYou: ApprovalRequest[]): Block[] {
	if (forYou.length < 2) return [];
	const n = forYou.length;
	const schedules = forYou.filter((r) => r.wants === "schedule").length;
	const live = n - schedules;
	const text = [
		live > 0
			? `${live === n ? `All ${n}` : live} ${live === 1 ? "page goes" : "pages go"} live now, oldest first.`
			: "",
		schedules > 0
			? `${schedules === n ? `All ${n}` : schedules} ${schedules === 1 ? "is a request" : "are requests"} to schedule: approved, not published; ${schedules === 1 ? "its writer then schedules it" : "their writers then schedule them"}.`
			: "",
		"A page that changed since this list was drawn is skipped and stays here.",
	]
		.filter(Boolean)
		.join(" ");
	return [
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: BULK.all,
					label: `Approve and publish all ${n}`,
					value: { rows: forYou.map((r) => optionValue(r)) },
					confirm: {
						title: `Approve and publish all ${n}?`,
						text,
						confirm: `Approve and publish ${n}`,
						deny: "Cancel",
					},
				},
			],
		},
	];
}

/**
 * The form under the Waiting rows, for two or more requests this person may decide (or one
 * left ticked after a decision on several that could not decide it). Its id changes with each
 * drawing: EmDash keeps a form's values while its id stays, so a list drawn again with every
 * box ticked must be a new form to submit what it shows.
 */
export function bulkBlocks(
	forYou: ApprovalRequest[],
	names: Names,
	state: BulkState | undefined,
): Block[] {
	// One request is decided from its row, unless it is one left ticked after a decision.
	if (forYou.length === 0 || (forYou.length === 1 && !state?.ticked.size)) return [];
	const values = forYou.map((r) => optionValue(r));
	const ticked = values.filter((v) => state?.ticked.has(readOption(v)!.key));
	stamp = (stamp + 1) % 1_000_000;
	return [
		{ type: "header", text: "Choose several" },
		{
			type: "form",
			block_id: `bulk-${Date.now().toString(36)}-${stamp}`,
			fields: [
				{
					type: "checkbox",
					action_id: "pick",
					label: "Tick the pages, oldest first",
					options: forYou.map((r, i) => ({ label: optionLabel(r, names), value: values[i]! })),
					initial_value: ticked,
				},
				{
					type: "text_input",
					action_id: "reason",
					label: "Note to the writers, to send them back (the same note to each)",
					multiline: true,
					...(state?.reason ? { initial_value: state.reason } : {}),
				},
			],
			submit: { label: "Continue with the ticked pages", action_id: BULK.review },
		},
	];
}

/** "these 3", "this one". */
function these(n: number): string {
	return n === 1 ? "this one" : `these ${n}`;
}

const VERB: Record<BulkDo, string> = { publish: "Approve and publish", send_back: "Send back" };

/**
 * The confirm step: what was ticked, in the order it will be decided (oldest first), with the
 * button that decides them. Requests no longer waiting for this person are left out and counted.
 * Drawn from one read of the list.
 */
export function confirmView(input: {
	config: Config;
	user: UserInfo | undefined;
	items: BulkItem[];
	waiting: ApprovalRequest[];
	names: Names;
	reason: string;
	/** When this selection is stored: the button starts it and nothing else. */
	at: string;
}): { response: BlockResponse; rows: BulkItem[] } {
	const { config, user, names } = input;
	const byKey = new Map(input.waiting.map((r) => [requestKey(r.collection, r.entryId), r]));
	const chosen = input.items
		.map((item) => ({ item, request: byKey.get(item.key) }))
		.filter(
			(row): row is { item: BulkItem; request: ApprovalRequest } =>
				row.request !== undefined && canDecide(config, row.request, user),
		)
		.sort((a, b) => a.request.requestedAt.localeCompare(b.request.requestedAt));
	const gone = input.items.length - chosen.length;
	const blocks: Block[] = [{ type: "header", text: "Approvals" }];
	if (chosen.length === 0) {
		blocks.push(
			{
				type: "section",
				text: "None of those is waiting for you any more. Someone may have decided them.",
			},
			{
				type: "actions",
				elements: [{ type: "button", action_id: BULK.back, label: "‹ Back to the list" }],
			},
		);
		return { response: { blocks }, rows: [] };
	}
	blocks.push({ type: "header", text: `Decide ${these(chosen.length)}?` });
	if (input.reason !== "")
		blocks.push({
			type: "section",
			text: `Your note, if you send them back: "${input.reason}"`,
		});
	for (const { request } of chosen) {
		blocks.push(
			{ type: "section", text: request.title },
			{
				type: "context",
				text: [
					names.types.get(request.collection) ?? request.collection,
					askerText(request),
					wantsText(request),
					changedText(request, names.fields.get(request.collection)),
				]
					.filter(Boolean)
					.join(" · "),
			},
		);
	}
	const notes: string[] = [];
	if (gone > 0)
		notes.push(
			`${gone} of those ${gone === 1 ? "is" : "are"} no longer waiting for you, so ${gone === 1 ? "it is" : "they are"} left out.`,
		);
	if (chosen.some((row) => row.request.wants === "schedule"))
		notes.push("A request to schedule is approved, not published: its writer then schedules it.");
	notes.push("Oldest first. A page that changed since this list was drawn is skipped.");
	notes.push(
		"A few are decided at once; any more follow in the background, and Waiting shows how far it is.",
	);
	if (input.reason === "") notes.push("To send them back instead, go back and write a note.");
	const n = chosen.length;
	blocks.push(
		{ type: "context", text: notes.join(" ") },
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: BULK.go,
					label: `${VERB.publish} ${n}`,
					style: "primary",
					value: { pick: input.at, do: "publish" },
				},
				...(input.reason !== ""
					? [
							{
								type: "button" as const,
								action_id: BULK.go,
								label: `${VERB.send_back} ${n}`,
								value: { pick: input.at, do: "send_back" },
							},
						]
					: []),
				{ type: "button", action_id: BULK.back, label: "‹ Back to the list" },
			],
		},
	);
	return {
		response: { blocks },
		rows: chosen.map((row) => ({ ...row.item, title: row.request.title })),
	};
}
