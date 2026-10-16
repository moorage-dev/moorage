// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import type { UserInfo } from "./requests.js";

import { ROLE, type Config } from "./config.js";
import { emailAsked, emailOverride, emailWriter, personFromUser } from "./notify.js";
import { holdRequest, MAIL_TASK, REMIND_TASK, taskName } from "./policy.js";
import {
	addHistory,
	approvers,
	collectionInfo,
	copyOf,
	mayApprove,
	personName,
	readDraft,
	requestKey,
	requests,
	titleOf,
	versions,
	type ApprovalRequest,
	type Draft,
} from "./requests.js";
import { fieldHashes, nameList } from "./text.js";

export interface Outcome {
	ok: boolean;
	message: string;
}

const fail = (message: string): Outcome => ({ ok: false, message });

export interface Checks {
	description: boolean;
	picture: boolean;
}

/** What the SEO panel is missing on this version. */
export function missingChecks(draft: Draft, hasSeo: boolean): Checks {
	const seo = draft.item.seo;
	if (!hasSeo || !seo) return { description: false, picture: false };
	const excerpt = typeof draft.data.excerpt === "string" && draft.data.excerpt.trim() !== "";
	return {
		description: !(seo.description?.trim() || excerpt),
		picture: !seo.image,
	};
}

export function firstName(name: string): string {
	return name.split(" ")[0] || name;
}

/**
 * Approve the version the approver was shown, optionally publishing it in the same step.
 * `seen` is the version on the approver's screen; if the page changed meanwhile nothing
 * is approved.
 */
export async function approve(
	ctx: PluginContext,
	config: Config,
	user: UserInfo | undefined,
	key: string,
	options: { seen: unknown; publish: boolean; override?: string },
): Promise<Outcome> {
	const store = requests(ctx);
	const request = await store.get(key);
	if (!request || request.status !== "waiting") return fail("This request has already been decided.");
	if (!user) return fail("Sign in again to approve.");
	if (options.override !== undefined) {
		if (user.role < ROLE.admin) return fail("Only admins can approve without review.");
		if (request.ai) return fail("Work from an AI tool always needs a review.");
		if (options.override.trim() === "") return fail("Write the reason first.");
	} else if (!mayApprove(config, request, user)) {
		return fail(
			request.requestedBy?.id === user.id
				? "You asked for this approval, so someone else needs to approve it."
				: "You can't approve on this site.",
		);
	}
	const draft = await readDraft(ctx, request.collection, request.entryId);
	if (!draft) return fail("This page no longer exists.");
	if (typeof options.seen === "string" && options.seen !== draft.fingerprint) {
		return fail("This page changed while you were looking. Check the new version, then decide.");
	}
	const info = await collectionInfo(ctx, request.collection);
	if (config.checks === "require" && options.override === undefined) {
		const missing = missingChecks(draft, info.hasSeo);
		if (missing.description || missing.picture) {
			const what = [missing.description ? "a search description" : "", missing.picture ? "a sharing picture" : ""]
				.filter(Boolean)
				.join(" and ");
			return fail(`Add ${what} in the SEO panel first. This site requires them before approval.`);
		}
	}

	const now = new Date().toISOString();
	const by = personFromUser(user);
	const versionId = `${key}#${now}`;
	await versions(ctx).put(versionId, {
		requestKey: key,
		at: now,
		by: by.name,
		title: titleOf(info, draft.data, request.title),
		fields: copyOf(info, draft.data),
	});
	const approved: ApprovalRequest = {
		...request,
		title: titleOf(info, draft.data, request.title),
		status: "approved",
		fingerprint: draft.fingerprint,
		approval: {
			by,
			at: now,
			fingerprint: draft.fingerprint,
			versionId,
			...(options.override !== undefined ? { override: options.override.trim() } : {}),
		},
	};
	addHistory(
		approved,
		now,
		options.override !== undefined
			? `${by.name} approved without review: "${options.override.trim()}"`
			: `${by.name} approved`,
	);
	await store.put(key, approved);

	if (options.override !== undefined) await emailOverride(ctx, config, approved);

	if (!options.publish) {
		await emailWriter(ctx, approved, "approved");
		const writer = approved.requestedBy?.name;
		return {
			ok: true,
			message: writer && !approved.ai ? `Approved. ${firstName(writer)} has been told.` : "Approved.",
		};
	}
	if (user.role < ROLE.editor) return { ok: true, message: "Approved. Press Publish when you're ready." };
	try {
		const versioned = await ctx.content?.getVersioned?.(request.collection, request.entryId);
		if (!versioned || !ctx.content?.publish) throw new Error("publishing is not available");
		await ctx.content.publish(request.collection, request.entryId, { _rev: versioned._rev });
	} catch (error) {
		ctx.log.warn("approved but could not publish", { error: String(error) });
		return { ok: false, message: "Approved, but it could not be published just now. Press Publish on the page." };
	}
	const published: ApprovalRequest = {
		...approved,
		status: "published",
		publishedAt: now,
		approval: { ...approved.approval!, published: true },
	};
	addHistory(published, now, `Published by ${by.name}`);
	await store.put(key, published);
	await emailWriter(ctx, published, "published");
	const writer = published.requestedBy?.name;
	return {
		ok: true,
		message: `Approved and published. It's live now.${writer && !published.ai && writer !== by.name ? ` ${firstName(writer)} has been told.` : ""}`,
	};
}

export async function sendBack(
	ctx: PluginContext,
	config: Config,
	user: UserInfo | undefined,
	key: string,
	note: unknown,
): Promise<Outcome> {
	const store = requests(ctx);
	const request = await store.get(key);
	if (!request || request.status !== "waiting") return fail("This request has already been decided.");
	if (!mayApprove(config, request, user) || !user) return fail("You can't decide on this request.");
	const text = typeof note === "string" ? note.trim() : "";
	if (text === "") return fail("Write what should change, then press Send back.");
	const now = new Date().toISOString();
	const by = personFromUser(user);
	const sent: ApprovalRequest = { ...request, status: "sent_back", sentBack: { by, at: now, note: text.slice(0, 2000) } };
	addHistory(sent, now, `${by.name} sent it back: "${text.slice(0, 120)}"`);
	await store.put(key, sent);
	await emailWriter(ctx, sent, "sent_back");
	const writer = sent.requestedBy?.name;
	return { ok: true, message: writer && !sent.ai ? `Sent back to ${firstName(writer)} with your note.` : "Sent back with your note." };
}

export async function saveNote(ctx: PluginContext, user: UserInfo | undefined, key: string, note: unknown): Promise<Outcome> {
	const store = requests(ctx);
	const request = await store.get(key);
	if (!request || request.status !== "waiting") return fail("There is no request waiting on this page.");
	if (!user || request.requestedBy?.id !== user.id) return fail("Only the person who asked can add a note.");
	const text = typeof note === "string" ? note.trim().slice(0, 2000) : "";
	const updated: ApprovalRequest = { ...request, ...(text ? { note: text } : {}) };
	if (!text) delete updated.note;
	addHistory(updated, new Date().toISOString(), text ? `${personName(user)} added a note` : `${personName(user)} removed the note`);
	await store.put(key, updated);
	return { ok: true, message: text ? "Note saved. The approvers will see it." : "Note removed." };
}

/** "Ask for approval" from the editor toolbar. */
export async function ask(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
	collection: string,
	id: string,
): Promise<{ type: "success" | "info" | "error"; message: string }> {
	if (!config) return { type: "info", message: "Approval is off until an admin saves the Approvals settings." };
	const info = await collectionInfo(ctx, collection);
	if (!config.collections.includes(collection)) return { type: "info", message: `Approval is off for ${info.label}.` };
	if (!user) return { type: "error", message: "Sign in again to ask for approval." };
	const key = requestKey(collection, id);
	const store = requests(ctx);
	const existing = await store.get(key);
	const draft = await readDraft(ctx, collection, id);
	if (!draft) return { type: "error", message: "Save this page first." };
	if (existing?.status === "waiting" && existing.requestedBy?.id !== user.id && mayApprove(config, existing, user)) {
		return { type: "info", message: "You can approve this yourself in the Approval panel." };
	}
	if (existing?.status === "approved" && existing.approval?.fingerprint === draft.fingerprint) {
		return { type: "info", message: "This version is already approved. Press Publish when you're ready." };
	}
	const now = new Date().toISOString();
	const result = holdRequest(
		existing,
		{
			collection,
			entryId: id,
			title: titleOf(info, draft.data, existing?.title ?? "Untitled"),
			fingerprint: draft.fingerprint,
			fields: fieldHashes(draft.data),
			requestedBy: personFromUser(user),
			ai: false,
			wants: "publish",
			how: "pressed Ask for approval",
		},
		now,
	);
	if (result.notify && ctx.email) result.request.emailedAt = now;
	await store.put(key, result.request);
	if (result.notify) await emailAsked(ctx, config, result.request);
	if (!result.again && config.remind && ctx.email) {
		await ctx.cron?.schedule(taskName(REMIND_TASK, key, now), {
			schedule: new Date(Date.parse(now) + 2 * 86_400_000).toISOString(),
			data: { key, requestedAt: now },
		});
	}
	const people = await approvers(ctx, config, user.id);
	const names = nameList(people.slice(0, 4).map((p) => personName(p)));
	if (result.again) return { type: "info", message: `Already waiting for approval. ${names || "The approvers"} ${people.length === 1 ? "was" : "were"} asked.` };
	if (people.length === 0) return { type: "info", message: "Sent for approval. Approval needs a second person: nobody else on this site can approve it yet." };
	return { type: "success", message: `Sent for approval. ${names} ${people.length === 1 ? "has" : "have"} been asked.` };
}

/** The cron task that emails approvers after a held publish. */
export async function runMailTask(ctx: PluginContext, config: Config | null, key: string): Promise<void> {
	if (!config) return;
	const request = await requests(ctx).get(key);
	if (request?.status !== "waiting") return;
	await emailAsked(ctx, config, request);
}

export { MAIL_TASK, REMIND_TASK };
