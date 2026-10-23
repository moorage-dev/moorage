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

// Pages read back per title. More pages than this with one title are rare; the title pass
// of a full check settles the rest.
const GROUP_LIMIT = 10;

/** Published pages with a normalised title, this entry included. */
async function titleGroup(
	ctx: PluginContext,
	key: string,
): Promise<Array<{ id: string; data: EntryRecord }>> {
	return (await titleGroups(ctx, [key]))[0] ?? [];
}

/** The pages of each title, read in one operation; empty titles have none. */
async function titleGroups(
	ctx: PluginContext,
	keys: string[],
): Promise<Array<Array<{ id: string; data: EntryRecord }>>> {
	const wanted = [...new Set(keys.filter((key) => key !== ""))];
	if (wanted.length === 0) return keys.map(() => []);
	const result = await entryStore(ctx).query({
		where: { titleKey: wanted.length === 1 ? (wanted[0] ?? "") : { in: wanted } },
		limit: GROUP_LIMIT * wanted.length,
	});
	return keys.map((key) =>
		key === "" ? [] : result.items.filter((item) => item.data.titleKey === key),
	);
}

/** Whether a record carries the "same title as another page" issue. */
export function isDuplicate(record: EntryRecord): boolean {
	return record.issues?.some((issue) => issue.id === "duplicate-title") ?? false;
}

/**
 * Switch the flag on the pages of one title read back from the store: on for all of
 * them when there are two or more, off for one left alone.
 */
function settleGroup(
	group: Array<{ id: string; data: EntryRecord }>,
	writes: Map<string, EntryRecord>,
): void {
	const duplicate = group.length > 1;
	for (const { id, data } of group) {
		if (isDuplicate(data) !== duplicate) writes.set(id, setDuplicate(data, duplicate));
	}
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

/** An entry's record rebuilt from the saved entry, not yet written. */
interface Rebuilt {
	entry: ContentEntry;
	previous: EntryRecord | null;
	/** Keeps the stored flag while the title stays the same; off otherwise. */
	record: EntryRecord;
	newKey: string;
	oldKey: string;
}

/** Read an entry and what is needed to rebuild its record: five operations, no writes. */
async function prepareEntry(
	ctx: PluginContext,
	collection: string,
	id: string,
	config: SeoConfig,
): Promise<Rebuilt | null> {
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
	const newKey = draft.titleKey ?? "";
	const oldKey = previous?.titleKey ?? "";
	// Until the titles are read back, a page keeps its flag while it keeps its title.
	const record = setDuplicate(
		draft,
		newKey !== "" && newKey === oldKey && previous !== null && isDuplicate(previous),
	);
	return { entry, previous, record, newKey, oldKey };
}

/** As buildEntryRecord, also returning the entry it read, to save a second read. */
export async function rebuildEntry(
	ctx: PluginContext,
	collection: string,
	id: string,
	config: SeoConfig,
): Promise<{ record: EntryRecord; entry: ContentEntry } | null> {
	const prepared = await prepareEntry(ctx, collection, id, config);
	if (!prepared) return null;
	const { entry, record, newKey, oldKey } = prepared;
	const store = entryStore(ctx);
	const key = entryKey(collection, id);

	// Write first, then read the pages with the new and the old title. A save and a check
	// (or two saves) running at the same time each write before they read, so at least one
	// of them sees the other's record and leaves the flags right on both.
	// Both titles in one read: a save moving a page between titles stays at 9 operations even on
	// a site that never saved settings (two reads), one below the sandbox's limit of 10.
	await store.put(key, record);
	const [group = [], left = []] = await titleGroups(ctx, [newKey, oldKey !== newKey ? oldKey : ""]);

	const writes = new Map<string, EntryRecord>();
	let members = group;
	const stored = group.find((item) => item.id === key)?.data;
	if (newKey !== "" && stored?.checkedAt !== record.checkedAt) {
		// Someone wrote this entry's record after us. Another save of the same entry settles
		// its own record; a check that read the entry before this save wrote an older copy,
		// so ours goes back. A copy found with neither title (a third one) is left to the next
		// save or check: reading it would take the save to the sandbox's limit of 10 operations.
		const current = stored ?? left.find((item) => item.id === key)?.data ?? null;
		if (current && isOlder(current.updatedAt, record.updatedAt)) {
			writes.set(key, record);
			members = [...group.filter((item) => item.id !== key), { id: key, data: record }];
		}
	}
	// Pages that now share this title learn about it; a page left alone with the old title
	// is no longer a duplicate.
	settleGroup(members, writes);
	settleGroup(
		left.filter((item) => item.id !== key),
		writes,
	);
	if (writes.size > 0)
		await store.putMany([...writes].map(([itemId, data]) => ({ id: itemId, data })));
	return { record: writes.get(key) ?? record, entry };
}

/**
 * The record for the editor panel: rebuilt from the saved entry, with `change` (the page
 * type an admin picked) applied, and written in one operation. The panel never moves a page
 * between titles, which costs up to five more operations: on Cloudflare a sandboxed route may
 * make only ten (Worker Loader's subrequest limit; see SANDBOX_OPERATIONS in scan.ts). When the title changed since the record was written, the save hook
 * that follows every save, or the next full check, settles the flags; the panel then keeps the
 * stored record as it is, only with `change` applied, so that hook still sees the old title.
 */
export async function refreshForPanel(
	ctx: PluginContext,
	collection: string,
	id: string,
	config: SeoConfig,
	change?: (record: EntryRecord) => EntryRecord,
): Promise<{ record: EntryRecord; entry: ContentEntry } | null> {
	const prepared = await prepareEntry(ctx, collection, id, config);
	if (!prepared) return null;
	const { entry, previous, newKey, oldKey } = prepared;
	const record = change ? change(prepared.record) : prepared.record;
	const key = entryKey(collection, id);
	if (previous === null || newKey === oldKey) await entryStore(ctx).put(key, record);
	else if (change) await entryStore(ctx).put(key, change(previous));
	return { record, entry };
}

/** Whether a stored record describes an older version of the entry than `than`. */
export function isOlder(updatedAt: string | null | undefined, than: string | null | undefined) {
	if (!updatedAt || !than) return false;
	const a = Date.parse(updatedAt);
	const b = Date.parse(than);
	return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

/** Remove an entry's record and settle the flag on the pages left with its title. */
export async function removeEntryRecord(
	ctx: PluginContext,
	collection: string,
	id: string,
): Promise<void> {
	const store = entryStore(ctx);
	const key = entryKey(collection, id);
	const previous = await store.get(key);
	await store.delete(key);
	const writes = new Map<string, EntryRecord>();
	settleGroup(
		(await titleGroup(ctx, previous?.titleKey ?? "")).filter((item) => item.id !== key),
		writes,
	);
	if (writes.size > 0)
		await store.putMany([...writes].map(([itemId, data]) => ({ id: itemId, data })));
}
