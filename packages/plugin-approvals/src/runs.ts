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

/**
 * Lanes side by side, at most. One: EmDash runs a tick's tasks one after another, so lanes side
 * by side would interleave and "oldest first" would not hold (an owner may rely on it: plugin
 * pages before release entries). More lanes make Cloudflare faster (a tick runs up to 10 tasks)
 * at the cost of that order.
 */
const LANES = 1;
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
	/** When its last row was decided. */
	endedAt?: string;
}

export interface RunState {
	run: Run;
	/** When it finished or was stopped; null while it runs. */
	endedAt: string | null;
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

/** A lane's KV key: per run, so a stopped run's late turn never writes the next run's lane. */
export function laneKey(userId: string, runId: string, lane: number): string {
	return `${RUN_PREFIX}${userId}:${runId}:${lane}`;
}

function readRun(entries: ReadonlyMap<string, unknown>, userId: string): RunState | null {
	const run = entries.get(`${RUN_PREFIX}${userId}`);
	if (!isRecord(run) || typeof run.id !== "string") return null;
	const lanes: Lane[] = [];
	for (let i = 0; i < Number(run.lanes); i++) {
		const lane = entries.get(laneKey(userId, run.id, i));
		if (isRecord(lane) && lane.run === run.id) lanes.push(lane as unknown as Lane);
	}
	const results = lanes.flatMap((l) => l.results ?? []);
	const left = lanes.reduce((n, l) => n + (l.rows?.length ?? 0), 0);
	const stopped = typeof run.stopped === "string" ? run.stopped : null;
	const running = left > 0 && !stopped;
	const ends = lanes.map((l) => l.endedAt).filter((at): at is string => typeof at === "string");
	const endedAt = running ? null : (stopped ?? ends.sort().at(-1) ?? String(run.at));
	return { run: run as unknown as Run, endedAt, lanes, results, left, running };
}

function expired(state: RunState): boolean {
	return state.endedAt !== null && Date.now() - Date.parse(state.endedAt) > KEEP_MS;
}

/** This person's bulk run, as the KV holds it, or null (none, or kept past its time). */
export function runOf(entries: ReadonlyMap<string, unknown>, userId: string): RunState | null {
	const state = readRun(entries, userId);
	return state && !expired(state) ? state : null;
}

/**
 * This person's keys that are no longer needed: a run kept past its time (7 days after it
 * ended) with its lanes, lanes of an earlier run, and a selection older than an hour.
 */
export function staleKeys(entries: ReadonlyMap<string, unknown>, userId: string): string[] {
	const keys: string[] = [];
	const state = readRun(entries, userId);
	const keep = state && !expired(state) ? state.run.id : null;
	if (state && !keep) keys.push(`${RUN_PREFIX}${userId}`);
	const lanePrefix = `${RUN_PREFIX}${userId}:`;
	for (const key of entries.keys()) {
		if (!key.startsWith(lanePrefix)) continue;
		if (keep && key.startsWith(`${lanePrefix}${keep}:`)) continue;
		keys.push(key);
	}
	const pick = entries.get(`${PICK_PREFIX}${userId}`);
	if (pick !== undefined && !pickOf(entries, userId)) keys.push(`${PICK_PREFIX}${userId}`);
	return keys;
}

/** Store what the confirm step shows, so the press needs nothing from the browser. One call. */
export async function storePick(ctx: PluginContext, userId: string, pick: Pick): Promise<void> {
	await ctx.kv.set(`${PICK_PREFIX}${userId}`, pick);
}

/** A run's task: with the person and a random run id, so two approvers' tasks never share a name. */
function taskName(userId: string, run: string, lane: number, seq: number): string {
	return `${RUN_TASK}-${userId}-${run}-${lane}-${seq}`
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.slice(0, 128);
}

/**
 * Start the background run for this person's stored selection. 2 + one call per lane: the run,
 * the lanes and their first tasks, the selection removed. Refused while one of theirs runs.
 */
export async function startRun(
	ctx: PluginContext,
	user: UserInfo,
	entries: ReadonlyMap<string, unknown>,
	/** The selection the pressed button belongs to (its confirm step's time). */
	token: unknown,
): Promise<{ ok: boolean; message: string }> {
	const current = runOf(entries, user.id);
	if (current?.running)
		return {
			ok: false,
			message:
				"Your earlier bulk decision is still running. Wait for it to finish, or stop it, then try again.",
		};
	const pick = pickOf(entries, user.id);
	// Only the selection this button showed: another tab may have stored a newer one since.
	if (!pick || pick.at !== token || pick.rows.length === 0 || !ctx.cron)
		return { ok: false, message: "Choose the pages again, then press Check selection." };
	const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
		await ctx.kv.set(laneKey(user.id, id, lane), state);
	}
	const now = new Date().toISOString();
	for (let lane = 0; lane < lanes; lane++) {
		await ctx.cron.schedule(taskName(user.id, id, lane, 0), {
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
	const key = laneKey(userId, runId, laneNo);
	const lane = entries.get(key) as Lane | undefined;
	if (!run || run.id !== runId || !lane || lane.run !== runId) return;
	// Run again after its lane was written but before the next task was set (EmDash retries a
	// failed task): set it now, so the lane goes on.
	if (lane.seq === seq + 1 && lane.rows.length > 0 && ctx.cron && !run.stopped) {
		await ctx.cron.schedule(taskName(userId, runId, laneNo, lane.seq), {
			schedule: new Date().toISOString(),
			data: { user: userId, run: runId, lane: laneNo, seq: lane.seq },
		});
		return;
	}
	// A task already done (run twice, or an older run's): nothing to do.
	if (lane.seq !== seq || lane.rows.length === 0) return;
	const store = (rows: Row[], results: RowResult[]) =>
		ctx.kv.set(key, {
			run: runId,
			seq: seq + 1,
			rows,
			results,
			...(rows.length === 0 ? { endedAt: new Date().toISOString() } : {}),
		} satisfies Lane);
	if (run.stopped || !config) {
		const text = run.stopped
			? "Not done: you stopped the run."
			: "Not done: the approval settings could not be read, so the run stopped. Decide it from the list.";
		await store([], [...lane.results, ...lane.rows.map((r) => notDone(r, text))]);
		return;
	}
	// A failed read throws, and EmDash runs the task again; only a person who is gone is final.
	const user = ctx.users ? await ctx.users.get(userId) : null;
	if (!user || user.role < approverRole(config.preset)) {
		await store(
			[],
			[
				...lane.results,
				...lane.rows.map((r) => ({
					key: r.key,
					title: r.title ?? r.key,
					state: "failed" as const,
					text: "You can't approve on this site any more, so this was not decided.",
				})),
			],
		);
		return;
	}
	const { results, rest } = await decideRows(
		m,
		config,
		user,
		run.do,
		run.reason,
		lane.rows,
		2,
		run.at,
	);
	await store(rest, [...lane.results, ...results]);
	if (rest.length > 0 && ctx.cron)
		await ctx.cron.schedule(taskName(userId, runId, laneNo, seq + 1), {
			schedule: new Date().toISOString(),
			data: { user: userId, run: runId, lane: laneNo, seq: seq + 1 },
		});
}

function notDone(row: Row, text: string): RowResult {
	return { key: row.key, title: row.title ?? row.key, state: "failed", text };
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
	const state = readRun(entries, userId);
	if (!state || state.running) return;
	for (let i = 0; i < state.run.lanes; i++) await ctx.kv.delete(laneKey(userId, state.run.id, i));
	await ctx.kv.delete(`${RUN_PREFIX}${userId}`);
}

/** Requests a lane run decides at most, for the words on the button. */
export function perRun(what: RowDo, config: Config): number {
	return Math.max(1, Math.floor((CALLS_PER_RUN_1_5 - 4 - ROWS_FIXED) / rowCost(what, config)));
}

export const RUN_ACTION = { stop: "bulk_stop", dismiss: "bulk_dismiss", refresh: "back" } as const;

/** The banner at the top of Waiting while a run goes, and its results when it is done. */
export function runBlocks(state: RunState | null, ticked = 0): Block[] {
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
				description:
					"A few are done at a time in the background, oldest first. Refresh to see how far it is. If the numbers do not move for a few minutes, this site's scheduled tasks may not be running: press Stop, then Dismiss, and decide from the list.",
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
							text: "The pages being decided right now finish first. What is decided stays decided; the rest stays in Waiting.",
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
			title: `${run.stopped ? "Stopped. " : ""}${finished}${look.length > 0 ? ` ${look.length} need a look${ticked > 0 ? `; ${ticked === look.length ? "they are" : `${ticked} still waiting are`} ticked below` : ""}.` : ""}`,
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
