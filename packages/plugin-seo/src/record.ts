// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

import type { PageSchemaType } from "./config.js";

/** Storage collection holding one record per content entry. */
export const ENTRIES = "entries";

// Extra schema an editor pastes into the JSON-LD field; larger values are ignored.
const CUSTOM_MAX_BYTES = 16 * 1024;

/**
 * What the public page hook needs about an entry, computed when the entry is
 * saved or published so that rendering a page costs one storage read instead
 * of a content read plus a byline lookup.
 */
export interface EntryRecord {
	v: 1;
	publishedAt: string | null;
	updatedAt: string | null;
	authors: Array<{ name: string; url?: string }>;
	/** Entry-level schema type, set from the editor panel. */
	type?: PageSchemaType;
	/** Nodes from the entry's JSON-LD field, emitted next to the main graph. */
	custom: Array<Record<string, unknown>>;
}

export function entryKey(collection: string, id: string): string {
	return `${collection}:${id}`;
}

export function entryStore(ctx: PluginContext): StorageCollection<EntryRecord> {
	return ctx.storage[ENTRIES] as StorageCollection<EntryRecord>;
}

function isNode(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "@type" in value;
}

/**
 * Read an entry's JSON-LD field: an object, an array of objects, or either as
 * a JSON string. Anything that is not a schema node with an `@type` is dropped.
 */
export function parseCustomSchema(value: unknown): Array<Record<string, unknown>> {
	let parsed = value;
	if (typeof value === "string") {
		if (value.trim() === "" || value.length > CUSTOM_MAX_BYTES) return [];
		try {
			parsed = JSON.parse(value);
		} catch {
			return [];
		}
	}
	const nodes = (Array.isArray(parsed) ? parsed : [parsed]).filter(isNode);
	return JSON.stringify(nodes).length > CUSTOM_MAX_BYTES ? [] : nodes;
}

/**
 * Build and store the record for one entry. Returns null when the entry is
 * gone or the plugin lacks content access.
 */
export async function buildEntryRecord(
	ctx: PluginContext,
	collection: string,
	id: string,
	jsonLdField: string,
): Promise<EntryRecord | null> {
	const entry = await ctx.content?.get(collection, id);
	if (!entry) return null;

	const store = entryStore(ctx);
	const key = entryKey(collection, id);
	const [credits, previous] = await Promise.all([
		ctx.bylines?.getEntriesBylines(collection, [id]) ?? [],
		store.get(key),
	]);

	const record: EntryRecord = {
		v: 1,
		publishedAt: entry.publishedAt,
		updatedAt: entry.updatedAt,
		authors: (credits[0]?.bylines ?? []).map(({ byline }) => ({
			name: byline.displayName,
			...(byline.websiteUrl ? { url: byline.websiteUrl } : {}),
		})),
		// The type is an editor's choice, not derived data: keep it across rebuilds.
		...(previous?.type ? { type: previous.type } : {}),
		custom: parseCustomSchema(entry.data[jsonLdField]),
	};
	await store.put(key, record);
	return record;
}
