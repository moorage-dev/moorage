// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

import { forgetAllSettings } from "../src/settings-memo.js";

/**
 * A stand-in for what EmDash hands the plugin: a key-value store, one storage
 * collection and a scheduler, all in memory. Reads are counted, so tests can
 * hold the page hook to its one read.
 */
export interface FakeContext {
	ctx: PluginContext;
	kv: Map<string, unknown>;
	rows: Map<string, Record<string, unknown>>;
	scheduled: Array<{ name: string; schedule: string }>;
	reads: () => number;
	/** How many storage queries ran (counts not included). */
	queries: () => number;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
	return Object.entries(where).every(([field, rule]) => {
		const value = row[field] as string;
		if (typeof rule !== "object" || rule === null) return value === rule;
		const range = rule as { gte?: string; lt?: string };
		if (range.gte !== undefined && !(value >= range.gte)) return false;
		if (range.lt !== undefined && !(value < range.lt)) return false;
		return true;
	});
}

export function fakeContext(stored: Record<string, unknown> = {}): FakeContext {
	// A new fake is a new site: nothing kept in memory from an earlier test.
	forgetAllSettings();
	const kv = new Map<string, unknown>(Object.entries(stored));
	const rows = new Map<string, Record<string, unknown>>();
	const scheduled: Array<{ name: string; schedule: string }> = [];
	let reads = 0;
	let queries = 0;

	const collection = {
		async put(id: string, data: Record<string, unknown>) {
			rows.set(id, data);
		},
		async count(where?: Record<string, unknown>) {
			return [...rows.values()].filter((row) => matches(row, where)).length;
		},
		async query(
			options: {
				where?: Record<string, unknown>;
				limit?: number;
				orderBy?: Record<string, "asc" | "desc">;
				cursor?: string;
			} = {},
		) {
			queries++;
			const found = [...rows.entries()].filter(([, row]) => matches(row, options.where));
			const [field, direction] = Object.entries(options.orderBy ?? {})[0] ?? [];
			if (field) {
				found.sort(([, a], [, b]) => {
					const order = String(a[field]) < String(b[field]) ? -1 : 1;
					return direction === "desc" ? -order : order;
				});
			}
			// Like EmDash: at most 100 rows a page.
			const limit = Math.min(options.limit ?? 50, 100);
			const start = options.cursor ? Number(options.cursor) : 0;
			const items = found.slice(start, start + limit).map(([id, data]) => ({ id, data }));
			const hasMore = found.length > start + items.length;
			return { items, hasMore, ...(hasMore ? { cursor: String(start + items.length) } : {}) };
		},
		async deleteMany(ids: string[]) {
			return ids.filter((id) => rows.delete(id)).length;
		},
	} as unknown as StorageCollection;

	const ctx = {
		plugin: { id: "analytics-consent", version: "0.0.0" },
		kv: {
			async get(key: string) {
				reads++;
				return kv.get(key) ?? null;
			},
			async set(key: string, value: unknown) {
				kv.set(key, value);
			},
			async getVersioned(key: string) {
				return kv.has(key) ? { value: kv.get(key), revision: JSON.stringify(kv.get(key)) } : null;
			},
			async compareAndSet(key: string, expected: string | null, value: unknown) {
				const current = kv.has(key) ? JSON.stringify(kv.get(key)) : null;
				if (current !== expected) return { applied: false };
				kv.set(key, value);
				return { applied: true, revision: JSON.stringify(value) };
			},
		},
		storage: { consents: collection },
		cron: {
			async list() {
				return scheduled.map((task) => ({ ...task, nextRunAt: "", lastRunAt: null }));
			},
			async schedule(name: string, options: { schedule: string }) {
				scheduled.push({ name, schedule: options.schedule });
			},
			async cancel() {},
		},
		log: { info() {}, warn() {}, error() {}, debug() {} },
	} as unknown as PluginContext;

	return { ctx, kv, rows, scheduled, reads: () => reads, queries: () => queries };
}
