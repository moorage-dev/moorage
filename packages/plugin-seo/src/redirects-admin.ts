// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

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
	/** "removing": the redirects it added are being removed again. */
	status: "checked" | "adding" | "done" | "removing";
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
	/** While removing: how many have been removed so far. */
	removed?: number;
}

/**
 * Calls to the host one run of the background task may spend on the import, after reading it
 * (one call): a sandboxed run may make only 10 on Cloudflare, and every run keeps to 9.
 */
export const TASK_CALLS = 8;

const EVERY_MINUTE = { schedule: "* * * * *" };

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

/** Start the background task that carries on with an import. Not logged when it fails: that
 * would cost another call, and "Add more now" or "Remove more now" carry on instead. */
async function schedule(ctx: PluginContext): Promise<void> {
	try {
		await ctx.cron?.schedule(IMPORT_TASK, EVERY_MINUTE);
	} catch {
		// See above.
	}
}

async function cancel(ctx: PluginContext): Promise<void> {
	try {
		await ctx.cron?.cancel(IMPORT_TASK);
	} catch {
		// The task also stops itself the next time it runs.
	}
}

/**
 * Add as many of the remaining redirects as `calls` allows (calls to the host, including saving
 * where it got to and starting or stopping the background task), then save; the background task
 * carries on from there, a few rows a minute. It stops before the sandbox's limit instead of
 * relying on the host to refuse. Safe to call repeatedly: a redirect created just before
 * progress could be saved shows up as "already exists" next time and is counted as added.
 */
export async function addMore(
	ctx: PluginContext,
	state: ImportState,
	calls = TASK_CALLS,
): Promise<ImportState> {
	const next: ImportState = { ...state, status: "adding", skipped: [...state.skipped] };
	// The background task runs once the import is under way, not while it is only checked.
	const scheduled = state.status === "adding";
	let used = 0;
	const save = async () => {
		used += 1;
		try {
			await ctx.kv.set(IMPORT_KEY, next);
			return true;
		} catch {
			return false;
		}
	};
	/** Calls kept for the end: the save, and starting the task (not finished) or stopping it. */
	const reserve = (finishing: boolean) => 1 + (finishing === scheduled ? 1 : 0);

	let sinceSave = 0;
	const startedAt = next.cursor;
	while (next.cursor < next.rows.length) {
		const row = next.rows[next.cursor];
		if (!row) break;
		const last = next.cursor === next.rows.length - 1;
		if (next.cursor !== startedAt && used + 1 + reserve(last) > calls) break;
		used += 1;
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
				// EmDash is busy, or the request ran out of calls: the next one carries on.
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
		// Progress is saved every few rows in case the request is cut short, when that still
		// leaves room for another row; otherwise the save at the end follows soon.
		if (sinceSave >= SAVE_EVERY && used + 1 + 1 + reserve(false) <= calls) {
			if (!(await save())) return next;
			sinceSave = 0;
		}
	}

	if (next.cursor >= next.rows.length) {
		next.status = "done";
		if (scheduled) await cancel(ctx);
	} else if (!scheduled) await schedule(ctx);
	await save();
	return next;
}

/**
 * Remove the redirects the import added, as many as `calls` allows (two calls each: EmDash
 * needs a redirect's current revision to delete it), then save how far it got; the background
 * task removes the rest. Returns null once they are all gone and the import is forgotten.
 */
export async function removeMore(
	ctx: PluginContext,
	state: ImportState,
	calls = TASK_CALLS,
): Promise<ImportState | null> {
	const scheduled = state.status === "removing";
	const next: ImportState = { ...state, status: "removing", removed: state.removed ?? 0 };
	const batch = await ctx.redirects?.list({ limit: PAGE_SIZE, group: state.group });
	let used = 1;
	const items = batch?.items ?? [];
	const reserve = (finishing: boolean) => 1 + (finishing === scheduled ? 1 : 0);
	let left = items.length;
	let failed = false;
	for (const item of items) {
		const finishing = left === 1 && !batch?.hasMore;
		if (used + 2 + reserve(finishing) > calls) break;
		used += 2;
		try {
			const current = await ctx.redirects?.get(item.id);
			if (current) await ctx.redirects?.delete?.(item.id, { _rev: current._rev });
			left -= 1;
			next.removed = (next.removed ?? 0) + 1;
		} catch {
			failed = true;
			break;
		}
	}
	if (left === 0 && !batch?.hasMore) {
		await ctx.kv.delete(IMPORT_KEY);
		if (scheduled) await cancel(ctx);
		return null;
	}
	// A redirect EmDash keeps refusing to remove would keep the task running for ever: after a
	// few runs that removed nothing, stop, and offer Remove again.
	next.stalls = failed && next.removed === (state.removed ?? 0) ? (state.stalls ?? 0) + 1 : 0;
	if (next.stalls >= MAX_STALLS) return stopRemoving(ctx, next, scheduled);
	if (!scheduled) await schedule(ctx);
	await ctx.kv.set(IMPORT_KEY, next);
	return next;
}

/** Stop removing; what is left stays, and Remove starts again. */
export async function stopRemoving(
	ctx: PluginContext,
	state: ImportState,
	scheduled = true,
): Promise<ImportState> {
	const { stalls: _stalls, removed, ...rest } = state;
	// What is left of the import, so Remove offers the right number again.
	const next: ImportState = {
		...rest,
		status: "done",
		added: Math.max(0, state.added - (removed ?? 0)),
	};
	if (scheduled) await cancel(ctx);
	await ctx.kv.set(IMPORT_KEY, next);
	return next;
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
			type: "context",
			text: "Skipped rows are not added. Copy any you still need and add them by hand under Manage > Redirects, which also accepts patterns.",
		},
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
	{ value: "301", label: "Permanent" },
	{ value: "302", label: "Temporary, the old address will come back" },
	{ value: "410", label: "Page removed on purpose, no new address" },
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
	if (/already exists/i.test(message)) {
		return "There is already a redirect from that old address. Use Change in the list below.";
	}
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
	if (state.status === "removing") {
		const removed = state.removed ?? 0;
		return [
			{
				type: "meter",
				label: `${removed} of ${state.added} removed`,
				value: removed,
				max: Math.max(state.added, removed, 1),
			},
			{
				type: "context",
				text: "The rest are removed in the background, a few each minute. You can leave this page.",
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "remove_redirects",
						label: "Remove more now",
						style: "primary",
					},
					{ type: "button", action_id: "stop_redirects", label: "Stop here" },
				],
			},
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
	/** Which task is open above the list, if any. */
	panel?: "add" | "import" | "export";
	/** Why a single typed redirect was refused. */
	problem?: string;
	exported?: string;
	/** Where EmDash's own Redirects screen lives, for the 404 log; absent when the site address is unknown. */
	managerUrl?: string;
}

function oneForm(editing: RedirectRow | undefined, formKey: string): Block {
	const current = editing ? String(editing.type) : "301";
	return {
		type: "form",
		// The id changes only after a successful add, so the form empties then
		// and keeps what was typed when an entry is refused.
		block_id: editing ? `edit_redirect_${editing.id}` : `add_one_${formKey}`,
		fields: [
			{
				type: "text_input",
				action_id: "source",
				label: "Redirect from",
				placeholder: "/old-page",
				initial_value: editing?.source ?? "",
			},
			{
				type: "text_input",
				action_id: "destination",
				label: "Redirect to",
				placeholder: "/new-page",
				initial_value: editing?.destination ?? "",
				condition: { field: "code", neq: "410" },
			},
			{
				type: "select",
				action_id: "code",
				label: "Kind",
				// A redirect keeps a kind this list does not offer, such as one imported as 308.
				options: KINDS.some((kind) => kind.value === current)
					? KINDS
					: [...KINDS, { value: current, label: `${kindLabel(Number(current))} (${current})` }],
				initial_value: current,
			},
		],
		submit: editing
			? { label: "Save changes", action_id: `save_redirect:${editing.id}` }
			: { label: "Add redirect", action_id: "add_redirect" },
	};
}

/**
 * The Redirects tab. The tasks are buttons in one row above the list, where
 * people look for them; pressing one opens that task in place, since a plugin
 * cannot open a dialog of its own. An import that is under way stays open
 * until it is finished.
 */
export function redirectsTab(view: RedirectsView): Block[] {
	const { state, rows, editing } = view;
	const panel = editing ? undefined : (view.panel ?? (state ? "import" : undefined));
	// The newest redirect changes after every successful add, which empties the form.
	const formKey = rows[0]?.id ?? "first";
	const blocks: Block[] = [
		{
			type: "context",
			text: "Send visitors from an old address to a new one. Pages you rename in EmDash are redirected for you.",
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "open_add",
					label: "Add a redirect",
					...(panel === undefined && !editing ? { style: "primary" as const } : {}),
				},
				{ type: "button", action_id: "open_import", label: "Import from WordPress" },
				{ type: "button", action_id: "export_redirects", label: "Export" },
				...(view.managerUrl
					? [
							{
								type: "link" as const,
								label: "Full Redirects screen",
								target: { kind: "external" as const, url: view.managerUrl },
							},
						]
					: []),
			],
		},
	];

	const close: Block = {
		type: "actions",
		elements: [{ type: "button", action_id: "close_panel", label: "Close" }],
	};
	const problem: Block[] = view.problem
		? [{ type: "banner", variant: "error", title: view.problem }]
		: [];
	if (editing) {
		blocks.push(
			{ type: "header", text: "Change a redirect" },
			...problem,
			oneForm(editing, formKey),
			close,
			{ type: "divider" },
		);
	} else if (panel === "add") {
		blocks.push(
			{ type: "header", text: "Add a redirect" },
			...problem,
			oneForm(undefined, formKey),
			close,
			{ type: "divider" },
		);
	} else if (panel === "import") {
		blocks.push({ type: "header", text: "Import from WordPress" }, ...importBlocks(state));
		// A finished or untouched import can be put away; one in progress stays visible.
		if (!state) blocks.push(close);
		blocks.push({ type: "divider" });
	} else if (panel === "export") {
		blocks.push(
			{ type: "header", text: "Export" },
			{
				type: "context",
				text: "Copy this list to keep a backup or to paste into a spreadsheet. It can be imported again here.",
			},
			{ type: "code", code: view.exported ?? "", language: "bash" },
			close,
			{ type: "divider" },
		);
	}

	if (rows.length === 0) {
		blocks.push({
			type: "empty",
			title: "No redirects yet",
			description: "Add one, or import a list from your old site.",
			size: "sm",
		});
	} else {
		blocks.push({
			type: "table",
			page_action_id: "redirects_table",
			columns: [
				{ key: "source", label: "Redirect from" },
				{ key: "destination", label: "Redirect to" },
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
						text: `Visitors to ${row.source} will see a not-found page.`,
						confirm: "Remove",
						deny: "Keep",
						// Red, like EmDash's own delete confirmations.
						style: "danger",
					},
				},
			})),
		});
		if (view.more) {
			blocks.push({
				type: "context",
				text: `Showing the newest ${rows.length}. The rest are in the full Redirects screen.`,
			});
		}
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
