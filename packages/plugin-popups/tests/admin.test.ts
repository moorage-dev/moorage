// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeStore, type Store } from "../src/config.js";
import { HELP_LINE, HIDE_ACTION } from "../src/help-line.js";
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
		const rest = page.blocks.filter((block) => block.block_id !== HELP_LINE);
		expect(JSON.stringify(rest)).not.toMatch(/Moorage|slug|webhook|KV|404/);
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
		const status = own.find((b) => b.type === "section") as Extract<Block, { type: "section" }>;
		expect(status.accessory).toMatchObject({
			type: "button",
			action_id: "row",
			label: "Turn off",
			value: "toggle:abcd1234",
		});
		const more = own.find(
			(b) => b.type === "actions" && JSON.stringify(b).includes("row_more"),
		) as Extract<Block, { type: "actions" }>;
		expect(more.elements.at(-1)).toMatchObject({
			type: "menu",
			label: "More",
			items: [
				{ label: "Change name or kind", value: "kind:abcd1234" },
				{ label: "Duplicate", value: "duplicate:abcd1234" },
			],
		});
		expect(JSON.stringify(own)).toContain('"value":"delete:abcd1234"');
		// Near the top: before Results and Edit.
		expect(own.indexOf(more)).toBeLessThan(
			own.findIndex((b) => b.type === "header" && b.text === "Edit"),
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
		expect(tab.panels.map((p) => p.label)).toEqual(["Popups", "Results"]);
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
		// Only "Box in a page" is called a box, and each kind says where it appears: a popup
		// described as "a box" was picked by someone who wanted a box in a post.
		const kinds = formOf(s1, "save_s1").fields.find((f) => f.action_id === "kind") as unknown as {
			options: Array<{ value: string; label: string }>;
		};
		const kindWords = Object.fromEntries(kinds.options.map((o) => [o.value, o.label]));
		expect(kindWords.modal).toMatch(
			/^Popup: opens by itself over the page, in the middle of the screen/,
		);
		expect(kindWords.slide).toMatch(/^Slide-in: slides in at a bottom corner/);
		expect(kindWords.bar).toMatch(/^Top bar: a thin strip across the top of the page/);
		expect(kindWords.inline).toMatch(
			/^Box in a page: sits inside a page or post, where you place it while editing/,
		);
		for (const kind of ["modal", "slide", "bar"]) expect(kindWords[kind]).not.toMatch(/\bbox\b/i);
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
		const field = formOf(page, "save_all").fields.find((f) => f.action_id === "form");
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
		expect(formOf(typed, "save_all").fields.find((f) => f.action_id === "form")).toMatchObject({
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
		expect(actions).toEqual(["save_all"]);
		expect(formOf(page, "save_all").fields.map((f) => f.action_id)).not.toContain("form");
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
		// The same from the More menu, which has its own id.
		const copy = stored(fake).popups[0]!.id;
		await press(fake, "row_more", `duplicate:${copy}`);
		expect(stored(fake).popups).toHaveLength(2);
		await press(fake, "row_more", `delete:${copy}`);
		expect(stored(fake).popups.map((p) => p.name)).toEqual(["Monthly letter (copy) (copy)"]);
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

describe("the help line", () => {
	const line = (response: BlockResponse) =>
		response.blocks.find((block) => block.type === "actions" && block.block_id === HELP_LINE);
	const stocked = () => fakeContext({ popups: { popups: [popup()] } });

	it("ends every screen an admin sees: the list, a popup and its preview", async () => {
		const fake = stocked();
		const list = await load(fake);
		expect(list.blocks.at(-1)).toEqual({
			type: "actions",
			block_id: HELP_LINE,
			elements: [
				{
					type: "link",
					label: "Help",
					target: {
						kind: "external",
						url: "https://moorage.dev/guides/add-a-popup-or-top-bar-to-emdash",
					},
				},
				{
					type: "link",
					label: "More free plugins",
					target: { kind: "external", url: "https://moorage.dev/plugins" },
				},
				{
					type: "link",
					label: "by Moorage",
					target: { kind: "external", url: "https://moorage.dev" },
				},
			],
		});
		for (const screen of [
			await press(fake, "row", "change:abcd1234"),
			await press(fake, "row", "preview:abcd1234"),
			await press(fake, "new"),
		]) {
			expect(screen.blocks.filter((block) => block.block_id === HELP_LINE)).toHaveLength(1);
			expect(screen.blocks.at(-1)?.block_id).toBe(HELP_LINE);
		}
	});

	it("never shows to an editor, on any screen", async () => {
		const fake = stocked();
		for (const screen of [
			await load(fake, EDITOR),
			await press(fake, "row", "change:abcd1234", EDITOR),
			await press(fake, "row", "preview:abcd1234", EDITOR),
		]) {
			expect(words(screen)).not.toMatch(/moorage/i);
		}
	});

	it("hides with the switch in Settings, keeps it through other saves, and shows again", async () => {
		const fake = stocked();
		// The switch sits in the Settings tab.
		expect(
			all(await load(fake)).some(
				(block) => block.type === "form" && block.submit.action_id === HIDE_ACTION,
			),
		).toBe(true);
		const hidden = await submit(fake, HIDE_ACTION, "help_line_switch_off", {
			hide_help_line: true,
		});
		expect(line(hidden)).toBeUndefined();
		expect(stored(fake).settings.hideHelpLine).toBe(true);
		expect(line(await load(fake))).toBeUndefined();
		expect(line(await press(fake, "row", "change:abcd1234"))).toBeUndefined();

		await submit(fake, "save_look", "look", { scheme: "dark" });
		await submit(fake, "save_emails", "emails", { emails: "a@hartleys.test" });
		await press(fake, "row", "toggle:abcd1234");
		expect(stored(fake).settings.hideHelpLine).toBe(true);
		expect(stored(fake).popups).toHaveLength(1);

		const shown = await submit(fake, HIDE_ACTION, "help_line_switch_on", { hide_help_line: false });
		expect(line(shown)).toBeDefined();
	});

	it("an editor cannot use the switch", async () => {
		const fake = stocked();
		await submit(fake, HIDE_ACTION, "help_line_switch_off", { hide_help_line: true }, EDITOR);
		expect(normalizeStore(fake.kv.get("popups")).settings.hideHelpLine).toBe(false);
	});

	it("shows on a site whose settings were saved before the switch existed", async () => {
		const fake = fakeContext({ popups: { popups: [], settings: { scheme: "dark" } } });
		expect(line(await load(fake))).toBeDefined();
	});
});

describe("Settings", () => {
	it("refuses unreadable colours and wrong email addresses, and saves good ones", async () => {
		const fake = fakeContext();
		expect(
			words(
				await submit(fake, "save_look", "look", {
					colour_set: "own",
					background: "#ffffff",
					text: "#dddddd",
					accent: "#8a3b12",
				}),
			),
		).toContain("hard to read");
		await submit(fake, "save_look", "look", {
			scheme: "dark",
			colour_set: "own",
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

describe("a finished popup's page: one Save", () => {
	const field = (response: BlockResponse, id: string) =>
		formOf(response, "save_all").fields.find((f) => f.action_id === id) as
			| (Record<string, unknown> & { initial_value?: unknown })
			| undefined;
	const banner = (response: BlockResponse) =>
		all(response).find((b) => b.type === "banner" && b.variant === "error") as
			| Extract<Block, { type: "banner" }>
			| undefined;

	it("has one form for what it says, when and where, and dates, and the kind on its own screen", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const page = await press(fake, "row", "change:abcd1234");
		const shown = all(page).filter((b) => b.type === "form") as Array<
			Extract<Block, { type: "form" }>
		>;
		expect(shown.map((f) => f.submit)).toEqual([{ label: "Save changes", action_id: "save_all" }]);
		const ids = shown[0]!.fields.map((f) => f.action_id);
		for (const id of ["heading", "button_url", "trigger", "where", "devices", "start_date"])
			expect(ids).toContain(id);
		// Turn on or off sits beside the name, not in the form.
		expect(ids).not.toContain("on");
		// The kind decides which boxes there are, so it is changed on a screen of its own.
		const kind = await press(fake, "nav", "kind:abcd1234");
		expect(
			(all(kind).filter((b) => b.type === "form") as Array<Extract<Block, { type: "form" }>>).map(
				(f) => f.submit.action_id,
			),
		).toEqual(["save_s1"]);
		expect(words(kind)).toContain("back:abcd1234:4");
		const changed = await submit(fake, "save_s1", formOf(kind, "save_s1").block_id!, {
			name: "Monthly news",
			kind: "slide",
		});
		expect(stored(fake).popups[0]).toMatchObject({ name: "Monthly news", kind: "slide", step: 4 });
		expect(formOf(changed, "save_all")).toBeDefined();
		// A refused name stays on the kind's own screen.
		const noName = await submit(fake, "save_s1", formOf(kind, "save_s1").block_id!, { name: "" });
		expect(words(noName)).toContain("Give it a name");
		expect(formOf(noName, "save_all")).toBeUndefined();
		// Nothing about saving first beside Preview: the line under the one Save says it.
		expect(words(page)).not.toContain("Save your changes first");
		expect(words(page)).toContain("Preview shows what was last saved.");
	});

	it("keeps what was typed when a save is refused, and shows every problem at once", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const page = await press(fake, "row", "change:abcd1234");
		const block = formOf(page, "save_all").block_id!;
		const refused = await submit(fake, "save_all", block, {
			heading: "",
			text: "Typed but not saved",
			button_label: "Order a cake",
			button_url: "/cakes",
			where: "prefix",
			prefixes: "",
			exclude: "/contact",
			start_date: "2026-12-01",
			start_time: "09:00",
			end_date: "2026-11-01",
			end_time: "09:00",
		});
		expect(refused.toast?.type).toBe("error");
		// The same form id: the admin keeps every box as it was typed.
		expect(formOf(refused, "save_all").block_id).toBe(block);
		expect(field(refused, "text")?.initial_value).toBe("Typed but not saved");
		expect(field(refused, "exclude")?.initial_value).toBe("/contact");
		expect(field(refused, "start_date")?.initial_value).toBe("2026-12-01");
		// One banner with the problems of all three parts.
		const errors = all(refused).filter((b) => b.type === "banner" && b.variant === "error");
		expect(errors).toHaveLength(1);
		expect(banner(refused)!.description).toContain("Write a heading.");
		expect(banner(refused)!.description).toContain("Type at least one address");
		expect(banner(refused)!.description).toContain("It must end after it starts.");
		expect(stored(fake).popups[0]).toMatchObject({
			heading: "Fresh from the oven, once a month",
			where: "all",
			exclude: [],
			start: null,
		});
	});

	it("saves everything with one write and shows the saved values after", async () => {
		forms({});
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const page = await press(fake, "row", "change:abcd1234");
		const block = formOf(page, "save_all").block_id!;
		const saved = await submit(fake, "save_all", block, {
			heading: "Open on Boxing Day",
			text: "Ten till two.",
			button_label: "See the hours",
			button_url: "/hours",
			where: "prefix",
			prefixes: "/cakes/",
			devices: "desktop",
			end_date: "2099-12-27",
			end_time: "14:00",
			on: true,
		});
		expect(saved.toast?.type).toBe("success");
		expect(stored(fake).popups[0]).toMatchObject({
			heading: "Open on Boxing Day",
			text: "Ten till two.",
			buttonUrl: "/hours",
			where: "prefix",
			prefixes: ["/cakes/"],
			devices: "desktop",
			end: Date.UTC(2099, 11, 27, 14),
			on: true,
		});
		// A new form id, so the admin draws the saved values.
		expect(formOf(saved, "save_all").block_id).not.toBe(block);
		expect(field(saved, "heading")?.initial_value).toBe("Open on Boxing Day");
		expect(field(saved, "prefixes")?.initial_value).toBe("/cakes/");
		expect(field(saved, "end_date")?.initial_value).toBe("2099-12-27");
	});

	it("still offers the site's forms as a list after a save or a refusal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.endsWith("/forms/list")
					? new Response(
							JSON.stringify({
								data: {
									items: [{ id: "f1", name: "Newsletter", slug: "newsletter", status: "active" }],
								},
							}),
						)
					: new Response(
							JSON.stringify({
								success: true,
								data: { name: "Newsletter", pages: [], settings: { spamProtection: "honeypot" } },
							}),
						),
			),
		);
		const fake = fakeContext({
			popups: { popups: [popup({ contains: "form", form: "newsletter" })] },
		});
		const page = await press(fake, "row", "change:abcd1234");
		const block = formOf(page, "save_all").block_id!;
		const refused = await submit(fake, "save_all", block, { heading: "" });
		expect(field(refused, "form")?.type).toBe("select");
		const saved = await submit(fake, "save_all", block, { heading: "Hello", form: "newsletter" });
		expect(saved.toast?.type).toBe("success");
		expect(field(saved, "form")?.type).toBe("select");
	});

	it("lets an Editor save words and dates but never changes when and where", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const page = await press(fake, "row", "change:abcd1234", EDITOR);
		const ids = formOf(page, "save_all").fields.map((f) => f.action_id);
		expect(ids).toContain("heading");
		expect(ids).toContain("end_date");
		expect(ids).not.toContain("where");
		expect(words(page)).not.toContain("kind:abcd1234");
		const saved = await submit(
			fake,
			"save_all",
			formOf(page, "save_all").block_id!,
			{
				heading: "New words",
				where: "prefix",
				prefixes: "/x/",
				devices: "phone",
				trigger: "exit",
				end_date: "2099-12-27",
				end_time: "14:00",
			},
			EDITOR,
		);
		expect(saved.toast?.type).toBe("success");
		expect(stored(fake).popups[0]).toMatchObject({
			heading: "New words",
			end: Date.UTC(2099, 11, 27, 14),
			where: "all",
			prefixes: [],
			devices: "all",
			trigger: "read",
		});
		// An empty address list would be refused for an Admin; an Editor's is simply ignored.
		const again = await submit(
			fake,
			"save_all",
			formOf(saved, "save_all").block_id!,
			{ heading: "Newer words", where: "prefix", prefixes: "" },
			EDITOR,
		);
		expect(again.toast?.type).toBe("success");
		expect(stored(fake).popups[0]).toMatchObject({ heading: "Newer words", where: "all" });
		// And the kind's own screen refuses an Editor.
		expect(words(await press(fake, "nav", "kind:abcd1234", EDITOR))).toContain(
			"Only an administrator",
		);
	});
});

describe("fits a phone, and React can tell every control apart", () => {
	// Every screen an Admin or Editor can reach, for each kind, finished or half made.
	async function screens(): Promise<BlockResponse[]> {
		const kinds = ["bar", "slide", "modal", "inline"] as const;
		const popups = kinds.flatMap((kind, i) => [
			popup({ id: `done000${i}`, handle: `done-${kind}`, kind }),
			popup({ id: `half000${i}`, handle: `half-${kind}`, kind, step: 1, on: false }),
		]);
		const fake = fakeContext({ popups: { popups } });
		const out: BlockResponse[] = [await press(fake, "new")];
		for (const role of [ADMIN, EDITOR]) {
			out.push(await load(fake, role), await press(fake, "nav", "numbers", role));
			for (const p of popups) {
				out.push(await press(fake, "row", `change:${p.id}`, role));
				out.push(await press(fake, "row", `preview:${p.id}`, role));
				for (const step of [1, 2, 3, 4])
					out.push(await press(fake, "nav", `back:${p.id}:${step}`, role));
			}
		}
		out.push(await press(fake, "nav", "kind:done0001"));
		return out;
	}

	const ids = (elements: Array<Record<string, unknown>>) =>
		elements.map((e) => e.action_id).filter((id): id is string => typeof id === "string");

	it("gives each button, menu and field in one actions block or form its own id", async () => {
		let checked = 0;
		for (const response of await screens()) {
			for (const block of all(response)) {
				const elements =
					block.type === "actions"
						? (block.elements as unknown as Array<Record<string, unknown>>)
						: block.type === "form"
							? (block.fields as unknown as Array<Record<string, unknown>>)
							: null;
				if (!elements) continue;
				const own = ids(elements);
				expect(new Set(own).size, JSON.stringify(own)).toBe(own.length);
				if (block.type === "actions" && elements.length > 1) checked++;
			}
		}
		// The popup pages' Preview beside More, at least.
		expect(checked).toBeGreaterThan(0);
	});

	it("keeps the popup page's Turn off and More apart, both going to the same place", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const own = all(await press(fake, "row", "change:abcd1234"));
		const status = own.find((b) => b.type === "section") as Extract<Block, { type: "section" }>;
		expect((status.accessory as { action_id?: string }).action_id).toBe("row");
		const actions = own.find(
			(b) => b.type === "actions" && JSON.stringify(b).includes("duplicate:abcd1234"),
		) as Extract<Block, { type: "actions" }>;
		expect(ids(actions.elements as unknown as Array<Record<string, unknown>>)).toEqual([
			"row_more",
		]);
	});

	it("keeps every dropdown choice we word short enough for a 390 px phone", async () => {
		// A dropdown is as wide as its chosen words (Block Kit 1.3.1), so a long choice runs
		// past a phone's edge; long choices belong in radio buttons, which wrap. Forms are
		// named by the site under Forms, so their dropdown is left out.
		const MAX_OPTION = 40;
		const labels = new Set<string>();
		for (const response of await screens())
			for (const block of all(response))
				if (block.type === "form")
					for (const field of block.fields)
						if (field.type === "select" && field.action_id !== "form")
							for (const o of field.options) labels.add(o.label);
		expect([...labels]).toContain("Only the close button");
		expect([...labels]).toContain("After a month (recommended)");
		expect([...labels].filter((l) => l.length > MAX_OPTION)).toEqual([]);
	});

	it("asks when it opens with choices that wrap, not a dropdown as wide as its words", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const trigger = formOf(await press(fake, "row", "change:abcd1234"), "save_all").fields.find(
			(f) => f.action_id === "trigger",
		);
		expect(trigger?.type).toBe("radio");
	});
});
