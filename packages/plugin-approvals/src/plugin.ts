// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import type { SandboxedPlugin } from "emdash/plugin";

import { ask, MAIL_TASK, REMIND_TASK, runMailTask } from "./actions.js";
import { handleAdmin } from "./admin.js";
import { approverRole, loadConfig } from "./config.js";
import { emailReminder } from "./notify.js";
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

// After "Approve and publish" the request is already marked published; the hook that
// follows the publish must not add a second line.
const SAME_PUBLISH_MS = 60_000;

function entryId(content: unknown): string | null {
	const id = (content as { id?: unknown } | null)?.id;
	return typeof id === "string" ? id : null;
}

/** A save while a request waits: record approvers' edits; keep the waiting version current. */
async function afterSave(
	ctx: PluginContext,
	collection: string,
	content: unknown,
	actor: { id: string; role: number } | undefined,
): Promise<void> {
	const id = entryId(content);
	if (!id) return;
	const store = requests(ctx);
	const key = requestKey(collection, id);
	const request = await store.get(key);
	if (request?.status !== "waiting") return;
	const draft = await readDraft(ctx, collection, id);
	if (!draft || draft.fingerprint === request.fingerprint) return;
	const config = await loadConfig(ctx);
	const info = await collectionInfo(ctx, collection);
	const hashes = fieldHashes(draft.data);
	const slugs = changedFields(request.fields ?? {}, hashes);
	const labels = slugs.map((slug) => info.fields.find((f) => f.slug === slug)?.label ?? slug);
	const fieldText = labels.length > 0 ? labels.join(", ") : "the page";
	const now = new Date().toISOString();
	const updated: ApprovalRequest = { ...request, fingerprint: draft.fingerprint, fields: hashes };
	if (actor && config && actor.id !== request.requestedBy?.id && actor.role >= approverRole(config.preset)) {
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
				if (request.status === "published" && request.publishedAt && Date.parse(now) - Date.parse(request.publishedAt) < SAME_PUBLISH_MS) {
					return;
				}
				const updated: ApprovalRequest = { ...request, status: "published", publishedAt: now };
				addHistory(updated, now, request.status === "approved" ? "Published" : "Published without approval");
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
		cron: async (event, ctx) => {
			const data = event.data ?? {};
			const key = typeof data.key === "string" ? data.key : null;
			if (!key) return;
			const config = await loadConfig(ctx);
			if (event.name.startsWith(`${MAIL_TASK}-`)) {
				await runMailTask(ctx, config, key);
				return;
			}
			if (event.name.startsWith(`${REMIND_TASK}-`)) {
				if (!config?.remind) return;
				const request = await requests(ctx).get(key);
				// Only the request this reminder was set for, still waiting.
				if (request?.status !== "waiting" || request.requestedAt !== data.requestedAt) return;
				await emailReminder(ctx, config, request);
			}
		},
	},
	routes: {
		// The Approvals page and the dashboard widget. Writers and approvers may open it;
		// the handler shows each person only their part.
		admin: {
			permission: "content:read_drafts",
			handler: async (routeCtx, ctx) => handleAdmin(routeCtx.input, routeCtx.user, ctx),
		},
		"editor/panel": {
			permission: "content:read_drafts",
			handler: async (routeCtx, ctx) => handlePanel(routeCtx.input, routeCtx.ui?.entry, routeCtx.user, ctx),
		},
		"editor/ask": {
			permission: "content:read_drafts",
			handler: async (routeCtx, ctx) => {
				const entry = routeCtx.ui?.entry;
				if (!entry) return { toast: { type: "error", message: "Save this page first." } };
				const toast = await ask(ctx, await loadConfig(ctx), routeCtx.user, entry.collection, entry.id);
				return { toast, refresh: true };
			},
		},
	},
};

export default plugin;
