// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PageFragmentEvent, PluginContext, RouteContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIG_KEY } from "../src/config.js";
import { createPlugin } from "../src/index.js";
import { memoSettings, SETTINGS_TTL_MS } from "../src/settings-memo.js";
import { fakeContext, type FakeContext } from "./helpers.js";

type Hook = (event: PageFragmentEvent, ctx: PluginContext) => Promise<unknown>;

const render = (fake: FakeContext) =>
	(createPlugin().hooks["page:fragments"]!.handler as Hook)(
		{
			page: {
				url: "https://acme.test/",
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

	it("keeps sites apart, shares a read in flight, gives copies, and forgets a failed read", async () => {
		let reads = 0;
		const read = async () => ({ n: ++reads });
		const [a, b] = await Promise.all([
			memoSettings(owner("p", "https://a.test"), read, 0),
			memoSettings(owner("p", "https://a.test"), read, 0),
		]);
		expect(reads).toBe(1);
		expect(a).toEqual(b);
		expect(a).not.toBe(b);
		a.n = 99;
		expect(await memoSettings(owner("p", "https://a.test"), read, 1)).toEqual({ n: 1 });
		expect(await memoSettings(owner("p", "https://b.test"), read, 1)).toEqual({ n: 2 });

		const failing = async (): Promise<{ n: number }> => {
			throw new Error("database away");
		};
		await expect(memoSettings(owner("q"), failing, 0)).rejects.toThrow("database away");
		expect(await memoSettings(owner("q"), read, 1)).toEqual({ n: 3 });
	});
});
