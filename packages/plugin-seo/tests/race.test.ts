// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { handlePanel } from "../src/panel.js";
import plugin from "../src/plugin.js";
import { rebuildEntry, removeEntryRecord, type EntryRecord } from "../src/record.js";
import { loadScan, SCAN_TASK, scanStep, startScan, type ScanState } from "../src/scan.js";

// A save hook and the site-wide check can run at the same time: EmDash runs save hooks
// after answering the save, and the check continues in the background. Neither has a
// transaction, so these tests put each step of one in between the steps of the other,
// on an in-memory store, and check that the "same title as another page" flag ends up
// right whatever the order.

const LONG_TEXT =
	"We bake bread every morning from flour milled a few streets away, and deliver it by bicycle.";

interface Entry {
	id: string;
	slug: string;
	status: "published" | "draft";
	data: Record<string, unknown>;
	seo: Record<string, unknown>;
	publishedAt: string | null;
	updatedAt: string | null;
}

type Op = "read" | "write";
type Gate = { when: "before" | "after"; op: Op | string; run: () => Promise<unknown> };

const clone = <T>(value: T): T => structuredClone(value);

class World {
	records = new Map<string, EntryRecord>();
	/** Order rows were created in, as the host's created_at; a row put again keeps its place. */
	created = new Map<string, number>();
	private rows = 0;
	entries = new Map<string, Entry>();
	kv = new Map<string, unknown>();
	ops: string[] = [];
	private minute = 0;

	page(id: string, title: string): Entry {
		const entry: Entry = {
			id,
			slug: id,
			status: "published",
			data: { title, body: LONG_TEXT },
			seo: {
				title: null,
				description: "What we do.",
				image: "/hero.jpg",
				canonical: null,
				noIndex: false,
			},
			publishedAt: "2026-10-01T09:00:00.000Z",
			updatedAt: this.stamp(),
		};
		this.entries.set(id, entry);
		return entry;
	}

	/** An editor changes the title; the entry gets a newer updatedAt. */
	rename(id: string, title: string): void {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`no entry ${id}`);
		entry.data = { ...entry.data, title };
		entry.updatedAt = this.stamp();
	}

	/** An editor sets a search title in the SEO panel; EmDash leaves updatedAt as it was. */
	searchTitle(id: string, title: string): void {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`no entry ${id}`);
		entry.seo = { ...entry.seo, title };
	}

	private stamp(): string {
		this.minute += 1;
		return `2026-10-22T10:${String(this.minute).padStart(2, "0")}:00.000Z`;
	}

	record(id: string): EntryRecord | undefined {
		return this.records.get(`pages:${id}`);
	}

	flagged(id: string): boolean {
		return this.record(id)?.issues?.some((issue) => issue.id === "duplicate-title") ?? false;
	}

	/**
	 * A plugin context for one actor (a save hook, the check). Gates run another actor
	 * to the end just before or after this actor's first read or write of a kind.
	 */
	ctx(actor: string, gates: Gate[] = []): PluginContext {
		const pending = [...gates];
		const step = async <T>(op: Op, name: string, run: () => T): Promise<T> => {
			const before = pending.findIndex(
				(gate) => gate.when === "before" && (gate.op === op || gate.op === name),
			);
			if (before !== -1) await pending.splice(before, 1)[0]?.run();
			const result = clone(run());
			this.ops.push(`${actor}:${name}`);
			const after = pending.findIndex(
				(gate) => gate.when === "after" && (gate.op === op || gate.op === name),
			);
			if (after !== -1) await pending.splice(after, 1)[0]?.run();
			return result;
		};
		const records = this.records;
		const created = this.created;
		const write = (id: string, data: EntryRecord) => {
			if (!created.has(id)) created.set(id, (this.rows += 1));
			records.set(id, clone(data));
		};
		const remove = (id: string) => {
			created.delete(id);
			return records.delete(id);
		};
		const matches = (
			data: EntryRecord,
			where?: { titleKey?: string | { in: string[] }; status?: { in: string[] } },
		) =>
			(where?.titleKey === undefined ||
				(typeof where.titleKey === "string"
					? data.titleKey === where.titleKey
					: where.titleKey.in.includes(data.titleKey ?? ""))) &&
			(where?.status === undefined || where.status.in.includes(data.status ?? ""));
		const ordered = () =>
			[...records]
				.map(([id, data]) => ({ id, data }))
				.sort((a, b) =>
					(a.data.titleKey ?? "") === (b.data.titleKey ?? "")
						? a.id.localeCompare(b.id)
						: (a.data.titleKey ?? "").localeCompare(b.data.titleKey ?? ""),
				);
		const store = {
			get: (id: string) => step("read", "get", () => records.get(id) ?? null),
			getMany: (ids: string[]) =>
				step("read", "getMany", () => {
					const found = new Map<string, EntryRecord>();
					for (const id of ids) {
						const data = records.get(id);
						if (data) found.set(id, data);
					}
					return found;
				}),
			put: (id: string, data: EntryRecord) =>
				step("write", "put", () => {
					write(id, data);
				}),
			putMany: (items: Array<{ id: string; data: EntryRecord }>) =>
				step("write", "putMany", () => {
					for (const { id, data } of items) write(id, data);
				}),
			delete: (id: string) => step("write", "delete", () => remove(id)),
			deleteMany: (ids: string[]) =>
				step("write", "deleteMany", () => ids.filter((id) => remove(id)).length),
			query: (options: {
				where?: { titleKey?: string | { in: string[] }; status?: { in: string[] } };
				orderBy?: { titleKey: "asc" };
				limit?: number;
				cursor?: string;
			}) =>
				step("read", "query", () => {
					const limit = options.limit ?? 50;
					if (!options.orderBy) {
						// As the host: in creation order, continuing after the last row read, so
						// deleting rows already read never skips one.
						const after = Number(options.cursor ?? 0);
						const rows = [...records]
							.map(([id, data]) => ({ id, data, at: created.get(id) ?? 0 }))
							.filter((item) => item.at > after && matches(item.data, options.where))
							.sort((a, b) => a.at - b.at);
						const page = rows.slice(0, limit);
						const more = rows.length > limit;
						const last = page.at(-1);
						return {
							items: page.map(({ id, data }) => ({ id, data })),
							hasMore: more,
							...(more && last ? { cursor: String(last.at) } : {}),
						};
					}
					const all = ordered().filter((item) => matches(item.data, options.where));
					const start = Number(options.cursor ?? 0);
					const items = all.slice(start, start + limit);
					const hasMore = start + limit < all.length;
					return { items, hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
				}),
		};
		const entries = this.entries;
		const kv = this.kv;
		return {
			site: { name: "Acme", url: "https://acme.test", locale: "en" },
			storage: { entries: store },
			content: {
				get: async (_collection: string, id: string) =>
					step("read", "content.get", () => entries.get(id) ?? null),
				getPublicUrl: async (_collection: string, id: string) =>
					step("read", "content.getPublicUrl", () => `https://acme.test/${id}`),
				list: async (_collection: string, options: { limit: number; cursor?: string }) =>
					step("read", "content.list", () => {
						const all = [...entries.values()].filter((entry) => entry.status === "published");
						const start = Number(options.cursor ?? 0);
						const items = all.slice(start, start + options.limit);
						const hasMore = start + options.limit < all.length;
						return {
							items,
							hasMore,
							...(hasMore ? { cursor: String(start + options.limit) } : {}),
						};
					}),
			},
			bylines: { getEntriesBylines: async () => (this.ops.push(`${actor}:bylines`), []) },
			schema: {
				getCollection: async () => (
					this.ops.push(`${actor}:schema`),
					{ routable: true, hidden: false }
				),
			},
			kv: {
				get: async (key: string) => step("read", "kv.get", () => kv.get(key) ?? null),
				set: async (key: string, value: unknown) =>
					step("write", "kv.set", () => {
						kv.set(key, clone(value));
					}),
				delete: async (key: string) => step("write", "kv.delete", () => kv.delete(key)),
			},
			settings: {
				get: async (key: string) =>
					step("read", "settings.get", () => kv.get(`settings:${key}`) ?? null),
				set: async (key: string, value: unknown) =>
					step("write", "settings.set", () => {
						kv.set(`settings:${key}`, clone(value));
					}),
			},
			cron: {
				schedule: async () => step("write", "cron.schedule", () => {}),
				cancel: async () => step("write", "cron.cancel", () => {}),
			},
			log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
		} as unknown as PluginContext;
	}
}

const save = (world: World, id: string, gates: Gate[] = [], actor = `save ${id}`) =>
	rebuildEntry(world.ctx(actor, gates), "pages", id, DEFAULT_CONFIG);

const check = (world: World, gates: Gate[] = []) =>
	startScan(world.ctx("check", gates), ["pages"], DEFAULT_CONFIG);

describe("the same-title flag when a save and a check overlap", () => {
	it("keeps the flag on a page whose save read the titles before the check wrote them", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");

		// The save of b looks for pages with its title, finds none yet, and the whole
		// check runs before the save writes.
		await save(world, "b", [{ when: "after", op: "query", run: () => check(world) }]);

		expect(world.flagged("a")).toBe(true);
		expect(world.flagged("b")).toBe(true);
		expect(world.record("b")?.status).toBe("fix");
	});

	it("flags both pages when two pages get the same title at the same moment", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");

		// Each save looks for the other before either has written.
		await save(world, "a", [{ when: "before", op: "write", run: () => save(world, "b") }]);

		expect(world.flagged("a")).toBe(true);
		expect(world.flagged("b")).toBe(true);
	});

	it("does not write a renamed page back with its old title while checking every page", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");
		await save(world, "a");
		await save(world, "b");
		expect(world.flagged("a")).toBe(true);

		// The check reads the pages; then b is renamed and saved before the check writes.
		await check(world, [
			{
				when: "after",
				op: "content.list",
				run: async () => {
					world.rename("b", "Catering");
					await save(world, "b");
				},
			},
		]);

		expect(world.record("b")?.title).toBe("Catering");
		expect(world.flagged("b")).toBe(false);
		expect(world.flagged("a")).toBe(false);
		expect(world.record("a")?.status).toBe("ready");
	});

	it("does not write back the old title when the SEO panel renames a page during a check", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");
		await save(world, "a");
		await save(world, "b");

		await check(world, [
			{
				when: "after",
				op: "content.list",
				run: async () => {
					world.searchTitle("b", "Catering in Springfield");
					await save(world, "b");
				},
			},
		]);

		expect(world.record("b")?.title).toBe("Catering in Springfield");
		expect(world.flagged("a")).toBe(false);
		expect(world.flagged("b")).toBe(false);
	});

	it("does not flag a page whose twin was renamed after the title pass read them", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");
		world.page("c", "Contact");
		await save(world, "a");
		await save(world, "b");
		await save(world, "c");
		// Records from before the flag existed: the title pass is what flags them.
		for (const id of ["a", "b"]) {
			const data = world.record(id)!;
			world.records.set(`pages:${id}`, {
				...data,
				issues: [],
				status: "ready",
			});
		}
		const state: ScanState = {
			status: "running",
			collections: [],
			phase: "titles",
			checked: 3,
			tally: { checked: 3, fix: 0, hidden: 0, rows: [], more: false },
			startedAt: "2026-10-22T10:00:00.000Z",
		};

		await scanStep(
			world.ctx("check", [
				{
					when: "after",
					op: "query",
					run: async () => {
						world.rename("b", "Catering");
						await save(world, "b");
					},
				},
			]),
			state,
			DEFAULT_CONFIG,
		);

		expect(world.record("b")?.title).toBe("Catering");
		expect(world.flagged("a")).toBe(false);
		expect(world.flagged("b")).toBe(false);
	});

	it("puts a save's record back when a check that read the entry earlier overwrote it", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");
		await save(world, "a");
		await save(world, "b");

		// A check reads b with its old title. b is renamed and its save writes; the check's
		// write of the old copy lands after the save's write, before the save reads back.
		const stale = world.record("b")!;
		world.rename("b", "Catering");
		await save(world, "b", [
			{
				when: "after",
				op: "write",
				run: async () => {
					world.records.set("pages:b", stale);
				},
			},
		]);

		expect(world.record("b")?.title).toBe("Catering");
		expect(world.flagged("a")).toBe(false);
		expect(world.flagged("b")).toBe(false);
	});

	it("keeps the remaining pages flagged when one of three with a title is deleted", async () => {
		const world = new World();
		for (const id of ["a", "b", "c"]) world.page(id, "Our services");
		for (const id of ["a", "b", "c"]) await save(world, id);
		expect(["a", "b", "c"].map((id) => world.flagged(id))).toEqual([true, true, true]);

		world.entries.delete("c");
		await removeEntryRecord(world.ctx("delete c"), "pages", "c");
		expect(["a", "b"].map((id) => world.flagged(id))).toEqual([true, true]);

		world.entries.delete("b");
		await removeEntryRecord(world.ctx("delete b"), "pages", "b");
		expect(world.flagged("a")).toBe(false);
	});
});

const opsOf = (world: World, actor: string) =>
	world.ops.filter((op) => op.startsWith(`${actor}:`)).map((op) => op.slice(actor.length + 1));

const afterSave = plugin.hooks?.["content:afterSave"] as unknown as (
	event: { collection: string; content: { id: string } },
	ctx: PluginContext,
) => Promise<void>;

describe("operations a save costs", () => {
	// Cloudflare allows a sandboxed hook 10 operations (see SANDBOX_OPERATIONS); a save must
	// stay at 9 at most, its read of the settings included.
	it("stays at 9 at most on the costliest save, moving a page between titles", async () => {
		// No settings saved yet: reading them costs two operations, the most it can.
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");
		world.page("c", "Weddings");
		for (const id of ["a", "b", "c"]) await save(world, id);
		const stale = { ...world.record("b")!, title: "Catering", titleKey: "catering" };

		// b moves to c's title; a check's older copy of b (another title) lands right after the
		// save's write, so its read-back finds b in neither title.
		world.rename("b", "Weddings");
		await afterSave(
			{ collection: "pages", content: { id: "b" } },
			world.ctx("move", [
				{
					when: "after",
					op: "put",
					run: async () => {
						world.records.set("pages:b", { ...stale, updatedAt: "2026-10-01T00:00:00.000Z" });
					},
				},
			]),
		);
		expect(opsOf(world, "move").length).toBeLessThanOrEqual(9);
		// a is alone with its title now. b's own record (the older copy) is left to the next
		// save or check, which a further read would have cost.
		expect(world.flagged("a")).toBe(false);
		await fullCheck(world);
		expect(world.record("b")?.title).toBe("Weddings");
		expect(world.flagged("b") && world.flagged("c")).toBe(true);
	});

	it("stays at 9 at most when a save keeps its title and its record was overwritten", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");
		await save(world, "a");
		await save(world, "b");
		const stale = { ...world.record("b")!, title: "Catering", titleKey: "catering" };

		world.rename("b", "Our services");
		await afterSave(
			{ collection: "pages", content: { id: "b" } },
			world.ctx("keep", [
				{
					when: "after",
					op: "put",
					run: async () => {
						world.records.set("pages:b", { ...stale, updatedAt: "2026-10-01T00:00:00.000Z" });
					},
				},
			]),
		);
		expect(opsOf(world, "keep").length).toBeLessThanOrEqual(9);
		// The older copy, with a title the save did not read, is left to the next check.
		await fullCheck(world);
		expect(world.record("b")?.title).toBe("Our services");
		expect(world.flagged("a") && world.flagged("b")).toBe(true);
	});

	it("stays within the sandbox's operations per request", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Catering");
		await save(world, "a");
		await save(world, "b");

		// An ordinary save: nothing about shared titles changes.
		await save(world, "a", [], "plain");
		expect(opsOf(world, "plain").length).toBeLessThanOrEqual(6);

		// b takes a's title: both pages are flagged.
		world.rename("b", "Our services");
		await save(world, "b", [], "join");
		expect(world.flagged("a") && world.flagged("b")).toBe(true);
		expect(opsOf(world, "join").length).toBeLessThanOrEqual(8);

		// b moves on: a is alone again.
		world.rename("b", "Weddings");
		await save(world, "b", [], "leave");
		expect(world.flagged("a") || world.flagged("b")).toBe(false);
		expect(opsOf(world, "leave").length).toBeLessThanOrEqual(8);
	});
});

const cronTick = plugin.hooks?.cron as unknown as (
	event: { name: string },
	ctx: PluginContext,
) => Promise<void>;

/**
 * Run a whole check: started as a visit to the SEO page would, then continued by the background
 * task, one tick per request as on the host. Returns the operations of each tick.
 */
async function fullCheck(world: World, gates: Gate[] = []): Promise<string[][]> {
	const ticks: string[][] = [];
	// Records are stamped to the millisecond; let the saves above be older than the check.
	await new Promise((resolve) => setTimeout(resolve, 5));
	let state: ScanState | null = await startScan(
		world.ctx("start", gates),
		["pages"],
		DEFAULT_CONFIG,
	);
	for (let index = 1; state && (state.status !== "done" || state.sweep); index += 1) {
		if (index > 100) throw new Error("the check never finished");
		await cronTick({ name: SCAN_TASK }, world.ctx(`tick ${index}`));
		ticks.push(opsOf(world, `tick ${index}`));
		state = await loadScan(world.ctx("look"));
	}
	return ticks;
}

describe("records of pages deleted during a check", () => {
	it("removes the record a check wrote back for a deleted page, and its twin's flag", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Our services");
		await save(world, "a");
		await save(world, "b");

		// b is deleted after the check listed it and before the check wrote: the check writes
		// b's record back after the delete hook removed it.
		await fullCheck(world, [
			{
				when: "after",
				op: "content.list",
				run: async () => {
					world.entries.delete("b");
					await removeEntryRecord(world.ctx("delete b"), "pages", "b");
				},
			},
		]);
		// The next full check does not see b, so its record goes and a is alone again.
		await fullCheck(world);

		expect(world.record("b")).toBeUndefined();
		expect(world.flagged("a")).toBe(false);
		expect(world.record("a")?.status).toBe("ready");
		// A later save of a does not find b's record either.
		await save(world, "a");
		expect(world.flagged("a")).toBe(false);
	});

	it("removes left-over records on a site checked in several batches, within the budget", async () => {
		const world = new World();
		for (let index = 0; index < 45; index += 1) world.page(`p${index}`, `Page number ${index}`);
		world.page("a", "Our services");
		world.page("b", "Our services");
		world.page("c", "Contact us");
		for (const id of world.entries.keys()) await save(world, id);
		expect(world.flagged("a")).toBe(true);
		// Left over from deletes that raced earlier checks.
		world.entries.delete("b");
		world.entries.delete("p7");

		const steps = await fullCheck(world);

		expect(world.record("b")).toBeUndefined();
		expect(world.record("p7")).toBeUndefined();
		expect(world.flagged("a")).toBe(false);
		expect(world.record("c")).toBeDefined();
		expect(world.records.size).toBe(world.entries.size);
		// Each tick of the background task, its own reads of the check and settings included.
		expect(steps.length).toBeGreaterThan(3);
		for (const ops of steps) expect(ops.length).toBeLessThanOrEqual(8);
	});

	it("keeps the record of a page created after the check read its list", async () => {
		const world = new World();
		for (let index = 0; index < 25; index += 1) world.page(`p${index}`, `Page number ${index}`);
		for (const id of world.entries.keys()) await save(world, id);
		await new Promise((resolve) => setTimeout(resolve, 5));

		// EmDash lists the newest entries first, so a page created during a check is never
		// listed by it. Here it is created once every entry has been read.
		let state = await startScan(world.ctx("step 0"), ["pages"], DEFAULT_CONFIG);
		while (!state.sweep) state = await scanStep(world.ctx("step"), state, DEFAULT_CONFIG);
		world.page("new", "Opening hours");
		await save(world, "new");
		const written = world.record("new")?.checkedAt;
		await new Promise((resolve) => setTimeout(resolve, 5));
		while (state.status !== "done" || state.sweep) {
			state = await scanStep(world.ctx("step"), state, DEFAULT_CONFIG);
		}

		expect(world.record("new")?.title).toBe("Opening hours");
		// The check never wrote it: the sweep is what left it alone.
		expect(world.record("new")?.checkedAt).toBe(written);
	});

	it("keeps a page unpublished while a check ran, with its page type, as a draft", async () => {
		const world = new World();
		world.page("a", "Our services");
		world.page("b", "Catering");
		await save(world, "a");
		await save(world, "b");
		world.records.set("pages:a", { ...world.record("a")!, type: "AboutPage" });
		// a was unpublished in the gap between a check's list and its write: the check wrote
		// a's published record over the one the unpublish hook had just written.
		const entry = world.entries.get("a")!;
		entry.status = "draft";

		await fullCheck(world);

		expect(world.record("a")?.type).toBe("AboutPage");
		expect(world.record("a")?.status).toBe("draft");
		expect(world.record("a")?.titleKey).toBe("");
	});

	it("keeps a published page whose record a page view wrote back during the check", async () => {
		const world = new World();
		world.page("a", "Our services");
		await save(world, "a");
		world.records.set("pages:a", { ...world.record("a")!, type: "AboutPage" });
		const before = world.record("a")!;

		// A page view read a's record before the check rewrote it and wrote it back after (the
		// picture-for-shared-links write), so a's record is older than the check.
		await fullCheck(world, [
			{
				when: "after",
				op: "putMany",
				run: async () => {
					world.records.set("pages:a", before);
				},
			},
		]);

		expect(world.record("a")?.type).toBe("AboutPage");
		expect(world.record("a")?.status).toBe("ready");
	});

	it("confirms many left-over records a few per request, within the budget", async () => {
		const world = new World();
		for (let index = 0; index < 30; index += 1) world.page(`p${index}`, `Page number ${index}`);
		for (const id of world.entries.keys()) await save(world, id);
		for (const id of ["p1", "p4", "p9", "p16", "p25"]) world.entries.delete(id);
		for (const id of ["p2", "p3", "p20"]) world.entries.get(id)!.status = "draft";

		const ticks = await fullCheck(world);

		for (const id of ["p1", "p4", "p9", "p16", "p25"]) expect(world.record(id)).toBeUndefined();
		for (const id of ["p2", "p3", "p20"]) expect(world.record(id)?.status).toBe("draft");
		for (const ops of ticks) expect(ops.length).toBeLessThanOrEqual(8);
	});

	it("keeps drafts and pages of collections the check does not cover", async () => {
		const world = new World();
		world.page("a", "Our services");
		await save(world, "a");
		const draft = world.page("d", "Coming soon");
		draft.status = "draft";
		await save(world, "d");
		world.records.set("posts:x", { ...world.record("a")!, collection: "posts", entryId: "x" });
		world.created.set("posts:x", 999);

		await fullCheck(world);

		expect(world.record("d")?.status).toBe("draft");
		expect(world.records.has("posts:x")).toBe(true);
	});
});

describe("operations the Google preview panel costs", () => {
	const ADMIN = 50;
	const setType = { type: "block_action", action_id: "set_type", value: "AboutPage" };
	const openPanel = (world: World, id: string, actor: string, input: unknown = setType) =>
		handlePanel(input, { collection: "pages", id }, ADMIN, world.ctx(actor));

	it("stays within the budget when a page joins another's title and its type changes", async () => {
		const world = new World();
		world.kv.set("settings:config", DEFAULT_CONFIG);
		world.page("a", "Our services");
		world.page("b", "Catering");
		await save(world, "a");
		await save(world, "b");

		// b takes a's title; the panel is opened and the type changed before the save hook runs.
		world.rename("b", "Our services");
		await openPanel(world, "b", "panel");
		expect(opsOf(world, "panel").length).toBeLessThanOrEqual(8);
		expect(world.record("b")?.type).toBe("AboutPage");

		// The save hook moves b between titles as usual.
		await save(world, "b");
		expect(world.flagged("a") && world.flagged("b")).toBe(true);
		expect(world.record("b")?.type).toBe("AboutPage");
	});

	it("stays within the budget when a page leaves a shared title and its type changes", async () => {
		const world = new World();
		world.kv.set("settings:config", DEFAULT_CONFIG);
		world.page("a", "Our services");
		world.page("b", "Our services");
		await save(world, "a");
		await save(world, "b");

		world.rename("b", "Weddings");
		await openPanel(world, "b", "panel");
		expect(opsOf(world, "panel").length).toBeLessThanOrEqual(8);

		await save(world, "b");
		expect(world.flagged("a") || world.flagged("b")).toBe(false);
		expect(world.record("b")?.type).toBe("AboutPage");
		expect(world.record("b")?.title).toBe("Weddings");
	});

	it("keeps an ordinary open as cheap as before", async () => {
		const world = new World();
		world.kv.set("settings:config", DEFAULT_CONFIG);
		world.page("a", "Our services");
		world.page("b", "Our services");
		await save(world, "a");
		await save(world, "b");

		await openPanel(world, "b", "open", { type: "page_load" });
		expect(opsOf(world, "open").length).toBeLessThanOrEqual(8);
		expect(world.flagged("a") && world.flagged("b")).toBe(true);
	});
});
