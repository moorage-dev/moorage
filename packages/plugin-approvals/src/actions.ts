// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { ROLE, type Config } from "./config.js";
import { warnIfRoom, type Meter } from "./meter.js";
import {
	askedJob,
	deliver,
	overrideJob,
	personFromUser,
	queueMail,
	REMIND_AFTER_MS,
	reminderJob,
	writerJob,
	type MailJob,
} from "./notify.js";
import { holdRequest, MAIL_TASK, REMIND_TASK, scheduleAsked, taskName } from "./policy.js";
import type { CollectionInfo, UserInfo } from "./requests.js";
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
	seoGaps,
	titleOf,
	versions,
	type ApprovalRequest,
	type Draft,
} from "./requests.js";
import { fieldHashes, nameList, secondPerson } from "./text.js";

export interface Outcome {
	ok: boolean;
	message: string;
}

/**
 * An outcome, with what the action read and wrote, so the screen that follows is drawn
 * without reading it all again (each read is a call, and a run may make only so many).
 */
export interface Decision extends Outcome {
	/** The request as it now stands. */
	request?: ApprovalRequest;
	draft?: Draft;
	info?: CollectionInfo;
}

const fail = (message: string, read: Omit<Decision, "ok" | "message"> = {}): Decision => ({
	ok: false,
	message,
	...read,
});

export interface Checks {
	description: boolean;
	picture: boolean;
}

/** What the SEO panel is missing on this version. */
export function missingChecks(draft: Draft, hasSeo: boolean): Checks {
	return seoGaps(hasSeo ? draft.item.seo : null, draft.data);
}

export function firstName(name: string): string {
	return name.split(" ")[0] || name;
}

/** Queue emails; a failure is logged when a call is left for it. One call. */
async function queueOrLog(ctx: PluginContext, m: Meter | undefined, jobs: Array<MailJob | null>) {
	try {
		await queueMail(ctx, jobs);
	} catch (error) {
		if (m) warnIfRoom(m, "could not queue approval emails", { error: String(error) });
	}
}

/**
 * Approve the version the approver was shown, optionally publishing it in the same step.
 * `seen` is the version on the approver's screen; if the page changed meanwhile nothing
 * is approved. At most 9 calls: settings (the caller's), the request, the page (2), its
 * content type (unless given), the text copy, the request again, the publish, and one more
 * for the "require" checks or a failed publish.
 *
 * Emails are queued, not sent. After a publish the content:afterPublish hook queues them and
 * records "Published by", in its own run.
 */
export async function approve(
	ctx: PluginContext,
	config: Config,
	user: UserInfo | undefined,
	key: string,
	options: { seen: unknown; publish: boolean; override?: string },
	known: { info?: CollectionInfo; meter?: Meter } = {},
): Promise<Decision> {
	const store = requests(ctx);
	const request = await store.get(key);
	if (!request || request.status !== "waiting")
		return fail("This request has already been decided.", request ? { request } : {});
	if (!user) return fail("Sign in again to approve.", { request });
	if (options.override !== undefined) {
		if (user.role < ROLE.admin) return fail("Only admins can approve without review.", { request });
		if (request.ai) return fail("Work from an AI tool always needs a review.", { request });
		if (options.override.trim() === "") return fail("Write the reason first.", { request });
	} else if (!mayApprove(config, request, user)) {
		return fail(
			request.requestedBy?.id === user.id
				? "You asked for this approval, so someone else needs to approve it."
				: "You can't approve on this site.",
			{ request },
		);
	}
	const publishing = options.publish && user.role >= ROLE.editor && Boolean(ctx.content?.publish);
	const draft = await readDraft(ctx, request.collection, request.entryId, {
		forPublish: publishing,
	});
	if (!draft) return fail("This page no longer exists.", { request });
	if (typeof options.seen === "string" && options.seen !== draft.fingerprint) {
		return fail("This page changed while you were looking. Check the new version, then decide.", {
			request,
			draft,
		});
	}
	const info = known.info ?? (await collectionInfo(ctx, request.collection));
	if (config.checks === "require" && options.override === undefined) {
		// Read for publishing, the page came without its SEO panel: read that once more.
		const seo =
			draft.rev !== undefined
				? (await ctx.content?.get(request.collection, request.entryId))?.seo
				: draft.item.seo;
		const missing = seoGaps(info.hasSeo ? seo : null, draft.data);
		if (missing.description || missing.picture) {
			const what = [
				missing.description ? "a search description" : "",
				missing.picture ? "a sharing picture" : "",
			]
				.filter(Boolean)
				.join(" and ");
			return fail(`Add ${what} in the SEO panel first. This site requires them before approval.`, {
				request,
				draft,
				info,
			});
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
	delete approved.publishing;
	addHistory(
		approved,
		now,
		options.override !== undefined
			? `${by.name} approved without review: "${options.override.trim()}"`
			: `${by.name} approved`,
	);
	// Nobody is emailed about their own decision.
	const ownRequest = approved.requestedBy?.id === user.id;
	const override = options.override !== undefined;
	const writer = approved.requestedBy?.name;

	if (!publishing) {
		await store.put(key, approved);
		await queueOrLog(ctx, known.meter, [
			override ? overrideJob(ctx, config, approved, false) : null,
			ownRequest ? null : writerJob(ctx, approved, "approved"),
		]);
		if (options.publish)
			return {
				ok: true,
				message: "Approved. Press Publish when you're ready.",
				request: approved,
				draft,
				info,
			};
		return {
			ok: true,
			message:
				writer && !approved.ai ? `Approved. ${firstName(writer)} has been told.` : "Approved.",
			request: approved,
			draft,
			info,
		};
	}

	// Stored approved before publishing: the publish passes this plugin's own check only then.
	const jobs = ctx.email
		? [
				override ? overrideJob(ctx, config, approved, true) : null,
				ownRequest ? null : writerJob(ctx, approved, "published"),
			].filter((job): job is MailJob => job !== null)
		: [];
	await store.put(key, { ...approved, publishing: { by, at: now, jobs } });
	try {
		if (!draft.rev || !ctx.content?.publish) throw new Error("publishing is not available");
		await ctx.content.publish(request.collection, request.entryId, { _rev: draft.rev });
	} catch (error) {
		// Approved but not live: an approval without review is still told to the other approvers.
		if (override) await queueOrLog(ctx, known.meter, [overrideJob(ctx, config, approved, false)]);
		else if (known.meter)
			warnIfRoom(known.meter, "approved but could not publish", { error: String(error) });
		return {
			ok: false,
			message: "Approved, but it could not be published just now. Press Publish on the page.",
			request: approved,
			draft,
			info,
		};
	}
	// What content:afterPublish is about to store; shown now.
	const published: ApprovalRequest = {
		...approved,
		status: "published",
		publishedAt: now,
		approval: { ...approved.approval!, published: true },
	};
	addHistory(published, now, `Published by ${by.name}`);
	if (override) {
		return {
			ok: true,
			message: `Published without review. It's live now.${writer && !ownRequest ? ` ${firstName(writer)} has been told.` : ""}`,
			request: published,
			draft,
			info,
		};
	}
	return {
		ok: true,
		message: `Approved and published. It's live now.${writer && !published.ai && writer !== by.name ? ` ${firstName(writer)} has been told.` : ""}`,
		request: published,
		draft,
		info,
	};
}

export async function sendBack(
	ctx: PluginContext,
	config: Config,
	user: UserInfo | undefined,
	key: string,
	note: unknown,
	meter?: Meter,
): Promise<Decision> {
	const store = requests(ctx);
	const request = await store.get(key);
	if (!request || request.status !== "waiting")
		return fail("This request has already been decided.", request ? { request } : {});
	if (!mayApprove(config, request, user) || !user)
		return fail("You can't decide on this request.", { request });
	const text = typeof note === "string" ? note.trim() : "";
	if (text === "") return fail("Write what should change, then press Send back.", { request });
	const now = new Date().toISOString();
	const by = personFromUser(user);
	const sent: ApprovalRequest = {
		...request,
		status: "sent_back",
		sentBack: { by, at: now, note: text.slice(0, 2000) },
	};
	addHistory(sent, now, `${by.name} sent it back: "${text.slice(0, 120)}"`);
	await store.put(key, sent);
	await queueOrLog(ctx, meter, [writerJob(ctx, sent, "sent_back")]);
	const writer = sent.requestedBy?.name;
	return {
		ok: true,
		message:
			writer && !sent.ai
				? `Sent back to ${firstName(writer)} with your note.`
				: "Sent back with your note.",
		request: sent,
	};
}

export async function saveNote(
	ctx: PluginContext,
	user: UserInfo | undefined,
	key: string,
	note: unknown,
): Promise<Decision> {
	const store = requests(ctx);
	const request = await store.get(key);
	if (!request || request.status !== "waiting")
		return fail("There is no request waiting on this page.", request ? { request } : {});
	if (!user || request.requestedBy?.id !== user.id)
		return fail("Only the person who asked can add a note.", { request });
	const text = typeof note === "string" ? note.trim().slice(0, 2000) : "";
	const updated: ApprovalRequest = { ...request, ...(text ? { note: text } : {}) };
	if (!text) delete updated.note;
	addHistory(
		updated,
		new Date().toISOString(),
		text ? `${personName(user)} added a note` : `${personName(user)} removed the note`,
	);
	await store.put(key, updated);
	return {
		ok: true,
		message: text ? "Note saved. The approvers will see it." : "Note removed.",
		request: updated,
	};
}

/**
 * "Ask for approval" from the editor toolbar or the Approvals page. 8 calls with the
 * caller's settings read: the content type, the request, the page (2), the request again,
 * the email task, and the approvers' names.
 */
export async function ask(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
	collection: string,
	id: string,
): Promise<{ type: "success" | "info" | "error"; message: string }> {
	if (!config)
		return {
			type: "info",
			message: "Approval is off until an admin saves the Approvals settings.",
		};
	const info = await collectionInfo(ctx, collection);
	if (!config.collections.includes(collection))
		return { type: "info", message: `Approval is off for ${info.label}.` };
	if (!user) return { type: "error", message: "Sign in again to ask for approval." };
	const key = requestKey(collection, id);
	const store = requests(ctx);
	const existing = await store.get(key);
	const draft = await readDraft(ctx, collection, id);
	if (!draft) return { type: "error", message: "Save this page first." };
	// Below Author, people may only ask about their own drafts, as EmDash lets them edit only those.
	if (user.role < ROLE.author && draft.item.authorId !== user.id) {
		return { type: "error", message: "You can only ask for approval on your own drafts." };
	}
	if (
		existing?.status === "waiting" &&
		existing.requestedBy?.id !== user.id &&
		mayApprove(config, existing, user)
	) {
		return { type: "info", message: "You can approve this yourself in the Approval panel." };
	}
	if (existing?.status === "approved" && existing.approval?.fingerprint === draft.fingerprint) {
		return {
			type: "info",
			message: "This version is already approved. Press Publish when you're ready.",
		};
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
	result.request.checks = missingChecks(draft, info.hasSeo);
	if (result.notify && ctx.email) result.request.emailedAt = now;
	await store.put(key, result.request);
	if (result.notify) await scheduleAsked(ctx, config, key, now, !result.again);
	const people = await approvers(ctx, config, user.id);
	const names = nameList(people.slice(0, 4).map((p) => personName(p)));
	if (people.length === 0)
		return {
			type: "info",
			message: `${result.again ? "Already waiting for approval." : "Sent for approval."} ${secondPerson(user.role >= ROLE.admin)}`,
		};
	if (result.again)
		return {
			type: "info",
			message: `Already waiting for approval. ${names} ${people.length === 1 ? "was" : "were"} asked.`,
		};
	return {
		type: "success",
		message: `Sent for approval. ${names} ${people.length === 1 ? "has" : "have"} been asked.`,
	};
}

/**
 * The cron task that emails approvers after a request: the request is read when it runs, so
 * a request decided meanwhile is not sent. Sets the two-day reminder first when asked to.
 */
export async function runMailTask(
	m: Meter,
	config: Config | null,
	key: string,
	data: Record<string, unknown>,
): Promise<void> {
	if (!config) return;
	const ctx = m.ctx;
	const request = await requests(ctx).get(key);
	if (request?.status !== "waiting") return;
	const remind = typeof data.remind === "string" ? data.remind : null;
	if (remind && config.remind && ctx.cron) {
		// Same name as before for the same request, so running this again changes nothing.
		await ctx.cron.schedule(taskName(REMIND_TASK, key, remind), {
			schedule: new Date(Date.parse(remind) + REMIND_AFTER_MS).toISOString(),
			data: { key, requestedAt: remind },
		});
	}
	await deliver(m, [askedJob(ctx, config, request)]);
}

/** The two-day reminder, for the request it was set for if it still waits. */
export async function runRemindTask(
	m: Meter,
	config: Config | null,
	key: string,
	requestedAt: unknown,
): Promise<void> {
	if (!config?.remind) return;
	const request = await requests(m.ctx).get(key);
	if (request?.status !== "waiting" || request.requestedAt !== requestedAt) return;
	await deliver(m, [reminderJob(m.ctx, config, request)]);
}

export { MAIL_TASK, REMIND_TASK };
