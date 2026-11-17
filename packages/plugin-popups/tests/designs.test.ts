// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// @vitest-environment happy-dom

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { RouteContext } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { boot, VISIT_KEY } from "../src/client/boot.js";
import { CSS } from "../src/client/css.js";
import {
	DECLINE_LABEL,
	MAX_LABEL,
	MAX_NOTE,
	normalizePopup,
	normalizeSettings,
	normalizeStore,
	type Popup,
} from "../src/config.js";
import { clientConfig, clientItem, contentPrint } from "../src/fragment.js";
import { createPlugin } from "../src/index.js";
import { fakeContext, popup, type FakeContext } from "./helpers.js";

/**
 * The "Picture on top" design, the label, the note, the highlighted words and the
 * new closing words: what is stored, what reaches the page, what is refused.
 */

const PICTURE = {
	id: "m1",
	url: "/_emdash/api/media/file/bee.png",
	alt: "A bee on a phone",
	width: 900,
	height: 580,
};

const REPORT: Partial<Popup> = {
	design: "top",
	picture: PICTURE,
	label: "Free Revenue Report",
	heading: "Check How Much Revenue Your Salon Is Losing to Missed Calls",
	highlight: "Losing to Missed Calls",
	text: "Get your free report and uncover lost revenue.",
	buttonLabel: "See What I'm Losing",
	note: "Takes less than 30 seconds",
	decline: "not-interested",
};

describe("what is stored", () => {
	it("keeps today's look for popups saved before, and cleans the new fields", () => {
		const old = popup();
		expect(old).toMatchObject({ design: "plain", panel: "", label: "", note: "", highlight: "" });
		const p = popup({
			...REPORT,
			label: "x".repeat(50),
			note: "y".repeat(90),
			panel: "#FC3",
		} as Partial<Popup>);
		expect(p.label).toHaveLength(MAX_LABEL);
		expect(p.note).toHaveLength(MAX_NOTE);
		expect(p.panel).toBe("#ffcc33");
		expect(p.design).toBe("top");
		expect(p.decline).toBe("not-interested");
		expect(DECLINE_LABEL["not-interested"]).toBe("Thanks, I'm not interested");
		// A top bar has one look; a design it cannot draw falls back to Plain.
		expect(popup({ ...REPORT, kind: "bar" }).design).toBe("plain");
		expect(normalizePopup({ ...popup(), design: "wild" })!.design).toBe("plain");
		// Highlighted words that are no longer in the heading are dropped, never drawn.
		expect(popup({ highlight: "not there" }).highlight).toBe("");
		expect(popup({ panel: "red" }).panel).toBe("");
	});
});

describe("what reaches the page", () => {
	it("leaves the page's data for an existing popup exactly as it was", () => {
		// Pinned before this release: a close or a click stays remembered after the update.
		expect(contentPrint(popup())).toBe("ikrp4y");
		expect(contentPrint(popup({ kind: "bar", start: 5 }))).toBe("1n71mpn");
		const c = clientItem(popup({ picture: PICTURE }), "")!.c;
		expect(Object.keys(c).toSorted()).toEqual(["b", "h", "img", "no", "x"]);
	});

	it("counts the label and the note as words, the design and highlight as looks", () => {
		const same = contentPrint(popup());
		expect(contentPrint(popup({ label: "New" }))).not.toBe(same);
		expect(contentPrint(popup({ note: "Quick" }))).not.toBe(same);
		expect(contentPrint(popup({ design: "top", picture: null, panel: "#ffcc33" }))).toBe(same);
		expect(contentPrint(popup({ highlight: "once a month" }))).toBe(same);
	});

	it("sends the design only with a picture, the panel colour, and the new words", () => {
		const c = clientItem(popup(REPORT), "")!.c;
		expect(c).toMatchObject({
			ds: 1,
			lb: "Free Revenue Report",
			nt: "Takes less than 30 seconds",
			hl: "Losing to Missed Calls",
			no: "Thanks, I'm not interested",
		});
		expect(c.pn).toBeUndefined();
		expect(clientItem(popup({ ...REPORT, panel: "#ffcc33" }), "")!.c.pn).toBe("#ffcc33");
		// Picture on top with no picture is drawn Plain, so nobody is stuck with an empty panel.
		expect(clientItem(popup({ ...REPORT, picture: null }), "")!.c.ds).toBeUndefined();
	});

	it("draws highlighted words in the text colour when the chosen colours would make them hard to read", () => {
		const settings = normalizeSettings({
			colourSet: "own",
			colors: { background: "#ffffff", text: "#111111", accent: "#ffe066" },
		});
		const item = clientItem(popup(REPORT), "", settings)!;
		expect(item.c.hl).toBeUndefined();
		const fine = normalizeSettings({
			colourSet: "own",
			colors: { background: "#ffffff", text: "#111111", accent: "#5b21b6" },
		});
		expect(clientItem(popup(REPORT), "", fine)!.c.hl).toBe("Losing to Missed Calls");
	});
});

describe("drawn in the browser", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
		vi.setSystemTime(Date.UTC(2026, 9, 16, 12));
		document.head.innerHTML = "";
		document.body.innerHTML =
			'<h1 style="font-family: Georgia, serif">Rye</h1><a id=a href="#popup-p0">Open</a>';
		localStorage.clear();
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
	});
	afterEach(() => {
		document.querySelector("#popups")?.remove();
		vi.useRealTimers();
	});

	const open = async (raw: Partial<Popup>) => {
		const item = clientItem(popup({ id: "pop00000", handle: "p0", trigger: "click", ...raw }), "")!;
		boot(clientConfig(normalizeSettings({}), [item], "popups"));
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
		document.querySelector<HTMLElement>("#a")!.click();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
		return document.querySelector("#popups")!;
	};

	it("draws Picture on top: the whole picture on its panel, the label, the highlight and the note", async () => {
		const host = await open({ ...REPORT, panel: "#ffcc33" });
		const root = host.shadowRoot!;
		const box = root.querySelector(".pp")!;
		expect(box.classList.contains("top")).toBe(true);
		const panel = root.querySelector<HTMLElement>(".pan")!;
		expect(panel.style.getPropertyValue("--pn")).toBe("#ffcc33");
		expect(panel.querySelector("img")!.getAttribute("src")).toBe(PICTURE.url);
		expect(root.querySelector(".pic")).toBeNull();
		expect(root.querySelector(".lb")!.textContent).toBe("Free Revenue Report");
		const heading = root.querySelector("h2")!;
		expect(heading.textContent).toBe(REPORT.heading);
		expect(heading.querySelector(".hl")!.textContent).toBe("Losing to Missed Calls");
		expect(root.querySelector(".nt")!.textContent).toBe("Takes less than 30 seconds");
		// The note sits under the button, the closing words last.
		const row = [...root.querySelector(".r")!.children].map((el) => el.className);
		expect(row).toEqual(["p", "nt", "q"]);
		expect(root.querySelector(".q")!.textContent).toBe("Thanks, I'm not interested");
		// The close button stays visible over the panel.
		expect(root.querySelector(".x")!.classList.contains("on-pic")).toBe(true);
	});

	it("draws Plain as today, with any label and note, and escapes every word", async () => {
		const host = await open({
			heading: "Fresh <b>bread</b>",
			highlight: "<b>bread</b>",
			label: "New & warm",
			note: "<i>soon</i>",
		});
		const root = host.shadowRoot!;
		expect(root.querySelector(".pp")!.classList.contains("top")).toBe(false);
		expect(root.querySelector("h2 b")).toBeNull();
		expect(root.querySelector("h2 .hl")!.textContent).toBe("<b>bread</b>");
		expect(root.querySelector(".lb")!.textContent).toBe("New & warm");
		expect(root.querySelector(".nt i")).toBeNull();
	});

	it("uses the page's own fonts: the body's for text, the page heading's for the heading", async () => {
		const host = (await open({})) as HTMLElement;
		expect(host.style.getPropertyValue("--ph")).toContain("Georgia");
		// No fixed font: the text takes the page's own, unless a theme sets --popups-font.
		expect(CSS).not.toContain("system-ui");
		expect(CSS).toContain(
			"var(--popups-heading-font,var(--cookie-consent-heading-font,var(--ph)))",
		);
	});
});

// ── Saving on the admin page ────────────────────────────────

const ADMIN = 50;
const EDITOR = 40;

async function save(fake: FakeContext, values: Record<string, unknown>, role = ADMIN) {
	const handler = createPlugin().routes.admin!.handler;
	return (await handler({
		...fake.ctx,
		request: new Request("https://hartleys.test/_emdash/api/plugins/popups/admin"),
		input: { type: "form_submit", action_id: "save_s2", block_id: "s2:abcd1234:x", values },
		user: { id: "u1", role },
	} as unknown as RouteContext)) as BlockResponse;
}
const stored = (fake: FakeContext) => normalizeStore(fake.kv.get("popups")).popups[0]!;
const errors = (r: BlockResponse) =>
	r.blocks
		.filter((b: Block) => b.type === "banner")
		.map((b) => (b as { description?: string }).description ?? "")
		.join(" ");

describe("saving what it says", () => {
	it("offers the new fields: words to everyone, the design and panel to Admins", async () => {
		const fake = fakeContext({ popups: { popups: [popup({ step: 1 })] } });
		const handler = createPlugin().routes.admin!.handler;
		const page = (role: number) =>
			handler({
				...fake.ctx,
				request: new Request("https://hartleys.test/x"),
				input: { type: "block_action", action_id: "row", value: "change:abcd1234" },
				user: { id: "u1", role },
			} as unknown as RouteContext) as Promise<BlockResponse>;
		const ids = (r: BlockResponse) =>
			[...JSON.stringify(r.blocks).matchAll(/"action_id":"([a-z_]+)"/g)].map((m) => m[1]);
		const asAdmin = ids(await page(ADMIN));
		expect(asAdmin).toEqual(
			expect.arrayContaining(["label", "highlight", "note", "design", "panel"]),
		);
		const asEditor = ids(await page(EDITOR));
		expect(asEditor).toEqual(expect.arrayContaining(["label", "highlight", "note"]));
		expect(asEditor).not.toContain("design");
		expect(asEditor).not.toContain("panel");
		expect(JSON.stringify((await page(ADMIN)).blocks)).toContain("Thanks, I'm not interested");
	});

	it("saves the design, panel, label, note and highlight", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		await save(fake, {
			heading: REPORT.heading,
			label: REPORT.label,
			note: REPORT.note,
			highlight: REPORT.highlight,
			design: "top",
			panel: "#ffcc33",
			decline: "not-interested",
		});
		expect(stored(fake)).toMatchObject({
			design: "top",
			panel: "#ffcc33",
			label: REPORT.label,
			note: REPORT.note,
			highlight: REPORT.highlight,
			decline: "not-interested",
		});
	});

	it("refuses highlighted words that are not in the heading, a long label or note, and a wrong panel colour", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		const r = await save(fake, { highlight: "free cake" });
		expect(errors(r)).toContain(
			'The words to highlight, "free cake", are not in the heading. Copy them from the heading exactly, or leave the box empty.',
		);
		expect(errors(await save(fake, { label: "x".repeat(31) }))).toContain(
			"The label is 31 letters; keep it to 30.",
		);
		expect(errors(await save(fake, { note: "x".repeat(61) }))).toContain(
			"The note is 61 letters; keep it to 60.",
		);
		expect(errors(await save(fake, { panel: "yellow" }))).toContain(
			"Write the panel colour like #fde68a, or leave it empty to use the button colour.",
		);
		expect(stored(fake)).toMatchObject({ highlight: "", label: "", note: "", panel: "" });
	});

	it("refuses highlighted words the chosen colours would make hard to read", async () => {
		const fake = fakeContext({
			popups: {
				popups: [popup()],
				settings: {
					colourSet: "own",
					colors: { background: "#ffffff", text: "#111111", accent: "#ffe066" },
				},
			},
		});
		expect(errors(await save(fake, { highlight: "once a month" }))).toContain(
			"The highlighted words would be hard to read",
		);
	});

	it("lets an Editor change the label, note and highlight but never the design", async () => {
		const fake = fakeContext({ popups: { popups: [popup()] } });
		await save(
			fake,
			{ label: "New", note: "Quick", highlight: "once a month", design: "top" },
			EDITOR,
		);
		expect(stored(fake)).toMatchObject({
			label: "New",
			note: "Quick",
			highlight: "once a month",
			design: "plain",
		});
	});

	it("serves a box in a page its design and new words", async () => {
		const fake = fakeContext({
			popups: { popups: [popup({ ...REPORT, id: "inl00001", kind: "inline" })] },
		});
		const routes = createPlugin().routes as Record<
			string,
			{ handler: (ctx: RouteContext) => Promise<unknown> }
		>;
		const answer = (await routes.box!.handler({
			...fake.ctx,
			input: { id: "inl00001" },
			request: new Request("https://hartleys.test/x"),
		} as unknown as RouteContext)) as { box: Record<string, unknown> };
		expect(answer.box).toMatchObject({
			design: "top",
			label: REPORT.label,
			note: REPORT.note,
			highlight: REPORT.highlight,
		});
	});
});
