// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { approverRole, type Config } from "./config.js";
import { CALLS_PER_RUN_1_5, type Meter } from "./meter.js";
import type { UserInfo } from "./requests.js";
import { decideRows, rowCost, type Decided, type Row, type RowDo, type RowResult } from "./rows.js";

/**
 * Deciding several requests with one press ("Approve and publish all", or the ticked ones). The
 * press itself decides as many as fit in its calls and its time (decideNow); what is left goes
 * to background turns (one-shot cron tasks), each deciding what fits in its own calls and time
 * and starting the next turn for the rest (runLane).
 *
 * Kept in the plugin's KV, which the Approvals page reads anyway (one kv.list() with the
 * settings), so the progress banner costs no call:
 * - `state:bulk-pick:<user>`: what the confirm step showed for the ticked ones, until the press.
 * - `state:bulk:<user>`: the run: what to do, the note, how many, when, stopped or not.
 * - `state:bulk:<user>:<run>:<lane>`: the requests still to decide and the results so far.
 * One run at a time per person. "How many done" on the banner is counted from the requests the
 * page reads anyway (decided by this person since the run started), so a turn cut off before it
 * stored its lane still shows what it decided.
 */

/**
 * The cron hook's time limit, set in plugin.ts. EmDash gives a hook 5 seconds unless it says
 * otherwise (hook.timeout ?? 5e3 in emdash 1.5.0); a sandboxed plugin also stops at the
 * runner's 30 seconds (wallTimeMs in @emdash-cms/cloudflare's sandbox), so it stays under that.
 */
export const CRON_TIMEOUT_MS = 25_000;
/** A background turn starts no new request after this long: well inside CRON_TIMEOUT_MS. */
export const TURN_MS = 15_000;
/** The press starts no new request after this long: the person is waiting for the page. */
export const PRESS_MS = 8_000;
/**
 * A run whose lane has not moved for this long, and that has no task left, has been dropped
 * by EmDash (a one-shot task is deleted after 5 failed tries, 1 + 2 + 4 + 8 + 16 = 31 minutes
 * of waiting). Short enough to end it soon after; long enough never to race a turn in flight.
 */
export const STALL_MS = 3 * 60_000;
/** Whatever the tasks say, a lane that has not moved for this long is over. */
export const STALL_MAX_MS = 40 * 60_000;

export const PICK_PREFIX = "state:bulk-pick:";
export const RUN_PREFIX = "state:bulk:";
export const RUN_TASK = "bulk";

// One lane per run: EmDash runs a tick's tasks one after another, so lanes side by side would
// interleave and "oldest first" would not hold (an owner may rely on it: plugin pages before
// release entries). Earlier releases' runs may say how many lanes they had; they are read as such.
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
	/** Ended on a page load because its turns stopped coming (the site was too slow). */
	stalled?: boolean;
}

export interface Lane {
	run: string;
	seq: number;
	rows: Row[];
	results: RowResult[];
	/** When its last row was decided. */
	endedAt?: string;
	/** When it was last written. */
	movedAt?: string;
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
	return `${taskPrefix(userId, run)}${lane}-${seq}`;
}

function taskPrefix(userId: string, run: string): string {
	return `${RUN_TASK}-${userId}-${run}-`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

/**
 * Calls the list after a press needs: the requests, the approvers, the text copies. The KV is
 * not read again: the press knows what it stored.
 */
export const LIST_CALLS = 3;
/** Calls to store what is left after a press: the run read again, the run, its lane, its task. */
const STORE_CALLS = 4;

/**
 * The press: decide `rows` (oldest first) now, as many as fit in this request's calls and in
 * PRESS_MS, and send the rest to background turns. Its calls: the settings (1, the caller's),
 * the requests and the content types (2), each request (see rows.ts), the emails and the copies
 * (2, and one kept for a failed publish), then either an earlier finished result removed (1) or
 * the rest stored (STORE_CALLS), and the list drawn after it (LIST_CALLS). Refused while one of
 * this person's runs goes.
 */
export async function decideNow(
	m: Meter,
	config: Config,
	user: UserInfo,
	entries: ReadonlyMap<string, unknown>,
	what: RowDo,
	reason: string,
	rows: Row[],
	now: () => number = Date.now,
): Promise<{
	ok: boolean;
	message: string;
	/** What to show on the banner when nothing was stored (everything decided now). */
	shown?: RunState;
	/** The KV as it is now, for the list drawn after the press. */
	entries?: Map<string, unknown>;
	collections?: Decided["collections"];
}> {
	const ctx = m.ctx;
	const startedAt = now();
	const current = runOf(entries, user.id);
	if (current?.running) return { ok: false, message: STILL_GOING };
	if (rows.length === 0)
		return { ok: false, message: "None of those is waiting for you any more." };
	const at = new Date(startedAt).toISOString();
	const id = `${startedAt.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	// Without scheduled tasks nothing can follow in the background: no calls kept to store it.
	const background = Boolean(ctx.cron);
	const earlier = entries.has(`${RUN_PREFIX}${user.id}`) ? 1 : 0;
	const decided = await decideRows(
		m,
		config,
		user,
		what,
		reason,
		rows,
		LIST_CALLS + earlier,
		at,
		{ allowanceMs: PRESS_MS, startedAt, now },
		{ runId: id, stopReserve: background ? STORE_CALLS : 0 },
	);
	const { results, rest } = decided;
	// The emails and the text copies first: a press cut off after them loses only what is left.
	await decided.finish();
	const done = results.filter((r) => r.state === "done").length;
	const run: Run = { id, do: what, reason, total: rows.length, lanes: 1, at };
	const after = new Map(entries);
	if (rest.length > 0 && ctx.cron) {
		// Another tab's press may store a run at the same moment: the run record is written only
		// if it is still what it was just now (compare and set), so one of two presses wins.
		const runKey = `${RUN_PREFIX}${user.id}`;
		const lane: Lane = { run: id, seq: 0, rows: rest, results, movedAt: at };
		const stored = await ctx.kv.getVersioned(runKey);
		const theirs = isRecord(stored?.value) ? stored.value : null;
		const busy = theirs !== null && theirs.id !== current?.run.id;
		const won =
			!busy && (await ctx.kv.compareAndSet(runKey, stored?.revision ?? null, run)).applied;
		if (!won) {
			return {
				ok: false,
				message: `${done} done. Another decision of yours started at the same time, so the other ${rest.length} were not started: they stay in Waiting.`,
				entries: theirs ? new Map([...after, [runKey, theirs]]) : after,
				collections: decided.collections,
			};
		}
		await ctx.kv.set(laneKey(user.id, id, 0), lane);
		await ctx.cron.schedule(taskName(user.id, id, 0, 0), {
			schedule: new Date().toISOString(),
			data: { user: user.id, run: id, lane: 0, seq: 0 },
		});
		after.set(`${RUN_PREFIX}${user.id}`, run);
		after.set(laneKey(user.id, id, 0), lane);
		return {
			ok: true,
			message: `${done} done. The other ${rest.length} ${rest.length === 1 ? "follows" : "follow"} in the background; you can leave this page.`,
			entries: after,
			collections: decided.collections,
		};
	}
	// Everything decided now: nothing stored, and an earlier finished result is put away, so it
	// does not come back on the next load.
	if (earlier) {
		await ctx.kv.delete(`${RUN_PREFIX}${user.id}`).catch(() => false);
		after.delete(`${RUN_PREFIX}${user.id}`);
	}
	const endedAt = new Date().toISOString();
	const leftOut = rest.map((r) =>
		notDone(
			r,
			background
				? "Not done: try it again from the list."
				: "Not done: this site has no scheduled tasks, so only a few are decided at a time. Decide it from the list.",
		),
	);
	const all = [...results, ...leftOut];
	const shown: RunState = {
		run,
		endedAt,
		lanes: [{ run: id, seq: 1, rows: [], results: all, endedAt }],
		results: all,
		left: 0,
		running: false,
	};
	return {
		ok: true,
		message:
			what === "publish"
				? `Approved ${done} of ${rows.length}.`
				: `Sent back ${done} of ${rows.length}.`,
		shown,
		entries: after,
		collections: decided.collections,
	};
}

/**
 * The most one press decides when nothing is stored for later (no scheduled tasks): what its
 * calls allow at the worst cost per page. Paths: the settings, the requests and the content
 * types, the emails, the copies and one call kept, an earlier result removed, the list.
 */
export function pressCap(what: RowDo, config: Config): number {
	return Math.max(
		1,
		Math.floor((CALLS_PER_RUN_1_5 - 1 - 2 - 3 - 1 - LIST_CALLS) / rowCost(what, config)),
	);
}

const STILL_GOING =
	"Your earlier decision on several pages is still going. Wait for it, or stop it.";

/**
 * One lane's turn: re-read who decides (their role may have changed), decide what fits in the
 * calls and in TURN_MS, store the results and what is left, start the next turn for the rest,
 * then write the text copies and queue the emails. At most 25 calls: the KV (settings and the
 * run, 1), the person (1), the rows (see rows.ts), the lane (1), the next task (1).
 */
export async function runLane(
	m: Meter,
	data: Record<string, unknown>,
	loadEntries: (
		ctx: PluginContext,
	) => Promise<{ config: Config | null; entries: Map<string, unknown> }>,
	clock: { now?: () => number; allowanceMs?: number } = {},
): Promise<void> {
	const now = clock.now ?? Date.now;
	const startedAt = now();
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
	const store = (rows: Row[], results: RowResult[]) => {
		const at = new Date().toISOString();
		return ctx.kv.set(key, {
			run: runId,
			seq: seq + 1,
			rows,
			results,
			movedAt: at,
			...(rows.length === 0 ? { endedAt: at } : {}),
		} satisfies Lane);
	};
	if (run.stopped || !config) {
		const text = run.stalled
			? "Not done: the run was stopped because this site was too slow."
			: run.stopped
				? "Not done: you stopped it."
				: "Not done: the approval settings could not be read, so it stopped. Decide it from the list.";
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
	const decided = await decideRows(
		m,
		config,
		user,
		run.do,
		run.reason,
		lane.rows,
		1,
		run.at,
		{ allowanceMs: clock.allowanceMs ?? TURN_MS, startedAt, now },
		{ runId, stopReserve: 1 },
	);
	const { results, rest } = decided;
	// The emails and the text copies first (a turn cut off after them loses neither; its retry
	// counts the rows as decided), then what was decided, then the next turn.
	await decided.finish();
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

/**
 * On opening the Approvals page: end this person's run if its turns stopped coming. EmDash
 * drops a one-shot task after 5 failed tries; the run would then show "running" for ever.
 * Only when its lane has not moved for STALL_MS: one call to list this plugin's tasks, and one
 * to mark the run stopped when none of them is this run's (or it has not moved for
 * STALL_MAX_MS). Returns whether it ended the run.
 */
export async function endIfStalled(
	ctx: PluginContext,
	userId: string,
	entries: Map<string, unknown>,
	now = Date.now(),
): Promise<boolean> {
	const state = runOf(entries, userId);
	if (!state?.running) return false;
	const moved = Math.max(
		Date.parse(state.run.at),
		...state.lanes.map((l) => (l.movedAt ? Date.parse(l.movedAt) : 0)),
	);
	const idle = now - moved;
	if (idle < STALL_MS) return false;
	if (idle < STALL_MAX_MS && ctx.cron) {
		const prefix = taskPrefix(userId, state.run.id);
		const tasks = await ctx.cron.list();
		if (tasks.some((t) => t.name.startsWith(prefix))) return false;
	}
	const ended: Run = { ...state.run, stopped: new Date(now).toISOString(), stalled: true };
	await ctx.kv.set(`${RUN_PREFIX}${userId}`, ended);
	entries.set(`${RUN_PREFIX}${userId}`, ended);
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

export const RUN_ACTION = { stop: "bulk_stop", dismiss: "bulk_dismiss", refresh: "back" } as const;

/**
 * The keys of this run's requests done as asked since it started, as the requests read for the
 * page say: sent back, or published (a request to schedule: approved). The count on the
 * banner, right even when a turn was cut off before it stored its lane. An approval not yet
 * live is not done.
 */
export function decidedKeys(
	state: RunState | null,
	all: ReadonlyArray<{
		collection: string;
		entryId: string;
		status: string;
		wants?: string;
		approval?: { by: { id: string }; at: string };
		sentBack?: { by: { id: string }; at: string };
	}>,
	userId: string,
): Set<string> {
	const keys = new Set<string>();
	if (!state) return keys;
	const mine = new Set([
		...state.lanes.flatMap((l) => (l.rows ?? []).map((r) => r.key)),
		...state.results.map((r) => r.key),
	]);
	const since = state.run.at;
	for (const request of all) {
		const k = `${request.collection}:${request.entryId}`;
		if (!mine.has(k)) continue;
		const by =
			state.run.do === "send_back"
				? request.status === "sent_back"
					? request.sentBack
					: undefined
				: request.status === "published" ||
					  (request.status === "approved" && request.wants === "schedule")
					? request.approval
					: undefined;
		if (by && by.by.id === userId && by.at >= since) keys.add(k);
	}
	for (const r of state.results) if (r.state === "done") keys.add(r.key);
	return keys;
}

/** The banner at the top of Waiting while a run goes, and its results when it is done. */
export function runBlocks(
	state: RunState | null,
	ticked = 0,
	decided = new Set<string>(),
): Block[] {
	if (!state) return [];
	const { run, results } = state;
	const done = Math.max(results.filter((r) => r.state === "done").length, decided.size);
	const look = results.filter((r) => r.state === "failed");
	const notLive = results.filter((r) => r.state === "approved" && !decided.has(r.key)).length;
	const notLiveText = notLive > 0 ? `, ${notLive} approved but not live yet` : "";
	const pages = `${run.total} ${run.total === 1 ? "page" : "pages"}`;
	const doing = run.do === "publish" ? "Approving" : "Sending back";
	if (state.running) {
		return [
			{
				type: "banner",
				title: `${doing} ${pages}: ${done} done${notLiveText}${look.length > 0 ? `, ${look.length} need a look` : ""}. You can leave this page.`,
				description:
					"The rest are decided in the background, a few at a time, oldest first. Refresh to see how far it is.",
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
							title: "Stop deciding the rest?",
							text: "The pages being decided right now finish first. What is decided stays decided; the rest stays in Waiting.",
							confirm: "Stop",
							deny: "Keep going",
						},
					},
				],
			},
		];
	}
	const finished = run.stalled
		? `Stopped: this site was too slow to finish. ${done} decided; the rest are still waiting.`
		: `${run.stopped ? "Stopped. " : ""}${run.do === "publish" ? `Approved ${done} of ${pages}.` : `Sent back ${done} of ${pages}.`}${notLive > 0 ? ` ${notLive} approved but not live yet.` : ""}`;
	const failed = look.length > 0 && !run.stalled;
	return [
		{
			type: "banner",
			variant: failed || notLive > 0 || run.stalled ? "alert" : "default",
			title: `${finished}${failed ? ` ${look.length} need a look${ticked > 0 ? `; ${ticked === look.length ? "they are" : `${ticked} still waiting are`} ticked below` : ""}.` : ""}`,
		},
		...(results.length > 0
			? [
					{
						type: "accordion" as const,
						label: "Each page",
						...(look.length > 0 || notLive > 0 ? { default_open: true } : {}),
						blocks: results.flatMap((r) => [
							{ type: "section" as const, text: r.title },
							{ type: "context" as const, text: r.text },
						]),
					},
				]
			: []),
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
