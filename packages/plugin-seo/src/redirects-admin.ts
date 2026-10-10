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

/** A redirect as the Redirects tab lists it. */
export interface RedirectRow {
	id: string;
	source: string;
	destination: string;
	type: number;
	hits: number;
}

// Redirects shown in the tab; the full list lives in EmDash's own Redirects screen.
const ROWS_SHOWN = 20;

const KINDS: Array<{ value: string; label: string }> = [
	{ value: "301", label: "Permanent (301)" },
	{ value: "302", label: "Temporary (302)" },
	{ value: "410", label: "Page deleted on purpose (410)" },
];

function kindLabel(type: number): string {
	if (type === 301 || type === 308) return "Permanent";
	if (type === 302 || type === 307) return "Temporary";
	return type === 410 ? "Deleted on purpose" : String(type);
}

/** The newest redirects, for the table. */
export async function listRedirects(
	ctx: PluginContext,
): Promise<{ rows: RedirectRow[]; more: boolean }> {
	const page = await ctx.redirects?.list({ limit: ROWS_SHOWN });
	return {
		rows: (page?.items ?? []).map(({ id, source, destination, type, hits }) => ({
			id,
			source,
			destination,
			type,
			hits,
		})),
		more: page?.hasMore ?? false,
	};
}

function hostMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/already exists/i.test(message)) return "A redirect from that old address already exists.";
	if (/must be different/i.test(message)) return "The old and new address are the same.";
	if (/loop/i.test(message)) return "That would send visitors in a circle.";
	if (/changed since/i.test(message)) return "That redirect was just changed elsewhere. Try again.";
	return "EmDash could not save that redirect. Check both addresses start with /.";
}

/** Read one typed redirect the same way an imported row is read. */
function readOne(source: string, destination: string, code: string): ReadyRow | string {
	const plan = planImport(exportList([{ source, destination, type: Number(code) || 301 }]), []);
	return plan.ready[0] ?? plan.skipped[0]?.reason ?? "Type the old address first.";
}

/** Add one redirect typed into the form. Returns an error message, or null. */
export async function addOne(
	ctx: PluginContext,
	source: string,
	destination: string,
	code: string,
): Promise<string | null> {
	const row = readOne(source, destination, code);
	if (typeof row === "string") return `${row}.`;
	try {
		await ctx.redirects?.create?.(row);
		return null;
	} catch (error) {
		return hostMessage(error);
	}
}

/** Change one redirect. Returns an error message, or null. */
export async function updateOne(
	ctx: PluginContext,
	id: string,
	source: string,
	destination: string,
	code: string,
): Promise<string | null> {
	const row = readOne(source, destination, code);
	if (typeof row === "string") return `${row}.`;
	try {
		const current = await ctx.redirects?.get(id);
		if (!current) return "That redirect no longer exists.";
		await ctx.redirects?.update?.(id, { ...row, _rev: current._rev });
		return null;
	} catch (error) {
		return hostMessage(error);
	}
}

/** Remove one redirect. Returns an error message, or null. */
export async function removeOne(ctx: PluginContext, id: string): Promise<string | null> {
	try {
		const current = await ctx.redirects?.get(id);
		if (current) await ctx.redirects?.delete?.(id, { _rev: current._rev });
		return null;
	} catch (error) {
		return hostMessage(error);
	}
}

function importBlocks(state: ImportState | null): Block[] {
	if (!state) {
		return [
			{
				type: "context",
				text: "Paste a list exported from Redirection, Yoast SEO Premium or Rank Math, or any list of old address, new address. Nothing is added until you confirm.",
			},
			{
				type: "form",
				block_id: "redirects",
				fields: [
					{
						type: "text_input",
						action_id: "list",
						label: "Your list, one redirect per line",
						multiline: true,
						placeholder: "/old-page,/new-page",
						initial_value: "",
					},
				],
				submit: { label: "Check list", action_id: "check_redirects" },
			},
		];
	}
	if (state.status === "checked") {
		const ready = state.rows.length;
		return [
			{
				type: "banner",
				variant: ready === 0 ? "alert" : "default",
				title: `${ready} ready, ${state.skipped.length} skipped`,
				description:
					ready === 0
						? "Nothing in this list can be added. See why below."
						: `Read as ${FORMAT_NAMES[state.format]}. Nothing has been added yet. Existing redirects are never changed.`,
			},
			{
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
			},
			...skippedTable(state.skipped),
		];
	}
	if (state.status === "adding") {
		return [
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
		];
	}
	return [
		{
			type: "banner",
			title: `${plural(state.added, "redirect")} added from your list`,
			description: `They are labelled "${state.group}".`,
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
									style: "danger" as const,
								},
							},
						]
					: []),
			],
		},
		...skippedTable(state.skipped),
	];
}

export interface RedirectsView {
	state: ImportState | null;
	rows: RedirectRow[];
	more: boolean;
	/** The redirect whose edit form is open. */
	editing?: RedirectRow;
	/** Keep the add form open (after a rejected entry). */
	adding?: boolean;
	exported?: string;
	/** Where EmDash's own Redirects screen lives, for the 404 log; absent when the site address is unknown. */
	managerUrl?: string;
}

function redirectForm(editing: RedirectRow | undefined): Block {
	const fields: Extract<Block, { type: "form" }>["fields"] = [
		{
			type: "text_input",
			action_id: "source",
			label: "When someone visits this old address",
			placeholder: "/old-page",
			initial_value: editing?.source ?? "",
		},
		{
			type: "text_input",
			action_id: "destination",
			label: "Send them to",
			placeholder: "/new-page",
			initial_value: editing?.destination ?? "",
		},
	];
	// A new redirect is permanent, which is what a moved page needs. The kind is
	// only offered when changing one, and always includes the kind it already has.
	if (editing) {
		const current = String(editing.type);
		fields.push({
			type: "select",
			action_id: "code",
			label: "Kind",
			options: KINDS.some((kind) => kind.value === current)
				? KINDS
				: [...KINDS, { value: current, label: `${kindLabel(editing.type)} (${current})` }],
			initial_value: current,
		});
	}
	return {
		type: "form",
		// A new id each time makes the admin start the form empty again.
		block_id: editing ? `edit_redirect_${editing.id}` : `add_redirect_${Date.now()}`,
		fields,
		submit: editing
			? { label: "Save changes", action_id: `save_redirect:${editing.id}` }
			: { label: "Add redirect", action_id: "add_redirect" },
	};
}

/** The Redirects tab: add one, see and change what exists, import a list. */
export function redirectsTab(view: RedirectsView): Block[] {
	const { state, rows, editing } = view;
	const blocks: Block[] = [
		{
			type: "context",
			text: "Send visitors from an old address to a new one (301 redirects), so links and Google results keep working after a page moves.",
		},
	];

	if (editing) {
		blocks.push(
			{ type: "header", text: "Change a redirect" },
			redirectForm(editing),
			{
				type: "actions",
				elements: [{ type: "button", action_id: "cancel_edit", label: "Cancel" }],
			},
			{ type: "divider" },
		);
	}

	// What exists comes first; adding is one click away.
	if (rows.length === 0) {
		blocks.push({
			type: "empty",
			title: "No redirects yet",
			description: "Add one below, or import a list from WordPress.",
			size: "sm",
		});
	} else {
		blocks.push({
			type: "table",
			page_action_id: "redirects_table",
			columns: [
				{ key: "source", label: "Old address" },
				{ key: "destination", label: "Sends visitors to" },
				{ key: "kind", label: "Kind" },
				{ key: "hits", label: "Visits", format: "number" },
				{ key: "edit", label: "", format: "element" },
				{ key: "remove", label: "", format: "element" },
			],
			rows: rows.map((row) => ({
				source: row.source,
				destination: row.destination || "(none)",
				kind: kindLabel(row.type),
				hits: row.hits,
				edit: { type: "button", action_id: "edit_redirect", label: "Change", value: row.id },
				remove: {
					type: "button",
					action_id: "remove_redirect",
					label: "Remove",
					value: row.id,
					confirm: {
						title: "Remove this redirect?",
						text: `${row.source} will stop sending visitors anywhere.`,
						confirm: "Remove",
						deny: "Cancel",
						// Red, like EmDash's own delete confirmations.
						style: "danger",
					},
				},
			})),
		});
	}
	if (view.managerUrl) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "link",
					label: view.more
						? `Showing the newest ${rows.length}. All redirects and the missing-page log`
						: "Missing-page log",
					target: { kind: "external", url: view.managerUrl },
				},
			],
		});
	}

	if (!editing) {
		blocks.push({
			type: "accordion",
			label: "Add a redirect",
			default_open: rows.length === 0 || view.adding === true,
			blocks: [redirectForm(undefined)],
		});
	}
	blocks.push({
		type: "accordion",
		label: "Import a list from WordPress",
		default_open: state !== null,
		blocks: importBlocks(state),
	});
	blocks.push({
		type: "accordion",
		label: "Export",
		default_open: view.exported !== undefined,
		blocks:
			view.exported !== undefined
				? [
						{
							type: "context",
							text: "Copy this list to keep a backup or to paste into a spreadsheet.",
						},
						{ type: "code", code: view.exported, language: "bash" },
					]
				: [
						{
							type: "actions",
							elements: [
								{
									type: "button",
									action_id: "export_redirects",
									label: "Show my redirects as a list",
								},
							],
						},
					],
	});
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
