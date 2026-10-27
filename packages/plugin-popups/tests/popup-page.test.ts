// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeStore, type Popup, type Store } from "../src/config.js";
import { HELP_LINE } from "../src/help-line.js";
import { createPlugin } from "../src/index.js";
import type { CountRow } from "../src/stats.js";
import { fakeContext, popup, type FakeContext } from "./helpers.js";

/**
 * A finished popup's own page, as the approved redesign lays it out
 * (planning/polish/popups-edit/mockup.html): back, name, status with its
 * switch, Preview and More, Results, Edit with one form, Delete at the foot.
 */

const ADMIN = 50;
const EDITOR = 40;

// Noon UTC on Friday 16 October 2026.
const NOW = Date.UTC(2026, 9, 16, 12);
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function call(fake: FakeContext, input: unknown, role = ADMIN): Promise<BlockResponse> {
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
const press = (fake: FakeContext, action: string, value: string, role = ADMIN) =>
	call(fake, { type: "block_action", action_id: action, value }, role);
const open = (fake: FakeContext, id = "abcd1234", role = ADMIN) =>
	press(fake, "row", `change:${id}`, role);
const submit = (
	fake: FakeContext,
	action: string,
	block: string,
	values: Record<string, unknown>,
	role = ADMIN,
) => call(fake, { type: "form_submit", action_id: action, block_id: block, values }, role);

const words = (r: BlockResponse | Block[]) => JSON.stringify(Array.isArray(r) ? r : r.blocks);
const stored = (fake: FakeContext): Store => normalizeStore(fake.kv.get("popups"));
const form = (r: BlockResponse) =>
	r.blocks.find((b) => b.type === "form" && b.submit.action_id.startsWith("save_all")) as Extract<
		Block,
		{ type: "form" }
	>;
const fieldIds = (r: BlockResponse) => form(r).fields.map((f) => f.action_id);
const field = (r: BlockResponse, id: string) =>
	form(r).fields.find((f) => f.action_id === id) as Record<string, unknown> | undefined;
const actionsWith = (r: BlockResponse, text: string) =>
	r.blocks.find((b) => b.type === "actions" && JSON.stringify(b).includes(text)) as
		| Extract<Block, { type: "actions" }>
		| undefined;
const at = (r: BlockResponse, test: (b: Block) => boolean) => r.blocks.findIndex(test);
const header = (text: string) => (b: Block) => b.type === "header" && b.text === text;
const tiles = (r: BlockResponse) =>
	(r.blocks.filter((b) => b.type === "stats") as Array<Extract<Block, { type: "stats" }>>).flatMap(
		(b) => b.items,
	);
const contexts = (r: BlockResponse) =>
	(r.blocks.filter((b) => b.type === "context") as Array<Extract<Block, { type: "context" }>>).map(
		(b) => b.text,
	);

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

const FORM: Partial<Popup> = { contains: "form", form: "newsletter", thanks: "Thanks" };

/** A popup with a form, with enough views in both 30-day periods to compare. */
function busy(): FakeContext {
	const fake = fakeContext({
		popups: { popups: [popup({ ...FORM, createdAt: "2026-08-01T09:00:00.000Z" })] },
	});
	fake.rows.set("a", count("abcd1234", "2026-09-10", 967, { sent: 35, closed: 300 }));
	fake.rows.set("b", count("abcd1234", "2026-10-03", 1500, { sent: 60, closed: 445 }));
	fake.rows.set("c", count("abcd1234", "2026-10-10", 984, { sent: 36, closed: 300 }));
	return fake;
}

describe("a finished popup's page, in the approved order", () => {
	it("goes back, name, status with its switch, Preview and More, Results, Edit, Delete, help", async () => {
		const page = await open(busy());
		const kinds = page.blocks.map((b) => (b.type === "header" ? `header:${b.text}` : b.type));
		// Back to the list first: a button, since a link to the page already open does nothing.
		expect(page.blocks[0]).toEqual({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "nav",
					label: "← All popups",
					value: "list",
					style: "secondary",
				},
			],
		});
		expect(kinds.slice(1, 4)).toEqual(["header:Monthly letter", "section", "actions"]);
		const results = at(page, header("Results"));
		const edit = at(page, header("Edit"));
		const save = at(page, (b) => b.type === "form");
		const remove = at(page, (b) => words([b]).includes('"label":"Delete popup"'));
		const help = at(page, (b) => b.block_id === HELP_LINE);
		expect(results).toBeGreaterThan(3);
		expect(edit).toBeGreaterThan(results);
		expect(save).toBeGreaterThan(edit);
		expect(remove).toBeGreaterThan(save);
		expect(help).toBeGreaterThan(remove);
		expect(page.blocks.at(-1)?.block_id).toBe(HELP_LINE);
		// One "Back" only: nothing at the foot sends to the list any more.
		expect(words(page)).not.toContain("Back to the list");
	});

	it("says the status in one line, with Turn off beside it", async () => {
		const page = await open(busy());
		expect(page.blocks[2]).toEqual({
			type: "section",
			text: "On · Popup with a form · every page, after they have read a while",
			accessory: {
				type: "button",
				action_id: "row",
				label: "Turn off",
				value: "toggle:abcd1234",
			},
		});
		const off = fakeContext({ popups: { popups: [popup({ on: false })] } });
		expect((await open(off)).blocks[2]).toMatchObject({
			text: "Off · Popup · every page, after they have read a while",
			accessory: { label: "Turn on" },
		});
	});

	it("has Preview as its one primary action and More with Change name or kind and Duplicate", async () => {
		const page = await open(busy());
		expect(page.blocks[3]).toEqual({
			type: "actions",
			elements: [
				{
					type: "link",
					label: "Preview on your site",
					target: {
						kind: "external",
						url: "https://hartleys.test/?popups_preview=abcd1234&scheme=light",
					},
					appearance: "primary",
				},
				{
					type: "menu",
					action_id: "row_more",
					label: "More",
					items: [
						{ label: "Change name or kind", value: "kind:abcd1234" },
						{ label: "Duplicate", value: "duplicate:abcd1234" },
					],
					style: "secondary",
				},
			],
		});
		expect(words(page).match(/"appearance":"primary"|"style":"primary"/g)).toHaveLength(1);
		// Dark mode is a plain link below the form.
		const dark = at(page, (b) => words([b]).includes("scheme=dark"));
		expect(dark).toBeGreaterThan(at(page, (b) => b.type === "form"));
		expect(page.blocks[dark]).toMatchObject({
			type: "actions",
			elements: [{ type: "link", label: "Preview in dark mode", appearance: "inline" }],
		});
	});

	it("no longer repeats the form in a summary grid", async () => {
		const page = await open(busy());
		expect(page.blocks.some((b) => b.type === "fields")).toBe(false);
		expect(words(page)).not.toContain("Again after closing");
	});

	it("shows the same problem banner as the list, under the actions", async () => {
		const fake = fakeContext({
			popups: { popups: [popup({ contains: "form", form: "newsleter" })] },
			problems: { abcd1234: { k: "missing", at: 1 } },
		});
		const page = await open(fake);
		const banner = at(page, (b) => b.type === "banner");
		expect(banner).toBe(4);
		expect(page.blocks[banner]).toMatchObject({
			variant: "error",
			title: '"Monthly letter" cannot open: there is no form called "newsleter" any more',
		});
		const paused = fakeContext({
			popups: { popups: [popup({ ...FORM })] },
			problems: { abcd1234: { k: "paused", at: 1 } },
		});
		expect((await open(paused)).blocks[4]).toMatchObject({ type: "banner", variant: "alert" });
		expect((await open(busy())).blocks.some((b) => b.type === "banner")).toBe(false);
	});
});

describe("its Results", () => {
	it("opens on the last 30 days, with the Period alone in its own row", async () => {
		const page = await open(busy());
		const picker = page.blocks.find(
			(b) => b.type === "actions" && b.elements.some((e) => e.type === "select"),
		) as Extract<Block, { type: "actions" }>;
		expect(picker.elements).toHaveLength(1);
		expect(picker.elements[0]).toMatchObject({
			action_id: "period",
			label: "Period",
			initial_value: "p:abcd1234:30-days",
		});
		expect(at(page, (b) => b === picker)).toBe(at(page, header("Results")) + 1);
		expect(contexts(page)).toContain("17 Sep to 16 Oct, compared with the 30 days before.");
		// The Results tab opens on the same period.
		const list = await call(busy(), { type: "page_load", page: "/" });
		expect(words(list)).toContain('"initial_value":"r:30-days"');
	});

	it("shows two tiles, the chart with its own line, how often it was seen and closed", async () => {
		const page = await open(busy());
		expect(tiles(page)).toEqual([
			{ label: "Sign-ups", value: "96", description: "up from 35", trend: "up" },
			{ label: "Rate", value: "4%", description: "no change from 4%", trend: "neutral" },
		]);
		const chart = at(page, (b) => b.type === "chart");
		expect(page.blocks[chart - 1]).toEqual({ type: "context", text: "Sign-ups per day" });
		expect(page.blocks[chart + 1]).toEqual({
			type: "context",
			text: "Seen 2,484 times (up from 967); closed 745 times without signing up. Rate shows from 100 views.",
		});
		const row = page.blocks[chart + 2] as Extract<Block, { type: "actions" }>;
		expect(row.elements).toMatchObject([
			{ type: "button", label: "Compare popups", value: "numbers:30-days", style: "secondary" },
			{ type: "link", label: "Download CSV", appearance: "secondary" },
		]);
		expect(words([row])).toMatch(/export\?from=2026-09-17&to=2026-10-16&popup=abcd1234/);
	});

	it("draws a short bar chart whose day labels never crowd a phone", async () => {
		const page = await open(busy());
		const chart = page.blocks.find((b) => b.type === "chart") as Extract<Block, { type: "chart" }>;
		expect(chart.config).toMatchObject({ chart_type: "custom", height: 140 });
		const options = (chart.config as { options: Record<string, any> }).options;
		const labels = options.xAxis.data as string[];
		expect(labels).toHaveLength(30);
		expect(labels[0]).toBe("17 Sep");
		expect(labels.at(-1)).toBe("16 Oct");
		// At most five labels show: every (interval + 1)th.
		const shown = labels.filter((_, i) => i % (options.xAxis.axisLabel.interval + 1) === 0);
		expect(shown.length).toBeLessThanOrEqual(5);
		expect(options.xAxis.axisLabel.hideOverlap).toBe(true);
		expect(options.series).toHaveLength(1);
		expect(options.series[0]).toMatchObject({ type: "bar", name: "Sign-ups per day" });
		expect(options.series[0].data[labels.indexOf("3 Oct")]).toBe(60);
		// Nothing a sanitiser strips: no formatter functions.
		expect(JSON.stringify(options)).not.toContain("formatter");
		// A long period: a bar a week, still five labels at most.
		const long = await press(busy(), "period", "p:abcd1234:start");
		const weekly = (
			long.blocks.find((b) => b.type === "chart") as Extract<Block, { type: "chart" }>
		).config as { options: Record<string, any> };
		const n = weekly.options.xAxis.data.length;
		expect(Math.ceil(n / (weekly.options.xAxis.axisLabel.interval + 1))).toBeLessThanOrEqual(5);
		expect(contexts(long)).toContain("Sign-ups per week");
	});

	it("says Button clicks for a top bar, and never closed for a bar or a box in a page", async () => {
		for (const kind of ["bar", "inline"] as const) {
			const fake = fakeContext({ popups: { popups: [popup({ kind })] } });
			fake.rows.set("a", count("abcd1234", "2026-10-03", 150, { clicked: 6, closed: 9 }));
			const page = await open(fake);
			expect(tiles(page).map((t) => t.label)).toEqual(["Button clicks", "Rate"]);
			expect(contexts(page)).toContain("Seen 150 times. Rate shows from 100 views.");
			expect(words(page)).not.toMatch(/closed \d/);
		}
	});
});

describe("its Edit form", () => {
	it("is one form, in the order words, when and where, dates, with short labels and no Turn it on", async () => {
		const page = await open(fakeContext({ popups: { popups: [popup({ ...FORM })] } }));
		const edit = at(page, header("Edit"));
		expect(page.blocks[edit + 1]).toEqual({
			type: "context",
			text: "Change what you need, then press Save changes at the bottom.",
		});
		expect(page.blocks[edit + 2]!.type).toBe("form");
		expect(page.blocks.filter((b) => b.type === "form")).toHaveLength(1);
		const ids = fieldIds(page);
		expect(ids).not.toContain("on");
		expect(words(page)).not.toContain("Turn it on");
		expect(ids.indexOf("decline")).toBeLessThan(ids.indexOf("trigger"));
		expect(ids.indexOf("again")).toBeLessThan(ids.indexOf("start_date"));
		const label = (id: string) => field(page, id)?.label;
		expect(label("picture")).toBe("Picture (optional)");
		expect(label("decline")).toBe("Words to say no");
		expect(label("thanks")).toBe("Thank-you heading");
		expect(label("exclude")).toBe("Never on these pages (one per line)");
		expect(label("start_date")).toBe("Starts on (empty: now)");
		expect(label("start_time")).toBe("Start time (UTC)");
		expect(label("end_date")).toBe("Ends on (empty: keeps going)");
		expect(label("end_time")).toBe("End time (UTC)");
		expect(contexts(page)).toContain(
			"Changes reach visitors within a few minutes. Preview shows what was last saved.",
		);
		// The site's own zone is named, not a separate line about it.
		expect(words(page)).not.toContain("your site's time zone");
	});

	it("keeps a popup on or off when Save changes arrives without the switch", async () => {
		const fake = fakeContext({
			popups: { popups: [popup(), popup({ id: "off00001", handle: "off", on: false })] },
		});
		for (const [id, on] of [
			["abcd1234", true],
			["off00001", false],
		] as const) {
			const page = await open(fake, id);
			await submit(fake, "save_all", form(page).block_id!, { heading: "New words" });
			expect(stored(fake).popups.find((p) => p.id === id)).toMatchObject({
				heading: "New words",
				on,
			});
		}
	});

	it("puts the click instructions under the form", async () => {
		const page = await open(fakeContext({ popups: { popups: [popup({ trigger: "click" })] } }));
		const code = at(page, (b) => b.type === "code");
		expect(code).toBeGreaterThan(at(page, (b) => b.type === "form"));
		expect(code).toBeLessThan(at(page, (b) => words([b]).includes("Delete popup")));
		expect(words(page)).toContain("/#popup-monthly-letter");
	});
});

describe("its actions stay on the page", () => {
	it("Turn off stays on the popup's page and keeps the form's id, so typing is not lost", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const before = form(await open(fake)).block_id;
		const off = await press(fake, "row", "toggle:abcd1234");
		expect(stored(fake).popups[0]!.on).toBe(false);
		expect(off.toast).toMatchObject({ type: "success" });
		expect(off.blocks.some((b) => b.type === "tab")).toBe(false);
		expect(off.blocks[1]).toEqual({ type: "header", text: "Monthly letter" });
		expect(off.blocks[2]).toMatchObject({ accessory: { label: "Turn on" } });
		expect(form(off).block_id).toBe(before);
	});

	it("Duplicate stays on the popup's page, with the copy turned off", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const out = await press(fake, "row_more", "duplicate:abcd1234");
		expect(out.toast?.message).toBe('Made "Monthly letter (copy)", turned off.');
		expect(out.blocks[1]).toEqual({ type: "header", text: "Monthly letter" });
		expect(stored(fake).popups).toHaveLength(2);
	});

	it("Duplicate still offers the site's forms as a list", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								items: [{ id: "f1", name: "Newsletter", slug: "newsletter", status: "active" }],
							},
						}),
					),
			),
		);
		const fake = fakeContext({ popups: { popups: [popup({ ...FORM })] } });
		const out = await press(fake, "row_more", "duplicate:abcd1234");
		expect(field(out, "form")?.type).toBe("select");
	});

	it("Change name or kind opens its screen from More, and comes back to the popup's page", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const kind = await press(fake, "row_more", "kind:abcd1234");
		const s1 = kind.blocks.find((b) => b.type === "form") as Extract<Block, { type: "form" }>;
		expect(s1.submit.action_id).toBe("save_s1");
		const back = await submit(fake, "save_s1", s1.block_id!, { name: "Letter", kind: "slide" });
		expect(back.blocks[1]).toEqual({ type: "header", text: "Letter" });
		expect(words(await press(fake, "row_more", "kind:abcd1234", EDITOR))).toContain(
			"Only an administrator",
		);
	});

	it("Delete is a danger button at the foot that asks first, and returns to the list", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const page = await open(fake);
		const row = actionsWith(page, "Delete popup")!;
		expect(row.elements).toEqual([
			{
				type: "button",
				action_id: "row",
				label: "Delete popup",
				value: "delete:abcd1234",
				style: "danger",
				confirm: {
					title: 'Delete "Monthly letter"?',
					text: "Its results stay under Results, as Deleted popups. This cannot be undone.",
					confirm: "Delete",
					deny: "Keep it",
					style: "danger",
				},
			},
		]);
		expect(page.blocks[at(page, (b) => b === row) - 1]).toEqual({ type: "divider" });
		// No Delete in More any more: a menu item cannot ask first.
		expect(words([actionsWith(page, "row_more")!])).not.toContain("delete:");
		const gone = await press(fake, "row", "delete:abcd1234");
		expect(gone.toast?.message).toContain('Deleted "Monthly letter".');
		expect(gone.blocks.some((b) => b.type === "tab")).toBe(true);
		expect(stored(fake).popups).toHaveLength(0);
	});
});

describe("an Editor's view", () => {
	it("keeps Turn off and Preview, says where and when it shows, and has no More, Delete or places", async () => {
		const fake = fakeContext({
			popups: { popups: [popup({ ...FORM, exclude: ["/contact"] })] },
		});
		const page = await open(fake, "abcd1234", EDITOR);
		expect(page.blocks[2]).toMatchObject({
			type: "section",
			accessory: { label: "Turn off", value: "toggle:abcd1234" },
		});
		expect(page.blocks[3]).toEqual({
			type: "context",
			text: "It shows on Every page, except /contact; on phones and computers; after they have read a while, from their second page. Only an administrator can change where and when.",
		});
		expect(words(page)).toContain('"label":"Preview on your site"');
		expect(words(page)).not.toContain("row_more");
		expect(words(page)).not.toContain("Delete popup");
		expect(words(page)).not.toContain("delete:");
		const ids = fieldIds(page);
		for (const id of ["contains", "form", "where", "trigger", "devices", "exclude", "on"])
			expect(ids).not.toContain(id);
		expect(ids).toContain("heading");
		expect(ids).toContain("start_date");
		expect(page.blocks.some((b) => b.block_id === HELP_LINE)).toBe(false);
	});
});

describe("each kind", () => {
	it("a top bar has no picture or form, and its status names where", async () => {
		const page = await open(fakeContext({ popups: { popups: [popup({ kind: "bar" })] } }));
		expect(page.blocks[2]).toMatchObject({ text: "On · Top bar · every page" });
		const ids = fieldIds(page);
		expect(ids).not.toContain("picture");
		expect(ids).not.toContain("contains");
		expect(ids).toContain("where");
	});

	it("a box in a page shows where it is placed and has no Where", async () => {
		const page = await open(fakeContext({ popups: { popups: [popup({ kind: "inline" })] } }));
		expect(page.blocks[2]).toMatchObject({ text: "On · Box in a page · where it is placed" });
		const ids = fieldIds(page);
		expect(ids).not.toContain("where");
		expect(ids).not.toContain("decline");
		expect(ids).toContain("picture");
	});

	it("a popup set for pages under an address says so", async () => {
		const page = await open(
			fakeContext({
				popups: {
					popups: [
						popup({ kind: "slide", where: "prefix", prefixes: ["/cakes/"], trigger: "exit" }),
					],
				},
			}),
		);
		expect(page.blocks[2]).toMatchObject({
			text: "On · Slide-in · pages under /cakes/, when they are about to leave",
		});
	});
});
