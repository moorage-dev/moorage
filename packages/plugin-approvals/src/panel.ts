// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { approve, saveNote, sendBack, type Outcome } from "./actions.js";
import { loadConfig } from "./config.js";
import type { UserInfo } from "./requests.js";
import { collectionInfo, readDraft, requestKey, requests, when } from "./requests.js";
import {
	ACTION,
	askedLine,
	buttonValue,
	canDecide,
	changesSinceApproval,
	decisionBlocks,
	historyBlock,
	liveChanges,
} from "./views.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The "Approval" panel in the entry editor. */
export async function handlePanel(
	input: unknown,
	entry: { collection: string; id: string } | undefined,
	user: UserInfo | undefined,
	ctx: PluginContext,
): Promise<BlockResponse> {
	if (!entry) return { blocks: [] };
	const config = await loadConfig(ctx);
	const info = await collectionInfo(ctx, entry.collection);
	const key = requestKey(entry.collection, entry.id);
	const interaction = isRecord(input) ? input : {};
	let outcome: Outcome | undefined;

	if (config && interaction.type === "block_action") {
		const value = buttonValue(interaction.value);
		if (
			value?.key === key &&
			(interaction.action_id === ACTION.approve || interaction.action_id === ACTION.approvePublish)
		) {
			outcome = await approve(ctx, config, user, key, {
				seen: value.seen,
				publish: interaction.action_id === ACTION.approvePublish,
			});
		}
	}
	if (config && interaction.type === "form_submit") {
		const values = isRecord(interaction.values) ? interaction.values : {};
		if (interaction.action_id === ACTION.sendBack)
			outcome = await sendBack(ctx, config, user, key, values.note);
		if (interaction.action_id === ACTION.saveNote)
			outcome = await saveNote(ctx, user, key, values.note);
	}
	const toast = outcome
		? {
				toast: {
					type: outcome.ok ? ("success" as const) : ("error" as const),
					message: outcome.message,
				},
			}
		: {};
	// After publishing from the panel the editor must reload the entry.
	const refresh =
		outcome?.ok && interaction.action_id === ACTION.approvePublish
			? { refresh: true as const }
			: {};

	if (!config) {
		return {
			blocks: [
				{ type: "context", text: "Approval is off until an admin saves the Approvals settings." },
			],
			...toast,
		};
	}
	const request = await requests(ctx).get(key);
	const held = config.collections.includes(entry.collection);
	if (!held && !request) {
		const blocks: Block[] = [{ type: "section", text: `Approval is off for ${info.label}.` }];
		if (!info.keepsDrafts) {
			blocks.push({
				type: "context",
				text: "EmDash publishes this type's saves at once, so it can't be held.",
			});
		}
		return { blocks, ...toast };
	}
	const draft = await readDraft(ctx, entry.collection, entry.id);
	if (!draft)
		return { blocks: [{ type: "context", text: "Save this page to ask for approval." }], ...toast };

	if (!request || request.status === "closed") {
		return {
			blocks: [{ type: "context", text: "Pressing Publish sends this page for approval first." }],
			...toast,
		};
	}

	const blocks: Block[] = [];
	if (request.status === "waiting") {
		if (canDecide(config, request, user)) {
			blocks.push(
				{ type: "section", text: "Waiting for your approval" },
				{ type: "context", text: askedLine(request) },
				...decisionBlocks({
					config,
					request,
					draft,
					info,
					user,
					key,
					changes: liveChanges(info, draft),
					surface: "panel",
				}),
			);
		} else {
			blocks.push(
				{ type: "section", text: "Waiting for approval" },
				{ type: "context", text: `Asked on ${when(request.requestedAt)}. Not live yet.` },
			);
			if (user && request.requestedBy?.id === user.id) {
				blocks.push({
					type: "form",
					block_id: `note:${key}`,
					fields: [
						{
							type: "text_input",
							action_id: "note",
							label: "Add a note for the approver (optional)",
							placeholder: "For example: new prices from Monday",
							multiline: true,
							...(request.note ? { initial_value: request.note } : {}),
						},
					],
					submit: { label: "Save note", action_id: ACTION.saveNote },
				});
			}
		}
	} else if (request.status === "sent_back" && request.sentBack) {
		blocks.push(
			{
				type: "banner",
				title: `Sent back by ${request.sentBack.by.name}, ${when(request.sentBack.at)}`,
				description: `"${request.sentBack.note}"`,
			},
			{ type: "section", text: "Make the changes, save, then press Publish again." },
		);
	} else if (request.status === "approved" && request.approval) {
		if (request.approval.fingerprint === draft.fingerprint) {
			blocks.push(
				{ type: "section", text: `Approved by ${request.approval.by.name}` },
				{
					type: "context",
					text: `${when(request.approval.at)}. Press Publish when you're ready, or schedule it.`,
				},
			);
		} else {
			const changes = await changesSinceApproval(ctx, info, request, draft);
			blocks.push(
				{
					type: "banner",
					variant: "alert",
					title: `Changed since ${request.approval.by.name} approved it`,
					description:
						changes.length > 0
							? changes.map((c) => `${c.label}: ${c.text}`).join(" ")
							: "The page's address or settings changed.",
				},
				{ type: "section", text: "Press Publish to ask again." },
			);
		}
	} else if (request.status === "published") {
		blocks.push({
			type: "section",
			text: `Published ${when(request.publishedAt ?? request.updatedAt)}.${request.approval ? ` Approved by ${request.approval.by.name}.` : ""}`,
		});
		if (request.approval && request.approval.fingerprint !== draft.fingerprint) {
			blocks.push({
				type: "context",
				text: "There are newer changes; pressing Publish sends them for approval.",
			});
		}
	}
	// As in the mockup: open where the history explains the state, folded for a writer who waits.
	const open =
		(request.status === "waiting" && canDecide(config, request, user)) ||
		request.status === "sent_back" ||
		request.status === "published" ||
		(request.status === "approved" && request.approval?.fingerprint === draft.fingerprint);
	blocks.push(historyBlock(request, open));
	return { blocks, ...toast, ...refresh };
}
