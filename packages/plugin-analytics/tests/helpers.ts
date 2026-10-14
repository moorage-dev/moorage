// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

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
	const kv = new Map<string, unknown>(Object.entries(stored));
	const rows = new Map<string, Record<string, unknown>>();
	const scheduled: Array<{ name: string; schedule: string }> = [];
	let reads = 0;

	const collection = {
		async put(id: string, data: Record<string, unknown>) {
			rows.set(id, data);
		},
		async count(where?: Record<string, unknown>) {
			return [...rows.values()].filter((row) => matches(row, where)).length;
		},
		async query(options: { where?: Record<string, unknown>; limit?: number } = {}) {
			const found = [...rows.entries()].filter(([, row]) => matches(row, options.where));
			const items = found.slice(0, options.limit ?? 50).map(([id, data]) => ({ id, data }));
			return { items, hasMore: found.length > items.length };
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

	return { ctx, kv, rows, scheduled, reads: () => reads };
}
