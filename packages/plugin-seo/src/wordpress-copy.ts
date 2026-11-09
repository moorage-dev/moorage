// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block } from "@emdash-cms/blocks";
import type { CollectionSchemaInfo, PluginContext } from "emdash";

import { plural } from "./redirects-admin.js";
import { SCAN_KEY } from "./scan.js";
import {
	IMPORTED_DESCRIPTION_FIELD,
	IMPORTED_TITLE_FIELD,
	planCopy,
	writesSomething,
	type CopyPlan,
} from "./wordpress.js";

/**
 * "Copy imported WordPress SEO values": an admin's one button on the Overview that copies the
 * titles and descriptions the WordPress import left in content fields (see wordpress.ts) into
 * each entry's SEO panel, where the page uses them.
 *
 * Two passes over the entries, each a page of entries at a time so that every request stays
 * within the sandbox's calls: first counting what would change (nothing is written), then, once
 * the admin confirms, copying. The copy reads every page of entries again just before writing,
 * so a value someone put in the SEO panel after the count is never written over.
 *
 * Writing goes through `ctx.content.update(collection, id, { seo })`, which needs content:write.
 * EmDash writes an SEO-only update straight into the SEO panel's table: the published page uses
 * it at once, no draft is made and the entry is not republished (the SEO panel has no drafts in
 * EmDash 1.4.0; emdash-cms/emdash#4028). In EmDash 1.4.0 only a plugin run in the site's process
 * can do this: the sandbox runners pass `seo` on as if it were a field, and EmDash refuses it.
 * The count tries one harmless write first (an empty `seo`), and says so when it is refused.
 */

/** KV key of the copy, and the background task that continues it. */
export const COPY_KEY = "wordpress-seo";
export const COPY_TASK = "seo-wordpress-copy";

// Entries read per page. The sandbox runners return 100 at most.
const LIST_PAGE = 100;
// Rows shown in "What will change".
const SAMPLE_ROWS = 10;
// What the end of a copy step may need: saving where it got to, starting or stopping the
// background task, and asking for the pages to be checked again.
const COPY_END_CALLS = 3;

export interface CopyTally {
	/** Entries that get (or got) at least one value. */
	pages: number;
	titles: number;
	descriptions: number;
	/** Entries whose SEO panel already had a different value, which is kept. */
	own: number;
}

export interface CopyJob {
	status: "counting" | "counted" | "copying" | "done" | "failed";
	/** Collections still to read in this pass; the first is in progress. */
	collections: string[];
	cursor?: string;
	/** Every collection the copy covers: the copy reads them again from the first. */
	scope: string[];
	/** Whether EmDash let the plugin write the SEO panel (the count's harmless write). */
	writable?: boolean;
	found: CopyTally;
	copied: CopyTally;
	/** The first entries that would change, for the admin to see before copying. */
	sample: Array<{ page: string; title: string; description: string }>;
	/** Why the copy stopped, when it failed. */
	error?: string;
	/** The names the site goes by, left off the end of titles; kept for the background task. */
	siteNames: string[];
	startedAt: string;
	finishedAt?: string;
}

const emptyTally = (): CopyTally => ({ pages: 0, titles: 0, descriptions: 0, own: 0 });

/** Collections whose entries can hold imported values and have an SEO panel to copy them to. */
export function copyScope(collections: CollectionSchemaInfo[]): string[] {
	return collections
		.filter(
			(collection) =>
				collection.hasSeo &&
				collection.fields.some(
					(field) =>
						field.slug === IMPORTED_TITLE_FIELD || field.slug === IMPORTED_DESCRIPTION_FIELD,
				),
		)
		.map((collection) => collection.slug);
}

export function newCopyJob(collections: string[], siteNames: string[]): CopyJob {
	return {
		status: "counting",
		siteNames: [...new Set(siteNames.map((name) => name.trim()).filter((name) => name !== ""))],
		collections: [...collections],
		scope: [...collections],
		found: emptyTally(),
		copied: emptyTally(),
		sample: [],
		startedAt: new Date().toISOString(),
	};
}

type Item = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["content"]>["list"]>>
>["items"][number];

function titleOf(item: Item): string {
	const { title, name } = item.data;
	if (typeof title === "string") return title;
	return typeof name === "string" ? name : "";
}

function planFor(item: Item, siteName: string[]): CopyPlan | null {
	// The SEO panel's values, as the list returns them for a collection that has the panel.
	return planCopy({ data: item.data, seo: item.seo, title: titleOf(item), siteName });
}

function add(tally: CopyTally, plan: CopyPlan): void {
	if (writesSomething(plan)) tally.pages += 1;
	if (plan.title !== undefined) tally.titles += 1;
	if (plan.description !== undefined) tally.descriptions += 1;
}

/** Move on to the next page of entries, or the next collection. */
function advance(job: CopyJob, page: { hasMore: boolean; cursor?: string }): void {
	if (page.hasMore && page.cursor) job.cursor = page.cursor;
	else {
		job.cursor = undefined;
		job.collections = job.collections.slice(1);
	}
}

/** Write SEO panel values; throws when EmDash gives the plugin no way to write content. */
async function writeSeo(
	ctx: PluginContext,
	collection: string,
	id: string,
	seo: { title?: string; description?: string },
): Promise<void> {
	const content = ctx.content;
	if (!content?.update) throw new Error("the plugin may not change content");
	await content.update(collection, id, { seo });
}

function clone(job: CopyJob): CopyJob {
	return {
		...job,
		collections: [...job.collections],
		scope: [...job.scope],
		found: { ...job.found },
		copied: { ...job.copied },
		sample: [...job.sample],
	};
}

/**
 * Count what the copy would change, a page of entries per call to the host, and save where it
 * got to. Writes nothing to any entry. `calls` is what the caller can spare, saving included.
 */
export async function countStep(
	ctx: PluginContext,
	current: CopyJob,
	calls: number,
): Promise<CopyJob> {
	const job = clone(current);
	const siteName = job.siteNames;
	let used = 0;
	// One read, maybe the harmless write, and saving.
	while (job.collections.length > 0 && used + (job.writable === undefined ? 3 : 2) <= calls) {
		const collection = job.collections[0] ?? "";
		const page = ctx.content
			? await ctx.content.list(collection, { limit: LIST_PAGE, cursor: job.cursor })
			: { items: [], hasMore: false };
		used += 1;
		for (const item of page.items) {
			const plan = planFor(item, siteName);
			if (!plan) continue;
			if (plan.own) job.found.own += 1;
			if (!writesSomething(plan)) continue;
			add(job.found, plan);
			if (job.sample.length < SAMPLE_ROWS) {
				job.sample.push({
					page: titleOf(item) || "(no title)",
					title: plan.title ?? "",
					description: plan.description ?? "",
				});
			}
			if (job.writable === undefined) {
				// An empty `seo` changes nothing; it shows whether EmDash takes `seo` from this plugin.
				used += 1;
				try {
					await writeSeo(ctx, collection, item.id, {});
					job.writable = true;
				} catch {
					job.writable = false;
				}
			}
		}
		advance(job, page);
	}
	if (job.collections.length === 0) job.status = "counted";
	await ctx.kv.set(COPY_KEY, job);
	return job;
}

/**
 * Copy the values into the SEO panel, a page of entries at a time, and save where it got to. Each
 * page of entries is read again just before writing, so only empty panel fields are filled; a
 * page of entries read again after some of it was copied finds those entries done. When the copy
 * is over, the pages are checked again (the check is restarted on the next visit to the SEO page),
 * because EmDash runs no save hook for a plugin's own writes.
 * `scheduled: false` when no background task runs for it yet; one is started if more is left.
 */
export async function copyStep(
	ctx: PluginContext,
	current: CopyJob,
	calls: number,
	{ scheduled = true }: { scheduled?: boolean } = {},
): Promise<CopyJob> {
	const job: CopyJob = { ...clone(current), status: "copying" };
	if (current.status === "counted") {
		// The copy reads every entry again, from the first collection.
		job.collections = [...job.scope];
		job.cursor = undefined;
	}
	const siteName = job.siteNames;
	let used = 0;
	const room = () => calls - COPY_END_CALLS - used;
	// A read and at least one write must fit.
	while (job.collections.length > 0 && room() >= 2) {
		const collection = job.collections[0] ?? "";
		const page = ctx.content
			? await ctx.content.list(collection, { limit: LIST_PAGE, cursor: job.cursor })
			: { items: [], hasMore: false };
		used += 1;
		const plans = page.items.map((item) => ({ item, plan: planFor(item, siteName) }));
		const todo = plans.filter(({ plan }) => writesSomething(plan));
		let done = 0;
		for (const { item, plan } of todo) {
			if (room() < 1 || !plan) break;
			used += 1;
			try {
				await writeSeo(ctx, collection, item.id, {
					...(plan.title !== undefined ? { title: plan.title } : {}),
					...(plan.description !== undefined ? { description: plan.description } : {}),
				});
			} catch (error) {
				job.status = "failed";
				job.error = `${titleOf(item) || item.id}: ${error instanceof Error ? error.message : String(error)}`;
				break;
			}
			add(job.copied, plan);
			done += 1;
		}
		if (job.status === "failed" || done < todo.length) break;
		// The page of entries is finished: count the ones that kept their own values once.
		job.copied.own += plans.filter(({ plan }) => plan?.own).length;
		advance(job, page);
	}
	if (job.collections.length === 0 && job.status === "copying") {
		job.status = "done";
		job.finishedAt = new Date().toISOString();
	}
	const over = job.status !== "copying";
	if (over) {
		// The pages' records still describe them as they were: check them again.
		try {
			await ctx.kv.delete(SCAN_KEY);
		} catch {
			// The next "Check all pages again" does the same.
		}
	}
	try {
		if (over && scheduled) await ctx.cron?.cancel(COPY_TASK);
		if (!over && !scheduled) await ctx.cron?.schedule(COPY_TASK, { schedule: "* * * * *" });
	} catch {
		// Each click on Update continues the copy as well.
	}
	await ctx.kv.set(COPY_KEY, job);
	return job;
}

/**
 * Stop a copy, or put away a finished one. A copy stopped part-way has changed some pages, so they
 * are checked again too.
 */
export async function closeCopy(ctx: PluginContext, job: CopyJob | null): Promise<void> {
	if (job?.status === "copying") {
		try {
			await ctx.cron?.cancel(COPY_TASK);
		} catch {
			// The task stops itself when it finds no copy under way.
		}
		await ctx.kv.delete(SCAN_KEY);
	}
	await ctx.kv.delete(COPY_KEY);
}

/** What the copy did, in one sentence or two. */
export function copiedMessage(job: CopyJob): string {
	const { titles, descriptions, own } = job.copied;
	const parts = [
		descriptions > 0 ? plural(descriptions, "description") : "",
		titles > 0 ? plural(titles, "title") : "",
	].filter((part) => part !== "");
	const copied =
		parts.length > 0
			? `Copied ${parts.join(" and ")} into the SEO panel.`
			: "Nothing needed copying.";
	const kept =
		own > 0
			? ` ${own === 1 ? "1 page already had its own, which was" : `${own} pages already had their own, which were`} kept.`
			: "";
	return `${copied}${kept}`;
}

const COPY_HEADER: Block = { type: "header", text: "Copy imported WordPress SEO values" };

/**
 * The section on the Overview, for admins. Shown while a copy is under way or just ended, or
 * when the last check found pages with imported values (`imported`).
 */
export function copySection(job: CopyJob | null, imported: number): Block[] {
	if (!job) {
		if (imported === 0) return [];
		return [
			COPY_HEADER,
			{
				type: "context",
				text: `${imported === 1 ? "1 page has" : `${imported} pages have`} a search title or description from WordPress (Yoast or Rank Math) that the page does not use yet: the WordPress import put them in the fields SEO Title and SEO Description, not in the page's SEO panel. This copies them into the SEO panel. A page whose SEO panel already has its own title or description keeps it, and the site's name is left off the end of each title, as your site adds it.`,
			},
			{
				type: "actions",
				elements: [{ type: "button", action_id: "wp_count", label: "See what will change" }],
			},
		];
	}
	const blocks: Block[] = [COPY_HEADER];
	if (job.status === "counting") {
		blocks.push(
			{
				type: "context",
				text: `${job.found.pages} ${job.found.pages === 1 ? "page" : "pages"} found so far. Nothing has been changed.`,
			},
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: "wp_count", label: "Continue counting", style: "primary" },
					{ type: "button", action_id: "wp_cancel", label: "Cancel" },
				],
			},
		);
		return blocks;
	}
	if (job.status === "counted") {
		const { found } = job;
		if (found.pages === 0) {
			blocks.push(
				{
					type: "empty",
					title: "Nothing to copy: every page's SEO panel already has these values or its own.",
					size: "sm",
				},
				{
					type: "actions",
					elements: [{ type: "button", action_id: "wp_cancel", label: "Close" }],
				},
			);
			return blocks;
		}
		blocks.push({
			type: "stats",
			items: [
				{ label: "Pages that will change", value: found.pages },
				{ label: "Descriptions to copy", value: found.descriptions },
				{ label: "Titles to copy", value: found.titles },
			],
		});
		if (found.own > 0) {
			blocks.push({
				type: "context",
				text: `${found.own === 1 ? "1 page already has its own title or description, which is" : `${found.own} pages already have their own title or description, which are`} kept.`,
			});
		}
		blocks.push({
			type: "table",
			page_action_id: "wp_table",
			columns: [
				{ key: "page", label: "Page" },
				{ key: "title", label: "SEO Title" },
				{ key: "description", label: "Meta Description" },
			],
			rows: job.sample.map((row) => ({
				...row,
				title: row.title || "(kept as it is)",
				description: row.description || "(kept as it is)",
			})),
		});
		if (found.pages > job.sample.length) {
			blocks.push({
				type: "context",
				text: `Showing the first ${job.sample.length} of ${found.pages}.`,
			});
		}
		if (job.writable === false) {
			blocks.push(
				{
					type: "banner",
					variant: "alert",
					title: "This site cannot copy them yet",
					description:
						"Here the SEO plugin runs sandboxed, and EmDash does not yet let a sandboxed plugin fill in the SEO panel. Nothing has been changed. Copy the values into each page's SEO panel by hand (they are in SEO Title and SEO Description, under the page's text), or run the plugin in the site's process (listed under plugins: [ ] in astro.config.mjs) and copy them here.",
				},
				{
					type: "actions",
					elements: [{ type: "button", action_id: "wp_cancel", label: "Close" }],
				},
			);
			return blocks;
		}
		blocks.push(
			{
				type: "context",
				text: "The pages use the copied values as soon as they are copied: the SEO panel has no drafts, so nothing needs publishing again.",
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "wp_copy",
						label: `Copy into ${plural(found.pages, "page")}`,
						style: "primary",
					},
					{ type: "button", action_id: "wp_cancel", label: "Cancel" },
				],
			},
		);
		return blocks;
	}
	if (job.status === "copying") {
		blocks.push(
			{
				type: "context",
				text: `${job.copied.pages} of ${job.found.pages} ${job.found.pages === 1 ? "page" : "pages"} copied so far. The rest follow in the background, a few each minute. You can leave this page.`,
			},
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: "wp_copy", label: "Update" },
					{ type: "button", action_id: "wp_cancel", label: "Stop here" },
				],
			},
		);
		return blocks;
	}
	if (job.status === "failed") {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "The copy stopped",
			description: `EmDash refused to save ${job.error ?? "a page"}. ${job.copied.pages > 0 ? `${plural(job.copied.pages, "page")} copied before that keep their values.` : "Nothing was changed."}`,
		});
	} else {
		blocks.push({
			type: "context",
			text: `${copiedMessage(job)} The pages are being checked again.`,
		});
	}
	blocks.push({
		type: "actions",
		elements: [{ type: "button", action_id: "wp_cancel", label: "Close" }],
	});
	return blocks;
}
