// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// A slow site (each call to the database a long round trip, as on Cloudflare Workers with D1)
// and EmDash's hook timeout. EmDash races each hook against its timeout (executeWithTimeout in
// emdash 1.5.0, hook.timeout ?? 5e3) and, when the timeout wins, records a failure and retries
// a one-shot task with backoff; on Workers the invocation then ends and the handler's remaining
// calls never complete. Found on a live site in 0.5.0: six pages chosen, the task failed five
// times, one or two pages moved, the lane never stored, the banner said "0 done" throughout.
//
// The harness here runs the plugin's cron turn against an in-memory site in virtual time: each
// call to the site takes CALL_MS, and once a turn has used up the hook's timeout every further
// call fails without effect, as on Workers, where it never completes. No real waiting.

import { describe, expect, it, vi } from "vitest";

import { runRemindTask } from "../src/actions.js";
import { allBlocks } from "../src/bulk.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { meter } from "../src/meter.js";
import plugin from "../src/plugin.js";
import type { ApprovalRequest } from "../src/requests.js";
import {
	CRON_TIMEOUT_MS,
	decidedKeys,
	decideNow,
	endIfStalled,
	LIST_CALLS,
	pressCap,
	runBlocks,
	runLane,
	runOf,
	STALL_MS,
	TURN_MS,
	type Lane,
	type Run,
} from "../src/runs.js";
import { fingerprint } from "../src/text.js";

const CONFIG: Config = { ...DEFAULT_CONFIG, collections: ["pages"], preset: "others" };
const ADMIN = {
	id: "u-admin",
	role: 50,
	name: "Ellen Marsh",
	email: "ellen@agency.test",
	createdAt: "2026-01-01T00:00:00.000Z",
};
const WRITER = { id: "u-sam", name: "Sam Reyes" };
const RUN_AT = "2026-11-16T10:00:00.000Z";

interface Item {
	id: string;
	slug: string;
	status: string;
	data: Record<string, unknown>;
	publishedTimes: number;
	rev: number;
}

/** An in-memory site whose every call takes `callMs` of virtual time. */
class SlowSite {
	clock = Date.parse(RUN_AT) + 60_000;
	kv = new Map<string, unknown>();
	requests = new Map<string, ApprovalRequest>();
	items = new Map<string, Item>();
	tasks = new Map<string, { schedule: string; data?: Record<string, unknown> }>();
	/** Order of what was published, with the publishing note's time when it went live. */
	published: Array<{ id: string; noteAt: string | undefined; at: number }> = [];
	calls = 0;
	/** The invocation ended (timed out): every call from now fails without effect. */
	private dead = false;
	private deadline = Number.POSITIVE_INFINITY;
	private onTimeout: (() => void) | null = null;

	/** Called after each KV write: a test may end the invocation there. */
	afterKvSet?: (key: string) => void;
	/** Give the plugin an email service (the writers' emails are queued as tasks). */
	withEmail = false;

	/** End the current invocation now, as EmDash's timeout would. */
	endNow(): void {
		this.deadline = this.clock;
	}

	/** Handlers EmDash stopped waiting for that still run (in-process). */
	abandoned: Array<Promise<unknown>> = [];

	/**
	 * `sandboxed`: once the timeout wins, the invocation ends and its later calls never land.
	 * `in-process`: EmDash stops waiting, but the handler keeps running and its calls still land,
	 * while the retry may already run.
	 */
	constructor(
		public callMs: number,
		public mode: "sandboxed" | "in-process" = "sandboxed",
	) {}

	now = () => this.clock;

	/** Each invocation's number: a call from an earlier, abandoned one always fails. */
	private gen = 0;
	private current = 0;

	private async call<T>(work: () => T, gen = this.current): Promise<T> {
		const inProcess = this.mode === "in-process";
		if (!inProcess && (this.dead || gen !== this.current)) throw new Error("the invocation ended");
		this.calls++;
		this.clock += this.callMs;
		if (gen === this.current && this.clock > this.deadline) {
			this.dead = true;
			this.deadline = Number.POSITIVE_INFINITY;
			this.onTimeout?.();
			if (!inProcess) throw new Error("the invocation ended");
		}
		await Promise.resolve();
		return work();
	}

	/**
	 * One invocation of the cron hook as EmDash runs it: raced against `timeoutMs`; when the
	 * timeout wins the handler is abandoned and its later calls never complete.
	 */
	async invoke(timeoutMs: number, run: () => Promise<void>): Promise<"ok" | "timeout"> {
		this.dead = false;
		this.deadline = this.clock + timeoutMs;
		const timedOut = new Promise<"timeout">((resolve) => {
			this.onTimeout = () => resolve("timeout");
		});
		const running = run().then(() => "ok" as const);
		// The abandoned handler's later calls all fail: none of them changes the site.
		running.catch(() => {});
		const result = await Promise.race([running, timedOut]);
		if (result === "timeout") this.abandoned.push(running.catch(() => {}));
		this.dead = true;
		this.deadline = Number.POSITIVE_INFINITY;
		return result;
	}

	ctx(): unknown {
		// The newest context is the live invocation's; earlier ones were abandoned.
		const gen = ++this.gen;
		this.current = gen;
		this.dead = false;
		const call = <T>(work: () => T) => this.call(work, gen);
		const store = {
			get: (key: string) => call(() => this.requests.get(key) ?? null),
			getMany: (keys: string[]) =>
				call(() => {
					const found = new Map<string, ApprovalRequest>();
					for (const key of keys) {
						const r = this.requests.get(key);
						if (r) found.set(key, structuredClone(r));
					}
					return found;
				}),
			updateIf: (
				key: string,
				args: { where: Record<string, unknown>; set: Partial<ApprovalRequest> },
			) =>
				call(() => {
					const r = this.requests.get(key);
					if (!r) return { applied: false };
					for (const [k, v] of Object.entries(args.where))
						if ((r as unknown as Record<string, unknown>)[k] !== v) return { applied: false };
					this.requests.set(key, { ...r, ...structuredClone(args.set) });
					return { applied: true };
				}),
		};
		return {
			kv: {
				get: (key: string) => call(() => this.kv.get(key) ?? null),
				getVersioned: (key: string) =>
					call(() =>
						this.kv.has(key)
							? { value: this.kv.get(key), revision: JSON.stringify(this.kv.get(key)) }
							: null,
					),
				compareAndSet: (key: string, revision: string | null, value: unknown) =>
					call(() => {
						const now = this.kv.has(key) ? JSON.stringify(this.kv.get(key)) : null;
						if (now !== revision) return { applied: false };
						this.kv.set(key, value);
						return { applied: true };
					}),
				set: (key: string, value: unknown) =>
					call(() => {
						this.kv.set(key, value);
						this.afterKvSet?.(key);
					}),
				delete: (key: string) => call(() => this.kv.delete(key)),
			},
			users: { get: (id: string) => call(() => (id === ADMIN.id ? ADMIN : null)) },
			storage: {
				requests: store,
				versions: { putMany: () => call(() => undefined) },
			},
			schema: {
				listCollections: () =>
					call(() => [
						{
							slug: "pages",
							label: "Pages",
							titleField: "title",
							supports: ["drafts", "revisions"],
							hasSeo: false,
							fields: [
								{ slug: "title", label: "Title", type: "string", sortOrder: 0 },
								{ slug: "content", label: "Content", type: "text", sortOrder: 1 },
							],
						},
					]),
			},
			content: {
				get: (_c: string, id: string) => call(() => this.item(id)),
				getVersioned: (_c: string, id: string) => {
					return call(() => {
						const item = this.item(id);
						return item ? { item, _rev: `rev-${id}-${item.rev}` } : null;
					});
				},
				publish: (_c: string, id: string, opts?: { _rev?: string }) =>
					call(() => {
						const item = this.items.get(id)!;
						// EmDash refuses a publish whose revision token is no longer current.
						if (opts?._rev !== `rev-${id}-${item.rev}`) throw new Error("CONFLICT");
						item.rev++;
						item.status = "published";
						item.publishedTimes++;
						const r = this.requests.get(`pages:${id}`);
						this.published.push({ id, noteAt: r?.publishing?.at, at: Date.now() });
						// What content:afterPublish does with a fresh note (plugin.ts).
						if (r?.status === "approved" && r.publishing) {
							// The plugin stamps notes with the real clock.
							const fresh = Date.now() - Date.parse(r.publishing.at) < 5 * 60_000;
							const updated: ApprovalRequest = {
								...r,
								status: "published",
								history: [
									{ at: "", text: fresh ? `Published by ${r.publishing.by.name}` : "Published" },
									...r.history,
								],
							};
							delete updated.publishing;
							this.requests.set(`pages:${id}`, updated);
						}
					}),
			},
			cron: {
				schedule: (name: string, opts: { schedule: string; data?: Record<string, unknown> }) =>
					call(() => void this.tasks.set(name, opts)),
				list: () =>
					call(() =>
						[...this.tasks.keys()].map((name) => ({
							name,
							schedule: "",
							nextRunAt: "",
							lastRunAt: null,
						})),
					),
			},
			site: { name: "Harbour Street Bakery", url: "https://bakery.test", locale: "en" },
			...(this.withEmail ? { email: { send: () => call(() => undefined) } } : {}),
			log: { warn: () => call(() => undefined), info: () => call(() => undefined) },
		};
	}

	private item(id: string) {
		const item = this.items.get(id);
		return item ? { ...structuredClone(item), draftRevisionId: null } : null;
	}

	async addWaiting(n: number): Promise<string[]> {
		const keys: string[] = [];
		for (let i = 1; i <= n; i++) {
			const id = `p${i}`;
			const data = { title: `Page ${i}`, content: "Iced coffee" };
			this.items.set(id, {
				id,
				slug: `page-${i}`,
				status: "draft",
				data,
				publishedTimes: 0,
				rev: 0,
			});
			const at = new Date(Date.parse(RUN_AT) - (n - i) * 60_000 - 3_600_000).toISOString();
			this.requests.set(`pages:${id}`, {
				collection: "pages",
				entryId: id,
				title: `Page ${i}`,
				status: "waiting",
				requestedBy: WRITER,
				requestedAt: at,
				updatedAt: at,
				ai: false,
				wants: "publish",
				fingerprint: await fingerprint(data, `page-${i}`),
				history: [],
			});
			keys.push(`pages:${id}`);
		}
		return keys;
	}

	/** A run of this person's over `keys`, stored as the press leaves it, and its first task. */
	async startRun(keys: string[], what: "publish" | "send_back" = "publish"): Promise<void> {
		const rows = keys.map((key) => ({ key, seen: this.requests.get(key)!.fingerprint }));
		const run: Run = {
			id: "r1",
			do: what,
			reason: what === "send_back" ? "Prices" : "",
			total: rows.length,
			lanes: 1,
			at: RUN_AT,
		};
		const lane: Lane = { run: "r1", seq: 0, rows, results: [], movedAt: RUN_AT };
		this.kv.set(`state:bulk:${ADMIN.id}`, run);
		this.kv.set(`state:bulk:${ADMIN.id}:r1:0`, lane);
		this.tasks.set(`bulk-${ADMIN.id}-r1-0-0`, {
			schedule: RUN_AT,
			data: { user: ADMIN.id, run: "r1", lane: 0, seq: 0 },
		});
	}

	lane(): Lane {
		return this.kv.get(`state:bulk:${ADMIN.id}:r1:0`) as Lane;
	}

	/** EmDash's cron executor for this run: due tasks one at a time, retries with backoff. */
	async tick(timeoutMs: number): Promise<"ok" | "timeout" | "none"> {
		const entry = [...this.tasks.entries()].find(([name]) => name.startsWith(`bulk-${ADMIN.id}-`));
		if (!entry) return "none";
		const [name, task] = entry;
		this.tasks.delete(name);
		const ctx = this.ctx();
		const result = await this.invoke(timeoutMs, () =>
			runLane(
				meter(ctx as never),
				task.data ?? {},
				async () => {
					await this.call(() => undefined); // kv.list with the settings
					return { config: CONFIG, entries: new Map(this.kv) };
				},
				{ now: this.now },
			),
		);
		if (result === "timeout") {
			// EmDash puts the same task back with its backoff (1, 2, 4, 8 and 16 minutes).
			const retry = Number((task.data?.__retry as number | undefined) ?? 0);
			if (retry < 5) {
				this.tasks.set(name, { ...task, data: { ...task.data, __retry: retry + 1 } });
				this.clock += 60_000 * 2 ** retry;
			}
		}
		this.clock += 60_000;
		return result;
	}

	/** Requests no longer waiting. */
	decided(): string[] {
		return [...this.requests.entries()].filter(([, r]) => r.status !== "waiting").map(([k]) => k);
	}
}

/** The cron hook's timeout as the plugin declares it (EmDash's default when it says nothing). */
function cronTimeout(): number {
	const cron = plugin.hooks?.cron as unknown;
	const declared =
		typeof cron === "object" && cron !== null ? (cron as { timeout?: number }).timeout : undefined;
	return declared ?? 5_000;
}

describe("a slow site and EmDash's hook timeout", () => {
	it("declares time limits that fit: the cron hook under the sandbox's 30 seconds, a turn well inside it", () => {
		expect(cronTimeout()).toBe(CRON_TIMEOUT_MS);
		expect(CRON_TIMEOUT_MS).toBeLessThan(30_000);
		expect(TURN_MS).toBeLessThanOrEqual(CRON_TIMEOUT_MS * 0.6);
		for (const name of [
			"content:beforePublish",
			"content:beforeSchedule",
			"content:afterSave",
			"content:afterPublish",
			"content:afterDelete",
		] as const) {
			const hook = plugin.hooks?.[name] as { timeout?: number } | undefined;
			expect(hook?.timeout, name).toBeGreaterThan(5_000);
			expect(hook?.timeout, name).toBeLessThan(30_000);
		}
	});

	// The fault, reproduced: 6 pages, each call half a second. Under 0.5.0's bare cron hook
	// (5 seconds) the turn decided pages and was cut off before it stored its lane.
	it("a turn cut off by the timeout loses no progress: what it decided is in its lane", async () => {
		const site = new SlowSite(500);
		const keys = await site.addWaiting(6);
		await site.startRun(keys);
		const result = await site.tick(cronTimeout());
		expect(result).toBe("ok");
		const lane = site.lane();
		const decided = site.decided();
		expect(decided.length).toBeGreaterThan(0);
		// Every page decided is recorded, and the lane moved on.
		expect(lane.seq).toBe(1);
		expect(lane.results.map((r) => r.key).sort()).toEqual(decided.sort());
		expect(lane.rows.length + lane.results.length).toBe(6);
		// The next turn is set for the rest.
		expect([...site.tasks.keys()]).toEqual([`bulk-${ADMIN.id}-r1-0-1`]);
	});

	for (const callMs of [200, 500, 1_000, 2_000]) {
		it(`at ${callMs} ms a call: every turn ends inside the timeout, and all 6 are published once`, async () => {
			const site = new SlowSite(callMs);
			const keys = await site.addWaiting(6);
			await site.startRun(keys);
			const perTurn: number[] = [];
			for (let i = 0; i < 20; i++) {
				const before = site.decided().length;
				const result = await site.tick(cronTimeout());
				if (result === "none") break;
				expect(result, `turn ${i + 1}`).toBe("ok");
				perTurn.push(site.decided().length - before);
			}
			console.info(`slow site, ${callMs} ms a call: decided per turn ${perTurn.join(" ")}`);
			expect(site.decided()).toHaveLength(6);
			for (const item of site.items.values()) expect(item.publishedTimes).toBe(1);
			expect(site.lane().rows).toEqual([]);
			expect(site.lane().results.every((r) => r.state === "done")).toBe(true);
			// Oldest first.
			expect(site.published.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
		});
	}

	// A turn cut off at any point, then run again by EmDash minutes later: a page approved but not
	// published is published then, and its note renewed so the writer is still told.
	it("cut off between an approval and its publish: the retry publishes it with a fresh note", async () => {
		const site = new SlowSite(500);
		const keys = await site.addWaiting(2);
		await site.startRun(keys);
		// Reads (kv, user, requests, types: 4 calls) and the first page's read and guarded
		// write (2 calls, no draft revision here) fit; its publish does not.
		const first = await site.tick(6 * 500 + 1);
		expect(first).toBe("timeout");
		expect(site.requests.get("pages:p1")?.status).toBe("approved");
		expect(site.items.get("p1")?.status).toBe("draft");
		// EmDash's backoff, and more: the retry comes 9 minutes later (the note is as old).
		const approved = site.requests.get("pages:p1")!;
		const old = new Date(Date.now() - 9 * 60_000).toISOString();
		site.requests.set("pages:p1", {
			...approved,
			publishing: { ...approved.publishing!, at: old },
		});
		site.clock += 9 * 60_000;
		for (let i = 0; i < 10; i++) if ((await site.tick(cronTimeout())) === "none") break;
		const p1 = site.published.find((p) => p.id === "p1")!;
		expect(p1).toBeDefined();
		expect(p1.at - Date.parse(p1.noteAt!)).toBeLessThan(5 * 60_000);
		expect(site.requests.get("pages:p1")?.history[0]?.text).toBe("Published by Ellen Marsh");
		expect(site.items.get("p1")?.publishedTimes).toBe(1);
		expect(site.decided()).toHaveLength(2);
	});

	it("the banner counts what was decided even when the lane was never stored", async () => {
		const site = new SlowSite(500);
		const keys = await site.addWaiting(6);
		await site.startRun(keys);
		// Two decided, as the cut-off turns of 0.5.0 left them: approved, lane untouched.
		for (const key of keys.slice(0, 2)) {
			const r = site.requests.get(key)!;
			site.requests.set(key, {
				...r,
				status: "published",
				approval: {
					by: { id: ADMIN.id, name: ADMIN.name },
					at: "2026-11-16T10:00:23.000Z",
					fingerprint: r.fingerprint,
					versionId: "v",
				},
			});
		}
		const state = runOf(site.kv, ADMIN.id)!;
		const done = decidedKeys(state, [...site.requests.values()], ADMIN.id);
		expect(done.size).toBe(2);
		expect(JSON.stringify(runBlocks(state, 0, done))).toContain("Approving 6 pages: 2 done.");
	});
});

describe("a run EmDash stopped running", () => {
	async function stalledSite(movedMinutesAgo: number, taskLeft: boolean) {
		const site = new SlowSite(10);
		const keys = await site.addWaiting(3);
		await site.startRun(keys);
		if (!taskLeft) site.tasks.clear();
		site.clock = Date.parse(RUN_AT) + movedMinutesAgo * 60_000;
		return site;
	}

	it("ends it on opening Approvals when its task is gone: Stopped, too slow, and the form again", async () => {
		const site = await stalledSite(10, false);
		const entries = new Map(site.kv);
		const ctx = site.ctx() as never;
		expect(await endIfStalled(ctx, ADMIN.id, entries, site.clock)).toBe(true);
		expect(site.calls).toBe(2); // cron.list, kv.set
		// A finished run is kept for 7 days by the real clock, and this one ended at the site's clock
		// (a fixed date): read it at that moment, or the test fails a week after RUN_AT.
		vi.useFakeTimers({ toFake: ["Date"], now: site.clock });
		try {
			const state = runOf(entries, ADMIN.id)!;
			expect(state.running).toBe(false);
			const banner = JSON.stringify(runBlocks(state, 0, new Set(["pages:p1"])));
			expect(banner).toContain(
				"Stopped: this site was too slow to finish. 1 decided; the rest are still waiting.",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves it while EmDash still has its task (retrying), or while its lane moved lately", async () => {
		const retrying = await stalledSite(10, true);
		expect(
			await endIfStalled(retrying.ctx() as never, ADMIN.id, new Map(retrying.kv), retrying.clock),
		).toBe(false);
		expect(retrying.calls).toBe(1); // cron.list only
		const recent = await stalledSite(STALL_MS / 60_000 - 1, false);
		expect(
			await endIfStalled(recent.ctx() as never, ADMIN.id, new Map(recent.kv), recent.clock),
		).toBe(false);
		expect(recent.calls).toBe(0);
	});

	it("ends it after 40 minutes without a move even if a task is still listed", async () => {
		const site = await stalledSite(41, true);
		expect(await endIfStalled(site.ctx() as never, ADMIN.id, new Map(site.kv), site.clock)).toBe(
			true,
		);
	});
});

describe("the press on a slow site", () => {
	it("decides what fits in its time, and sends the rest to the background", async () => {
		const site = new SlowSite(1_000);
		const keys = await site.addWaiting(6);
		const rows = keys.map((key) => ({ key, seen: site.requests.get(key)!.fingerprint }));
		const ctx = site.ctx() as never;
		const done = await decideNow(
			meter(ctx),
			CONFIG,
			ADMIN,
			new Map(),
			"publish",
			"",
			rows,
			site.now,
		);
		expect(done.ok).toBe(true);
		const decided = site.decided().length;
		expect(decided).toBeGreaterThan(0);
		expect(decided).toBeLessThan(6);
		const lane = [...site.kv.entries()].find(([k]) => k.split(":").length === 5)?.[1] as Lane;
		expect(lane.rows).toHaveLength(6 - decided);
		expect(site.tasks.size).toBe(1);
	});

	it("decides 4 at once on a quick site, storing nothing", async () => {
		const site = new SlowSite(5);
		const keys = await site.addWaiting(4);
		const rows = keys.map((key) => ({ key, seen: site.requests.get(key)!.fingerprint }));
		const m = meter(site.ctx() as never);
		const done = await decideNow(m, CONFIG, ADMIN, new Map(), "publish", "", rows, site.now);
		expect(done.message).toBe("Approved 4 of 4.");
		expect(site.decided()).toHaveLength(4);
		expect(site.kv.size).toBe(0);
		expect(site.tasks.size).toBe(0);
		expect(done.shown?.results.every((r) => r.state === "done")).toBe(true);
	});
});

describe("a reminder left from a request decided days ago", () => {
	for (const status of ["approved", "published", "sent_back", "closed"] as const) {
		it(`does nothing when it fires for a request now ${status}: one read, no email`, async () => {
			const site = new SlowSite(1);
			const [key] = await site.addWaiting(1);
			const request = site.requests.get(key!)!;
			site.requests.set(key!, { ...request, status });
			const sent: unknown[] = [];
			const ctx = {
				...(site.ctx() as object),
				email: { send: async (message: unknown) => void sent.push(message) },
			};
			const m = meter(ctx as never);
			await runRemindTask(m, { ...CONFIG, remind: true }, key!, request.requestedAt);
			expect(sent).toEqual([]);
			expect(m.used()).toBe(1);
			expect(site.tasks.size).toBe(0);
		});
	}
});

describe("approvals made meanwhile, and in-process turns that go on after the timeout", () => {
	/** p2 approved by Ellen after the run started, without publishing (Review's Approve). */
	async function approvedMeanwhile(site: SlowSite, key: string) {
		const r = site.requests.get(key)!;
		site.requests.set(key, {
			...r,
			status: "approved",
			approval: {
				by: { id: ADMIN.id, name: ADMIN.name },
				at: new Date(Date.parse(RUN_AT) + 30_000).toISOString(),
				fingerprint: r.fingerprint,
				versionId: "v",
			},
		});
	}

	it("leaves a page she approved meanwhile without publishing unpublished, and says so", async () => {
		const site = new SlowSite(10);
		const keys = await site.addWaiting(3);
		await site.startRun(keys);
		await approvedMeanwhile(site, keys[1]!);
		while ((await site.tick(cronTimeout())) !== "none");
		expect(site.items.get("p2")?.status).toBe("draft");
		expect(site.requests.get(keys[1]!)?.status).toBe("approved");
		const result = site.lane().results.find((r) => r.key === keys[1]);
		expect(result).toMatchObject({
			state: "approved",
			text: "Approved earlier; not published by this run.",
		});
		expect(site.items.get("p1")?.status).toBe("published");
		expect(site.items.get("p3")?.status).toBe("published");
		// Not counted as done on the banner.
		const state = runOf(site.kv, ADMIN.id)!;
		const done = decidedKeys(state, [...site.requests.values()], ADMIN.id);
		expect(done.has(keys[1]!)).toBe(false);
		expect(JSON.stringify(runBlocks(state, 0, done))).toContain(
			"Approved 2 of 3 pages. 1 approved but not live yet.",
		);
	});

	it("a retry that loses the publish to the earlier turn still running reports it live, and publishes once", async () => {
		const site = new SlowSite(10, "in-process");
		const keys = await site.addWaiting(1);
		await site.startRun(keys);
		// The earlier turn approved it (its note carries this run) and is about to publish.
		const r = site.requests.get(keys[0]!)!;
		site.requests.set(keys[0]!, {
			...r,
			status: "approved",
			approval: {
				by: { id: ADMIN.id, name: ADMIN.name },
				at: new Date().toISOString(),
				fingerprint: r.fingerprint,
				versionId: "v",
			},
			publishing: {
				by: { id: ADMIN.id, name: ADMIN.name },
				at: new Date().toISOString(),
				jobs: [],
				run: "r1",
			},
		});
		const ctx = site.ctx() as {
			content: { getVersioned: (c: string, id: string) => Promise<unknown> };
		};
		const read = ctx.content.getVersioned;
		// Right after the retry read the page, the earlier turn's publish lands.
		ctx.content.getVersioned = async (c, id) => {
			const out = await read(c, id);
			const item = site.items.get(id)!;
			item.rev++;
			item.status = "published";
			item.publishedTimes++;
			site.requests.set(keys[0]!, { ...site.requests.get(keys[0]!)!, status: "published" });
			return out;
		};
		await runLane(
			meter(ctx as never),
			{ user: ADMIN.id, run: "r1", lane: 0, seq: 0 },
			async () => ({ config: CONFIG, entries: new Map(site.kv) }),
		);
		expect(site.items.get("p1")?.publishedTimes).toBe(1);
		expect(site.lane().results[0]).toMatchObject({
			state: "done",
			text: "Approved and published. It's live now.",
		});
	});

	for (const callMs of [500, 1_500]) {
		it(`in-process at ${callMs} ms a call, with turns EmDash stops waiting for: each page published once, none reported not live`, async () => {
			const site = new SlowSite(callMs, "in-process");
			const keys = await site.addWaiting(6);
			await site.startRun(keys);
			// A timeout shorter than a turn, so EmDash stops waiting and retries while it goes on.
			for (let i = 0; i < 40; i++) {
				const result = await site.tick(4_000);
				if (result === "none") {
					await Promise.all(site.abandoned.splice(0));
					if ([...site.tasks.keys()].length === 0) break;
				}
			}
			await Promise.all(site.abandoned.splice(0));
			expect(site.decided()).toHaveLength(6);
			for (const item of site.items.values()) expect(item.publishedTimes, item.id).toBe(1);
			const results = site.lane().results;
			for (const r of results) {
				const live = site.items.get(r.key.split(":")[1]!)?.status === "published";
				if (live) expect(r.text, r.key).not.toContain("not live");
			}
		});
	}
});

describe("a turn cut off right after it stored what it decided", () => {
	it("has already queued the writers' emails and the text copies", async () => {
		const site = new SlowSite(10);
		site.withEmail = true;
		const keys = await site.addWaiting(3);
		await site.startRun(keys, "send_back");
		let copies = 0;
		site.afterKvSet = (key) => {
			if (key.includes(":r1:")) site.endNow();
		};
		const base = site.ctx;
		site.ctx = () => {
			const ctx = base.call(site) as { storage: { versions: { putMany: () => Promise<void> } } };
			const put = ctx.storage.versions.putMany;
			ctx.storage.versions.putMany = async () => {
				copies++;
				return put();
			};
			return ctx;
		};
		await site.tick(cronTimeout());
		expect(site.lane().results.filter((r) => r.state === "done")).toHaveLength(3);
		expect([...site.tasks.keys()].some((name) => name.startsWith("send-"))).toBe(true);
		// Send back keeps no text copy; an approval does.
		expect(copies).toBe(0);
	});

	it("an approval of a request to schedule: its email and its text copy are written before the lane", async () => {
		const site = new SlowSite(10);
		site.withEmail = true;
		const keys = await site.addWaiting(2);
		for (const key of keys)
			site.requests.set(key, { ...site.requests.get(key)!, wants: "schedule" });
		await site.startRun(keys);
		const order: string[] = [];
		site.afterKvSet = (key) => {
			if (key.includes(":r1:")) {
				order.push("lane");
				site.endNow();
			}
		};
		const base = site.ctx;
		site.ctx = () => {
			const ctx = base.call(site) as {
				storage: { versions: { putMany: () => Promise<void> } };
				cron: { schedule: (n: string, o: unknown) => Promise<void> };
			};
			const put = ctx.storage.versions.putMany;
			ctx.storage.versions.putMany = async () => {
				order.push("copies");
				return put();
			};
			const schedule = ctx.cron.schedule;
			ctx.cron.schedule = async (n, o) => {
				if (n.startsWith("send-")) order.push("emails");
				return schedule(n, o);
			};
			return ctx;
		};
		await site.tick(cronTimeout());
		expect(order).toEqual(["emails", "copies", "lane"]);
	});
});

describe("the press cut by time with every row in reach", () => {
	it("keeps the calls to store the rest and draw the list", async () => {
		const site = new SlowSite(1_500);
		const keys = await site.addWaiting(4);
		const rows = keys.map((key) => ({ key, seen: site.requests.get(key)!.fingerprint }));
		const m = meter(site.ctx() as never);
		const done = await decideNow(m, CONFIG, ADMIN, new Map(), "publish", "", rows, site.now);
		expect(done.ok).toBe(true);
		expect(site.decided().length).toBeLessThan(4);
		// The settings read before it (1) and the list after it (LIST_CALLS).
		expect(1 + m.used() + LIST_CALLS).toBeLessThanOrEqual(25);
		expect(site.tasks.size).toBe(1);
	});
});

describe("words", () => {
	it("a late turn after the run was ended as too slow does not say the person stopped it", async () => {
		const site = new SlowSite(10);
		const keys = await site.addWaiting(3);
		await site.startRun(keys);
		site.clock = Date.parse(RUN_AT) + 10 * 60_000;
		const entries = new Map(site.kv);
		// Its task is listed, but nothing moved for 41 minutes: ended.
		site.clock = Date.parse(RUN_AT) + 41 * 60_000;
		expect(await endIfStalled(site.ctx() as never, ADMIN.id, entries, site.clock)).toBe(true);
		site.kv = entries;
		await site.tick(cronTimeout());
		const texts = site.lane().results.map((r) => r.text);
		expect(texts).toEqual(
			Array(3).fill("Not done: the run was stopped because this site was too slow."),
		);
	});

	it("without scheduled tasks, the all button offers only what one press decides, and says so", async () => {
		const site = new SlowSite(1);
		await site.addWaiting(9);
		const waiting = [...site.requests.values()];
		const blocks = JSON.stringify(allBlocks(waiting, pressCap("publish", CONFIG)));
		const cap = pressCap("publish", CONFIG);
		expect(cap).toBeLessThan(9);
		expect(blocks).toContain(`"label":"Approve and publish the oldest ${cap}"`);
		expect(blocks).not.toContain("All 9");
		expect(blocks).toContain(`the other ${9 - cap} stay here for the next press`);
		expect(JSON.stringify(allBlocks(waiting))).toContain('"label":"Approve and publish all 9"');
	});
});
