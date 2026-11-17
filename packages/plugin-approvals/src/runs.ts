// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { approverRole, type Config } from "./config.js";
import { CALLS_PER_RUN_1_5, type Meter } from "./meter.js";
import type { UserInfo } from "./requests.js";
import { decideRows, rowCost, ROWS_FIXED, type Row, type RowDo, type RowResult } from "./rows.js";

/**
 * "Approve and publish selected" and "Send back selected" as one press: the press stores the
 * decision and starts background runs (one-shot cron tasks); each run decides as many requests as
 * fit in its calls and starts the next run for the rest. Nothing of the list travels through the
 * browser after the confirm step: the selection is stored when it is shown, and the press only
 * says "go".
 *
 * Kept in the plugin's KV, which the Approvals page reads anyway (one kv.list() with the
 * settings), so the progress banner costs no call:
 * - `state:bulk-pick:<user>`: what the confirm step showed, until the press.
 * - `state:bulk:<user>`: the run: what to do, the note, how many, when, stopped or not.
 * - `state:bulk:<user>:<lane>`: each lane's requests still to decide and its results so far.
 * Several lanes run side by side (each its own task, with its own calls), so a long list does
 * not wait for one task after another. One run at a time per person.
 */

export const PICK_PREFIX = "state:bulk-pick:";
export const RUN_PREFIX = "state:bulk:";
export const RUN_TASK = "bulk";

/** Lanes side by side, at most. */
const LANES = 5;
/** A finished run's results are shown this long unless dismissed. */
const KEEP_MS = 7 * 86_400_000;
/** A selection shown on the confirm step stays good this long. */
const PICK_MS = 60 * 60_000;

export interface Pick {
	do: RowDo;
	reason: string;
	rows: Row[];
	at: string;
}

export interface Run {
	id: string;
	do: RowDo;
	reason: string;
	total: number;
	lanes: number;
	at: string;
	stopped?: string;
}

export interface Lane {
	run: string;
	seq: number;
	rows: Row[];
	results: RowResult[];
}

export interface RunState {
	run: Run;
	lanes: Lane[];
	results: RowResult[];
	left: number;
	running: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pickOf(entries: ReadonlyMap<string, unknown>, userId: string): Pick | null {
	const value = entries.get(`${PICK_PREFIX}${userId}`);
	if (!isRecord(value) || !Array.isArray(value.rows)) return null;
	if (Date.now() - Date.parse(String(value.at)) > PICK_MS) return null;
	return value as unknown as Pick;
}

/** This person's bulk run, as the KV holds it, or null. */
export function runOf(entries: ReadonlyMap<string, unknown>, userId: string): RunState | null {
	const run = entries.get(`${RUN_PREFIX}${userId}`);
	if (!isRecord(run) || typeof run.id !== "string") return null;
	const lanes: Lane[] = [];
	for (let i = 0; i < Number(run.lanes); i++) {
		const lane = entries.get(`${RUN_PREFIX}${userId}:${i}`);
		if (isRecord(lane) && lane.run === run.id) lanes.push(lane as unknown as Lane);
	}
	const results = lanes.flatMap((l) => l.results ?? []);
	const left = lanes.reduce((n, l) => n + (l.rows?.length ?? 0), 0);
	const state = { run: run as unknown as Run, lanes, results, left, running: false };
	state.running = left > 0 && !state.run.stopped;
	if (!state.running && Date.now() - Date.parse(state.run.at) > KEEP_MS) return null;
	return state;
}

/** Store what the confirm step shows, so the press needs nothing from the browser. One call. */
export async function storePick(ctx: PluginContext, userId: string, pick: Pick): Promise<void> {
	await ctx.kv.set(`${PICK_PREFIX}${userId}`, pick);
}

function taskName(run: string, lane: number, seq: number): string {
	return `${RUN_TASK}-${run}-${lane}-${seq}`;
}

/**
 * Start the background run for this person's stored selection. 2 + one call per lane: the run,
 * the lanes and their first tasks, the selection removed. Refused while one of theirs runs.
 */
export async function startRun(
	ctx: PluginContext,
	user: UserInfo,
	entries: ReadonlyMap<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
	const current = runOf(entries, user.id);
	if (current?.running)
		return {
			ok: false,
			message:
				"Your earlier bulk decision is still running. Wait for it to finish, or stop it, then try again.",
		};
	const pick = pickOf(entries, user.id);
	if (!pick || pick.rows.length === 0 || !ctx.cron)
		return { ok: false, message: "Choose the pages again, then press Check selection." };
	const id = Date.now().toString(36);
	const lanes = Math.min(LANES, Math.ceil(pick.rows.length / 4));
	const split: Row[][] = Array.from({ length: lanes }, () => []);
	// Round robin keeps each lane oldest first.
	pick.rows.forEach((row, i) => split[i % lanes]!.push(row));
	const run: Run = {
		id,
		do: pick.do,
		reason: pick.reason,
		total: pick.rows.length,
		lanes,
		at: new Date().toISOString(),
	};
	await ctx.kv.set(`${RUN_PREFIX}${user.id}`, run);
	for (let lane = 0; lane < lanes; lane++) {
		const state: Lane = { run: id, seq: 0, rows: split[lane]!, results: [] };
		await ctx.kv.set(`${RUN_PREFIX}${user.id}:${lane}`, state);
	}
	const now = new Date().toISOString();
	for (let lane = 0; lane < lanes; lane++) {
		await ctx.cron.schedule(taskName(id, lane, 0), {
			schedule: now,
			data: { user: user.id, run: id, lane, seq: 0 },
		});
	}
	await ctx.kv.delete(`${PICK_PREFIX}${user.id}`);
	return {
		ok: true,
		message: `${pick.do === "publish" ? "Approving and publishing" : "Sending back"} ${run.total} ${run.total === 1 ? "page" : "pages"}. You can leave this page.`,
	};
}

/**
 * One lane's run: re-read who decides (their role may have changed), decide what fits, store
 * the results and what is left, and start the next run for the rest. At most 25 calls: the KV
 * (settings and the run, 1), the person (1), the rows (see rows.ts), the lane (1), the next task (1).
 */
export async function runLane(
	m: Meter,
	data: Record<string, unknown>,
	loadEntries: (
		ctx: PluginContext,
	) => Promise<{ config: Config | null; entries: Map<string, unknown> }>,
): Promise<void> {
	const ctx = m.ctx;
	const userId = typeof data.user === "string" ? data.user : "";
	const runId = typeof data.run === "string" ? data.run : "";
	const laneNo = typeof data.lane === "number" ? data.lane : -1;
	const seq = typeof data.seq === "number" ? data.seq : -1;
	if (!userId || !runId || laneNo < 0) return;
	const { config, entries } = await loadEntries(ctx);
	const run = entries.get(`${RUN_PREFIX}${userId}`) as Run | undefined;
	const laneKey = `${RUN_PREFIX}${userId}:${laneNo}`;
	const lane = entries.get(laneKey) as Lane | undefined;
	// A task already done (run twice, or an older run's): nothing to do.
	if (!run || run.id !== runId || !lane || lane.run !== runId || lane.seq !== seq) return;
	if (lane.rows.length === 0) return;
	const store = (rows: Row[], results: RowResult[]) =>
		ctx.kv.set(laneKey, { run: runId, seq: seq + 1, rows, results } satisfies Lane);
	if (run.stopped || !config) {
		await store([], [...lane.results, ...lane.rows.map((r) => stoppedResult(r))]);
		return;
	}
	const user = await ctx.users?.get(userId).catch(() => null);
	if (!user || user.role < approverRole(config.preset)) {
		await store(
			[],
			[
				...lane.results,
				...lane.rows.map((r) => ({
					key: r.key,
					title: r.key,
					state: "failed" as const,
					text: "You can't approve on this site any more, so this was not decided.",
				})),
			],
		);
		return;
	}
	const { results, rest } = await decideRows(m, config, user, run.do, run.reason, lane.rows, 2);
	await store(rest, [...lane.results, ...results]);
	if (rest.length > 0 && ctx.cron)
		await ctx.cron.schedule(taskName(runId, laneNo, seq + 1), {
			schedule: new Date().toISOString(),
			data: { user: userId, run: runId, lane: laneNo, seq: seq + 1 },
		});
}

function stoppedResult(row: Row): RowResult {
	return { key: row.key, title: row.key, state: "failed", text: "Not done: you stopped the run." };
}

/** Stop this person's run: each lane stops at its next turn. One call. */
export async function stopRun(
	ctx: PluginContext,
	userId: string,
	entries: ReadonlyMap<string, unknown>,
): Promise<boolean> {
	const state = runOf(entries, userId);
	if (!state?.running) return false;
	await ctx.kv.set(`${RUN_PREFIX}${userId}`, { ...state.run, stopped: new Date().toISOString() });
	return true;
}

/** Remove a finished run's results from the page. One call per lane, plus one. */
export async function dismissRun(
	ctx: PluginContext,
	userId: string,
	entries: ReadonlyMap<string, unknown>,
): Promise<void> {
	const state = runOf(entries, userId);
	if (!state || state.running) return;
	for (let i = 0; i < state.run.lanes; i++) await ctx.kv.delete(`${RUN_PREFIX}${userId}:${i}`);
	await ctx.kv.delete(`${RUN_PREFIX}${userId}`);
}

/** Requests a lane run decides at most, for the words on the button. */
export function perRun(what: RowDo, config: Config): number {
	return Math.max(1, Math.floor((CALLS_PER_RUN_1_5 - 4 - ROWS_FIXED) / rowCost(what, config)));
}

export const RUN_ACTION = { stop: "bulk_stop", dismiss: "bulk_dismiss", refresh: "back" } as const;

/** The banner at the top of Waiting while a run goes, and its results when it is done. */
export function runBlocks(state: RunState | null): Block[] {
	if (!state) return [];
	const { run, results } = state;
	const done = results.filter((r) => r.state === "done").length;
	const look = results.filter((r) => r.state !== "done");
	const pages = `${run.total} ${run.total === 1 ? "page" : "pages"}`;
	const doing = run.do === "publish" ? "Approving" : "Sending back";
	if (state.running) {
		return [
			{
				type: "banner",
				title: `${doing} ${pages}: ${done} done, ${look.length} need a look. You can leave this page.`,
				description: "A few are done at a time in the background. Refresh to see how far it is.",
			},
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: RUN_ACTION.refresh, label: "Refresh" },
					{
						type: "button",
						action_id: RUN_ACTION.stop,
						label: "Stop",
						style: "danger",
						confirm: {
							title: "Stop this run?",
							text: "What is already decided stays decided. The rest stays in Waiting.",
							confirm: "Stop",
							deny: "Keep going",
						},
					},
				],
			},
		];
	}
	const finished =
		run.do === "publish" ? `Approved ${done} of ${pages}.` : `Sent back ${done} of ${pages}.`;
	return [
		{
			type: "banner",
			variant: look.length > 0 ? "alert" : "default",
			title: `${run.stopped ? "Stopped. " : ""}${finished}${look.length > 0 ? ` ${look.length} need a look: they are ticked below.` : ""}`,
		},
		{
			type: "accordion",
			label: "Each page",
			...(look.length > 0 ? { default_open: true } : {}),
			blocks: results.flatMap((r) => [
				{ type: "section" as const, text: r.title },
				{ type: "context" as const, text: r.text },
			]),
		},
		{
			type: "actions",
			elements: [{ type: "button", action_id: RUN_ACTION.dismiss, label: "Dismiss" }],
		},
	];
}

/** The requests of a finished run that need a look, to tick on the list. */
export function needsLook(state: RunState | null): Set<string> {
	if (!state || state.running) return new Set();
	return new Set(state.results.filter((r) => r.state === "failed").map((r) => r.key));
}
