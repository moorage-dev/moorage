// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import type { SandboxedPlugin } from "emdash/plugin";

import {
	ask,
	MAIL_TASK,
	missingChecks,
	REMIND_TASK,
	runMailTask,
	runRemindTask,
} from "./actions.js";
import { handleAdmin } from "./admin.js";
import { approverRole, isHeldRole, loadConfig } from "./config.js";
import { meter } from "./meter.js";
import { deliver, queueMail, readJobs, SEND_TASK } from "./notify.js";
import { handlePanel } from "./panel.js";
import { gate } from "./policy.js";
import {
	addHistory,
	collectionInfo,
	personName,
	readDraft,
	requestKey,
	requests,
	type ApprovalRequest,
} from "./requests.js";
import { changedFields, fieldHashes } from "./text.js";

// "Approve and publish" leaves a note on the request; the publish hook that follows finishes
// it. A note older than this is stale (its publish failed) and ignored.
const SAME_PUBLISH_MS = 5 * 60_000;

function entryId(content: unknown): string | null {
	const id = (content as { id?: unknown } | null)?.id;
	return typeof id === "string" ? id : null;
}

/** A save while a request waits: record approvers' edits; keep the waiting version current. */
async function afterSave(
	ctx: PluginContext,
	collection: string,
	content: unknown,
	actor: { id: string; role: number; source?: string } | undefined,
): Promise<void> {
	const id = entryId(content);
	if (!id) return;
	const store = requests(ctx);
	const key = requestKey(collection, id);
	const request = await store.get(key);
	if (request?.status === "approved" && request.approval && actor && actor.source !== "mcp") {
		// Someone who needs no approval (an admin under "Others need my OK") changed an
		// approved page: their own change needs no new approval, so the approval follows it.
		const config = await loadConfig(ctx);
		if (!config || isHeldRole(config.preset, actor.role)) return;
		const draft = await readDraft(ctx, collection, id);
		if (!draft || draft.fingerprint === request.approval.fingerprint) return;
		const user = await ctx.users?.get(actor.id).catch(() => null);
		const now = new Date().toISOString();
		const updated: ApprovalRequest = {
			...request,
			fingerprint: draft.fingerprint,
			fields: fieldHashes(draft.data),
			approval: { ...request.approval, fingerprint: draft.fingerprint },
		};
		addHistory(updated, now, `Changed by ${personName(user)}; no approval needed`);
		await store.put(key, updated);
		return;
	}
	if (request?.status !== "waiting") return;
	const draft = await readDraft(ctx, collection, id);
	if (!draft) return;
	if (draft.fingerprint === request.fingerprint) {
		// Only the SEO panel may have changed: keep the list's "things to check" current.
		// EmDash sends the SEO panel with the page only when its type has one.
		const checks = missingChecks(draft, draft.item.seo !== undefined);
		if (
			checks.description === request.checks?.description &&
			checks.picture === request.checks?.picture
		)
			return;
		await store.put(key, { ...request, checks });
		return;
	}
	const config = await loadConfig(ctx);
	const info = await collectionInfo(ctx, collection);
	const hashes = fieldHashes(draft.data);
	const slugs = changedFields(request.fields ?? {}, hashes);
	const labels = slugs.map((slug) => info.fields.find((f) => f.slug === slug)?.label ?? slug);
	const fieldText = labels.length > 0 ? labels.join(", ") : "the page";
	const now = new Date().toISOString();
	const updated: ApprovalRequest = {
		...request,
		fingerprint: draft.fingerprint,
		fields: hashes,
		checks: missingChecks(draft, info.hasSeo),
	};
	if (
		actor &&
		config &&
		actor.id !== request.requestedBy?.id &&
		actor.role >= approverRole(config.preset)
	) {
		const user = await ctx.users?.get(actor.id).catch(() => null);
		const by = { id: actor.id, name: personName(user) };
		updated.edits = [...(request.edits ?? []), { by, at: now, fields: labels }].slice(-10);
		addHistory(updated, now, `Edited by ${by.name} before approving: ${fieldText}`);
	} else {
		addHistory(updated, now, `Changed while waiting: ${fieldText}`);
	}
	await store.put(key, updated);
}

const plugin: SandboxedPlugin = {
	hooks: {
		"content:beforePublish": async (event, ctx) => gate(event, ctx, "publish"),
		"content:beforeSchedule": async (event, ctx) => gate(event, ctx, "schedule", event.scheduledAt),

		// Never fails the save.
		"content:afterSave": async (event, ctx) => {
			try {
				await afterSave(ctx, event.collection, event.content, event.actor);
			} catch (error) {
				ctx.log.warn("could not update the approval after a save", { error: String(error) });
			}
		},
		"content:afterPublish": async (event, ctx) => {
			try {
				const id = entryId(event.content);
				if (!id) return;
				const store = requests(ctx);
				const key = requestKey(event.collection, id);
				const request = await store.get(key);
				if (!request) return;
				const now = new Date().toISOString();
				const recent = (at: string | undefined) =>
					Boolean(at) && Date.parse(now) - Date.parse(at!) < SAME_PUBLISH_MS;
				// Marked published by the action itself (releases up to 0.1.6).
				if (request.status === "published" && recent(request.publishedAt)) return;
				const pending = request.publishing;
				if (request.status === "approved" && pending && recent(pending.at)) {
					// "Approve and publish": queue its emails first, so none is lost if the
					// write after it fails, then record who published.
					if (pending.jobs.length > 0) await queueMail(ctx, pending.jobs);
					const updated: ApprovalRequest = {
						...request,
						status: "published",
						publishedAt: now,
						approval: request.approval
							? { ...request.approval, published: true }
							: request.approval,
					};
					delete updated.publishing;
					addHistory(updated, now, `Published by ${pending.by.name}`);
					await store.put(key, updated);
					return;
				}
				const updated: ApprovalRequest = { ...request, status: "published", publishedAt: now };
				delete updated.publishing;
				addHistory(
					updated,
					now,
					request.status === "approved" ? "Published" : "Published without approval",
				);
				await store.put(key, updated);
			} catch (error) {
				ctx.log.warn("could not record a publish", { error: String(error) });
			}
		},
		"content:afterDelete": async (event, ctx) => {
			try {
				const store = requests(ctx);
				const key = requestKey(event.collection, event.id);
				const request = await store.get(key);
				if (!request || request.status === "closed" || request.status === "published") return;
				const now = new Date().toISOString();
				const updated: ApprovalRequest = { ...request, status: "closed" };
				addHistory(updated, now, "This page was deleted.");
				await store.put(key, updated);
			} catch (error) {
				ctx.log.warn("could not close a request", { error: String(error) });
			}
		},
		// Emails: each run sends what fits in its calls and queues the rest (notify.ts).
		cron: async (event, raw) => {
			const m = meter(raw);
			const data = event.data ?? {};
			if (event.name.startsWith(`${SEND_TASK}-`)) {
				await deliver(m, readJobs(data.jobs));
				return;
			}
			const key = typeof data.key === "string" ? data.key : null;
			if (!key) return;
			const config = await loadConfig(m.ctx);
			if (event.name.startsWith(`${MAIL_TASK}-`)) {
				await runMailTask(m, config, key, data);
				return;
			}
			if (event.name.startsWith(`${REMIND_TASK}-`)) {
				await runRemindTask(m, config, key, data.requestedAt);
			}
		},
	},
	routes: {
		// The Approvals page and the dashboard widget. Writers and approvers may open it;
		// the handler shows each person only their part.
		admin: {
			permission: "content:read_drafts",
			handler: async (routeCtx, ctx) => handleAdmin(routeCtx.input, routeCtx.user, meter(ctx)),
		},
		"editor/panel": {
			permission: "content:read_drafts",
			handler: async (routeCtx, ctx) =>
				handlePanel(routeCtx.input, routeCtx.ui?.entry, routeCtx.user, meter(ctx)),
		},
		"editor/ask": {
			permission: "content:read_drafts",
			handler: async (routeCtx, ctx) => {
				const entry = routeCtx.ui?.entry;
				if (!entry) return { toast: { type: "error", message: "Save this page first." } };
				const toast = await ask(
					ctx,
					await loadConfig(ctx),
					routeCtx.user,
					entry.collection,
					entry.id,
				);
				return { toast, refresh: true };
			},
		},
	},
};

export default plugin;
