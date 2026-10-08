// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import {
	exportList,
	planImport,
	type ExistingRedirect,
	type ListFormat,
	type ReadyRow,
	type SkippedRow,
} from "./redirects.js";

/** KV key holding the import in progress. */
export const IMPORT_KEY = "redirects";
/** Name of the background task that keeps adding redirects after the first click. */
export const IMPORT_TASK = "redirects-import";

// How many redirects are added before progress is saved. The sandbox allows
// only a handful of operations per request and there is no bulk API, so
// progress is saved often and each request continues where the last stopped.
const SAVE_EVERY = 4;
// Existing redirects read while checking a list, and shown when exporting.
const LIST_PAGES = 5;
const PAGE_SIZE = 100;
// Requests that may fail on the same row before that row is given up on.
const MAX_STALLS = 3;
// Rows shown in the skipped table; the rest are counted.
const SKIPPED_SHOWN = 50;

const FORMAT_NAMES: Record<ListFormat, string> = {
	redirection: "Redirection",
	yoast: "Yoast SEO Premium",
	rankmath: "Rank Math",
	plain: "a plain list",
};

export interface ImportState {
	status: "checked" | "adding" | "done";
	format: ListFormat;
	rows: ReadyRow[];
	skipped: SkippedRow[];
	/** Rows before this index have been handled. */
	cursor: number;
	added: number;
	/** Label on every redirect this import creates, so the batch can be found again. */
	group: string;
	/** Requests in a row that added nothing; a row that keeps failing is skipped. */
	stalls?: number;
}

export async function loadImport(ctx: PluginContext): Promise<ImportState | null> {
	const state = await ctx.kv.get<ImportState>(IMPORT_KEY);
	return state && Array.isArray(state.rows) ? state : null;
}

async function existingRedirects(ctx: PluginContext): Promise<ExistingRedirect[]> {
	const rules: ExistingRedirect[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < LIST_PAGES; page += 1) {
		const result = await ctx.redirects?.list({ limit: PAGE_SIZE, cursor });
		if (!result) break;
		rules.push(...result.items);
		cursor = result.hasMore ? result.cursor : undefined;
		if (!cursor) break;
	}
	return rules;
}

/** Read a pasted list and store what would be added. Nothing is created yet. */
export async function checkList(ctx: PluginContext, text: string): Promise<ImportState> {
	const plan = planImport(text, await existingRedirects(ctx));
	const state: ImportState = {
		status: "checked",
		format: plan.format,
		rows: plan.ready,
		skipped: plan.skipped,
		cursor: 0,
		added: 0,
		group: `Imported ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
	};
	await ctx.kv.set(IMPORT_KEY, state);
	return state;
}

function refusal(error: unknown): { kind: "exists" | "invalid" | "stop"; message: string } {
	const message = error instanceof Error ? error.message : String(error);
	if (/already exists/i.test(message)) return { kind: "exists", message };
	if (/invalid source pattern|must be different|destination|path traversal|loop/i.test(message)) {
		return { kind: "invalid", message };
	}
	// Anything else (the request ran out of operations, or EmDash is busy) is retried later.
	return { kind: "stop", message };
}

/**
 * Add as many of the remaining redirects as this request allows. Safe to call
 * repeatedly: a redirect created just before progress could be saved shows up
 * as "already exists" next time and is counted as added.
 */
export async function addMore(ctx: PluginContext, state: ImportState): Promise<ImportState> {
	const next: ImportState = { ...state, status: "adding", skipped: [...state.skipped] };
	const save = async () => {
		try {
			await ctx.kv.set(IMPORT_KEY, next);
			return true;
		} catch {
			return false;
		}
	};

	if (state.status === "checked") {
		try {
			await ctx.cron?.schedule(IMPORT_TASK, { schedule: "* * * * *" });
		} catch (error) {
			ctx.log.warn("could not schedule background import", { error: String(error) });
		}
	}

	let sinceSave = 0;
	const startedAt = next.cursor;
	while (next.cursor < next.rows.length) {
		const row = next.rows[next.cursor];
		if (!row) break;
		try {
			await ctx.redirects?.create?.({
				source: row.source,
				destination: row.destination,
				type: row.type,
				groupName: next.group,
			});
			next.added += 1;
		} catch (error) {
			const { kind, message } = refusal(error);
			if (kind === "stop") {
				// Usually the request ran out of operations and the next one carries on.
				// A row that stops every request is skipped so the import cannot hang.
				if (next.cursor !== startedAt) break;
				next.stalls = (next.stalls ?? 0) + 1;
				if (next.stalls < MAX_STALLS) break;
				next.skipped.push({
					line: 0,
					source: row.source,
					reason: `EmDash could not add it: ${message}`,
				});
			} else if (kind === "exists") next.added += 1;
			else
				next.skipped.push({ line: 0, source: row.source, reason: `EmDash refused it: ${message}` });
		}
		next.cursor += 1;
		next.stalls = 0;
		sinceSave += 1;
		if (sinceSave >= SAVE_EVERY) {
			if (!(await save())) return next;
			sinceSave = 0;
		}
	}

	if (next.cursor >= next.rows.length) {
		next.status = "done";
		try {
			await ctx.cron?.cancel(IMPORT_TASK);
		} catch {
			// The task also stops itself the next time it runs.
		}
	}
	await save();
	return next;
}

/** Remove the redirects the last import added. Returns how many are still left. */
export async function removeBatch(ctx: PluginContext, state: ImportState): Promise<number> {
	const batch = await ctx.redirects?.list({ limit: PAGE_SIZE, group: state.group });
	const items = batch?.items ?? [];
	let left = items.length;
	for (const item of items) {
		try {
			const current = await ctx.redirects?.get(item.id);
			if (current) await ctx.redirects?.delete?.(item.id, { _rev: current._rev });
			left -= 1;
		} catch {
			break;
		}
	}
	if (left === 0 && !batch?.hasMore) {
		try {
			await ctx.cron?.cancel(IMPORT_TASK);
		} catch {
			// Nothing scheduled.
		}
		await ctx.kv.delete(IMPORT_KEY);
		return 0;
	}
	return left;
}

/** The site's redirects as copyable text. */
export async function exportText(ctx: PluginContext): Promise<{ text: string; count: number }> {
	const rules: Array<{ source: string; destination: string; type: number }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < LIST_PAGES; page += 1) {
		const result = await ctx.redirects?.list({ limit: PAGE_SIZE, cursor });
		if (!result) break;
		rules.push(...result.items);
		cursor = result.hasMore ? result.cursor : undefined;
		if (!cursor) break;
	}
	return { text: exportList(rules), count: rules.length };
}

export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function skippedTable(skipped: SkippedRow[]): Block[] {
	if (skipped.length === 0) return [];
	const blocks: Block[] = [
		{ type: "header", text: `Skipped (${skipped.length})` },
		{
			type: "table",
			page_action_id: "skipped_table",
			columns: [
				{ key: "line", label: "Row" },
				{ key: "source", label: "Old address" },
				{ key: "reason", label: "Why" },
			],
			rows: skipped.slice(0, SKIPPED_SHOWN).map((row) => ({
				line: row.line > 0 ? String(row.line) : "",
				source: row.source,
				reason: row.reason,
			})),
		},
	];
	if (skipped.length > SKIPPED_SHOWN) {
		blocks.push({ type: "context", text: `And ${skipped.length - SKIPPED_SHOWN} more.` });
	}
	return blocks;
}

/** The Redirects tab for the current import state. */
export function redirectsTab(state: ImportState | null, exported?: string): Block[] {
	const blocks: Block[] = [
		{
			type: "context",
			text: "Send visitors from an old address to a new one (301 redirects). Paste a list exported from WordPress: Redirection, Yoast SEO Premium or Rank Math. To edit single redirects, use Redirects in the sidebar.",
		},
	];

	if (!state) {
		blocks.push({
			type: "form",
			block_id: "redirects",
			fields: [
				{
					type: "text_input",
					action_id: "list",
					label: "Paste your list (old address, new address), one per line",
					multiline: true,
					placeholder: "/old-page,/new-page",
					initial_value: "",
				},
			],
			submit: { label: "Check list", action_id: "check_redirects" },
		});
	} else if (state.status === "checked") {
		const ready = state.rows.length;
		blocks.push({
			type: "banner",
			variant: ready === 0 ? "alert" : "default",
			title: `${ready} ready, ${state.skipped.length} skipped`,
			description:
				ready === 0
					? "Nothing in this list can be added. See why below."
					: `Read as ${FORMAT_NAMES[state.format]}. Nothing has been added yet. Existing redirects are never changed.`,
		});
		blocks.push({
			type: "actions",
			elements: [
				...(ready > 0
					? [
							{
								type: "button" as const,
								action_id: "add_redirects",
								label: `Add ${plural(ready, "redirect")}`,
								style: "primary" as const,
								confirm: {
									title: `Add ${plural(ready, "redirect")}?`,
									text: "Visitors to these old addresses will be sent to the new ones. You can remove them all again afterwards.",
									confirm: "Add",
									deny: "Cancel",
								},
							},
						]
					: []),
				{ type: "button", action_id: "reset_redirects", label: "Start again" },
			],
		});
		blocks.push(...skippedTable(state.skipped));
	} else if (state.status === "adding") {
		blocks.push(
			{
				type: "meter",
				label: `${state.added} of ${state.rows.length} added`,
				value: state.cursor,
				max: state.rows.length,
			},
			{
				type: "context",
				text: "The rest are added in the background, a few each minute. You can leave this page.",
			},
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: "more_redirects", label: "Add more now", style: "primary" },
					{ type: "button", action_id: "stop_redirects", label: "Stop here" },
				],
			},
		);
	} else {
		blocks.push(
			{
				type: "banner",
				title: `${plural(state.added, "redirect")} added`,
				description: `They are labelled "${state.group}" under Redirects in the sidebar.`,
			},
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: "reset_redirects", label: "Import another list" },
					...(state.added > 0
						? [
								{
									type: "button" as const,
									action_id: "remove_redirects",
									label: `Remove the ${state.added} just added`,
									confirm: {
										title: "Remove these redirects?",
										text: "Only the redirects this import added are removed.",
										confirm: "Remove",
										deny: "Cancel",
									},
								},
							]
						: []),
				],
			},
			...skippedTable(state.skipped),
		);
	}

	blocks.push({ type: "divider" });
	if (exported !== undefined) {
		blocks.push(
			{ type: "context", text: "Copy this list to keep a backup or to paste into a spreadsheet." },
			{ type: "code", code: exported, language: "bash" },
		);
	} else {
		blocks.push({
			type: "actions",
			elements: [
				{ type: "button", action_id: "export_redirects", label: "Show my redirects as a list" },
			],
		});
	}
	return blocks;
}

export type RedirectsToast = BlockResponse["toast"];

/** Stop an import where it is; what was added stays and can still be removed. */
export async function stopImport(ctx: PluginContext, state: ImportState): Promise<ImportState> {
	const next: ImportState = { ...state, status: "done" };
	try {
		await ctx.cron?.cancel(IMPORT_TASK);
	} catch {
		// Nothing scheduled.
	}
	await ctx.kv.set(IMPORT_KEY, next);
	return next;
}
