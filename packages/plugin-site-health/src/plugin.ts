// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import type { SandboxedPlugin } from "emdash/plugin";

import { handleAdmin } from "./admin.js";
import { mailDue, mailStep } from "./alerts.js";
import { counted } from "./budget.js";
import { dueStep, ensureTask, passStep, refreshEntry, startPass, TASK } from "./scan.js";
import { KEY, load } from "./state.js";

/** One scheduled run: send a due email, or move the full check one step, or check what is due. */
export async function cronRun(raw: PluginContext, now = Date.now()): Promise<void> {
	const counter = { ops: 0 };
	const ctx = counted(raw, counter);
	const data = await load(ctx);
	const stamp = new Date(now).toISOString();
	if (mailDue(data, now)) {
		await mailStep(ctx, data, now);
		data.queue = { ...data.queue, cronAt: stamp, ops: counter.ops + 1 };
		await ctx.kv.set(KEY.queue, data.queue);
		return;
	}
	const scan = data.scan;
	const startDue =
		!scan || (scan.status === "done" && scan.nextAt !== undefined && scan.nextAt <= stamp);
	if (startDue) {
		data.scan = { ...(await startPass(ctx, data, now)), cronAt: stamp };
		await passStep(ctx, data, counter, now);
		return;
	}
	// The first check runs flat out; later ones take turns with links to other sites.
	// The last run was a check of what is due (or both ran at once): the full check goes next.
	const passTurn = !data.summary || (data.queue.cronAt ?? "") >= (scan?.cronAt ?? "");
	if (scan?.status === "running" && passTurn) {
		data.scan = { ...scan, cronAt: stamp };
		await passStep(ctx, data, counter, now);
		return;
	}
	await dueStep(ctx, data, counter, now);
}

async function onEntry(
	raw: PluginContext,
	collection: string,
	id: unknown,
	deleted = false,
): Promise<void> {
	if (typeof id !== "string") return;
	const ctx = counted(raw, { ops: 0 });
	try {
		const data = await load(ctx);
		const entry = deleted ? null : await ctx.content?.get(collection, id);
		await refreshEntry(
			ctx,
			collection,
			entry ?? { id, slug: null, status: "deleted", data: {} },
			data,
		);
	} catch (error) {
		ctx.log.warn("could not re-read the page's links", { collection, id, error: String(error) });
	}
}

const idOf = (content: unknown) => (content as { id?: unknown } | null)?.id;

const plugin: SandboxedPlugin = {
	hooks: {
		// The first check starts as soon as the plugin is switched on (starting it
		// schedules the task); a site that has one only makes sure the task is there.
		"plugin:activate": async (_event, raw) => {
			const counter = { ops: 0 };
			const ctx = counted(raw, counter);
			try {
				const data = await load(ctx);
				if (data.scan) {
					await ensureTask(ctx);
					return;
				}
				data.scan = await startPass(ctx, data);
				await passStep(ctx, data, counter);
			} catch (error) {
				ctx.log.warn("could not start the first check", { error: String(error) });
				// The scheduled task starts it instead.
				await ensureTask(ctx);
			}
		},
		cron: async (event, ctx) => {
			if (event.name !== TASK) return;
			await cronRun(ctx);
		},
		"content:afterSave": async (event, ctx) => {
			await onEntry(ctx, event.collection, idOf(event.content));
		},
		"content:afterPublish": async (event, ctx) => {
			await onEntry(ctx, event.collection, idOf(event.content));
		},
		"content:afterUnpublish": async (event, ctx) => {
			await onEntry(ctx, event.collection, idOf(event.content));
		},
		"content:afterDelete": async (event, ctx) => {
			await onEntry(ctx, event.collection, event.id, true);
		},
	},
	routes: {
		// The Site Health page and the dashboard widget. Editors may open both;
		// the handler shows them only the links they can fix.
		admin: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => {
				const counter = { ops: 0 };
				return handleAdmin(routeCtx.input, routeCtx.user, counted(ctx, counter), counter);
			},
		},
	},
};

export default plugin;
