// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { definePlugin, getRequestContext, PluginRouteError } from "emdash";
import type { PluginContext, PluginDescriptor, RouteContext } from "emdash";

import pkg from "../package.json" with { type: "json" };
import { ADMIN_ROLE, handleInteraction, type Interaction } from "./admin.js";
import {
	bannerVersion,
	CONFIG_KEY,
	needsConsent,
	normalizeConfig,
	type AnalyticsConfig,
} from "./config.js";
import { pageFragments } from "./fragment.js";
import {
	countConsents,
	DESCRIPTOR_STORAGE,
	ensurePruneScheduled,
	parseConsent,
	PRUNE_TASK,
	pruneConsents,
	saveConsent,
	STORAGE,
} from "./record.js";

export type { AnalyticsConfig } from "./config.js";

const { version } = pkg;

/** Permanent id: part of every route URL and storage key. Not "analytics", which a registry plugin already uses. */
export const PLUGIN_ID = "analytics-consent";

/** Add to `plugins: []` in `astro.config.mjs`. There are no options: everything is set on the admin page. */
export function analyticsPlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version,
		format: "native",
		entrypoint: "@moorage/plugin-analytics",
		options: {},
		storage: DESCRIPTOR_STORAGE,
	};
}

async function readConfig(ctx: PluginContext): Promise<AnalyticsConfig> {
	return normalizeConfig(await ctx.kv.get(CONFIG_KEY));
}

/**
 * The visitor's country, for deciding whether to show the banner. On
 * Cloudflare it comes with the request; elsewhere it is unknown and the
 * browser falls back to its time zone. Nothing is looked up and nothing stored.
 */
export function countryOf(ctx: Pick<RouteContext, "request" | "requestMeta">): string | null {
	const found = ctx.requestMeta?.geo?.country ?? ctx.request.headers.get("cf-ipcountry") ?? "";
	const code = found.trim().toUpperCase();
	// Cloudflare sends XX for "unknown" and T1 for Tor.
	return /^[A-Z]{2}$/.test(code) && code !== "XX" ? code : null;
}

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version,
		capabilities: ["hooks.page-fragments:register"],
		storage: STORAGE,
		admin: {
			pages: [{ path: "/settings", label: "Analytics", icon: "chart-bar", group: "Marketing" }],
		},
		hooks: {
			// May run three times for one page: one read, then pure work.
			"page:fragments": async (event, ctx) => {
				const config = await readConfig(ctx);
				const request = getRequestContext();
				return pageFragments(config, PLUGIN_ID, {
					path: event.page.path,
					url: event.page.url,
					editMode: request?.editMode === true,
					preview: request?.preview !== undefined,
				});
			},
			"plugin:activate": async (_event, ctx) => {
				await ensurePruneScheduled(ctx);
			},
			cron: async (event, ctx) => {
				if (event.name !== PRUNE_TASK) return;
				const removed = await pruneConsents(ctx, new Date());
				if (removed > 0) ctx.log.info("Removed consent records older than a year", { removed });
			},
		},
		routes: {
			// The admin page. Editors may open it (read-only); only admins may save.
			admin: {
				permission: "plugins:read",
				handler: async (ctx) => {
					const config = await readConfig(ctx);
					const admin = (ctx.user?.role ?? 0) >= ADMIN_ROLE;
					// Sites that had the plugin before this task existed never ran the activate hook for it.
					if (admin) await ensurePruneScheduled(ctx).catch(() => {});
					const counts = await countConsents(ctx, new Date()).catch(() => null);
					const outcome = handleInteraction(ctx.input as Interaction | undefined, {
						config,
						admin,
						counts,
					});
					if (outcome.save) await ctx.kv.set(CONFIG_KEY, outcome.save);
					return outcome.response;
				},
			},
			// Public, never cached: tells the browser which country the visitor is in.
			geo: {
				public: true,
				methods: ["GET"],
				handler: async (ctx) => ({ country: countryOf(ctx) }),
			},
			// Public write: one row per answer to the banner. See `record.ts` for the limits.
			record: {
				public: true,
				methods: ["POST"],
				request: { body: "json", maxBytes: 512 },
				handler: async (ctx) => {
					const input = parseConsent(ctx.input);
					if (!input) throw PluginRouteError.badRequest("Not a consent record");
					const config = await readConfig(ctx);
					const asking = needsConsent(config) && config.banner.audience !== "none";
					// Only answers to the banner that is live right now are kept.
					if (!asking || input.version !== bannerVersion(config)) return { saved: false };
					return { saved: (await saveConsent(ctx, input, new Date())) === "saved" };
				},
			},
		},
	});
}

export default createPlugin;
