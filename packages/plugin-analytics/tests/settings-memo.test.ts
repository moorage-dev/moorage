// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PageFragmentEvent, PluginContext, RouteContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIG_KEY } from "../src/config.js";
import { createPlugin } from "../src/index.js";
import { forgetSettings, memoSettings, SETTINGS_TTL_MS } from "../src/settings-memo.js";
import { fakeContext, type FakeContext } from "./helpers.js";

type Hook = (event: PageFragmentEvent, ctx: PluginContext) => Promise<unknown>;

const render = (fake: FakeContext, query = "") =>
	(createPlugin().hooks["page:fragments"]!.handler as Hook)(
		{
			page: {
				url: `https://acme.test/${query}`,
				path: "/",
				locale: null,
				kind: "custom",
				pageType: "website",
				title: "Acme",
				description: null,
				canonical: null,
				image: null,
			},
		},
		fake.ctx,
	).then((result) => JSON.stringify(result));

const save = (fake: FakeContext, ga4: string) =>
	createPlugin().routes.admin!.handler({
		...fake.ctx,
		request: new Request("https://acme.test/_emdash/api/plugins/analytics-consent/admin"),
		input: { type: "form_submit", action_id: "save_tools", values: { ga4 } },
		user: { id: "u1", email: "a@acme.test", name: null, role: 50, createdAt: "" },
	} as unknown as RouteContext);

afterEach(() => vi.useRealTimers());

describe("settings kept between page views", () => {
	it("reads the settings once for two page views in a row", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" } } });
		const first = await render(fake);
		const second = await render(fake);
		expect(fake.reads()).toBe(1);
		expect(second).toBe(first);
		expect(second).toContain("G-AB12CD34EF");
	});

	it("shows a save from the admin page on the very next page view", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" } } });
		expect(await render(fake)).toContain("G-AB12CD34EF");
		await save(fake, "G-ZZ98YY76XX");
		const after = await render(fake);
		expect(after).toContain("G-ZZ98YY76XX");
		expect(after).not.toContain("G-AB12CD34EF");
	});

	it("reads fresh for the banner preview, so a save made elsewhere shows at once", async () => {
		const fake = fakeContext({ [CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" } } });
		await render(fake);
		// Saved in another isolate: this one still keeps the old settings for page views.
		fake.kv.set(CONFIG_KEY, { tools: { ga4: "G-ZZ98YY76XX" } });
		expect(await render(fake)).toContain("G-AB12CD34EF");
		const preview = await render(fake, "?cookie_preview=light");
		expect(preview).toContain("G-ZZ98YY76XX");
		expect(preview).not.toContain("G-AB12CD34EF");
		expect(fake.reads()).toBe(2);
		// What the preview read is the newest there is, so page views use it from now on.
		expect(await render(fake)).toContain("G-ZZ98YY76XX");
		expect(fake.reads()).toBe(2);
	});

	it("picks up a change made elsewhere once the settings are 30 seconds old", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-21T10:00:00Z"), toFake: ["Date"] });
		const fake = fakeContext({ [CONFIG_KEY]: { tools: { ga4: "G-AB12CD34EF" } } });
		await render(fake);
		// Another isolate saved: the stored value changes without this isolate knowing.
		fake.kv.set(CONFIG_KEY, { tools: { ga4: "G-ZZ98YY76XX" } });
		vi.advanceTimersByTime(SETTINGS_TTL_MS - 1);
		expect(await render(fake)).toContain("G-AB12CD34EF");
		expect(fake.reads()).toBe(1);
		vi.advanceTimersByTime(1);
		expect(await render(fake)).toContain("G-ZZ98YY76XX");
		expect(fake.reads()).toBe(2);
	});
});

describe("memoSettings", () => {
	const owner = (id: string, url?: string) => ({ plugin: { id }, site: url ? { url } : undefined });

	it("keeps sites apart, gives copies, and forgets a failed read", async () => {
		let reads = 0;
		const read = async () => ({ n: ++reads });
		const a = await memoSettings(owner("p", "https://a.test"), read, { now: 0 });
		const b = await memoSettings(owner("p", "https://a.test"), read, { now: 0 });
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

	// Issue #46: on Cloudflare Workers a promise that does I/O belongs to the request that made it.
	// When that request ends first, every other request waiting on the same promise fails, and the
	// page goes out without this plugin's output.
	it("never makes one request wait on another request's read", async () => {
		const site = owner("w", "https://a.test");
		// The first request's read never settles: its request ended before the database answered.
		const first = memoSettings(site, () => new Promise<{ n: number }>(() => {}), { now: 0 });
		void first;
		const second = memoSettings(site, async () => ({ n: 2 }), { now: 0 });
		const late = new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 50));
		expect(await Promise.race([second, late])).toEqual({ n: 2 });
		// And a read that has finished is kept as a plain value for the page views after it.
		expect(await memoSettings(site, async () => ({ n: 3 }), { now: 1 })).toEqual({ n: 2 });
	});

	it("does not keep a read that was under way when the settings were saved", async () => {
		const site = owner("s", "https://a.test");
		let finish: (value: { n: number }) => void = () => {};
		const slow = memoSettings(site, () => new Promise<{ n: number }>((r) => (finish = r)), {
			now: 0,
		});
		forgetSettings("s"); // a save in this isolate, while the old read is still out
		finish({ n: 1 });
		expect(await slow).toEqual({ n: 1 });
		expect(await memoSettings(site, async () => ({ n: 2 }), { now: 1 })).toEqual({ n: 2 });
	});
});
