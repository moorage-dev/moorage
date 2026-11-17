// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";

import type { Config } from "./config.js";
import type { UserInfo } from "./requests.js";
import { ago, requestKey, when, type ApprovalRequest } from "./requests.js";
import { canDecide } from "./views.js";

/**
 * Deciding several waiting requests at once, from the Waiting tab.
 *
 * Block Kit has no tick box per row and no table selection, so the Waiting tab keeps its rows
 * (each with Review) and adds one form under them: "Only the ones I tick" or "All N waiting for
 * you", one tick box group with an option per request, what to do and, for Send back, one shared
 * note. Check selection shows the list and stores it; the button there starts the background
 * run that decides them (runs.ts, rows.ts), with the same checks as a single decision: who may
 * decide, still waiting, and unchanged since the list was shown.
 */

export const BULK = {
	review: "bulk_review",
	go: "bulk_go",
	back: "bulk_back",
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
	which?: "ticked" | "all";
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

/**
 * The form under the Waiting rows, for two or more requests this person may decide (or one
 * left ticked after a bulk decision that could not decide it). Its id
 * changes with each drawing: EmDash keeps a form's values while its id stays, so a list drawn
 * again with every box ticked must be a new form to submit what it shows.
 */
export function bulkBlocks(
	forYou: ApprovalRequest[],
	names: Names,
	state: BulkState | undefined,
): Block[] {
	// One request is decided from its row, unless it is one left ticked after a bulk decision.
	if (forYou.length === 0 || (forYou.length === 1 && !state?.ticked.size)) return [];
	const values = forYou.map((r) => optionValue(r));
	const ticked = values.filter((v) => state?.ticked.has(readOption(v)!.key));
	stamp = (stamp + 1) % 1_000_000;
	return [
		{
			type: "accordion",
			label: "Decide several at once",
			...(state ? { default_open: true } : {}),
			blocks: [
				{
					type: "context",
					text: "Choose the pages and what to do, then press Check selection. You see the list before anything happens.",
				},
				{
					type: "form",
					block_id: `bulk-${Date.now().toString(36)}-${stamp}`,
					fields: [
						// "Select all" as a choice inside the form: a button would draw the form again
						// and lose the action and the note typed so far.
						{
							type: "radio",
							action_id: "which",
							label: "Which pages",
							options: [
								{ label: "Only the ones I tick", value: "ticked" },
								{ label: `All ${values.length} waiting for you`, value: "all" },
							],
							initial_value: state?.which ?? "ticked",
						},
						{
							type: "checkbox",
							action_id: "pick",
							label: "Pages waiting for you, oldest first",
							options: forYou.map((r, i) => ({ label: optionLabel(r, names), value: values[i]! })),
							initial_value: ticked,
							condition: { field: "which", eq: "ticked" },
						},
						{
							type: "radio",
							action_id: "do",
							label: "What to do",
							options: [
								{ label: "Approve and publish selected", value: "publish" },
								{ label: "Send back selected", value: "send_back" },
							],
							initial_value: state?.do ?? "publish",
						},
						{
							type: "text_input",
							action_id: "reason",
							label: "What should change? The same note goes to each writer.",
							multiline: true,
							...(state?.reason ? { initial_value: state.reason } : {}),
							condition: { field: "do", eq: "send_back" },
						},
					],
					submit: { label: "Check selection", action_id: BULK.review },
				},
			],
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
	do: BulkDo;
	reason: string;
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
	blocks.push({ type: "header", text: `${VERB[input.do]} ${these(chosen.length)}?` });
	if (input.do === "send_back")
		blocks.push({ type: "section", text: `Your note to each writer: "${input.reason}"` });
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
	if (input.do === "publish") {
		notes.push("Oldest first.");
		if (chosen.some((row) => row.request.wants === "schedule"))
			notes.push("A request to schedule is approved, not published: its writer then schedules it.");
	}
	notes.push("Any page that changed since this list was drawn is skipped and stays in Waiting.");
	notes.push(
		"They are decided in the background: you can leave this page, and Waiting shows how far it is.",
	);
	blocks.push(
		{ type: "context", text: notes.join(" ") },
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: BULK.go,
					label: `${VERB[input.do]} ${chosen.length}`,
					style: "primary",
				},
				{ type: "button", action_id: BULK.back, label: "‹ Back to the list" },
			],
		},
	);
	return {
		response: { blocks },
		rows: chosen.map((row) => ({ ...row.item, title: row.request.title })),
	};
}
