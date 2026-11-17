// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { z } from "astro/zod";
import type { RouteContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeStore } from "../src/config.js";
import { createPlugin } from "../src/index.js";
import { MCP_ROUTES } from "../src/mcp.js";
import { forgetAllSettings, memoSettings } from "../src/settings-memo.js";
import { fakeContext, popup, type FakeContext } from "./helpers.js";

// The site's own record of a file, read in-process (EmDash's database); here, one known file.
vi.mock("../src/media-file.js", () => ({
	storedFileUrl: async (id: string) => (id === "m1" ? "/_emdash/api/media/file/01ABC.jpg" : null),
}));

/**
 * The tools an AI assistant uses through EmDash's MCP server: each one is a private route
 * with a permission, and each handler applies the same checks and role rules as the admin page.
 */

const ADMIN = 50;
const EDITOR = 40;

const plugin = createPlugin();
const routes = plugin.routes as Record<
	string,
	{ permission?: string; handler: (ctx: RouteContext) => Promise<unknown> }
>;

afterEach(() => vi.unstubAllGlobals());

async function tool(
	fake: FakeContext,
	name: keyof typeof MCP_ROUTES,
	input: unknown,
	role = ADMIN,
) {
	return routes[MCP_ROUTES[name]]!.handler({
		...fake.ctx,
		input,
		request: new Request(`https://hartleys.test/_emdash/api/plugins/popups/${MCP_ROUTES[name]}`),
		user: { id: "u1", role },
	} as unknown as RouteContext) as Promise<Record<string, unknown>>;
}
async function refused(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected a refusal");
}
const stored = (fake: FakeContext) => normalizeStore(fake.kv.get("popups"));

describe("the tools EmDash lists", () => {
	it("names six tools on private routes, with the permission and the destructive flag of each", () => {
		const tools = plugin.mcp!.tools;
		expect(new Set(Object.keys(tools))).toEqual(
			new Set(["create", "get", "list", "turn_off", "turn_on", "update"]),
		);
		const facts = Object.fromEntries(
			Object.entries(tools).map(([name, t]) => [
				name,
				[t.route, routes[t.route]!.permission, t.destructive ?? false],
			]),
		);
		expect(facts).toEqual({
			list: ["mcp/list", "plugins:read", false],
			get: ["mcp/get", "plugins:read", false],
			create: ["mcp/create", "plugins:manage", true],
			update: ["mcp/update", "plugins:read", true],
			turn_on: ["mcp/turn-on", "plugins:read", true],
			turn_off: ["mcp/turn-off", "plugins:read", true],
		});
		for (const [name, t] of Object.entries(tools)) {
			// EmDash turns the input into JSON Schema for the consent screen and the AI client.
			expect(() => z.toJSONSchema(t.input), name).not.toThrow();
			expect(t.description).not.toMatch(/Moorage|hosting/i);
		}
	});
});

describe("reading", () => {
	it("lists every popup with its kind, on or off, where it shows and its warnings", async () => {
		const fake = fakeContext({
			popups: {
				popups: [
					popup(),
					popup({ id: "half0001", name: "Half made", step: 2, on: false }),
					popup({ id: "form0001", name: "Letter", contains: "form", form: "newsletter" }),
				],
			},
			problems: { form0001: { k: "missing", at: 1 } },
		});
		const answer = await tool(fake, "list", {}, EDITOR);
		expect(answer.popups).toEqual([
			expect.objectContaining({
				id: "abcd1234",
				name: "Monthly letter",
				kind: "popup",
				on: true,
				status: "On",
				showsOn: "Every page",
				warnings: [],
			}),
			expect.objectContaining({ id: "half0001", on: false, status: "Not finished" }),
			expect.objectContaining({
				id: "form0001",
				warnings: [expect.stringContaining('there is no form called "newsletter"')],
			}),
		]);
		expect((answer.popups as Array<{ warnings: string[] }>)[1]!.warnings[0]).toContain(
			"not finished",
		);
	});

	it("gives one popup's full settings and its results line", async () => {
		const fake = fakeContext({ popups: { popups: [popup({ label: "New", note: "Quick" })] } });
		const answer = await tool(fake, "get", { id: "abcd1234" }, EDITOR);
		expect(answer).toMatchObject({
			id: "abcd1234",
			kind: "popup",
			heading: "Fresh from the oven, once a month",
			label: "New",
			note: "Quick",
			design: "plain",
			buttonLabel: "Order a cake",
			buttonUrl: "/cakes",
			closingWords: "no-thanks",
			opens: "read",
			where: "all",
			devices: "all",
			showAgain: "month",
			start: null,
			end: null,
			timeZone: "UTC",
		});
		expect(answer.results).toMatch(/^Since .*: seen 0 times, 0 button clicks/);
		expect(await refused(tool(fake, "get", { id: "nope0000" }))).toBe(
			'There is no popup with the id "nope0000". Call list to see the popups and their ids.',
		);
	});
});

describe("making and changing", () => {
	const OFFER = {
		name: "Christmas cakes",
		kind: "slide-in",
		heading: "Christmas cakes are here",
		highlight: "Christmas cakes",
		label: "This month",
		note: "Order by 20 December",
		buttonLabel: "Order a cake",
		buttonUrl: "/cakes",
		decline: "not-interested",
		where: "prefix",
		pages: ["/journal/"],
		end: "2026-12-24 18:00",
	};

	it("makes a finished popup, turned off unless asked", async () => {
		const fake = fakeContext({ popups: { popups: [] } });
		const answer = await tool(fake, "create", OFFER);
		const made = stored(fake).popups[0]!;
		expect(made).toMatchObject({
			name: "Christmas cakes",
			kind: "slide",
			step: 4,
			on: false,
			label: "This month",
			highlight: "Christmas cakes",
			where: "prefix",
			prefixes: ["/journal/"],
			decline: "not-interested",
		});
		expect(made.end).toBe(Date.UTC(2026, 11, 24, 18));
		expect(answer).toMatchObject({ id: made.id, on: false, status: "Off" });
		expect(answer.message).toContain("turned off");
		await tool(fake, "create", { ...OFFER, name: "Second", on: true });
		expect(stored(fake).popups[1]).toMatchObject({ name: "Second", on: true });
	});

	it("refuses what the admin page refuses, in its words", async () => {
		const fake = fakeContext({ popups: { popups: [] } });
		expect(await refused(tool(fake, "create", { ...OFFER, buttonUrl: "javascript:x" }))).toContain(
			"The link must be a page on this site",
		);
		expect(await refused(tool(fake, "create", { ...OFFER, highlight: "free cake" }))).toContain(
			'The words to highlight, "free cake", are not in the heading.',
		);
		expect(await refused(tool(fake, "create", { ...OFFER, end: "soon" }))).toContain(
			"Write the end like 2026-12-24 18:00",
		);
		expect(await refused(tool(fake, "create", { ...OFFER, kind: "rocket" }))).toContain(
			"Choose what kind it is",
		);
		expect(stored(fake).popups).toHaveLength(0);
	});

	it("lets only an Admin make a popup", async () => {
		const fake = fakeContext({ popups: { popups: [] } });
		expect(await refused(tool(fake, "create", OFFER, EDITOR))).toBe(
			"Only an administrator can make new popups.",
		);
	});

	it("changes only the given fields, and an Editor only words, pictures and dates", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		await tool(fake, "update", { id: "abcd1234", text: "New words.", note: "Quick" }, EDITOR);
		expect(stored(fake).popups[0]).toMatchObject({
			text: "New words.",
			note: "Quick",
			heading: "Fresh from the oven, once a month",
			on: true,
		});
		expect(
			await refused(
				tool(fake, "update", { id: "abcd1234", where: "prefix", design: "top" }, EDITOR),
			),
		).toBe(
			"Only an administrator can change these: design, where. Leave them out, or ask an administrator.",
		);
		await tool(fake, "update", { id: "abcd1234", design: "top", devices: "phone" });
		expect(stored(fake).popups[0]).toMatchObject({ design: "top", devices: "phone" });
	});

	it("never lets an Editor finish a half-made popup, so it cannot be turned on before an Admin chooses where", async () => {
		const fake = fakeContext({ popups: { popups: [popup({ step: 2, on: false })] } });
		await tool(fake, "update", { id: "abcd1234", text: "New words." }, EDITOR);
		expect(stored(fake).popups[0]).toMatchObject({ text: "New words.", step: 2, on: false });
		expect(await refused(tool(fake, "turn_on", { id: "abcd1234" }, EDITOR))).toContain(
			"not finished",
		);
	});

	it("sets a picture from the media library without a signed-in cookie", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		(fake.ctx as unknown as { media: Record<string, unknown> }).media.get = async (id: string) =>
			id === "m1"
				? {
						id: "m1",
						filename: "loaves.jpg",
						mimeType: "image/jpeg",
						url: "/_emdash/api/media/asset/m1/loaves.jpg",
						alt: "Loaves",
						width: 1600,
						height: 1000,
					}
				: null;
		// No cookie anywhere: the site's own media API is never asked.
		const fetched = vi.fn();
		vi.stubGlobal("fetch", fetched);
		await tool(fake, "update", { id: "abcd1234", picture: "m1" }, EDITOR);
		expect(stored(fake).popups[0]!.picture).toMatchObject({
			id: "m1",
			url: "/_emdash/api/media/file/01ABC.jpg",
			alt: "Loaves",
		});
		expect(fetched).not.toHaveBeenCalled();
		expect(await refused(tool(fake, "update", { id: "abcd1234", picture: "zz" }, EDITOR))).toBe(
			'There is no picture with the id "zz" in the media library.',
		);
	});

	it("turns a popup on and off, and the page view sees it at once", async () => {
		const fake = fakeContext({ popups: { popups: [popup({ on: false })] } });
		forgetAllSettings();
		// A page view keeps the popups in memory; a tool's change must not wait for it.
		await memoSettings(fake.ctx, async () => normalizeStore(fake.kv.get("popups")));
		const on = await tool(fake, "turn_on", { id: "abcd1234" }, EDITOR);
		expect(on).toMatchObject({ on: true, status: "On" });
		const seen = await memoSettings(fake.ctx, async () => normalizeStore(fake.kv.get("popups")));
		expect(seen.popups[0]!.on).toBe(true);
		await tool(fake, "turn_off", { id: "abcd1234" }, EDITOR);
		expect(stored(fake).popups[0]!.on).toBe(false);
		const half = fakeContext({ popups: { popups: [popup({ step: 2, on: false })] } });
		expect(await refused(tool(half, "turn_on", { id: "abcd1234" }))).toContain("not finished");
	});
});
