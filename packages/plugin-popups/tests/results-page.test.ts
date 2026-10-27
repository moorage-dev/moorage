// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlugin } from "../src/index.js";
import type { CountRow } from "../src/stats.js";
import { fakeContext, popup, type FakeContext } from "./helpers.js";

// The site's time zone, as EmDash's settings give it.
const site = vi.hoisted(() => ({ zone: "UTC" }));
vi.mock("emdash", async (original) => ({
	...(await original<typeof import("emdash")>()),
	getSiteSetting: vi.fn(async (key: string) => (key === "timezone" ? site.zone : undefined)),
}));

// Noon UTC on Friday 16 October 2026.
const NOW = Date.UTC(2026, 9, 16, 12);
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	site.zone = "UTC";
});
afterEach(() => vi.useRealTimers());

async function call(fake: FakeContext, input: unknown, role = 50): Promise<BlockResponse> {
	const response = (await createPlugin().routes.admin!.handler({
		...fake.ctx,
		request: new Request("https://hartleys.test/_emdash/api/plugins/popups/admin"),
		input,
		user: { id: "u1", email: "a@hartleys.test", name: null, role, createdAt: "" },
	} as unknown as RouteContext)) as BlockResponse;
	const checked = validateBlockResponse(response, { pluginPagePaths: ["/"] });
	expect(checked.valid, JSON.stringify(checked.errors)).toBe(true);
	return response;
}
const press = (fake: FakeContext, action: string, value?: unknown, block?: string) =>
	call(fake, {
		type: "block_action",
		action_id: action,
		...(value !== undefined ? { value } : {}),
		...(block ? { block_id: block } : {}),
	});

function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) =>
		block.type === "tab" ? [block, ...block.panels.flatMap((p) => flatten(p.blocks))] : [block],
	);
}
const all = (r: BlockResponse) => flatten(r.blocks);
const words = (r: BlockResponse) => JSON.stringify(r.blocks);
const tab = (r: BlockResponse) =>
	r.blocks.find((b) => b.type === "tab") as Extract<Block, { type: "tab" }>;
const resultsPanel = (r: BlockResponse) => tab(r).panels.find((p) => p.label === "Results")!.blocks;
const tableOf = (blocks: Block[]) =>
	blocks.find((b) => b.type === "table" && b.block_id?.startsWith("results:")) as Extract<
		Block,
		{ type: "table" }
	>;
const tiles = (blocks: Block[]) =>
	(blocks.filter((b) => b.type === "stats") as Array<Extract<Block, { type: "stats" }>>).flatMap(
		(b) => b.items,
	);
const picker = (blocks: Block[]) => {
	for (const b of blocks)
		if (b.type === "actions")
			for (const e of b.elements) if (e.type === "select" && e.action_id === "period") return e;
	return undefined;
};

const count = (popupId: string, day: string, seen: number, more: Partial<CountRow> = {}) => ({
	popup: popupId,
	day,
	seen,
	sent: 0,
	clicked: 0,
	closed: 0,
	phone: 0,
	...more,
});

function site1() {
	const fake = fakeContext({
		popups: {
			popups: [
				popup({ createdAt: "2026-08-01T09:00:00.000Z" }),
				popup({
					id: "form0001",
					handle: "letter",
					name: "Letter",
					contains: "form",
					form: "newsletter",
				}),
			],
		},
	});
	// The popup with a button: September and October, enough views in both.
	fake.rows.set("a1", count("abcd1234", "2026-09-05", 200, { clicked: 4, closed: 30, phone: 100 }));
	fake.rows.set("a2", count("abcd1234", "2026-10-03", 150, { clicked: 6, closed: 20, phone: 30 }));
	fake.rows.set("a3", count("abcd1234", "2026-10-05", 50, { clicked: 3, closed: 5, phone: 20 }));
	fake.rows.set("f1", count("form0001", "2026-10-04", 300, { sent: 15, closed: 40, phone: 150 }));
	// A popup deleted since: its counts stay in the totals, in a row of their own.
	fake.rows.set("g1", count("gone0001", "2026-10-02", 20, { sent: 1 }));
	return fake;
}

describe("the Results tab: how your popups compare", () => {
	it("opens on the last 30 days, and its totals are the rows of its table, deleted popups included", async () => {
		const fake = site1();
		const panel = resultsPanel(await call(fake, { type: "page_load", page: "/" }));
		expect(panel.find((b) => b.type === "header")).toMatchObject({
			text: "How your popups compare",
		});
		expect(picker(panel)).toMatchObject({ label: "Period", initial_value: "r:30-days" });
		expect(picker(panel)!.options.map((o) => o.label)).toEqual([
			"Since they started",
			"This month",
			"Last month",
			"Last 30 days",
		]);
		expect(words({ blocks: panel })).toContain("17 Sep to 16 Oct.");
		const table = tableOf(panel);
		expect(table.block_id).toBe("results:30-days");
		expect(table.page_action_id).toBe("numbers_page");
		expect(table.columns.map((c) => [c.label, !!c.sortable])).toEqual([
			["Popup", false],
			["Seen", true],
			["Sign-ups or clicks", false],
			["Rate", true],
			["Closed", false],
			["Seen on phones", false],
		]);
		expect(table.rows.map((r) => r.name)).toEqual(["Monthly letter", "Letter", "Deleted popups"]);
		expect(table.rows[0]).toMatchObject({
			seen: "200",
			responses: "9 button clicks",
			rate: "5%",
			closed: "25",
			phones: "25%",
		});
		expect(tiles(panel)).toEqual([
			{ label: "Seen", value: "520" },
			{ label: "Sign-ups", value: "16" },
			{ label: "Button clicks", value: "9" },
			{ label: "Closed", value: "65" },
		]);
		expect(panel.some((b) => b.type === "chart")).toBe(false);
		expect(words({ blocks: panel })).toContain(
			"Forms counts every sign-up to a form, wherever it sits; here you see only those that came through a popup. Ad blockers hide some visits.",
		);
	});

	it("changes period on the spot and keeps it while sorting by Rate", async () => {
		const fake = site1();
		const month = await press(fake, "period", "r:last-month");
		expect(tab(month).default_tab).toBe(1);
		const panel = resultsPanel(month);
		expect(picker(panel)).toMatchObject({ initial_value: "r:last-month" });
		expect(words({ blocks: panel })).toContain("1 Sep to 30 Sep.");
		expect(tableOf(panel).rows.map((r) => [r.name, r.seen])).toEqual([
			["Monthly letter", "200"],
			["Letter", "–"],
		]);
		const sorted = await press(
			fake,
			"numbers_page",
			{ sort: { key: "rate", dir: "desc" } },
			"results:this-month",
		);
		const rows = tableOf(resultsPanel(sorted)).rows;
		expect(tab(sorted).default_tab).toBe(1);
		expect(tableOf(resultsPanel(sorted)).block_id).toBe("results:this-month");
		expect(rows.map((r) => [r.name, r.rate])).toEqual([
			["Letter", "5%"],
			["Monthly letter", "5%"],
			["Deleted popups", "–"],
		]);
		const up = tableOf(
			resultsPanel(
				await press(
					fake,
					"numbers_page",
					{ sort: { key: "seen", dir: "asc" } },
					"results:this-month",
				),
			),
		).rows;
		expect(up.map((r) => r.name)).toEqual(["Monthly letter", "Letter", "Deleted popups"]);
	});

	it("handles the list's table action instead of ignoring it", async () => {
		const fake = site1();
		const back = await press(fake, "list_page", { sort: { key: "name", dir: "asc" } }, "list");
		expect(tab(back).default_tab).toBe(0);
	});
});

describe("a finished popup's own page: Results", () => {
	it("shows its period, two tiles, a bar a week since it started, a way to compare and its own download", async () => {
		const fake = site1();
		const page = all(await press(fake, "period", "p:abcd1234:start"));
		const at = page.findIndex((b) => b.type === "header" && b.text === "Results");
		expect(at).toBeGreaterThan(0);
		expect(picker(page)).toMatchObject({ initial_value: "p:abcd1234:start" });
		expect(picker(page)!.options[0]).toEqual({
			label: "Since it started",
			value: "p:abcd1234:start",
		});
		expect(words({ blocks: page })).toContain("1 Aug to 16 Oct.");
		expect(tiles(page)).toEqual([
			{ label: "Button clicks", value: "13" },
			{ label: "Rate", value: "3%" },
		]);
		expect(words({ blocks: page })).toContain(
			"Seen 400 times; closed 55 times without clicking. Rate shows from 100 views.",
		);
		const chart = page.find((b) => b.type === "chart") as Extract<Block, { type: "chart" }>;
		expect(chart.config).toMatchObject({ chart_type: "custom", height: 140 });
		const series = (chart.config as unknown as { options: { series: Array<{ name: string }> } })
			.options.series;
		expect(series).toHaveLength(1);
		expect(series[0]!.name).toBe("Button clicks per week");
		expect(words({ blocks: page })).toContain('"label":"Compare popups"');
		expect(words({ blocks: page })).toContain('"label":"Download CSV"');
		expect(words({ blocks: page })).toMatch(/export\?from=2026-08-01&to=2026-10-16&popup=abcd1234/);
		expect(words({ blocks: page })).not.toContain("See all numbers");
	});

	it("picks This month on the spot, compares with the same days of last month, and keeps the period", async () => {
		const fake = site1();
		const page = all(await press(fake, "row", "change:abcd1234"));
		const formId = page.find((b) => b.type === "form")!.block_id;
		const month = all(await press(fake, "period", "p:abcd1234:this-month"));
		expect(picker(month)).toMatchObject({ initial_value: "p:abcd1234:this-month" });
		expect(words({ blocks: month })).toContain(
			"1 Oct to 16 Oct, compared with the same days last month.",
		);
		expect(tiles(month)).toEqual([
			{ label: "Button clicks", value: "9", description: "up from 4", trend: "up" },
			{ label: "Rate", value: "5%", description: "up from 2%", trend: "up" },
		]);
		expect(words({ blocks: month })).toContain(
			"Seen 200 times (no change from 200); closed 25 times without clicking.",
		);
		const chart = month.find((b) => b.type === "chart") as Extract<Block, { type: "chart" }>;
		const options = (
			chart.config as unknown as {
				options: { xAxis: { data: string[] }; series: Array<{ data: number[] }> };
			}
		).options;
		// Every day of the month so far, empty days as 0.
		expect(options.xAxis.data).toHaveLength(16);
		expect(options.xAxis.data[2]).toBe("3 Oct");
		expect(options.series[0]!.data[2]).toBe(6);
		expect(options.series[0]!.data[3]).toBe(0);
		// The form keeps its id, so what was typed stays; Save carries the period.
		const form = month.find((b) => b.type === "form") as Extract<Block, { type: "form" }>;
		expect(form.block_id).toBe(formId);
		expect(form.submit.action_id).toBe("save_all:this-month");
		const saved = all(
			await call(fake, {
				type: "form_submit",
				action_id: "save_all:this-month",
				block_id: formId,
				values: { heading: "A new heading" },
			}),
		);
		expect(picker(saved)).toMatchObject({ initial_value: "p:abcd1234:this-month" });
		// Compare opens the Results tab on the same period.
		const button = JSON.stringify(month).match(/"value":"(numbers:[a-z0-9-]+)"/)![1]!;
		expect(button).toBe("numbers:this-month");
		const compared = await press(fake, "nav", button);
		expect(tab(compared).default_tab).toBe(1);
		expect(picker(resultsPanel(compared))).toMatchObject({ initial_value: "r:this-month" });
	});

	it("shows no chart and no rate under 100 views, with a short reason", async () => {
		const fake = site1();
		const page = all(await press(fake, "period", "p:abcd1234:last-month"));
		expect(page.some((b) => b.type === "chart")).toBe(true);
		const few = fakeContext({ popups: { popups: [popup()] } });
		few.rows.set("x", count("abcd1234", "2026-10-03", 40, { clicked: 2 }));
		const quiet = all(await press(few, "row", "change:abcd1234"));
		expect(quiet.some((b) => b.type === "chart")).toBe(false);
		expect(tiles(quiet)[1]).toEqual({
			label: "Rate",
			value: "–",
			description: "(needs 100 views)",
		});
	});

	it("says when counts older than 400 days are gone, instead of 'since it started'", async () => {
		const fake = fakeContext({
			popups: { popups: [popup({ createdAt: "2024-03-01T00:00:00.000Z" })] },
		});
		const page = all(await press(fake, "period", "p:abcd1234:start"));
		expect(words({ blocks: page })).toContain(
			"12 Sep 2025 to 16 Oct (counts are kept for 400 days).",
		);
	});
});

describe("reads only what the screen shows", () => {
	it("reads no rows for New popup, one popup's rows for its page, and one period for the list", async () => {
		const fake = site1();
		await press(fake, "new");
		expect(fake.queries).toEqual([]);
		await press(fake, "row", "change:abcd1234");
		// The last 30 days and the 30 before them, in one read.
		expect(fake.queries).toEqual([
			{ popup: "abcd1234", day: { gte: "2026-08-18", lte: "2026-10-16" } },
		]);
		fake.queries.length = 0;
		await press(fake, "period", "p:abcd1234:this-month");
		// This month and the same days of last month, in one read.
		expect(fake.queries).toEqual([
			{ popup: "abcd1234", day: { gte: "2026-09-01", lte: "2026-10-16" } },
		]);
		fake.queries.length = 0;
		await call(fake, { type: "page_load", page: "/" });
		expect(fake.queries).toEqual([{ day: { gte: "2026-09-17", lte: "2026-10-16" } }]);
	});
});

describe("days in the site's time zone", () => {
	it("counts and shows a visit by the site's own day", async () => {
		site.zone = "Pacific/Auckland";
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const count = createPlugin().routes.count!.handler;
		// Noon UTC on the 16th is 1 am on the 17th in Auckland.
		await count({
			...fake.ctx,
			input: { p: "abcd1234", e: "seen", m: false },
		} as unknown as RouteContext);
		expect([...fake.rows.keys()]).toEqual(["abcd1234:2026-10-17"]);
		const panel = resultsPanel(await call(fake, { type: "page_load", page: "/" }));
		expect(words({ blocks: panel })).toContain("18 Sep to 17 Oct.");
		expect(words({ blocks: panel })).toContain("(Pacific/Auckland)");
	});
});
