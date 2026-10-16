// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

import { normalizePopup, type Popup } from "../src/config.js";

/**
 * A stand-in for what EmDash hands the plugin: a key-value store and the count
 * collection in memory, plus a media list, a schema and an email outbox.
 */
export interface FakeContext {
	ctx: PluginContext;
	kv: Map<string, unknown>;
	rows: Map<string, Record<string, unknown>>;
	sent: Array<Record<string, unknown>>;
	reads: () => number;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
	return Object.entries(where).every(([field, rule]) => {
		const value = row[field] as string | number;
		if (typeof rule !== "object" || rule === null) return value === rule;
		const range = rule as { gte?: string | number; lte?: string | number; lt?: string | number };
		if (range.gte !== undefined && !(value >= range.gte)) return false;
		if (range.lte !== undefined && !(value <= range.lte)) return false;
		if (range.lt !== undefined && !(value < range.lt)) return false;
		return true;
	});
}

export function fakeContext(stored: Record<string, unknown> = {}, options: { email?: boolean } = {}): FakeContext {
	const kv = new Map<string, unknown>(Object.entries(stored));
	const rows = new Map<string, Record<string, unknown>>();
	const sent: Array<Record<string, unknown>> = [];
	let reads = 0;
	const collection = {
		async get(id: string) {
			return rows.get(id) ?? null;
		},
		async put(id: string, data: Record<string, unknown>) {
			rows.set(id, data);
		},
		async compareAndSet(id: string, expected: string | null, data: Record<string, unknown>) {
			if (expected === null && rows.has(id)) return { applied: false };
			rows.set(id, data);
			return { applied: true, revision: "1" };
		},
		async updateIf(id: string, args: { where: Record<string, unknown>; delta?: Record<string, { inc: number }> }) {
			const row = rows.get(id);
			if (!row || !matches(row, args.where)) return { applied: false };
			for (const [key, change] of Object.entries(args.delta ?? {})) {
				row[key] = ((row[key] as number) || 0) + change.inc;
			}
			return { applied: true, data: row };
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
		plugin: { id: "popups", version: "0.0.0" },
		site: { name: "Hartley's Bakery", url: "https://hartleys.test", locale: "en" },
		kv: {
			async get(key: string) {
				reads++;
				return kv.get(key) ?? null;
			},
			async set(key: string, value: unknown) {
				kv.set(key, structuredClone(value));
			},
		},
		storage: { counts: collection },
		media: {
			async list() {
				return {
					items: [
						{ id: "m1", filename: "loaves-1600.jpg", mimeType: "image/jpeg", url: "/_emdash/api/media/file/loaves.jpg", alt: "Three sourdough loaves", width: 1600, height: 1000, size: 1, createdAt: "" },
					],
					hasMore: false,
				};
			},
		},
		schema: {
			async listCollections() {
				return [
					{ slug: "posts", label: "Posts", hidden: false },
					{ slug: "pages", label: "Pages", hidden: false },
				];
			},
		},
		...(options.email
			? {
					email: {
						async send(message: Record<string, unknown>) {
							sent.push(message);
						},
					},
				}
			: {}),
		cron: {
			async list() {
				return [];
			},
			async schedule() {},
			async cancel() {},
		},
		log: { info() {}, warn() {}, error() {}, debug() {} },
	} as unknown as PluginContext;

	return { ctx, kv, rows, sent, reads: () => reads };
}

/** A finished popup with sensible content; override what a test cares about. */
export function popup(raw: Partial<Popup> = {}): Popup {
	return normalizePopup({
		id: "abcd1234",
		handle: "monthly-letter",
		name: "Monthly letter",
		kind: "modal",
		heading: "Fresh from the oven, once a month",
		text: "New breads, the cake of the month and the odd recipe.",
		contains: "button",
		buttonLabel: "Order a cake",
		buttonUrl: "/cakes",
		on: true,
		step: 4,
		...raw,
	})!;
}
