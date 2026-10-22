// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeStore, type Store } from "../src/config.js";
import { createPlugin } from "../src/index.js";
import { fakeContext, popup, type FakeContext } from "./helpers.js";

const ADMIN = 50;
const EDITOR = 40;

/** The forms plugin's definition route, as the server's own request reaches it. */
function forms(answer: Record<string, { status: number; body?: unknown }>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: { body?: string }) => {
			// The site's own media API, asked for a picture's public address.
			if (url.includes("/_emdash/api/media/")) {
				return new Response(
					JSON.stringify({ success: true, data: { item: { id: "m1", storageKey: "01ABC.jpg" } } }),
				);
			}
			const { id } = JSON.parse(init.body!) as { id: string };
			const found = answer[id] ?? { status: 404 };
			return new Response(JSON.stringify(found.body ?? {}), { status: found.status });
		}),
	);
}
afterEach(() => vi.unstubAllGlobals());

async function call(fake: FakeContext, input: unknown, role = ADMIN): Promise<BlockResponse> {
	const handler = createPlugin().routes.admin!.handler;
	const response = (await handler({
		...fake.ctx,
		request: new Request("https://hartleys.test/_emdash/api/plugins/popups/admin"),
		input,
		user: { id: "u1", email: "a@hartleys.test", name: null, role, createdAt: "" },
	} as unknown as RouteContext)) as BlockResponse;
	const checked = validateBlockResponse(response, { pluginPagePaths: ["/"] });
	expect(checked.valid, JSON.stringify(checked.errors)).toBe(true);
	return response;
}
const load = (fake: FakeContext, role = ADMIN) =>
	call(fake, { type: "page_load", page: "/" }, role);
const press = (fake: FakeContext, action: string, value?: string, role = ADMIN) =>
	call(fake, { type: "block_action", action_id: action, ...(value ? { value } : {}) }, role);
const submit = (
	fake: FakeContext,
	action: string,
	block: string,
	values: Record<string, unknown>,
	role = ADMIN,
) => call(fake, { type: "form_submit", action_id: action, block_id: block, values }, role);

function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) =>
		block.type === "tab"
			? [block, ...block.panels.flatMap((panel) => flatten(panel.blocks))]
			: block.type === "accordion"
				? [block, ...flatten(block.blocks)]
				: [block],
	);
}
const all = (response: BlockResponse) => flatten(response.blocks);
const words = (response: BlockResponse) => JSON.stringify(response.blocks);
const formOf = (response: BlockResponse, action: string) =>
	all(response).find((b) => b.type === "form" && b.submit.action_id === action) as Extract<
		Block,
		{ type: "form" }
	>;
const stored = (fake: FakeContext): Store => normalizeStore(fake.kv.get("popups"));

describe("the list", () => {
	it("starts empty, says a web person installed it, and offers New popup", async () => {
		const page = await load(fakeContext());
		const empty = all(page).find((b) => b.type === "empty");
		expect(empty).toMatchObject({ title: "No popups yet" });
		expect(words(page)).toContain("Your web person added Popups to this site");
		expect(words(page)).not.toMatch(/Moorage|slug|webhook|KV|404/);
	});

	it("puts the name with its status, then Edit, first, so phones keep them in view", async () => {
		const fake = fakeContext({ popups: { popups: [popup({ end: Date.UTC(2099, 11, 27, 14) })] } });
		const table = all(await load(fake)).find(
			(b) => b.type === "table" && b.block_id === "list",
		) as Extract<Block, { type: "table" }>;
		expect(table.columns.slice(0, 3).map((c) => c.key)).toEqual(["name", "edit", "preview"]);
		expect(table.rows[0]).toMatchObject({
			name: "Monthly letter (Popup) · On until 27 Dec 2099, 14:00",
		});
	});

	it("puts only Edit and Preview on each row, with a status that wraps, so a phone shows them all", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const page = await load(fake);
		const table = all(page).find((b) => b.type === "table" && b.block_id === "list") as Extract<
			Block,
			{ type: "table" }
		>;
		// Plain text with the name, not a badge or a column of its own: "On until 27 Dec 2099, 14:00" is long.
		expect(table.columns.map((c) => [c.key, c.format ?? "text"]).slice(0, 4)).toEqual([
			["name", "text"],
			["edit", "element"],
			["preview", "element"],
			["where", "text"],
		]);
		expect(table.columns.filter((c) => c.format === "element")).toHaveLength(2);
		expect(table.rows[0]).toMatchObject({
			edit: { type: "button", action_id: "row", label: "Edit", value: "change:abcd1234" },
			preview: { type: "button", action_id: "row", label: "Preview", value: "preview:abcd1234" },
		});
		expect(words(page)).not.toContain("toggle:");
		expect(words(page)).not.toContain("▾");
	});

	it("puts Turn off, Duplicate and Delete on the popup's own page, Duplicate and Delete for an Admin only", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const own = all(await press(fake, "row", "change:abcd1234"));
		const actions = own.find(
			(b) => b.type === "actions" && JSON.stringify(b).includes("toggle:abcd1234"),
		) as Extract<Block, { type: "actions" }>;
		expect(actions.elements).toMatchObject([
			{ type: "button", action_id: "row", label: "Turn off", value: "toggle:abcd1234" },
			{
				type: "menu",
				action_id: "row",
				label: "More",
				items: [
					{ label: "Duplicate", value: "duplicate:abcd1234" },
					{ label: "Delete", value: "delete:abcd1234" },
				],
			},
		]);
		// Near the top: before the first section.
		expect(own.indexOf(actions)).toBeLessThan(
			own.findIndex((b) => b.type === "header" && b.text === "1 What kind"),
		);
		const editor = words(await press(fake, "row", "change:abcd1234", EDITOR));
		expect(editor).toContain("toggle:abcd1234");
		expect(editor).not.toContain("delete:");
		// An unfinished popup: no Turn on, but an Admin can still delete it.
		const half = fakeContext({ popups: { popups: [popup({ step: 2, on: false })] } });
		const wizard = words(await press(half, "row", "change:abcd1234"));
		expect(wizard).not.toContain("toggle:");
		expect(wizard).toContain("delete:abcd1234");
	});

	it("shows red only when a popup really cannot open", async () => {
		forms({ cakes: { status: 410 } });
		const fake = fakeContext({
			popups: {
				popups: [
					popup({ contains: "form", form: "newsleter" }),
					popup({ id: "pause001", name: "Cakes", contains: "form", form: "cakes" }),
				],
			},
			problems: { abcd1234: { k: "missing", at: 1 }, pause001: { k: "paused", at: 1 } },
		});
		const banners = all(await load(fake)).filter((b) => b.type === "banner") as Array<
			Extract<Block, { type: "banner" }>
		>;
		expect(banners.map((b) => b.variant)).toEqual(["error", "alert"]);
		expect(banners[0]!.title).toBe(
			'"Monthly letter" cannot open: there is no form called "newsleter" any more',
		);
	});

	it("gives editors no Settings tab and no Duplicate or Delete", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const page = await load(fake, EDITOR);
		const tab = page.blocks.find((b) => b.type === "tab") as Extract<Block, { type: "tab" }>;
		expect(tab.panels.map((p) => p.label)).toEqual(["Popups", "Numbers"]);
		expect(words(page)).not.toContain("delete:");
		expect(words(await press(fake, "row", "delete:abcd1234", EDITOR))).toContain(
			"Only an administrator",
		);
		expect(stored(fake).popups).toHaveLength(1);
	});
});

describe("New popup, four steps", () => {
	it("goes from kind to words to where to dates, saving a draft each time", async () => {
		const fake = fakeContext();
		forms({
			newsletter: {
				status: 200,
				body: {
					success: true,
					data: { name: "Newsletter", pages: [], settings: { spamProtection: "honeypot" } },
				},
			},
		});
		const s1 = await press(fake, "new");
		expect(words(s1)).toContain("1 What kind (now)");
		const refused = await submit(fake, "save_s1", formOf(s1, "save_s1").block_id!, { name: "" });
		expect(words(refused)).toContain("Give it a name");
		const s2 = await submit(fake, "save_s1", formOf(s1, "save_s1").block_id!, {
			name: "Monthly letter",
			kind: "modal",
		});
		const id = stored(fake).popups[0]!.id;
		expect(stored(fake).popups[0]).toMatchObject({ handle: "monthly-letter", step: 1, on: false });
		// The picture is picked from the media library.
		const picture = formOf(s2, "save_s2").fields.find((f) => f.action_id === "picture");
		expect(picture).toMatchObject({
			type: "combobox",
			options: [{ value: "none" }, { value: "m1", label: "loaves-1600.jpg" }],
		});
		// A short label: never the full alt text or an id; and one line of help under the form.
		expect(JSON.stringify(picture)).not.toContain("Three sourdough loaves");
		const help = all(s2)
			.filter((b) => b.type === "context")
			.map((b) => (b as { text: string }).text);
		expect(help.at(-1)).toBe(
			"Pictures come from Media; forms and their thank-you message from Forms.",
		);
		const s3 = await submit(fake, "save_s2", formOf(s2, "save_s2").block_id!, {
			heading: "Fresh from the oven, once a month",
			text: "One email a month.",
			picture: "m1",
			contains: "form",
			form: "newsletter",
			thanks: "Thanks, you're on the list",
		});
		expect(stored(fake).popups[0]!.picture).toMatchObject({
			id: "m1",
			alt: "Three sourdough loaves",
		});
		expect(formOf(s3, "save_s3").fields.map((f) => f.action_id)).toContain("first_page");
		const s4 = await submit(fake, "save_s3", formOf(s3, "save_s3").block_id!, {
			trigger: "click",
			where: "collections",
			collections: ["posts"],
			devices: "all",
			again: "month",
			exclude: "/contact",
		});
		// Instructions for the web person, in a box to copy; never in the owner's path as code.
		const code = all(s4).find((b) => b.type === "code") as Extract<Block, { type: "code" }>;
		// With the leading slash: EmDash's menu refuses a custom link that is only "#...".
		expect(code.code).toContain("link to /#popup-monthly-letter");
		expect(code.code).toContain('data-popup="monthly-letter"');
		const preview = JSON.stringify(all(s4).filter((b) => b.type === "actions"));
		expect(preview).toContain(`https://hartleys.test/?popups_preview=${id}&scheme=dark`);
		expect(words(s4)).toContain("Times are UTC time, your site's time zone.");
		const done = await submit(fake, "save_s4", formOf(s4, "save_s4").block_id!, {
			start_date: "2026-11-01",
			start_time: "09:00",
			end_date: "2026-12-31",
			end_time: "18:00",
			on: true,
		});
		expect(done.toast?.type).toBe("success");
		expect(stored(fake).popups[0]).toMatchObject({
			step: 4,
			on: true,
			start: Date.UTC(2026, 10, 1, 9),
			end: Date.UTC(2026, 11, 31, 18),
			collections: ["posts"],
			exclude: ["/contact"],
			trigger: "click",
		});
	});

	it("offers the site's forms to choose from, and a box to type in when Forms cannot list them", async () => {
		const asked: Array<{ url: string; headers: Headers }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: { headers?: HeadersInit }) => {
				asked.push({ url, headers: new Headers(init.headers) });
				return new Response(
					JSON.stringify({
						data: {
							items: [
								{ id: "f1", name: "Newsletter", slug: "newsletter", status: "active" },
								{ id: "f2", name: "Cake orders", slug: "cakes", status: "paused" },
							],
						},
					}),
				);
			}),
		);
		const fake = fakeContext({
			popups: { popups: [popup({ contains: "form", form: "old-letter" })] },
		});
		const page = await press(fake, "row", "change:abcd1234");
		const field = formOf(page, "save_s2").fields.find((f) => f.action_id === "form");
		expect(field).toMatchObject({
			type: "select",
			label: "Form",
			initial_value: "old-letter",
			options: [
				{ value: "newsletter", label: "Newsletter" },
				{ value: "cakes", label: "Cake orders (paused under Forms)" },
				// A form since deleted under Forms still shows as chosen.
				{ value: "old-letter", label: "old-letter (no longer under Forms)" },
			],
		});
		// Asked as the signed-in person, the way the admin itself asks.
		const list = asked.find((a) => a.url.endsWith("/_emdash/api/plugins/emdash-forms/forms/list"));
		expect(list?.url).toBe("https://hartleys.test/_emdash/api/plugins/emdash-forms/forms/list");
		expect(list?.headers.get("X-EmDash-Request")).toBe("1");
		// The list alone never asks Forms.
		asked.length = 0;
		await load(fake);
		expect(asked).toEqual([]);

		// No Forms plugin, or the list cannot be read: the box to type in.
		forms({});
		const typed = await press(fake, "row", "change:abcd1234");
		expect(formOf(typed, "save_s2").fields.find((f) => f.action_id === "form")).toMatchObject({
			type: "text_input",
			initial_value: "old-letter",
		});
	});

	it("refuses a form that does not exist, or one that cannot work in a popup, the moment it is saved", async () => {
		const fake = fakeContext({ popups: { popups: [popup({ step: 1 })] } });
		forms({
			turnstile: {
				status: 200,
				body: {
					success: true,
					data: { name: "T", pages: [], settings: { spamProtection: "turnstile" } },
				},
			},
			paused: { status: 410 },
		});
		const block = "s2:abcd1234:x";
		const base = { heading: "Hello", contains: "form", thanks: "Thanks" };
		const wrong = await submit(fake, "save_s2", block, { ...base, form: "newsleter" });
		expect(wrong.toast?.type).toBe("error");
		expect(words(wrong)).toContain(
			'There is no form called \\"newsleter\\". Open Forms, copy the short name from the list, and paste it here.',
		);
		// What was typed stays in the box.
		expect(formOf(wrong, "save_s2").fields.find((f) => f.action_id === "form")).toMatchObject({
			initial_value: "newsleter",
		});
		expect(words(await submit(fake, "save_s2", block, { ...base, form: "turnstile" }))).toContain(
			"Cloudflare Turnstile",
		);
		const paused = await submit(fake, "save_s2", block, { ...base, form: "paused" });
		expect(paused.toast?.type).not.toBe("error");
		expect(all(paused).find((b) => b.type === "banner")).toMatchObject({ variant: "alert" });
		expect(stored(fake).popups[0]!.formNote).toBe("paused");
	});

	it("lets a box in a page skip When and where", async () => {
		const fake = fakeContext({ popups: { popups: [popup({ kind: "inline", step: 1 })] } });
		const next = await submit(fake, "save_s2", "s2:abcd1234:x", {
			heading: "Get the Journal",
			contains: "button",
			button_label: "Read",
			button_url: "/journal",
		});
		expect(words(next)).toContain("4 Dates and turn on (now)");
	});

	it("refuses unsafe links and dates that end before they start", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		expect(
			words(
				await submit(fake, "save_s2", "s2:abcd1234:x", {
					heading: "Hi",
					contains: "button",
					button_label: "Go",
					button_url: "javascript:alert(1)",
				}),
			),
		).toContain("The link must be");
		expect(
			words(
				await submit(fake, "save_s4", "s4:abcd1234:x", {
					start_date: "2026-12-01",
					start_time: "09:00",
					end_date: "2026-11-01",
					end_time: "09:00",
				}),
			),
		).toContain("It must end after it starts.");
	});
});

describe("finished popups", () => {
	it("an editor may change words and dates, not the form or where it shows", async () => {
		const fake = fakeContext({
			popups: { popups: [popup({ contains: "form", form: "newsletter" })] },
		});
		const page = await press(fake, "row", "change:abcd1234", EDITOR);
		const actions = all(page)
			.filter((b) => b.type === "form")
			.map((b) => (b as Extract<Block, { type: "form" }>).submit.action_id);
		expect(actions).toEqual(["save_s2", "save_s4"]);
		expect(formOf(page, "save_s2").fields.map((f) => f.action_id)).not.toContain("form");
		await submit(fake, "save_s2", "s2:abcd1234:x", { heading: "New words", form: "other" }, EDITOR);
		expect(stored(fake).popups[0]).toMatchObject({ heading: "New words", form: "newsletter" });
		expect(
			words(await submit(fake, "save_s3", "s3:abcd1234:x", { where: "all" }, EDITOR)),
		).toContain("Only an administrator");
	});

	it("says a change can take a few minutes to reach visitors only when visitors see it", async () => {
		const LATER = "It can take a few minutes to reach visitors.";
		const toast = (response: BlockResponse) => response.toast?.message ?? "";
		const fake = fakeContext({
			popups: { popups: [popup(), popup({ id: "off00001", name: "Quiet", on: false })] },
		});
		// A live popup's words: cached pages keep the old ones for a while.
		expect(
			toast(await submit(fake, "save_s2", "s2:abcd1234:x", { heading: "New words" })),
		).toContain(LATER);
		// A turned-off popup's words: no visitor sees them yet.
		expect(toast(await submit(fake, "save_s2", "s2:off00001:x", { heading: "Hush" }))).toBe(
			"Saved.",
		);
		// The look applies to every live popup.
		expect(toast(await submit(fake, "save_look", "look", { scheme: "dark" }))).toContain(LATER);
		// Alert addresses are never shown to visitors.
		expect(toast(await submit(fake, "save_emails", "emails", { emails: "jo@hartleys.test" }))).toBe(
			"Saved.",
		);
		// Turning off and deleting a live popup take time to leave cached pages too.
		expect(toast(await press(fake, "row", "toggle:abcd1234"))).toContain(LATER);
		await press(fake, "row", "toggle:abcd1234");
		expect(toast(await press(fake, "row", "delete:abcd1234"))).toContain(LATER);
		expect(toast(await press(fake, "row", "delete:off00001"))).not.toContain(LATER);
		// With nothing live, the look reaches no one.
		expect(toast(await submit(fake, "save_look", "look", { scheme: "light" }))).toBe("Saved.");
	});

	it("turns off, duplicates turned off, and deletes", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		await press(fake, "row", "toggle:abcd1234");
		expect(stored(fake).popups[0]!.on).toBe(false);
		await press(fake, "row", "duplicate:abcd1234");
		expect(stored(fake).popups.map((p) => [p.name, p.handle, p.on])).toEqual([
			["Monthly letter", "monthly-letter", false],
			["Monthly letter (copy)", "monthly-letter-copy", false],
		]);
		await press(fake, "row", "delete:abcd1234");
		expect(stored(fake).popups).toHaveLength(1);
	});

	it("shows the preview links from the row's Preview button", async () => {
		const fake = fakeContext({
			popups: { popups: [popup({ where: "prefix", prefixes: ["/journal/"] })] },
		});
		expect(words(await press(fake, "row", "preview:abcd1234"))).toContain(
			"https://hartleys.test/journal/?popups_preview=abcd1234&scheme=light",
		);
	});
});

describe("Numbers and Settings", () => {
	it("shows results since each popup started, a date range and a download", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		fake.rows.set("a", {
			popup: "abcd1234",
			day: "2026-10-03",
			seen: 150,
			sent: 0,
			clicked: 9,
			closed: 40,
			phone: 75,
		});
		fake.rows.set("b", {
			popup: "abcd1234",
			day: "2026-10-05",
			seen: 50,
			sent: 0,
			clicked: 1,
			closed: 10,
			phone: 25,
		});
		const page = await load(fake);
		const table = all(page).find((b) => b.type === "table" && b.block_id === "numbers") as Extract<
			Block,
			{ type: "table" }
		>;
		expect(table.columns.slice(0, 3).map((c) => c.label)).toEqual(["Popup", "Seen", "Responses"]);
		expect(table.rows[0]).toMatchObject({
			seen: "200",
			responses: "10 clicks (5%)",
			phones: "50%",
			since: "3 Oct",
		});
		expect(words(page)).toMatch(
			/https:\/\/hartleys\.test\/_emdash\/api\/plugins\/popups\/export\?expires=\d+&sig=[\w-]{43}/,
		);
		expect(all(page).some((b) => b.type === "chart")).toBe(true);
		const ranged = await submit(fake, "range", "range::", { from: "2026-10-05", to: "" });
		const rows = (
			all(ranged).find((b) => b.type === "table" && b.block_id === "numbers") as Extract<
				Block,
				{ type: "table" }
			>
		).rows;
		expect(rows[0]).toMatchObject({ seen: "50" });
		expect(words(ranged)).toMatch(/export\?from=2026-10-05&expires=\d+&sig=/);
	});

	it("refuses unreadable colours and wrong email addresses, and saves good ones", async () => {
		const fake = fakeContext();
		expect(
			words(
				await submit(fake, "save_look", "look", {
					custom: true,
					background: "#ffffff",
					text: "#dddddd",
					accent: "#8a3b12",
				}),
			),
		).toContain("hard to read");
		await submit(fake, "save_look", "look", {
			scheme: "dark",
			custom: true,
			background: "#fbf8f3",
			text: "#2b2420",
			accent: "#8a3b12",
			corner: "left",
		});
		expect(stored(fake).settings).toMatchObject({
			scheme: "dark",
			corner: "left",
			colors: { accent: "#8a3b12" },
		});
		expect(
			words(
				await submit(fake, "save_emails", "emails", { emails: "jo@hartleys.test\nnot an address" }),
			),
		).toContain("do not look like email addresses: not an address");
		await submit(fake, "save_emails", "emails", { emails: "jo@hartleys.test\nweb@studio.test" });
		expect(stored(fake).settings.emails).toEqual(["jo@hartleys.test", "web@studio.test"]);
	});

	it("says when no email service is set up", async () => {
		expect(words(await load(fakeContext()))).toContain("No email service is set up in EmDash yet");
	});
});
