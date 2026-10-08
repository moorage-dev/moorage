// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import type { PageMetadataContribution, PluginContext } from "emdash";
import type { SandboxedPlugin } from "emdash/plugin";

import { CONFIG_KEY, normalizeConfig } from "./config.js";
import { buildGraph } from "./graph.js";
import { buildEntryRecord, entryKey, entryStore, type EntryRecord } from "./record.js";
import { mergeRobots } from "./robots.js";

async function loadConfig(ctx: PluginContext) {
	return normalizeConfig(await ctx.kv.get(CONFIG_KEY));
}

/** Recompute an entry's record after it changed. Never fails the save. */
async function refreshEntry(ctx: PluginContext, collection: string, content: unknown) {
	const id = (content as { id?: unknown } | null)?.id;
	if (typeof id !== "string") return;
	try {
		const config = await loadConfig(ctx);
		await buildEntryRecord(ctx, collection, id, config.jsonLdField);
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
		// Runs on every uncached public render. Steady state is two reads: the
		// config and the entry's precomputed record.
		"page:metadata": async (event, ctx) => {
			const { page } = event;
			const config = await loadConfig(ctx);

			let record: EntryRecord | null = null;
			if (page.content) {
				const { collection, id } = page.content;
				try {
					record =
						(await entryStore(ctx).get(entryKey(collection, id))) ??
						// First render of an entry saved before the plugin was installed.
						(await buildEntryRecord(ctx, collection, id, config.jsonLdField));
				} catch (error) {
					ctx.log.warn("could not load entry record", { collection, id, error: String(error) });
				}
			}

			const rule = page.content ? config.collections[page.content.collection] : undefined;
			const contributions: PageMetadataContribution[] = [
				{
					kind: "meta",
					name: "robots",
					content: mergeRobots(page.seo?.robots, rule?.noindex === true, config.robots),
				},
				{
					// "primary" is the id of EmDash's own JSON-LD; using it replaces that
					// script instead of adding a second, unlinked one.
					kind: "jsonld",
					id: "primary",
					graph: {
						"@context": "https://schema.org",
						"@graph": buildGraph({ page, config, record, site: ctx.site }),
					},
				},
			];

			if (record && record.custom.length > 0) {
				contributions.push({
					kind: "jsonld",
					id: "seo:custom",
					graph: record.custom.map((node) => ({ "@context": "https://schema.org", ...node })),
				});
			}

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
		"content:afterDelete": async (event, ctx) => {
			await entryStore(ctx).delete(entryKey(event.collection, event.id));
		},
	},
	routes: {
		hello: {
			handler: async (_routeCtx, ctx) => {
				ctx.log.info("hello route called", { pluginId: ctx.plugin.id });
				return { greeting: "hello", pluginId: ctx.plugin.id };
			},
		},
	},
};

export default plugin;
