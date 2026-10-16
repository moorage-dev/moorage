// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { SandboxedPlugin } from "emdash/plugin";

import { handleAdmin } from "./admin.js";
import { check } from "./operations.js";
import { client, loadConnection, loadKey, siteQuery, snapshotPeople } from "./state.js";

const DAILY = "daily";
const WEEK = 7 * 86_400_000;

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			try {
				await ctx.cron?.schedule(DAILY, { schedule: "@daily" });
			} catch (error) {
				ctx.log.warn("could not schedule the daily check", { error: String(error) });
			}
		},
		// Daily: refresh the list of people (so the review can name anyone removed later).
		// Weekly: is the key still accepted and this site's data still found?
		cron: async (event, ctx) => {
			if (event.name !== DAILY) return;
			const connection = await loadConnection(ctx);
			const key = await loadKey(ctx);
			if (!connection || !key) return;
			const now = Date.now();
			try {
				await snapshotPeople(ctx, siteQuery(client(ctx, key), connection), now);
			} catch (error) {
				ctx.log.warn("could not refresh the list of people", { error: String(error) });
			}
			if (now - Date.parse(connection.lastCheck.at) >= WEEK - 3_600_000) await check(ctx, now);
		},
	},
	routes: {
		// The Restore page. Editors may open it and are told to ask an administrator;
		// everything else is for administrators only.
		admin: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => handleAdmin(routeCtx.input, routeCtx.user, ctx),
		},
	},
};

export default plugin;
