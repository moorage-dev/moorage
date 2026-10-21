// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PageMetadataContribution, PluginContext } from "emdash";
import type { SandboxedPlugin } from "emdash/plugin";

import { handleAdmin } from "./admin.js";
import { CONFIG_KEY, normalizeConfig } from "./config.js";
import { buildGraph } from "./graph.js";
import { handlePanel } from "./panel.js";
import {
	buildEntryRecord,
	entryKey,
	entryStore,
	observeImage,
	removeEntryRecord,
	type EntryRecord,
} from "./record.js";
import { addMore, IMPORT_TASK, loadImport } from "./redirects-admin.js";
import { isNoindex, mergeRobots } from "./robots.js";
import { loadScan, SCAN_KEY, SCAN_TASK, scanStep, startScan } from "./scan.js";
import { memoSettings } from "./settings-memo.js";

/** Always a fresh read. Page views use `memoSettings` around it; saves and record builds do not. */
async function loadConfig(ctx: PluginContext) {
	return normalizeConfig(await ctx.kv.get(CONFIG_KEY));
}

/** Recompute an entry's record after it changed. Never fails the save. */
async function refreshEntry(ctx: PluginContext, collection: string, content: unknown) {
	const id = (content as { id?: unknown } | null)?.id;
	if (typeof id !== "string") return;
	try {
		const config = await loadConfig(ctx);
		await buildEntryRecord(ctx, collection, id, config);
	} catch (error) {
		ctx.log.warn("could not refresh entry record", { collection, id, error: String(error) });
	}
}

/**
 * Sandboxed plugin entry. The explicit `SandboxedPlugin` annotation gives TypeScript per-hook /
 * per-route inference (`ctx` is `PluginContext` automatically; hook
 * `event` parameters are typed by hook name).
 */
const plugin: SandboxedPlugin = {
	hooks: {
		// Runs on every uncached public render. Steady state is one read, the
		// entry's precomputed record: the config is kept in memory between page
		// views (settings-memo.ts), and when it is not, both are read at once.
		"page:metadata": async (event, ctx) => {
			const { page } = event;
			const content = page.content;
			// A failed record read is reported below; it never fails the page.
			const readRecord = async () => {
				if (!content) return null;
				try {
					return { stored: await entryStore(ctx).get(entryKey(content.collection, content.id)) };
				} catch (error) {
					return { error };
				}
			};
			const [config, found] = await Promise.all([
				memoSettings(ctx, () => loadConfig(ctx)),
				readRecord(),
			]);

			let record: EntryRecord | null = null;
			if (content && found) {
				const { collection, id } = content;
				try {
					if ("error" in found) throw found.error;
					const { stored } = found;
					const store = entryStore(ctx);
					// First render of an entry saved before the plugin was installed. The
					// record is kept, so it is built from a fresh read, not the copy in memory.
					record = stored ?? (await buildEntryRecord(ctx, collection, id, await loadConfig(ctx)));
					// The picture this render shares (what becomes og:image) is something
					// the saved-entry check cannot see. Written only when it is news, and
					// not in the request that just built the record.
					const hasImage = Boolean(page.seo?.ogImage || page.image);
					if (stored && observeImage(stored, hasImage)) {
						// Read again just before writing: a save may have rebuilt the
						// record meanwhile, and the whole record is written back.
						const latest = await store.get(entryKey(collection, id));
						const changed = latest ? observeImage(latest, hasImage) : null;
						if (changed) await store.put(entryKey(collection, id), changed);
						record = changed ?? latest ?? stored;
					}
				} catch (error) {
					ctx.log.warn("could not load entry record", { collection, id, error: String(error) });
				}
			}

			const rule = page.content ? config.collections[page.content.collection] : undefined;
			const robots = mergeRobots(page.seo?.robots, rule?.noindex === true, config.robots);
			const contributions: PageMetadataContribution[] = [
				{ kind: "meta", name: "robots", content: robots },
				{
					// "primary" is the id of EmDash's own JSON-LD; using it replaces that
					// script instead of adding a second, unlinked one. The entry's own
					// JSON-LD field is part of this graph, so a page has one script.
					kind: "jsonld",
					id: "primary",
					graph: {
						"@context": "https://schema.org",
						"@graph": buildGraph({
							page,
							config,
							record,
							noindex: isNoindex(robots),
							site: ctx.site,
						}),
					},
				},
			];

			return contributions;
		},

		"content:afterSave": async (event, ctx) => {
			await refreshEntry(ctx, event.collection, event.content);
		},
		"content:afterPublish": async (event, ctx) => {
			await refreshEntry(ctx, event.collection, event.content);
		},
		"content:afterUnpublish": async (event, ctx) => {
			await refreshEntry(ctx, event.collection, event.content);
		},
		"content:afterRestore": async (event, ctx) => {
			await refreshEntry(ctx, event.collection, event.content);
		},
		// Start checking the site's pages as soon as the plugin is switched on, so the
		// numbers are usually there before anyone opens the SEO page.
		"plugin:activate": async (_event, ctx) => {
			try {
				if (await loadScan(ctx)) return;
				const collections = (await ctx.schema?.listCollections()) ?? [];
				const scan = await startScan(
					ctx,
					collections.filter((c) => c.routable && !c.hidden).map((c) => c.slug),
					await loadConfig(ctx),
				);
				// Run in the site's process (`plugins: []`), the plugin is switched on when the
				// server starts, which on a new site is before setup has added any pages. A check
				// that found nothing is not kept, so the first visit to the SEO page checks again.
				if (scan.status === "done" && scan.checked === 0) await ctx.kv.delete(SCAN_KEY);
			} catch (error) {
				ctx.log.warn("could not start the first page check", { error: String(error) });
			}
		},
		// Continues a redirects import a few rows at a time until it is done.
		cron: async (event, ctx) => {
			if (event.name === SCAN_TASK) {
				const scan = await loadScan(ctx);
				if (scan?.status === "running") await scanStep(ctx, scan, await loadConfig(ctx));
				else await ctx.cron?.cancel(SCAN_TASK);
				return;
			}
			if (event.name !== IMPORT_TASK) return;
			const state = await loadImport(ctx);
			if (state?.status === "adding") await addMore(ctx, state);
			else await ctx.cron?.cancel(IMPORT_TASK);
		},
		"content:afterDelete": async (event, ctx) => {
			await removeEntryRecord(ctx, event.collection, event.id);
		},
	},
	routes: {
		// The SEO admin page. Editors may open it; the handler lets only admins change anything.
		admin: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => handleAdmin(routeCtx.input, routeCtx.user?.role, ctx),
		},
		// The "Google preview" panel in the entry editor.
		"editor/preview": {
			permission: "content:read",
			handler: async (routeCtx, ctx) =>
				handlePanel(routeCtx.input, routeCtx.ui?.entry, routeCtx.user?.role, ctx),
		},
		hello: {
			handler: async (_routeCtx, ctx) => {
				ctx.log.info("hello route called", { pluginId: ctx.plugin.id });
				return { greeting: "hello", pluginId: ctx.plugin.id };
			},
		},
	},
};

export default plugin;
