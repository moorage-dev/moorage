// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The page hook called directly with a stand-in context, so the reads can be
// counted and the clock moved. tests/plugin.test.ts covers the same through the
// real sandbox and the admin page.

import type { PageMetadataContribution, PluginContext, PublicPageContext } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/plugin.js";
import type { EntryRecord } from "../src/record.js";
import { forgetAllSettings, memoSettings, SETTINGS_TTL_MS } from "../src/settings-memo.js";

type Hook = (
	event: { page: PublicPageContext },
	ctx: PluginContext,
) => Promise<PageMetadataContribution[]>;
const hook = plugin.hooks!["page:metadata"] as unknown as Hook;

const RECORD: EntryRecord = { v: 1, publishedAt: null, updatedAt: null, authors: [], custom: [] };

function page(content?: PublicPageContext["content"], query = ""): PublicPageContext {
	return {
		url: `https://acme.test/about${query}`,
		path: "/about",
		locale: null,
		kind: content ? "content" : "custom",
		pageType: "website",
		title: "About | Acme",
		pageTitle: "About",
		description: null,
		canonical: null,
		image: null,
		...(content ? { content } : {}),
	};
}

function fake(config: unknown, recordGate?: Promise<void>) {
	const kv = new Map<string, unknown>([["config", config]]);
	const started: string[] = [];
	let reads = 0;
	const ctx = {
		plugin: { id: "seo", version: "0.0.0" },
		site: { name: "Acme", url: "https://acme.test", locale: "en" },
		kv: {
			async get(key: string) {
				reads++;
				started.push(`kv:${key}`);
				await recordGate;
				return kv.get(key) ?? null;
			},
			async set(key: string, value: unknown) {
				kv.set(key, value);
			},
		},
		storage: {
			entries: {
				async get() {
					started.push("record");
					await recordGate;
					return RECORD;
				},
				async put() {},
			},
		},
		log: { info() {}, warn() {}, error() {}, debug() {} },
	} as unknown as PluginContext;
	return { ctx, kv, started, reads: () => reads };
}

const name = (contributions: PageMetadataContribution[]) => {
	const graph = contributions.find((c) => c.kind === "jsonld");
	const graphed = graph?.kind === "jsonld" ? (graph.graph as { "@graph"?: unknown }) : {};
	const nodes = (graphed["@graph"] ?? []) as Array<{ "@type": string; name?: string }>;
	return nodes.find((node) => node["@type"] === "Organization")?.name;
};

beforeEach(() => forgetAllSettings());
afterEach(() => vi.useRealTimers());

describe("settings kept between page views", () => {
	it("reads the config once for two page views in a row", async () => {
		const site = fake({ site: { name: "Acme Dental" } });
		expect(name(await hook({ page: page() }, site.ctx))).toBe("Acme Dental");
		expect(name(await hook({ page: page() }, site.ctx))).toBe("Acme Dental");
		expect(site.reads()).toBe(1);
	});

	it("reads fresh for an EmDash preview link, so a save made elsewhere shows at once", async () => {
		const site = fake({ site: { name: "Acme Dental" } });
		await hook({ page: page() }, site.ctx);
		// Saved in another isolate: this one still keeps the old config for page views.
		site.kv.set("config", { site: { name: "Acme Clinic" } });
		expect(name(await hook({ page: page() }, site.ctx))).toBe("Acme Dental");
		expect(name(await hook({ page: page(undefined, "?_preview=token") }, site.ctx))).toBe(
			"Acme Clinic",
		);
		expect(site.reads()).toBe(2);
		// What the preview read is the newest there is, so page views use it from now on.
		expect(name(await hook({ page: page() }, site.ctx))).toBe("Acme Clinic");
		expect(site.reads()).toBe(2);
	});

	it("picks up a change made elsewhere once the config is 30 seconds old", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-21T10:00:00Z"), toFake: ["Date"] });
		const site = fake({ site: { name: "Acme Dental" } });
		await hook({ page: page() }, site.ctx);
		// Another isolate saved: the stored value changes without this isolate knowing.
		site.kv.set("config", { site: { name: "Acme Clinic" } });
		vi.advanceTimersByTime(SETTINGS_TTL_MS - 1);
		expect(name(await hook({ page: page() }, site.ctx))).toBe("Acme Dental");
		expect(site.reads()).toBe(1);
		vi.advanceTimersByTime(1);
		expect(name(await hook({ page: page() }, site.ctx))).toBe("Acme Clinic");
		expect(site.reads()).toBe(2);
	});

	it("reads the config and the entry's record at the same time", async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const site = fake({}, gate);
		const rendering = hook(
			{ page: page({ collection: "pages", id: "e1", slug: "about" }) },
			site.ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Both reads were sent before either answered.
		expect(site.started).toEqual(["kv:config", "record"]);
		open();
		expect(await rendering).toHaveLength(2);
	});
});

describe("memoSettings", () => {
	const owner = (id: string, url?: string) => ({ plugin: { id }, site: url ? { url } : undefined });

	it("keeps sites apart, shares a read in flight, gives copies, and forgets a failed read", async () => {
		let reads = 0;
		const read = async () => ({ n: ++reads });
		const [a, b] = await Promise.all([
			memoSettings(owner("p", "https://a.test"), read, { now: 0 }),
			memoSettings(owner("p", "https://a.test"), read, { now: 0 }),
		]);
		expect(reads).toBe(1);
		expect(a).toEqual(b);
		expect(a).not.toBe(b);
		a.n = 99;
		expect(await memoSettings(owner("p", "https://a.test"), read, { now: 1 })).toEqual({ n: 1 });
		expect(await memoSettings(owner("p", "https://b.test"), read, { now: 1 })).toEqual({ n: 2 });

		const failing = async (): Promise<{ n: number }> => {
			throw new Error("database away");
		};
		await expect(memoSettings(owner("q"), failing, { now: 0 })).rejects.toThrow("database away");
		expect(await memoSettings(owner("q"), read, { now: 1 })).toEqual({ n: 3 });
	});
});
