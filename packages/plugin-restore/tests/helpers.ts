// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { env } from "cloudflare:workers";
import type { PluginContext } from "emdash";

import {
	createSimulatedCloudflare,
	type SimulatedCloudflare,
} from "../test-support/simulated-cloudflare.mjs";

export const PLUGIN_ID = "restore";
export const HOUR = 3_600_000;

/** Run SQL on the test site's real database (what the simulated Cloudflare queries). */
export async function sql(
	text: string,
	params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
	const result = await env.DB.prepare(text)
		.bind(...params)
		.all();
	return result.results;
}

export interface Site {
	host: PluginRuntimeTestHost;
	sim: SimulatedCloudflare;
	ctx: PluginContext;
	emails: Array<{ to: string; cc?: string[]; subject: string; text: string }>;
	/** The admin making the requests. */
	admin: { id: string; name: string; email: string; role: number; createdAt: string };
}

interface Options {
	otherDatabases?: string[];
	siteUrl?: string;
	withEmail?: boolean;
}

/**
 * A test site with EmDash's real tables, a simulated Cloudflare whose queries run on those
 * tables, and a plugin context like the host's. Key-value entries are stored in the site's
 * own options table, as EmDash stores them, so the plugin's check mark can be found.
 */
export async function startSite(options: Options = {}): Promise<Site> {
	const host = await createPluginRuntimeTestHost({
		site: { name: "Rosie's Bakery", url: options.siteUrl ?? "https://rosies.test", locale: "en" },
	});
	await host.fixtures.collection({
		slug: "pages",
		label: "Pages",
		labelSingular: "Page",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "portableText" },
		],
	});
	await host.fixtures.collection({
		slug: "products",
		label: "Products",
		labelSingular: "Product",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "price", label: "Price", type: "string" },
		],
	});
	const sim = createSimulatedCloudflare({
		exec: (text, params) => sql(text, params),
		accountName: "Rosie's Bakery",
		siteDatabase: "rosies-bakery",
		otherDatabases: options.otherDatabases ?? [],
	});
	const emails: Site["emails"] = [];
	const storage = new Map<string, Map<string, unknown>>();
	const collection = (name: string) => {
		if (!storage.has(name)) storage.set(name, new Map());
		const items = storage.get(name)!;
		return {
			async get(id: string) {
				return items.get(id) ?? null;
			},
			async put(id: string, data: unknown) {
				items.set(id, structuredClone(data));
			},
			async putMany(list: Array<{ id: string; data: unknown }>) {
				for (const { id, data } of list) items.set(id, structuredClone(data));
			},
			async query(q: { orderBy?: Record<string, "asc" | "desc">; limit?: number } = {}) {
				const [field, dir] = Object.entries(q.orderBy ?? {})[0] ?? ["", "asc"];
				const list = [...items.entries()].map(([id, data]) => ({ id, data }));
				if (field) {
					list.sort((a, b) => {
						const x = String((a.data as Record<string, unknown>)[field]);
						const y = String((b.data as Record<string, unknown>)[field]);
						return dir === "desc" ? y.localeCompare(x) : x.localeCompare(y);
					});
				}
				return { items: list.slice(0, q.limit ?? 50), hasMore: false };
			},
		};
	};
	const option = (key: string) => `plugin:${PLUGIN_ID}:${key}`;
	const ctx = {
		plugin: { id: PLUGIN_ID, version: "0.0.0" },
		site: { name: "Rosie's Bakery", url: options.siteUrl ?? "https://rosies.test", locale: "en" },
		kv: {
			async get(key: string) {
				const rows = await sql("SELECT value FROM options WHERE name = ?", [option(key)]);
				return rows[0] ? JSON.parse(String(rows[0].value)) : null;
			},
			async set(key: string, value: unknown) {
				await sql(
					"INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
					[option(key), JSON.stringify(value)],
				);
			},
			async delete(key: string) {
				await sql("DELETE FROM options WHERE name = ?", [option(key)]);
				return true;
			},
		},
		// Settings are `settings:<key>` in the same options table, in-process and sandboxed
		// alike (emdash src/plugins/settings.ts:238), so a restore rewinds them as well.
		settings: {
			async get(key: string) {
				const rows = await sql("SELECT value FROM options WHERE name = ?", [
					option(`settings:${key}`),
				]);
				return rows[0] ? JSON.parse(String(rows[0].value)) : null;
			},
			async set(key: string, value: unknown) {
				await sql(
					"INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
					[option(`settings:${key}`), JSON.stringify(value)],
				);
			},
			async delete(key: string) {
				await sql("DELETE FROM options WHERE name = ?", [option(`settings:${key}`)]);
				return true;
			},
		},
		storage: { restores: collection("restores"), moments: collection("moments") },
		http: { fetch: (url: string, init?: RequestInit) => sim.fetch(url, init) },
		log: { debug() {}, info() {}, warn() {}, error() {} },
		...(options.withEmail === false
			? {}
			: {
					email: {
						async send(message: Site["emails"][number]) {
							emails.push(message);
						},
					},
				}),
		url: (path: string) => `https://rosies.test${path}`,
	} as unknown as PluginContext;

	const created = await host.fixtures.user({
		email: "rosie@rosiesbakery.test",
		name: "Rosie",
		role: "admin",
	});
	const admin = {
		id: created.id,
		name: "Rosie",
		email: "rosie@rosiesbakery.test",
		role: 50,
		createdAt: new Date(Date.now() - 48 * HOUR).toISOString(),
	};
	// Everything that happened before "setup" is moved back in time, so the tests own the timeline.
	await sql("UPDATE _emdash_migrations SET timestamp = ?", [ago(10)]);
	await sql("UPDATE users SET created_at = ?, updated_at = ?", [ago(48), ago(48)]);
	return { host, sim, ctx, emails, admin };
}

/** An ISO time some hours ago. */
export function ago(hours: number): string {
	return new Date(Date.now() - hours * HOUR).toISOString();
}

/** Put an entry's dates (and its revisions) at a given time. */
export async function dated(collection: string, id: string, iso: string, authorId?: string) {
	await sql(`UPDATE "ec_${collection}" SET created_at = ?, updated_at = ? WHERE id = ?`, [
		iso,
		iso,
		id,
	]);
	await sql("DELETE FROM revisions WHERE entry_id = ?", [id]);
	if (authorId) {
		await sql(
			"INSERT INTO revisions (id, collection, entry_id, data, author_id, created_at) VALUES (?, ?, ?, '{}', ?, ?)",
			[crypto.randomUUID(), collection, id, authorId, iso],
		);
	}
}

export async function edited(collection: string, id: string, iso: string, authorId: string) {
	await sql(`UPDATE "ec_${collection}" SET updated_at = ? WHERE id = ?`, [iso, id]);
	await sql(
		"INSERT INTO revisions (id, collection, entry_id, data, author_id, created_at) VALUES (?, ?, ?, '{}', ?, ?)",
		[crypto.randomUUID(), collection, id, authorId, iso],
	);
}

/** A form enquiry, stored the way the Forms plugin stores it. */
export async function enquiry(name: string, email: string, iso: string) {
	await sql(
		"INSERT OR IGNORE INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES ('emdash-forms', 'forms', 'contact', ?, ?, ?)",
		[JSON.stringify({ name: "Contact", slug: "contact" }), ago(40), ago(40)],
	);
	await sql(
		"INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES ('emdash-forms', 'submissions', ?, ?, ?, ?)",
		[
			crypto.randomUUID(),
			JSON.stringify({ formId: "contact", data: { name, email }, createdAt: iso }),
			iso.replace("T", " ").replace(/\.\d+Z$/, ""),
			iso.replace("T", " ").replace(/\.\d+Z$/, ""),
		],
	);
}

/** Every block, including those inside accordions. */
export function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) =>
		block.type === "accordion" ? [block, ...flatten(block.blocks)] : [block],
	);
}

export function text(response: BlockResponse): string {
	return JSON.stringify(response.blocks);
}

/** Fail the test when the host would refuse to draw the response. */
export function valid(response: BlockResponse): BlockResponse {
	const result = validateBlockResponse(response, { pluginPagePaths: ["/restore"] });
	if (!result.valid) throw new Error(`Invalid blocks: ${JSON.stringify(result.errors)}`);
	return response;
}

export function find<T extends Block["type"]>(
	response: BlockResponse,
	type: T,
	match?: (block: Extract<Block, { type: T }>) => boolean,
) {
	return flatten(response.blocks).find(
		(block): block is Extract<Block, { type: T }> =>
			block.type === type && (!match || match(block as Extract<Block, { type: T }>)),
	);
}

/** Buttons anywhere on the page: in actions, sections and table rows. */
export function buttons(
	response: BlockResponse,
): Array<{ action_id: string; label: string; style?: string; value?: unknown; confirm?: unknown }> {
	const out: Array<{
		action_id: string;
		label: string;
		style?: string;
		value?: unknown;
		confirm?: unknown;
	}> = [];
	const take = (element: unknown) => {
		if (
			element &&
			typeof element === "object" &&
			(element as { type?: unknown }).type === "button"
		) {
			out.push(element as (typeof out)[number]);
		}
	};
	for (const block of flatten(response.blocks)) {
		if (block.type === "actions") block.elements.forEach(take);
		if (block.type === "section") take(block.accessory);
		if (block.type === "table") for (const row of block.rows) Object.values(row).forEach(take);
	}
	return out;
}
