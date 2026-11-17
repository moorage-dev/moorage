// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";

import { approve, sendBack, type Decision } from "./actions.js";
import type { Config } from "./config.js";
import { CALLS_PER_RUN_1_5, type Meter } from "./meter.js";
import type { CollectionInfo, UserInfo } from "./requests.js";
import { ago, collectionInfo, requestKey, when, type ApprovalRequest } from "./requests.js";
import { canDecide } from "./views.js";

/**
 * Deciding several waiting requests at once, from the Waiting tab.
 *
 * Block Kit has no tick box per row and no table selection, so the Waiting tab keeps its rows
 * (each with Review) and adds one form under them: one tick box group, an option per request,
 * with a "Select all" button, a choice of what to do and, for Send back, one shared note.
 * Continue shows what was ticked; the button there decides them, a few per press so each run
 * stays inside EmDash's call limit, and offers "Continue: N more to go" for the rest. Each
 * request goes through the same approve() and sendBack() as a single decision, with the same
 * checks: who may decide, still waiting, and unchanged since the list was shown.
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

/**
 * What one request costs at worst, in calls: approve and publish reads the request, the page
 * (2), the SEO panel under "require", writes the request and the text copy, and publishes; plus
 * its content type once per type. Send back reads and writes the request and queues an email.
 */
const ROW_COST: Record<BulkDo, number> = { publish: 7, send_back: 3 };

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
const DONE: Record<BulkDo, string> = { publish: "Approved and published", send_back: "Sent back" };

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
}): BlockResponse {
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
		return { blocks };
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
					value: {
						do: input.do,
						...(input.do === "send_back" ? { reason: input.reason } : {}),
						items: chosen.map((row) => row.item),
					},
				},
				{
					type: "button",
					action_id: BULK.back,
					label: "‹ Back to the list",
					value: { items: chosen.map((row) => row.item) },
				},
			],
		},
	);
	return { blocks };
}

interface Result {
	item: BulkItem;
	decision: Decision;
}

/**
 * Decide the requests in order while a whole one still fits in this run's calls (EmDash 1.5
 * allows 30; this path keeps to 25), and return what is left for the next press. Each request
 * goes through approve() or sendBack(), which check it is still waiting, who may decide it, and
 * that the page is the version the list showed; a request decided meanwhile is never decided
 * again. The settings were read by the caller (one call).
 */
export async function runBulk(
	m: Meter,
	config: Config,
	user: UserInfo | undefined,
	what: BulkDo,
	reason: string,
	items: BulkItem[],
): Promise<{ results: Result[]; rest: BulkItem[] }> {
	const ctx = m.ctx;
	const infos = new Map<string, CollectionInfo>();
	const results: Result[] = [];
	let next = 0;
	for (; next < items.length; next++) {
		const item = items[next]!;
		const collection = item.key.slice(0, item.key.indexOf(":"));
		const cost = ROW_COST[what] + (what === "publish" && !infos.has(collection) ? 1 : 0);
		// The first always goes, so every press moves on.
		if (results.length > 0 && m.left(CALLS_PER_RUN_1_5) < cost) break;
		let decision: Decision;
		if (what === "publish") {
			let info = infos.get(collection);
			if (!info) {
				info = await collectionInfo(ctx, collection);
				infos.set(collection, info);
			}
			decision = await approve(
				ctx,
				config,
				user,
				item.key,
				{ seen: item.seen, publish: true, keepSchedule: true },
				{ info },
			);
		} else {
			decision = await sendBack(ctx, config, user, item.key, reason);
		}
		results.push({ item, decision });
	}
	return { results, rest: items.slice(next) };
}

/** One request's line on the results: done, approved but not live, or not done and why. */
function outcome(decision: Decision): { state: "done" | "approved" | "failed"; text: string } {
	const request = decision.request;
	if (!request) return { state: "failed", text: "This request no longer exists." };
	if (decision.ok && request.status === "approved" && request.wants === "schedule") {
		const writer = request.requestedBy && !request.ai ? request.requestedBy.name : null;
		return {
			state: "done",
			text: `Approved. ${writer ? `${writer.split(" ")[0]} can` : "Its writer can"} schedule it now.`,
		};
	}
	if (decision.ok) return { state: "done", text: decision.message };
	if (request.status === "approved")
		return { state: "approved", text: "Approved, not live yet: press Publish on the page." };
	return { state: "failed", text: `Not done: ${decision.message}` };
}

/** After a press: each request's outcome, then Continue for the rest or the way back. */
export function resultView(
	what: BulkDo,
	reason: string,
	results: Result[],
	rest: BulkItem[],
): BlockResponse {
	const lines = results.map((r) => ({ ...r, ...outcome(r.decision) }));
	const ok = lines.filter((r) => r.state === "done").length;
	const notLive = lines.filter((r) => r.state === "approved").length;
	const failed = lines.filter((r) => r.state === "failed");
	const blocks: Block[] = [{ type: "header", text: "Approvals" }];
	blocks.push({ type: "header", text: VERB[what] });
	for (const line of lines) {
		blocks.push(
			{ type: "section", text: line.decision.request?.title ?? line.item.key },
			{ type: "context", text: line.text },
		);
	}
	const back = {
		type: "button" as const,
		action_id: BULK.back,
		label: "‹ Back to the list",
		// What could not be done stays ticked on the list.
		value: { items: failed.map((r) => r.item) },
	};
	if (rest.length > 0) {
		blocks.push(
			{ type: "context", text: "A few are done at a time. Press Continue for the rest." },
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: BULK.go,
						label: `Continue: ${rest.length} more to go`,
						style: "primary",
						value: { do: what, ...(what === "send_back" ? { reason } : {}), items: rest },
					},
					back,
				],
			},
		);
	} else {
		blocks.push({ type: "actions", elements: [{ ...back, style: "primary" as const }] });
	}
	const parts = [`${DONE[what]} ${ok}.`];
	if (notLive > 0) parts.push(`${notLive} approved, not live yet.`);
	if (failed.length > 0) parts.push(`${failed.length} could not be: see below.`);
	if (rest.length > 0) parts.push(`${rest.length} more to go: press Continue.`);
	return {
		blocks,
		toast: { type: failed.length > 0 ? "error" : "success", message: parts.join(" ") },
	};
}
