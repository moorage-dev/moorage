// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PageFragmentEvent, PluginContext, RouteContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STORE_KEY } from "../src/config.js";
import { createPlugin } from "../src/index.js";
import { forgetSettings, memoSettings, SETTINGS_TTL_MS } from "../src/settings-memo.js";
import { fakeContext, popup, type FakeContext } from "./helpers.js";

type Hook = (event: PageFragmentEvent, ctx: PluginContext) => Promise<unknown>;

const render = (fake: FakeContext, query = "") =>
	(createPlugin().hooks["page:fragments"]!.handler as Hook)(
		{
			page: {
				url: `https://hartleys.test/${query}`,
				path: "/",
				locale: null,
				kind: "custom",
				pageType: "website",
				title: "Hartley's",
				description: null,
				canonical: null,
				image: null,
			},
		},
		fake.ctx,
	).then((result) => JSON.stringify(result));

const route = (fake: FakeContext, name: string, input: unknown) =>
	(createPlugin().routes as Record<string, { handler: (ctx: RouteContext) => Promise<unknown> }>)[
		name
	]!.handler({
		...fake.ctx,
		input,
		request: new Request(`https://hartleys.test/_emdash/api/plugins/popups/${name}`),
		user: { id: "u1", email: "a@hartleys.test", name: null, role: 50, createdAt: "" },
	} as unknown as RouteContext);

/** Turn the popup off or on from the admin page, as an admin would. */
const toggle = (fake: FakeContext) =>
	route(fake, "admin", { type: "block_action", action_id: "row", value: "toggle:abcd1234" });

afterEach(() => vi.useRealTimers());

describe("popups kept between page views", () => {
	it("reads the popups once for two page views in a row", async () => {
		const fake = fakeContext({ [STORE_KEY]: { popups: [popup()] } });
		const first = await render(fake);
		const second = await render(fake);
		expect(fake.reads()).toBe(1);
		expect(second).toBe(first);
		expect(second).toContain("abcd1234");
	});

	it("shows a save from the admin page on the very next page view", async () => {
		const fake = fakeContext({ [STORE_KEY]: { popups: [popup()] } });
		expect(await render(fake)).toContain("abcd1234");
		await toggle(fake);
		expect(await render(fake)).not.toContain("abcd1234");
	});

	it("reads fresh for a preview link, so a save made elsewhere shows at once", async () => {
		const fake = fakeContext({ [STORE_KEY]: { popups: [popup()] } });
		await render(fake);
		// Saved in another isolate: this one still keeps the old popups for page views.
		fake.kv.set(STORE_KEY, { popups: [popup({ heading: "Saved a moment ago" })] });
		expect(await render(fake)).not.toContain("Saved a moment ago");
		expect(await render(fake, "?popups_preview=abcd1234")).toContain("Saved a moment ago");
		expect(fake.reads()).toBe(2);
		// What the preview read is the newest there is, so page views use it from now on.
		expect(await render(fake)).toContain("Saved a moment ago");
		expect(fake.reads()).toBe(2);
	});

	it("picks up a change made elsewhere once the popups are 30 seconds old", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-21T10:00:00Z"), toFake: ["Date"] });
		const fake = fakeContext({ [STORE_KEY]: { popups: [popup()] } });
		await render(fake);
		// Another isolate saved: the stored value changes without this isolate knowing.
		fake.kv.set(STORE_KEY, { popups: [popup({ on: false })] });
		vi.advanceTimersByTime(SETTINGS_TTL_MS - 1);
		expect(await render(fake)).toContain("abcd1234");
		expect(fake.reads()).toBe(1);
		vi.advanceTimersByTime(1);
		expect(await render(fake)).not.toContain("abcd1234");
		expect(fake.reads()).toBe(2);
	});

	it("serves a box in a page from the same copy, and a save shows at once", async () => {
		const box = popup({ kind: "inline" });
		const fake = fakeContext({ [STORE_KEY]: { popups: [box] } });
		await render(fake);
		expect(await route(fake, "box", { id: "abcd1234" })).toMatchObject({
			box: { id: "abcd1234" },
		});
		expect(fake.reads()).toBe(1);
		await toggle(fake);
		expect(await route(fake, "box", { id: "abcd1234" })).toEqual({ box: null });
	});
});

describe("memoSettings", () => {
	const owner = (id: string, url?: string) => ({ plugin: { id }, site: url ? { url } : undefined });

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
