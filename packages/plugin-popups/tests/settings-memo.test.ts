// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PageFragmentEvent, PluginContext, RouteContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STORE_KEY } from "../src/config.js";
import { createPlugin } from "../src/index.js";
import { SETTINGS_TTL_MS } from "../src/settings-memo.js";
import { fakeContext, popup, type FakeContext } from "./helpers.js";

type Hook = (event: PageFragmentEvent, ctx: PluginContext) => Promise<unknown>;

const render = (fake: FakeContext) =>
	(createPlugin().hooks["page:fragments"]!.handler as Hook)(
		{
			page: {
				url: "https://hartleys.test/",
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
