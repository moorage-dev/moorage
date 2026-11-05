// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { definePlugin, getRequestContext, pluginResponse, PluginRouteError } from "emdash";
import type { PluginContext, PluginDescriptor, RouteContext } from "emdash";

import pkg from "../package.json" with { type: "json" };
import {
	ADMIN_ROLE,
	CHECK_ACTION,
	handleInteraction,
	renderPage,
	type Interaction,
} from "./admin.js";
import {
	bannerVersion,
	cleanHeld,
	HELD_SEEN_KEY,
	isHeldName,
	CONFIG_KEY,
	enabledTools,
	needsConsent,
	normalizeConfig,
	type AnalyticsConfig,
	type HeldName,
} from "./config.js";
import { checkExport, signExport } from "./export-link.js";
import { heldOnly, pageFragments, siteHostOf } from "./fragment.js";
import {
	consentCsv,
	consentSummary,
	DESCRIPTOR_STORAGE,
	readConsentLog,
	ensurePruneScheduled,
	parseConsent,
	PRUNE_TASK,
	pruneConsents,
	saveConsent,
	STORAGE,
} from "./record.js";
import { forgetSettings, memoSettings } from "./settings-memo.js";
import { checkSite, readSiteCheck, SITE_CHECK_KEY, type SiteCheck } from "./site-check.js";
import { wordsCode, wordsFor } from "./words.js";

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
		// Renders EmDash's iframe and embed blocks, holding videos and maps back until the
		// visitor allows Marketing cookies (astro/held.mjs).
		componentsEntry: "@moorage/plugin-analytics/astro",
		options: {},
		storage: DESCRIPTOR_STORAGE,
	};
}

/** Always a fresh read. Page views use `memoSettings` around it. */
async function readConfig(ctx: PluginContext): Promise<AnalyticsConfig> {
	return normalizeConfig(await ctx.kv.get(CONFIG_KEY));
}

/** The memo of the providers seen on the site's pages, kept apart from the settings' own. */
const SEEN_MEMO = `${PLUGIN_ID}:seen`;

/** The providers of held videos and maps seen on the site's pages, kept 30 s like the settings. */
export function seenHeld(ctx: PluginContext, fresh = false): Promise<HeldName[]> {
	return memoSettings(
		{ plugin: { id: SEEN_MEMO }, site: ctx.site },
		async () => cleanHeld(await ctx.kv.get(HELD_SEEN_KEY)),
		{ fresh },
	);
}

/** Change the list of seen providers on its newest copy, so writes at the same moment all count. */
async function changeSeen(ctx: PluginContext, change: (list: HeldName[]) => HeldName[]) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const stored = await ctx.kv.getVersioned<unknown>(HELD_SEEN_KEY);
		const list = cleanHeld(stored?.value);
		const next = cleanHeld(change(list));
		if (next.join() === list.join()) return;
		const done = await ctx.kv.compareAndSet(HELD_SEEN_KEY, stored?.revision ?? null, next);
		if (done.applied) {
			forgetSettings(SEEN_MEMO);
			return;
		}
	}
}

/**
 * A page the site's owner is looking at to check their work: edit mode, an
 * EmDash preview link, or this plugin's "Preview the banner" link. Its settings
 * are read fresh (see settings-memo.ts).
 */
export function isOwnerView(
	url: string,
	request: { editMode?: boolean; preview?: unknown } | undefined,
): boolean {
	if (request?.editMode === true || request?.preview !== undefined) return true;
	return /[?&](_preview|cookie_preview)=/.test(url);
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

/**
 * The address to check: the site's own, as set in EmDash, or else the one the
 * admin is using. Only ever this site.
 */
export function siteOrigin(siteUrl: string | undefined, requestOrigin: string | undefined) {
	try {
		const url = new URL(siteUrl ?? "");
		if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
	} catch {
		// Not set or not an address: use the request's.
	}
	return requestOrigin;
}

async function readStoredCheck(ctx: PluginContext): Promise<SiteCheck | null> {
	return readSiteCheck(await ctx.kv.get(SITE_CHECK_KEY).catch(() => null));
}

/** Run "Check what loads" and keep the result, kept apart from the settings. */
async function runSiteCheck(
	ctx: PluginContext,
	config: AnalyticsConfig,
	requestOrigin: string | undefined,
): Promise<SiteCheck | null> {
	const origin = siteOrigin(ctx.site?.url, requestOrigin);
	if (!origin) return null;
	const result = await checkSite(origin, config, PLUGIN_ID).catch(() => null);
	if (result) await ctx.kv.set(SITE_CHECK_KEY, result);
	return result;
}

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version,
		capabilities: ["hooks.page-fragments:register"],
		storage: STORAGE,
		admin: {
			pages: [
				{ path: "/settings", label: "Analytics & Cookies", icon: "chart-bar", group: "Marketing" },
			],
		},
		hooks: {
			// May run three times for one page. The settings are kept in memory between
			// page views (settings-memo.ts), so a warm page view reads nothing.
			"page:fragments": async (event, ctx) => {
				const request = getRequestContext();
				const config = await memoSettings(ctx, () => readConfig(ctx), {
					fresh: isOwnerView(event.page.url, request),
				});
				const page = {
					path: event.page.path,
					url: event.page.url,
					editMode: request?.editMode === true,
					preview: request?.preview !== undefined,
				};
				// Only an excluded page on a site that asks, and has no named providers yet, needs to
				// know whether videos or maps were seen; every other page reads nothing more.
				const seen =
					enabledTools(config).length > 0 &&
					config.heldEmbeds.length === 0 &&
					heldOnly(config, page, ["any"])
						? await seenHeld(ctx).catch(() => [])
						: [];
				return pageFragments(config, PLUGIN_ID, page, siteHostOf(ctx.site?.url), seen);
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
					// Read with its revision: a save is written only over what it was made from.
					let stored = await ctx.kv.getVersioned<unknown>(CONFIG_KEY);
					const config = normalizeConfig(stored?.value);
					const admin = (ctx.user?.role ?? 0) >= ADMIN_ROLE;
					// Sites that had the plugin before this task existed never ran the activate hook for it.
					if (admin) await ensurePruneScheduled(ctx).catch(() => {});
					const now = Date.now();
					const origin = ctx.request ? new URL(ctx.request.url).origin : undefined;
					const input = ctx.input as Interaction | undefined;
					const checking =
						admin && input?.type === "block_action" && input.action_id === CHECK_ACTION;
					const [answers, exportQuery, siteCheck, heldSeen] = await Promise.all([
						consentSummary(ctx, new Date(now)).catch(() => null),
						// A plain link cannot send EmDash's request header, so the download is signed.
						// Only for an Admin: the first one stores the signing secret.
						admin && origin ? signExport(ctx.kv, now).catch(() => undefined) : undefined,
						checking ? runSiteCheck(ctx, config, origin) : readStoredCheck(ctx),
						seenHeld(ctx, true).catch(() => []),
					]);
					const state = {
						config,
						admin,
						answers,
						now,
						origin,
						siteHost: siteHostOf(ctx.site?.url),
						exportUrl: exportQuery
							? `${origin}/_emdash/api/plugins/${PLUGIN_ID}/export?${exportQuery}`
							: undefined,
						siteCheck,
						heldSeen,
					};
					let outcome = handleInteraction(input, state);
					// Written only over the settings it was made from. When another save came first, the
					// same change is made again on that one, so neither is lost.
					for (let attempt = 0; outcome.save && attempt < 3; attempt++) {
						const done = await ctx.kv.compareAndSet(
							CONFIG_KEY,
							stored?.revision ?? null,
							outcome.save,
						);
						if (done.applied) {
							// After the write, so a page view in between cannot keep the old settings.
							forgetSettings(PLUGIN_ID);
							if (outcome.unseen) {
								const gone = outcome.unseen;
								await changeSeen(ctx, (list) => list.filter((name) => name !== gone));
							}
							return outcome.response;
						}
						stored = await ctx.kv.getVersioned<unknown>(CONFIG_KEY);
						outcome = handleInteraction(input, {
							...state,
							config: normalizeConfig(stored?.value),
						});
					}
					if (outcome.save) {
						return renderPage({
							...state,
							toast: {
								type: "error",
								message:
									"Not saved: the settings were changed at the same moment. Please try again.",
							},
						});
					}
					return outcome.response;
				},
			},
			// The consent log as a spreadsheet. A plain link in the admin cannot send EmDash's
			// request header, so this route is public and serves only a link the admin page
			// signed for an Admin in the last ten minutes (see export-link.ts).
			export: {
				public: true,
				methods: ["GET"],
				response: "raw",
				handler: async (ctx) => {
					const params = ctx.request
						? new URL(ctx.request.url).searchParams
						: new URLSearchParams();
					const now = Date.now();
					if (!(await checkExport(ctx.kv, params, now))) {
						// A sentence, not an error object: this opens in a browser tab.
						return pluginResponse({
							status: 403,
							headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
							body: {
								kind: "text",
								value:
									"This download link has expired (it works for ten minutes) or is not valid. Open Analytics in the admin again and download from the Status tab.",
							},
						});
					}
					const { rows, more } = await readConsentLog(ctx);
					return pluginResponse({
						status: 200,
						headers: {
							"content-type": "text/csv; charset=utf-8",
							"content-disposition": `attachment; filename="consent-log-${new Date(now).toISOString().slice(0, 10)}.csv"`,
							"cache-control": "no-store",
						},
						body: { kind: "text", value: consentCsv(rows, more) },
					});
				},
			},
			// Public and cacheable: the banner's words in the page's language (see words.ts). The
			// address carries a code of the words, so a change is fetched past the browser's cache.
			words: {
				public: true,
				methods: ["GET"],
				cacheControl: "public, max-age=86400",
				handler: async (ctx) => {
					const params = ctx.request
						? new URL(ctx.request.url).searchParams
						: new URLSearchParams();
					let config = await memoSettings(ctx, () => readConfig(ctx));
					// The page asks for other words than the ones kept here (saved in another isolate in
					// the last 30 seconds): read them now, or the old ones would be cached for a day.
					const asked = params.get("w");
					if (asked && asked !== wordsCode(config)) {
						config = await memoSettings(ctx, () => readConfig(ctx), { fresh: true });
					}
					return { t: wordsFor(config, params.get("l") ?? undefined) };
				},
			},
			// Public: whether videos and maps are held back on this site, asked by the block
			// components on the server (astro/holding.mjs). Yes wherever the banner can ask someone.
			embeds: {
				public: true,
				methods: ["GET"],
				handler: async (ctx) => {
					// Which provider the asking block shows, so the Admin can have the banner name it. Only
					// the three known names count, checked before anything is read.
					const asked = ctx.request ? new URL(ctx.request.url).searchParams.get("p") : null;
					const name = isHeldName(asked) ? asked : undefined;
					const config = await memoSettings(ctx, () => readConfig(ctx));
					const hold = needsConsent(config) && config.banner.audience !== "none";
					// Anyone can call this route, so it never changes the settings or the banner's
					// version: it only notes the name apart (HELD_SEEN_KEY), and only a new one is written.
					if (hold && name && !config.heldEmbeds.includes(name)) {
						if (!(await seenHeld(ctx)).includes(name)) {
							await changeSeen(ctx, (list) => [...list, name]);
						}
					}
					return { hold };
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
					// The country the request came from, as the server saw it, is better evidence than
					// what the browser says; the browser's is kept only when the server knows none.
					const country = countryOf(ctx) ?? input.country;
					return { saved: (await saveConsent(ctx, { ...input, country }, new Date())) === "saved" };
				},
			},
		},
	});
}

export default createPlugin;
