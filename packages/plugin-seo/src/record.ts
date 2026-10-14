// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

import {
	checkEntry,
	NO_SOCIAL_IMAGE,
	statusOf,
	titleKey,
	type EntryStatus,
	type Issue,
} from "./checks.js";
import {
	ARTICLE_TYPES,
	defaultTypeForCollection,
	type PageSchemaType,
	type SeoConfig,
} from "./config.js";
import { collectImages, type EntryImage } from "./images.js";

/** Storage collection holding one record per content entry. */
export const ENTRIES = "entries";

// Extra schema an editor pastes into the JSON-LD field; larger values are ignored.
const CUSTOM_MAX_BYTES = 16 * 1024;

/**
 * What the plugin keeps about an entry, computed when the entry is saved or
 * published: the data the public page hook needs (so rendering a page costs
 * one storage read) and the result of the page checks.
 */
export interface EntryRecord {
	v: 1;
	publishedAt: string | null;
	updatedAt: string | null;
	authors: Array<{ name: string; url?: string }>;
	/** Entry-level schema type, set from the editor panel. */
	type?: PageSchemaType;
	/** Nodes from the entry's JSON-LD field, added to the page's graph. */
	custom: Array<Record<string, unknown>>;
	/**
	 * Images in the entry's own fields with their recorded size, so the page's
	 * primary image can be described with width and height. Absent on records
	 * written before 0.1.2, and when the entry has none.
	 */
	images?: EntryImage[];
	/** The entry's own data has no picture for shared links (the saved-entry check). */
	needsImage?: boolean;
	/**
	 * The page was last rendered with a picture (one the theme passes), which the
	 * saved-entry check cannot see. Set and cleared only by the public page hook;
	 * while set, "no picture for shared links" is not reported.
	 */
	imageSeen?: boolean;
	// Page checks. Absent on records written before checks existed.
	collection?: string;
	entryId?: string;
	title?: string;
	/**
	 * Indexed: ready, look, fix or hidden; "draft" for unpublished entries;
	 * "skip" for entries of a collection that has no pages of its own.
	 */
	status?: EntryStatus | "draft" | "skip";
	/** Indexed: normalised title, for finding pages that share one. */
	titleKey?: string;
	issues?: Issue[];
	checkedAt?: string;
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

export type ContentEntry = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>
>;

function entryTitle(entry: ContentEntry): string {
	const { title, name } = entry.data;
	if (typeof title === "string") return title;
	return typeof name === "string" ? name : "";
}

/**
 * The record for an entry, from data already in hand. Pure: no reads or
 * writes, so a scan can build many records and store them in one call.
 */
export function makeRecord(input: {
	collection: string;
	entry: ContentEntry;
	authors: EntryRecord["authors"];
	previous: EntryRecord | null;
	config: SeoConfig;
	siteUrl: string;
	duplicateTitle: boolean;
	/** False for a collection without public pages (testimonials, settings). */
	hasPages: boolean;
}): EntryRecord {
	const { collection, entry, authors, previous, config, siteUrl } = input;
	const rule = config.collections[collection];
	const type = previous?.type ?? rule?.type ?? defaultTypeForCollection(collection);
	const title = entry.seo?.title?.trim() || entryTitle(entry);
	const published = entry.status === "published";
	const counted = published && input.hasPages;
	const checked = !input.hasPages
		? []
		: checkEntry({
				slug: entry.slug,
				data: entry.data,
				seo: entry.seo,
				title: entryTitle(entry),
				siteUrl,
				isArticle: (ARTICLE_TYPES as readonly string[]).includes(type),
				authorCount: authors.length,
				duplicateTitle: input.duplicateTitle,
			});
	const needsImage = checked.some((issue) => issue.id === NO_SOCIAL_IMAGE.id);
	// What a render showed outlives a save: the save cannot see the theme's picture.
	const imageSeen = needsImage && previous?.imageSeen === true;
	const issues = imageSeen ? checked.filter((issue) => issue.id !== NO_SOCIAL_IMAGE.id) : checked;
	const images = input.hasPages ? collectImages(entry.data) : [];
	return {
		v: 1,
		publishedAt: entry.publishedAt,
		updatedAt: entry.updatedAt,
		authors,
		// The type is an editor's choice, not derived data: keep it across rebuilds.
		...(previous?.type ? { type: previous.type } : {}),
		custom: parseCustomSchema(entry.data[config.jsonLdField]),
		...(images.length > 0 ? { images } : {}),
		needsImage,
		...(imageSeen ? { imageSeen } : {}),
		collection,
		entryId: entry.id,
		title,
		// Only published pages with an address of their own are in search.
		status: !input.hasPages
			? "skip"
			: published
				? statusOf(issues, entry.seo?.noIndex === true || rule?.noindex === true)
				: "draft",
		titleKey: counted ? titleKey(title) : "",
		issues,
		checkedAt: new Date().toISOString(),
	};
}

/** A record's status after its issues changed; hidden, draft and skipped pages stay as they are. */
function restatus(record: EntryRecord, issues: Issue[]): EntryRecord["status"] {
	return record.status === "hidden" || record.status === "draft" || record.status === "skip"
		? record.status
		: statusOf(issues, false);
}

/**
 * What a public render of the page showed: it had a picture, or it did not.
 * Returns the changed record when that is news, otherwise null, so the caller
 * writes once per change and never on an ordinary render.
 *
 * Only pages whose own data has no picture are affected. Seeing a picture
 * drops "no picture for shared links"; a later render without one brings it back.
 */
export function observeImage(record: EntryRecord, hasImage: boolean): EntryRecord | null {
	const issues = record.issues ?? [];
	const listed = issues.some((issue) => issue.id === NO_SOCIAL_IMAGE.id);
	// Records written before 0.1.2 have no `needsImage`; the listed issue says the same.
	const needsImage = record.needsImage ?? listed;
	if (!needsImage) return null;
	if ((record.imageSeen === true) === hasImage && listed !== hasImage) return null;

	const others = issues.filter((issue) => issue.id !== NO_SOCIAL_IMAGE.id);
	const next = hasImage ? others : [...others, NO_SOCIAL_IMAGE];
	const { imageSeen: _seen, ...rest } = record;
	return {
		...rest,
		needsImage: true,
		...(hasImage ? { imageSeen: true } : {}),
		issues: next,
		status: restatus(record, next),
	};
}

/** Other published pages that share a title, excluding one entry. */
async function sameTitle(
	ctx: PluginContext,
	key: string,
	exceptId: string,
): Promise<Array<{ id: string; data: EntryRecord }>> {
	if (key === "") return [];
	const result = await entryStore(ctx).query({ where: { titleKey: key }, limit: 5 });
	return result.items.filter((item) => item.id !== exceptId);
}

/** A record with the "same title as another page" issue switched on or off. */
export function setDuplicate(record: EntryRecord, duplicate: boolean): EntryRecord {
	const others = (record.issues ?? []).filter((issue) => issue.id !== "duplicate-title");
	const issues: Issue[] = duplicate
		? [
				...others,
				{
					id: "duplicate-title",
					level: "fix",
					message: "Another page has the same title, so Google cannot tell them apart.",
					fix: "Give this page its own title in the SEO panel.",
				},
			]
		: others;
	return {
		...record,
		issues,
		status: restatus(record, issues),
	};
}

/**
 * Build and store the record for one entry, and keep the "same title" flag
 * right on the pages it shares, or used to share, a title with. Returns null
 * when the entry is gone or the plugin lacks content access.
 */
export async function buildEntryRecord(
	ctx: PluginContext,
	collection: string,
	id: string,
	config: SeoConfig,
): Promise<EntryRecord | null> {
	return (await rebuildEntry(ctx, collection, id, config))?.record ?? null;
}

/** As buildEntryRecord, also returning the entry it read, to save a second read. */
export async function rebuildEntry(
	ctx: PluginContext,
	collection: string,
	id: string,
	config: SeoConfig,
): Promise<{ record: EntryRecord; entry: ContentEntry } | null> {
	const entry = await ctx.content?.get(collection, id);
	if (!entry) return null;

	const store = entryStore(ctx);
	const key = entryKey(collection, id);
	const [credits, previous, schema] = await Promise.all([
		ctx.bylines?.getEntriesBylines(collection, [id]) ?? [],
		store.get(key),
		ctx.schema?.getCollection(collection),
	]);
	const authors = (credits[0]?.bylines ?? []).map(({ byline }) => ({
		name: byline.displayName,
		...(byline.websiteUrl ? { url: byline.websiteUrl } : {}),
	}));

	const draft = makeRecord({
		collection,
		entry,
		authors,
		previous,
		config,
		siteUrl: ctx.site.url,
		duplicateTitle: false,
		// Without schema access, assume the collection has pages.
		hasPages: schema ? schema.routable && !schema.hidden : true,
	});
	const twins = await sameTitle(ctx, draft.titleKey ?? "", key);
	const record = setDuplicate(draft, twins.length > 0);

	const writes: Array<{ id: string; data: EntryRecord }> = [{ id: key, data: record }];
	// Pages that now share this title learn about it.
	for (const twin of twins) {
		if (!twin.data.issues?.some((issue) => issue.id === "duplicate-title")) {
			writes.push({ id: twin.id, data: setDuplicate(twin.data, true) });
		}
	}
	// A page left alone with the old title is no longer a duplicate.
	const oldKey = previous?.titleKey ?? "";
	if (oldKey !== "" && oldKey !== record.titleKey) {
		const left = await sameTitle(ctx, oldKey, key);
		const only = left.length === 1 ? left[0] : undefined;
		if (only) writes.push({ id: only.id, data: setDuplicate(only.data, false) });
	}
	await store.putMany(writes);
	return { record, entry };
}

/** Remove an entry's record and un-flag a page left alone with its title. */
export async function removeEntryRecord(
	ctx: PluginContext,
	collection: string,
	id: string,
): Promise<void> {
	const store = entryStore(ctx);
	const key = entryKey(collection, id);
	const previous = await store.get(key);
	await store.delete(key);
	const left = await sameTitle(ctx, previous?.titleKey ?? "", key);
	const only = left.length === 1 ? left[0] : undefined;
	if (only) await store.put(only.id, setDuplicate(only.data, false));
}
