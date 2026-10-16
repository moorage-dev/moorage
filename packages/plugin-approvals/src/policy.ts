// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { ContentPolicyDecision, ContentPolicyEvent, PluginContext } from "emdash";

import { isHeldRole, loadConfig, type Config } from "./config.js";
import { EMAIL_EVERY_MS, REMIND_AFTER_MS } from "./notify.js";
import {
	addHistory,
	approvers,
	personName,
	requestKey,
	requests,
	when,
	type ApprovalRequest,
} from "./requests.js";
import { cleanReason, fieldHashes, fingerprint, nameList } from "./text.js";

export const CHECK_FAILED =
	"Not published: approval could not be checked just now. Nothing has changed. Try again in a minute; if it keeps happening, tell whoever looks after the site.";

export const MAIL_TASK = "mail";
export const REMIND_TASK = "remind";

function refuse(reason: string): ContentPolicyDecision {
	return { cancel: true, reason: cleanReason(reason) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cron task names allow letters, digits, dashes and underscores. */
export function taskName(prefix: string, key: string, at: string): string {
	const safe = `${key}-${at}`.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `${prefix}-${safe}`.slice(0, 128);
}

/** The approvers' names for a message, or a general wording when they cannot be read. */
async function askedNames(
	ctx: PluginContext,
	config: Config,
	request: ApprovalRequest,
): Promise<string> {
	try {
		// One page of people at most: this runs inside the publish, which has a time limit.
		const people = await approvers(ctx, config, request.ai ? null : request.requestedBy?.id, 1);
		const names = people.slice(0, 4).map((p) => personName(p));
		if (names.length === 0) return "";
		return people.length > 4
			? `${names.join(", ")} and ${people.length - 4} more`
			: nameList(names);
	} catch {
		return "";
	}
}

export interface HoldResult {
	request: ApprovalRequest;
	/** The approvers were emailed (or will be): a new request, or a day since the last email. */
	notify: boolean;
	/** The same version was already waiting. */
	again: boolean;
	/** The page changed after an approval. */
	changed: boolean;
	approvedBy?: string;
}

/**
 * Create or refresh the request for a held version. Shared by the publish hook and
 * "Ask for approval". Writes the request; the caller sends the email.
 */
export function holdRequest(
	existing: ApprovalRequest | null,
	input: {
		collection: string;
		entryId: string;
		title: string;
		fingerprint: string;
		fields: Record<string, string>;
		requestedBy: ApprovalRequest["requestedBy"];
		ai: boolean;
		wants: "publish" | "schedule";
		scheduledAt?: string;
		how: string;
	},
	now: string,
): HoldResult {
	const sameWaiting = existing?.status === "waiting" && existing.fingerprint === input.fingerprint;
	if (existing && sameWaiting) {
		const due =
			!existing.emailedAt || Date.parse(now) - Date.parse(existing.emailedAt) >= EMAIL_EVERY_MS;
		return { request: existing, notify: due, again: true, changed: false };
	}
	const changed =
		existing?.status === "approved" && existing.approval?.fingerprint !== input.fingerprint;
	const request: ApprovalRequest = {
		collection: input.collection,
		entryId: input.entryId,
		title: input.title,
		status: "waiting",
		// A scheduled run has nobody behind it: the request stays with whoever asked last.
		requestedBy: input.requestedBy ?? existing?.requestedBy ?? null,
		requestedAt: now,
		ai: input.ai,
		wants: input.wants,
		...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
		fingerprint: input.fingerprint,
		fields: input.fields,
		...(existing?.approval ? { approval: existing.approval } : {}),
		history: existing?.history ?? [],
		updatedAt: now,
	};
	const who = input.ai
		? `An AI tool (${input.requestedBy?.name ?? "someone's key"})`
		: (request.requestedBy?.name ?? "A scheduled publish");
	addHistory(
		request,
		now,
		changed
			? `${who} asked again: the page changed after it was approved`
			: `${who} asked for approval (${input.how})`,
	);
	return {
		request,
		notify: true,
		again: false,
		changed,
		...(changed && existing?.approval ? { approvedBy: existing.approval.by.name } : {}),
	};
}

export function heldMessage(
	result: HoldResult,
	names: string,
	email: boolean,
	ai: boolean,
): string {
	const asked = names
		? `${names} ${names.includes(" and ") ? "have" : "has"} been asked`
		: "The approvers have been asked";
	if (ai) {
		return `Sent for approval. Not live yet. On this site a person must OK what AI tools publish; ${names ? `${names} ${names.includes(" and ") ? "have" : "has"} been asked` : "the approvers have been asked"}. Do not try again: a person will approve and publish it.`;
	}
	if (result.again) {
		return `Still waiting for approval. Not live yet. ${names || "The approvers"} ${names.includes(" and ") || !names ? "were" : "was"} asked on ${when(result.request.requestedAt)}.`;
	}
	if (result.changed) {
		return `Sent for approval again. Not live yet. This page changed after ${result.approvedBy ?? "it was"} approved it, so ${names ? `${names} ${names.includes(" and ") ? "have" : "has"} been asked again` : "the approvers have been asked again"}.`;
	}
	return `Sent for approval. Not live yet. ${asked}; ${email ? "you'll get an email when they decide" : "watch for it in Approvals"}.`;
}

/**
 * Someone who needs no approval scheduled this version: mark it approved by them, so the
 * scheduled run (which has no person behind it) goes through. Never blocks the schedule:
 * if this fails, the run is refused later and EmDash's dashboard says so.
 */
async function clearForSchedule(
	event: ContentPolicyEvent,
	ctx: PluginContext,
	actor: { id: string },
): Promise<void> {
	try {
		const id = typeof event.content.id === "string" ? event.content.id : null;
		if (!id) return;
		const data = isRecord(event.content.data) ? event.content.data : {};
		const slug = typeof event.content.slug === "string" ? event.content.slug : null;
		const version = await fingerprint(data, slug);
		const store = requests(ctx);
		const key = requestKey(event.collection, id);
		const existing = await store.get(key);
		if (existing?.status === "approved" && existing.approval?.fingerprint === version) return;
		const user = await ctx.users?.get(actor.id).catch(() => null);
		const by = { id: actor.id, name: personName(user) };
		const now = new Date().toISOString();
		const titleValue = data.title;
		const request: ApprovalRequest = {
			collection: event.collection,
			entryId: id,
			title:
				typeof titleValue === "string" && titleValue.trim() !== ""
					? titleValue.trim()
					: (existing?.title ?? "Untitled"),
			status: "approved",
			requestedBy: existing?.requestedBy ?? by,
			requestedAt: existing?.requestedAt ?? now,
			ai: false,
			wants: "schedule",
			fingerprint: version,
			fields: fieldHashes(data),
			approval: { by, at: now, fingerprint: version, versionId: "" },
			history: existing?.history ?? [],
			updatedAt: now,
		};
		addHistory(request, now, `Scheduled by ${by.name}; no approval needed`);
		await store.put(key, request);
	} catch (error) {
		ctx.log.warn("could not record a schedule that needs no approval", { error: String(error) });
	}
}

/**
 * The publish and schedule gate. Fails safe: once a publish is known to need approval,
 * any error refuses it with a plain message rather than letting it through.
 */
export async function gate(
	event: ContentPolicyEvent,
	ctx: PluginContext,
	wants: "publish" | "schedule",
	scheduledAt?: string,
): Promise<ContentPolicyDecision> {
	let config: Config | null;
	try {
		config = await loadConfig(ctx);
	} catch (error) {
		ctx.log.error("could not read the approval settings", { error: String(error) });
		return refuse(CHECK_FAILED);
	}
	// Nothing is held until the settings are saved once.
	if (!config) return;
	const ai = event.origin.source === "mcp" && config.ai;
	const typeHeld = config.collections.includes(event.collection);
	// The early allow: types that are off are never touched, unless an AI tool publishes.
	if (!typeHeld && !ai) return;
	// Admins are not held under "Others need my OK" (AI work always is).
	if (!ai && event.actor && !isHeldRole(config.preset, event.actor.role)) {
		// The scheduled run has nobody behind it, so record this version as cleared now;
		// otherwise an admin's own scheduled post would be held when its time comes.
		if (wants === "schedule") await clearForSchedule(event, ctx, event.actor);
		return;
	}

	try {
		const content = event.content;
		const id = typeof content.id === "string" ? content.id : null;
		if (!id) return refuse(CHECK_FAILED);
		const data = isRecord(content.data) ? content.data : {};
		const slug = typeof content.slug === "string" ? content.slug : null;
		const version = await fingerprint(data, slug);
		const store = requests(ctx);
		const key = requestKey(event.collection, id);
		const existing = await store.get(key);

		// Approved, and this is exactly the version that was approved.
		if (existing?.status === "approved" && existing.approval?.fingerprint === version) return;

		const now = new Date().toISOString();
		const titleValue = data.title;
		const title =
			typeof titleValue === "string" && titleValue.trim() !== ""
				? titleValue.trim()
				: (existing?.title ?? "Untitled");
		let requestedBy: ApprovalRequest["requestedBy"] = null;
		if (event.actor) {
			const user = await ctx.users?.get(event.actor.id).catch(() => null);
			requestedBy = { id: event.actor.id, name: personName(user) };
		}
		const how =
			event.origin.source === "scheduler"
				? "a scheduled publish"
				: wants === "schedule"
					? "pressed Schedule"
					: event.origin.source === "mcp"
						? "published from an AI tool"
						: "pressed Publish";
		const result = holdRequest(
			existing,
			{
				collection: event.collection,
				entryId: id,
				title,
				fingerprint: version,
				fields: fieldHashes(data),
				requestedBy,
				ai: event.origin.source === "mcp",
				wants,
				...(scheduledAt ? { scheduledAt } : {}),
				how,
			},
			now,
		);
		if (result.notify && ctx.email) result.request.emailedAt = now;
		if (!result.again || result.notify) await store.put(key, result.request);
		if (result.notify && ctx.email) {
			// Email is sent by a one-shot task, so a slow email never delays the publish.
			await ctx.cron?.schedule(taskName(MAIL_TASK, key, now), {
				schedule: now,
				data: { key, kind: "asked" },
			});
		}
		if (!result.again && config.remind && ctx.email) {
			const at = new Date(Date.parse(now) + REMIND_AFTER_MS).toISOString();
			await ctx.cron?.schedule(taskName(REMIND_TASK, key, now), {
				schedule: at,
				data: { key, requestedAt: now },
			});
		}
		if (event.origin.source === "scheduler") {
			return refuse(
				result.changed
					? `Not published: this page changed after ${result.approvedBy ?? "it was"} approved it. It has been sent for approval again; schedule it once it's approved.`
					: "Not published: this page needs approval first. It has been sent for approval; schedule it once it's approved.",
			);
		}
		const names = await askedNames(ctx, config, result.request);
		return refuse(heldMessage(result, names, Boolean(ctx.email), event.origin.source === "mcp"));
	} catch (error) {
		ctx.log.error("approval check failed; the publish was refused", { error: String(error) });
		return refuse(CHECK_FAILED);
	}
}
