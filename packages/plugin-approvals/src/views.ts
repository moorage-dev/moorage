// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { firstName, missingChecks } from "./actions.js";
import { ROLE, type Config } from "./config.js";
import type { UserInfo } from "./requests.js";
import {
	copyOf,
	mayApprove,
	personName,
	versions,
	when,
	type ApprovalRequest,
	type CollectionInfo,
	type Draft,
} from "./requests.js";
import { describeChanges, nameList, type FieldChange } from "./text.js";

const HISTORY_SHOWN = 10;

export const ACTION = {
	approvePublish: "approve_publish",
	approve: "approve",
	sendBack: "send_back",
	override: "override",
	overridePublish: "override_publish",
	saveNote: "save_note",
	review: "review",
	back: "back",
	saveSettings: "save_settings",
	ask: "ask",
} as const;

/** What changes when this version goes live, against the live page. */
export function liveChanges(info: CollectionInfo, draft: Draft): FieldChange[] | null {
	if (!draft.live) return null;
	return describeChanges(copyOf(info, draft.live.data), copyOf(info, draft.data), "future");
}

/** What changed since the approved text copy. */
export async function changesSinceApproval(
	ctx: PluginContext,
	info: CollectionInfo,
	request: ApprovalRequest,
	draft: Draft,
): Promise<FieldChange[]> {
	const versionId = request.approval?.versionId;
	const copy = versionId ? await versions(ctx).get(versionId) : null;
	if (!copy) return [];
	return describeChanges(copy.fields, copyOf(info, draft.data), "past");
}

export function changeBlocks(
	changes: FieldChange[] | null,
	draft: Draft,
	info: CollectionInfo,
): Block[] {
	const blocks: Block[] = [{ type: "section", text: "What changes when this goes live" }];
	if (changes === null) {
		blocks.push({ type: "context", text: "New page: not live before." });
		for (const field of copyOf(info, draft.data)
			.filter((f) => f.text !== "")
			.slice(0, 4)) {
			blocks.push({
				type: "section",
				text: `${field.label}: ${field.text.length > 300 ? `${field.text.slice(0, 299)}…` : field.text}`,
			});
		}
		return blocks;
	}
	if (changes.length === 0) {
		blocks.push({ type: "context", text: "Nothing in the content differs from the live page." });
		return blocks;
	}
	for (const change of changes)
		blocks.push({ type: "section", text: `${change.label}: ${change.text}` });
	return blocks;
}

export function checksBanner(
	config: Config,
	draft: Draft,
	info: CollectionInfo,
	short = false,
): Block[] {
	if (config.checks === "off") return [];
	const missing = missingChecks(draft, info.hasSeo);
	if (!missing.description && !missing.picture) return [];
	const parts = short
		? [
				missing.description ? "No search description." : "",
				missing.picture ? "No sharing picture." : "",
			]
		: [
				missing.description ? "No search description: Google will write its own summary." : "",
				missing.picture
					? "No sharing picture: links shared on social media will have no image."
					: "",
			];
	return [
		{
			type: "banner",
			variant: "alert",
			title:
				config.checks === "require" ? "Needed before approval" : "Worth a look before approving",
			description: parts.filter(Boolean).join(" "),
		},
	];
}

export function historyBlock(request: ApprovalRequest, open = false): Block {
	return {
		type: "accordion",
		label: "History",
		...(open ? { default_open: true } : {}),
		blocks: request.history.slice(0, HISTORY_SHOWN).map((event) => ({
			type: "context" as const,
			text: `${when(event.at)}: ${event.text}`,
		})),
	};
}

export function askedLine(request: ApprovalRequest): string {
	const who = request.ai
		? `An AI tool (${request.requestedBy?.name ?? "someone"}'s key)`
		: (request.requestedBy?.name ?? "A scheduled publish");
	const edits = (request.edits ?? []).map(
		(e) => `${e.by.name} edited ${e.fields.join(", ")} at ${when(e.at).split(", ")[1]}.`,
	);
	return [`${who} asked on ${when(request.requestedAt)}. Not live yet.`, ...edits].join(" ");
}

type Named = Pick<UserInfo, "name" | "email">;

/** "Ellen Marsh and Tom Achebe", "A, B, C and 2 more". */
export function peopleList(people: Named[]): string {
	const names = people.slice(0, 3).map((p) => personName(p));
	return people.length > 3 ? `${names.join(", ")} and ${people.length - 3} more` : nameList(names);
}

/** Why your own request waits: whom it waits for, or that nobody else can approve it. */
export function waitReason(others: Named[]): string {
	return others.length === 0
		? "Nobody else on this site can approve it yet."
		: `Waiting for ${peopleList(others)}.`;
}

/**
 * Your own request: why it waits and, for an admin, Publish without review. Nobody approves
 * their own request, so there is no Approve or Send back here.
 */
export function ownRequestBlocks(
	request: ApprovalRequest,
	user: UserInfo | undefined,
	key: string,
	others: Named[],
): Block[] {
	const blocks: Block[] = [{ type: "section", text: waitReason(others) }];
	if ((user?.role ?? 0) < ROLE.admin || request.ai) return blocks;
	const alone = others.length === 0;
	blocks.push(
		{
			type: "context",
			text: `You asked for this, so ${alone ? "a second person approves it once there is one" : "someone else approves it"}. If it can't wait, publish it without review and give a reason: it is recorded in the page's history${alone ? "" : " and emailed to the other approvers"}.`,
		},
		{
			type: "form",
			block_id: `ov:${key}`,
			fields: [{ type: "text_input", action_id: "reason", label: "Reason", multiline: true }],
			submit: { label: "Publish without review", action_id: ACTION.overridePublish },
		},
	);
	return blocks;
}

/**
 * The review: what changed and the checks, then the approver's buttons and Send back or,
 * on your own request, why it waits (`others`: who else may approve it).
 */
export function decisionBlocks(input: {
	config: Config;
	request: ApprovalRequest;
	draft: Draft;
	info: CollectionInfo;
	user: UserInfo | undefined;
	key: string;
	changes: FieldChange[] | null;
	surface: "panel" | "page";
	others?: Named[];
}): Block[] {
	const { config, request, draft, info, user, key, changes, surface } = input;
	const writer = request.ai
		? "the AI tool"
		: request.requestedBy
			? firstName(request.requestedBy.name)
			: "the writer";
	const seen = { key, seen: draft.fingerprint };
	const blocks: Block[] = [];
	if (request.note) {
		blocks.push({
			type: "section",
			text: `${request.requestedBy ? `${firstName(request.requestedBy.name)}'s note` : "Note"}: "${request.note}"`,
		});
	}
	blocks.push(...changeBlocks(changes, draft, info));
	blocks.push({
		type: "context",
		text:
			surface === "panel"
				? "To compare every version, open Revisions below."
				: "To compare every version, open the page, then Revisions.",
	});
	if (surface === "page") {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "link",
					label: "Open the page",
					target: { kind: "content", collection: request.collection, id: request.entryId },
				},
			],
		});
	}
	blocks.push(...checksBanner(config, draft, info, surface === "page"));
	if (!canDecide(config, request, user)) {
		blocks.push(...ownRequestBlocks(request, user, key, input.others ?? []));
		return blocks;
	}
	const canPublish = (user?.role ?? 0) >= ROLE.editor;
	blocks.push({
		type: "actions",
		elements: [
			...(canPublish
				? [
						{
							type: "button" as const,
							action_id: ACTION.approvePublish,
							label: "Approve and publish",
							style: "primary" as const,
							value: seen,
						},
					]
				: []),
			{
				type: "button",
				action_id: ACTION.approve,
				label: "Approve",
				...(canPublish ? {} : { style: "primary" as const }),
				value: seen,
			},
		],
	});
	if (surface === "panel") {
		blocks.push({
			type: "context",
			text: `Approve without publishing: it goes live when ${request.ai || !request.requestedBy ? "someone" : writer} or you press Publish. Fixed a typo first? Edit and save the page, then approve; it is recorded as edited by you.`,
		});
	}
	blocks.push({
		type: "form",
		block_id: `sb:${key}`,
		fields: [
			{
				type: "text_input",
				action_id: "note",
				label: `Or send it back: what should ${request.ai || !request.requestedBy ? "change" : `${writer} change`}?`,
				placeholder: "For example: the price of iced coffee is wrong",
				multiline: true,
			},
		],
		submit: { label: "Send back", action_id: ACTION.sendBack },
	});
	if (surface === "page" && (user?.role ?? 0) >= ROLE.admin && !request.ai) {
		blocks.push({
			type: "accordion",
			label: "Approve without review (admins)",
			blocks: [
				{
					type: "context",
					text: "For emergencies only. The other approvers are emailed, and it is recorded in the page's history.",
				},
				{
					type: "form",
					block_id: `ov:${key}`,
					fields: [{ type: "text_input", action_id: "reason", label: "Reason", multiline: true }],
					submit: { label: "Approve without review", action_id: ACTION.override },
				},
			],
		});
	}
	return blocks;
}

export function canDecide(
	config: Config,
	request: ApprovalRequest,
	user: UserInfo | undefined,
): boolean {
	return request.status === "waiting" && mayApprove(config, request, user);
}

/** Read `{key, seen}` from a button value. */
export function buttonValue(value: unknown): { key: string; seen?: string } | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.key !== "string") return null;
	return { key: record.key, ...(typeof record.seen === "string" ? { seen: record.seen } : {}) };
}

/** Read the request key from a form's block id ("sb:pages:01J…"). */
export function formKey(blockId: unknown, prefix: string): string | null {
	return typeof blockId === "string" && blockId.startsWith(`${prefix}:`)
		? blockId.slice(prefix.length + 1)
		: null;
}
