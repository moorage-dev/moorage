// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { rebuildEntry, removeEntryRecord, type EntryRecord } from "../src/record.js";
import { scanStep, startScan, type ScanState } from "../src/scan.js";

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
					records.set(id, clone(data));
				}),
			putMany: (items: Array<{ id: string; data: EntryRecord }>) =>
				step("write", "putMany", () => {
					for (const { id, data } of items) records.set(id, clone(data));
				}),
			delete: (id: string) => step("write", "delete", () => records.delete(id)),
			query: (options: {
				where?: { titleKey?: string };
				orderBy?: { titleKey: "asc" };
				limit?: number;
				cursor?: string;
			}) =>
				step("read", "query", () => {
					const where = options.where?.titleKey;
					const all = ordered().filter(
						(item) => where === undefined || item.data.titleKey === where,
					);
					const start = Number(options.cursor ?? 0);
					const limit = options.limit ?? 50;
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
				get: async (key: string) => clone(kv.get(key) ?? null),
				set: async (key: string, value: unknown) => {
					kv.set(key, clone(value));
				},
				delete: async (key: string) => kv.delete(key),
			},
			cron: { schedule: async () => {}, cancel: async () => {} },
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

describe("operations a save costs", () => {
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
