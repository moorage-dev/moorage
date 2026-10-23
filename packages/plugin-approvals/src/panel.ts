// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { approve, saveNote, sendBack, type Decision } from "./actions.js";
import { loadConfig } from "./config.js";
import type { Meter } from "./meter.js";
import type { Draft, UserInfo } from "./requests.js";
import { approvers, collectionInfo, readDraft, requestKey, requests, when } from "./requests.js";
import {
	ACTION,
	askedLine,
	buttonValue,
	canDecide,
	changesSinceApproval,
	decisionBlocks,
	historyBlock,
	liveChanges,
	ownRequestBlocks,
} from "./views.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The "Approval" panel in the entry editor. An action returns what it read and wrote, and the
 * panel is drawn from that: at most 9 calls (approve and publish with the "require" checks).
 */
export async function handlePanel(
	input: unknown,
	entry: { collection: string; id: string } | undefined,
	user: UserInfo | undefined,
	m: Meter,
): Promise<BlockResponse> {
	if (!entry) return { blocks: [] };
	const ctx: PluginContext = m.ctx;
	const config = await loadConfig(ctx);
	const info = await collectionInfo(ctx, entry.collection);
	const key = requestKey(entry.collection, entry.id);
	const interaction = isRecord(input) ? input : {};
	let outcome: Decision | undefined;

	if (config && interaction.type === "block_action") {
		const value = buttonValue(interaction.value);
		if (
			value?.key === key &&
			(interaction.action_id === ACTION.approve || interaction.action_id === ACTION.approvePublish)
		) {
			outcome = await approve(
				ctx,
				config,
				user,
				key,
				{ seen: value.seen, publish: interaction.action_id === ACTION.approvePublish },
				{ info, meter: m },
			);
		}
	}
	if (config && interaction.type === "form_submit") {
		const values = isRecord(interaction.values) ? interaction.values : {};
		if (interaction.action_id === ACTION.sendBack)
			outcome = await sendBack(ctx, config, user, key, values.note, m);
		if (interaction.action_id === ACTION.saveNote)
			outcome = await saveNote(ctx, user, key, values.note);
		if (interaction.action_id === ACTION.overridePublish)
			outcome = await approve(
				ctx,
				config,
				user,
				key,
				{
					seen: undefined,
					publish: true,
					override: typeof values.reason === "string" ? values.reason : "",
				},
				{ info, meter: m },
			);
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
		outcome?.ok &&
		(interaction.action_id === ACTION.approvePublish ||
			interaction.action_id === ACTION.overridePublish)
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
	const request = outcome?.request ?? (await requests(ctx).get(key));
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
	if (!request || request.status === "closed") {
		return {
			blocks: [{ type: "context", text: "Pressing Publish sends this page for approval first." }],
			...toast,
		};
	}
	if (request.status === "sent_back" && request.sentBack) {
		return {
			blocks: [
				{
					type: "banner",
					title: `Sent back by ${request.sentBack.by.name}, ${when(request.sentBack.at)}`,
					description: `"${request.sentBack.note}"`,
				},
				{ type: "section", text: "Make the changes, save, then press Publish again." },
				historyBlock(request, true),
			],
			...toast,
			...refresh,
		};
	}
	// The page is read only where the panel shows something about it, and only once.
	const draft: Draft | null = outcome?.draft ?? (await readDraft(ctx, entry.collection, entry.id));
	if (!draft)
		return { blocks: [{ type: "context", text: "Save this page to ask for approval." }], ...toast };

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
				const others = await approvers(ctx, config, user.id);
				blocks.push(...ownRequestBlocks(request, user, key, others));
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
