// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { DARK, styles } from "../src/client/css.js";
import { COLOUR_OPTIONS, COLOUR_SETS } from "../src/colour-sets.js";
import {
	buttonText,
	colorProblems,
	contrast,
	normalizeSettings,
	normalizeStore,
	type Store,
} from "../src/config.js";
import { clientConfig, pageFragments } from "../src/fragment.js";
import { createPlugin } from "../src/index.js";
import { fakeContext, popup, type FakeContext } from "./helpers.js";

const ADMIN = 50;
const EDITOR = 40;
const OWN = { background: "#fbf8f3", text: "#2b2420", accent: "#8a3b12" };

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
const settingsPage = (fake: FakeContext, role = ADMIN) =>
	call(fake, { type: "page_load", page: "/" }, role);
const saveLook = (fake: FakeContext, values: Record<string, unknown>, role = ADMIN) =>
	call(fake, { type: "form_submit", action_id: "save_look", block_id: "look", values }, role);
const stored = (fake: FakeContext): Store => normalizeStore(fake.kv.get("popups"));

function lookForm(response: BlockResponse) {
	const flat = (blocks: Block[]): Block[] =>
		blocks.flatMap((block) =>
			block.type === "tab"
				? [block, ...block.panels.flatMap((panel) => flat(panel.blocks))]
				: [block],
		);
	return flat(response.blocks).find(
		(block) => block.type === "form" && block.submit.action_id === "save_look",
	) as Extract<Block, { type: "form" }> | undefined;
}

describe("the shared colour sets", () => {
	it("are the same file in Popups and in Analytics & Cookies, so the popups and banner match", () => {
		const here = readFileSync(new URL("../src/colour-sets.ts", import.meta.url), "utf8");
		const there = readFileSync(
			new URL("../../plugin-analytics/src/colour-sets.ts", import.meta.url),
			"utf8",
		);
		expect(there).toBe(here);
	});

	for (const set of COLOUR_SETS) {
		for (const look of ["light", "dark"] as const) {
			it(`"${set.label}" reads well in ${look} mode`, () => {
				const colours = set[look];
				// The same rules the owner's own colours must pass: text, and the button's words.
				expect(colorProblems(colours)).toEqual([]);
				expect(contrast(colours.background, colours.text)).toBeGreaterThanOrEqual(4.5);
				expect(contrast(colours.accent, buttonText(colours.accent))).toBeGreaterThanOrEqual(4.5);
			});
		}
	}
});

describe("the colours choice is stored", () => {
	it("as the theme's colours on a new site, or one where the switch was off", () => {
		expect(normalizeSettings({}).colourSet).toBe("theme");
		expect(normalizeSettings({ custom: false, colors: OWN }).colourSet).toBe("theme");
	});

	it("as My own colours where the switch was on, so nothing changes", () => {
		expect(normalizeSettings({ custom: true, colors: OWN }).colourSet).toBe("own");
	});

	it("as saved, or the fallback for a choice that is not on the list", () => {
		expect(normalizeSettings({ colourSet: "white-blue", custom: true }).colourSet).toBe(
			"white-blue",
		);
		expect(normalizeSettings({ colourSet: "purple", custom: true }).colourSet).toBe("own");
		expect(normalizeSettings({ colourSet: "purple" }).colourSet).toBe("theme");
	});
});

describe("what the browser is told", () => {
	const config = (settings: Record<string, unknown>) =>
		clientConfig(normalizeSettings(settings), [], "popups");

	it("no colours for the theme's colours, even with the old ones still stored", () => {
		expect(config({}).col).toBeUndefined();
		expect(config({ colourSet: "theme", custom: true, colors: OWN }).col).toBeUndefined();
	});

	it("a set's light and dark colours, with readable button words", () => {
		const out = config({ colourSet: "cream-brown", custom: true, colors: OWN });
		expect(out.col).toEqual({ g: "#fbf7f0", f: "#2b2420", x: "#8a3b12", y: "#ffffff" });
		expect(out.colDark).toEqual({ g: "#2a2420", f: "#f5ede3", x: "#e0a872", y: "#141414" });
	});

	it("the owner's own colours as before, the same in light and dark", () => {
		const out = config({ colourSet: "own", colors: OWN });
		expect(out.col).toEqual({ g: "#fbf8f3", f: "#2b2420", x: "#8a3b12", y: "#ffffff" });
		expect(out.colDark).toBeUndefined();
		expect(config({ custom: true, colors: OWN }).col).toEqual(out.col);
	});
});

describe("the stylesheet", () => {
	const light = { g: "#fbf7f0", f: "#2b2420", x: "#8a3b12", y: "#ffffff" };
	const dark = { g: "#2a2420", f: "#f5ede3", x: "#e0a872", y: "#141414" };

	it("uses a set's light colours, its dark ones, or each on the matching device", () => {
		const always = styles("light", light, dark);
		expect(always).toContain("--g:#fbf7f0");
		expect(always).not.toContain("--g:#2a2420");
		const night = styles("dark", light, dark);
		expect(night).toContain("--g:#2a2420");
		expect(night).not.toContain("--g:#fbf7f0");
		const auto = styles("auto", light, dark);
		expect(auto).toContain("--g:#fbf7f0");
		expect(auto).toContain("@media(prefers-color-scheme:dark){:host{--g:#2a2420");
		expect(auto).not.toContain(DARK);
	});

	it("keeps the owner's single set of colours on every device, as before", () => {
		for (const scheme of ["auto", "light", "dark"] as const) {
			const css = styles(scheme, light);
			expect(css).toContain("--g:#fbf7f0");
			expect(css).not.toContain("prefers-color-scheme");
		}
	});

	it("puts a set's colours into the top bar's server HTML, and keeps the script small", () => {
		const store = normalizeStore({
			popups: [popup({ id: "bar00001", kind: "bar" }), popup({ id: "mod00001" })],
			settings: { colourSet: "grey-green" },
		});
		const out = pageFragments(store, "popups", page("/"), Date.UTC(2026, 9, 16, 12));
		const html = (out[1] as { html: string }).html;
		expect(html).toContain("--g:#f2f3f2");
		expect(html).toContain("@media(prefers-color-scheme:dark){:host{--g:#1c211e");
		const code = (out[0] as { code: string }).code;
		expect(code).toContain('"colDark":{"g":"#1c211e"');
		expect(gzipSync(code).length).toBeLessThan(9 * 1024);
	});
});

function page(path: string) {
	return { path, url: `https://hartleys.test${path}`, editMode: false, preview: false };
}

describe("the colours choice in Settings", () => {
	it("offers the theme's colours, the shared sets and My own colours, which alone shows the colour boxes", async () => {
		const form = lookForm(await settingsPage(fakeContext()))!;
		const ids = form.fields.map((field) => field.action_id);
		expect(ids).toEqual(["scheme", "colour_set", "background", "text", "accent", "corner"]);
		const choice = form.fields[1]!;
		expect(choice).toMatchObject({ type: "radio", label: "Colours", initial_value: "theme" });
		expect(choice.type === "radio" && choice.options).toEqual(COLOUR_OPTIONS);
		for (const field of form.fields.slice(2, 5)) {
			expect(field.condition).toEqual({ field: "colour_set", eq: "own" });
		}
	});

	it("shows My own colours where the old switch was on", async () => {
		const fake = fakeContext({ popups: { popups: [], settings: { custom: true, colors: OWN } } });
		const form = lookForm(await settingsPage(fake))!;
		expect(form.fields[1]).toMatchObject({ initial_value: "own" });
		expect(form.fields[2]).toMatchObject({ initial_value: "#fbf8f3" });
	});

	it("saves a set, keeps the stored colours, and turns the old switch off for older versions", async () => {
		const fake = fakeContext({ popups: { popups: [], settings: { custom: true, colors: OWN } } });
		const response = await saveLook(fake, {
			colour_set: "pink-plum",
			// Hidden boxes are still sent; under a set they are neither checked nor saved.
			background: "#ffffff",
			text: "#eeeeee",
			accent: "nope",
		});
		expect(response.toast?.type).toBe("success");
		expect(stored(fake).settings).toMatchObject({
			colourSet: "pink-plum",
			custom: false,
			colors: OWN,
		});
		await saveLook(fake, { colour_set: "own" });
		expect(stored(fake).settings).toMatchObject({ colourSet: "own", custom: true, colors: OWN });
	});

	it("checks My own colours as before", async () => {
		const fake = fakeContext();
		const response = await saveLook(fake, {
			colour_set: "own",
			background: "#ffffff",
			text: "#dddddd",
			accent: "#8a3b12",
		});
		expect(response.toast?.type).toBe("error");
		expect(JSON.stringify(response)).toContain("hard to read");
		expect(stored(fake).settings.colourSet).toBe("theme");
	});

	it("cannot be changed by an editor, who never sees it", async () => {
		const fake = fakeContext();
		const response = await saveLook(fake, { colour_set: "dark-gold" }, EDITOR);
		expect(response.toast?.type).toBe("error");
		expect(stored(fake).settings.colourSet).toBe("theme");
		expect(lookForm(await settingsPage(fake, EDITOR))).toBeUndefined();
	});
});
