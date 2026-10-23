// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import type { Group, LinkRow, Reason, Source } from "./model.js";
import { pickSettings, type SettingsKeys } from "./settings-store.js";

/**
 * KV keys. Everything is read with one `kv.list()` per run. All but the options
 * are state the plugin rebuilds (the check, its queue and results, the
 * checklist, when emails went out), so losing them costs one more check.
 */
export const KEY = {
	scan: "scan",
	summary: "summary",
	queue: "queue",
	options: "options",
	alerts: "alerts",
	checklist: "checklist",
} as const;

/**
 * Who gets emails and whether links to other sites are checked: `ctx.settings`
 * "options" (KV key `settings:options`), the same in-process and sandboxed. Up
 * to 0.1.2 it was the plain KV key `options`, still written for rollback (see
 * settings-store.ts).
 */
export const OPTIONS: SettingsKeys = { name: "options", legacy: KEY.options };

/**
 * Can the site open its own pages? Decided by the first page of each full check.
 * "updating": the site answered with EmDash's "database update not finished" page.
 */
export type LiveMode = "ok" | "not-public" | "blocked" | "failed" | "updating";

export type Phase =
	| "redirects"
	| "walk"
	| "resolve"
	| "live-home"
	| "live-pages"
	| "live-paths"
	| "checklist"
	| "sweep"
	| "count"
	| "freeze";

export interface CollectionInfo {
	slug: string;
	label: string;
	pattern: string | null;
	routable: boolean;
	titleField: string | null;
}

export interface ScanState {
	pass: number;
	status: "running" | "done";
	phase: Phase;
	collections: CollectionInfo[];
	/** Index of the collection being read. */
	ci: number;
	cursor?: string;
	/** Entries read so far. */
	walked: number;
	/** Published pages to open, and how many have been opened. */
	liveTotal?: number;
	liveDone: number;
	live?: LiveMode;
	/** Pages are kept ready for visitors (home page caching headers). */
	caching?: "ok" | "no";
	counts?: Omit<Summary, "rows" | "lookRows" | "unknownRows" | "pass" | "finishedAt" | "live">;
	startedAt: string;
	finishedAt?: string;
	lastStepAt?: string;
	/** The scheduled task's last run, when it made this step. */
	cronAt?: string;
	/** When the next full check starts. */
	nextAt?: string;
	/** Host calls made by the last run that wrote this. */
	ops?: number;
}

/** A row as the admin shows it. */
export interface RowView {
	id: string;
	kind: LinkRow["kind"];
	url: string;
	reason?: Reason;
	detail?: string;
	sources: Source[];
	count: number;
	menu: boolean;
	editor: boolean;
	since?: string;
}

/**
 * The last finished check, frozen. The page and the widget read only this
 * and the progress of a running check, so a number on screen is always a
 * finished pass over what it names.
 */
export interface Summary {
	pass: number;
	finishedAt: string;
	prevFinishedAt?: string;
	pages: number;
	links: number;
	fix: Record<Group, number>;
	editorFix: number;
	look: number;
	unknown: number;
	rows: Record<Group, RowView[]>;
	lookRows: RowView[];
	unknownRows: RowView[];
	live: LiveMode;
}

export interface Queue {
	/** When each host was last asked, and how often it asked us to slow down. */
	hosts: Record<string, { at: number; slow?: number }>;
	/** The scheduled task's last run. */
	cronAt?: string;
	ops?: number;
}

export interface Options {
	/** Who gets emails. Undefined until the first Admin opens the page. */
	recipients?: string[];
	outbound: boolean;
}

export interface AlertItem {
	id: string;
	text: string;
}

export interface Alerts {
	/** Last email of each kind. */
	urgentAt?: string;
	weeklyAt?: string;
	/** Urgent problems waiting for the next allowed email. */
	pending: AlertItem[];
	/** Rows already mailed as urgent, so they are not mailed twice. */
	sent: string[];
	/**
	 * The last email actually sent (a test or an alert). "not-set-up": it failed
	 * because no email service was chosen; "failed": any other failure.
	 */
	email?: {
		state: "working" | "not-set-up" | "failed";
		at: string;
		to: number;
		/** Who it went to, to tell when the list changed since. */
		list?: string[];
		kind?: "test" | "alert";
		error?: string;
	};
}

export type CheckStatus = "working" | "attention" | "untested" | "unknown";

export interface ChecklistState {
	checkedAt?: string;
	rows: Record<string, { status: CheckStatus; text: string }>;
}

export interface Loaded {
	scan: ScanState | null;
	summary: Summary | null;
	queue: Queue;
	options: Options;
	alerts: Alerts;
	checklist: ChecklistState;
}

export const ROWS_PER_GROUP = 10;

/** One read for everything kept in KV. */
export async function load(ctx: PluginContext): Promise<Loaded> {
	const items = await ctx.kv.list();
	const kv = new Map(items.map((item) => [item.key, item.value as unknown]));
	const options = ((await pickSettings(ctx, kv, OPTIONS)) as Partial<Options> | null) ?? {};
	const alerts = (kv.get(KEY.alerts) as Partial<Alerts> | undefined) ?? {};
	const queue = (kv.get(KEY.queue) as Partial<Queue> | undefined) ?? {};
	const checklist = (kv.get(KEY.checklist) as Partial<ChecklistState> | undefined) ?? {};
	return {
		scan: (kv.get(KEY.scan) as ScanState | undefined) ?? null,
		summary: (kv.get(KEY.summary) as Summary | undefined) ?? null,
		queue: { hosts: {}, ...queue },
		options: { outbound: true, ...options },
		alerts: { pending: [], sent: [], ...alerts },
		checklist: { rows: {}, ...checklist },
	};
}

export function view(id: string, row: LinkRow): RowView {
	return {
		id,
		kind: row.kind,
		url: row.url,
		...(row.reason ? { reason: row.reason } : {}),
		...(row.detail ? { detail: row.detail } : {}),
		sources: row.sources.slice(0, 5),
		count: row.count,
		menu: row.menu,
		editor: row.editor,
		...(row.since ? { since: row.since } : {}),
	};
}

function byCount(a: RowView, b: RowView): number {
	return b.count - a.count;
}

function without(list: RowView[], id: string): RowView[] {
	return list.filter((row) => row.id !== id);
}

/**
 * Keep the frozen summary true when one row changes between full checks (a
 * link to another site confirmed broken, a fix, a check again). Returns null
 * when nothing shown changed.
 */
export function applyChange(
	summary: Summary,
	id: string,
	before: LinkRow | null | undefined,
	after: LinkRow | null,
): Summary | null {
	const was = before?.state;
	const now = after?.state;
	const wasGroup = before?.group;
	if (was === now && wasGroup === after?.group && before?.reason === after?.reason) return null;
	const next: Summary = {
		...summary,
		fix: { ...summary.fix },
		rows: {
			site: without(summary.rows.site, id),
			page: without(summary.rows.page, id),
			link: without(summary.rows.link, id),
		},
		lookRows: without(summary.lookRows, id),
		unknownRows: without(summary.unknownRows, id),
	};
	if (was === "broken" && wasGroup) {
		next.fix[wasGroup] = Math.max(0, next.fix[wasGroup] - 1);
		if (before?.editor) next.editorFix = Math.max(0, next.editorFix - 1);
	}
	if (was === "look") next.look = Math.max(0, next.look - 1);
	if (was === "unknown") next.unknown = Math.max(0, next.unknown - 1);
	if (after && now === "broken" && after.group) {
		next.fix[after.group] += 1;
		if (after.editor) next.editorFix += 1;
		next.rows[after.group] = [...next.rows[after.group], view(id, after)]
			.sort(byCount)
			.slice(0, ROWS_PER_GROUP);
	}
	if (after && now === "look") {
		next.look += 1;
		next.lookRows = [...next.lookRows, view(id, after)].slice(0, ROWS_PER_GROUP);
	}
	if (after && now === "unknown") {
		next.unknown += 1;
		next.unknownRows = [...next.unknownRows, view(id, after)].slice(0, ROWS_PER_GROUP);
	}
	return next;
}

export function totalFix(summary: Summary): number {
	return summary.fix.site + summary.fix.page + summary.fix.link;
}
