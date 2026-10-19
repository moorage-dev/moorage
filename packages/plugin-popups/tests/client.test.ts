// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { boot, MEMORY_KEY, VISIT_KEY } from "../src/client/boot.js";
import type { ClientConfig, ClientItem } from "../src/client/types.js";
import type { Popup } from "../src/config.js";
import { normalizeSettings } from "../src/config.js";
import { clientConfig, clientItem } from "../src/fragment.js";
import { popup } from "./helpers.js";

/**
 * The respect rules in a simulated browser. The real-browser proof (sizes,
 * focus, the forms plugin, the cookie banner) is in
 * apps/demo-site/tests/popups.spec.ts; these cover the branches.
 */

type Win = typeof window & {
	happyDOM: { setURL(url: string): void; setInnerWidth?(w: number): void };
};
const win = window as Win;
const DAY = 86_400_000;

function config(...popups: Array<Partial<Popup>>): ClientConfig {
	const items = popups.map((raw, i) =>
		clientItem(popup({ id: `pop${i}0000`, handle: `p${i}`, ...raw }), "")!,
	) as ClientItem[];
	return clientConfig(normalizeSettings({}), items, "popups");
}

const host = () => document.querySelector("#popups");
const shadow = () => host()!.shadowRoot!;
const beacons: string[] = [];

async function ready(): Promise<void> {
	// The clock is fake: let promises settle and due timers run.
	for (let turn = 0; turn < 5; turn++) await vi.advanceTimersByTimeAsync(1);
}

/** Pretend the visitor read far enough, and let the timers run. */
async function readOn(): Promise<void> {
	await vi.advanceTimersByTimeAsync(31_000);
	await ready();
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
	});
	vi.setSystemTime(Date.UTC(2026, 9, 16, 12));
	win.happyDOM.setURL("https://hartleys.test/journal/rye");
	document.head.innerHTML = "";
	document.body.innerHTML = "<h1>Rye</h1><input id=q type=text>";
	document.documentElement.removeAttribute("data-cookie-consent");
	localStorage.clear();
	sessionStorage.clear();
	beacons.length = 0;
	Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
	Object.defineProperty(navigator, "sendBeacon", {
		value: vi.fn((_url: string, blob: Blob) => {
			void blob.text().then((text) => beacons.push(text));
			return true;
		}),
		configurable: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("a popup that opens by itself", () => {
	it("waits for the second page of a visit", async () => {
		boot(config({}));
		await readOn();
		expect(host()).toBeNull();
		document.body.innerHTML = "<h1>Next</h1>";
		boot(config({}));
		await readOn();
		expect(shadow().querySelector("dialog")?.hasAttribute("open")).toBe(true);
		expect(JSON.parse(sessionStorage.getItem(VISIT_KEY)!)).toMatchObject({ s: "pop00000" });
	});

	it("may open on the first page on computers when allowed, never on phones", async () => {
		boot(config({ firstPage: true }));
		await readOn();
		expect(host()).not.toBeNull();
		host()!.remove();
		sessionStorage.clear();
		Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
		boot(config({ firstPage: true }));
		await readOn();
		expect(host()).toBeNull();
	});

	it("opens as a sheet on every phone width, not only the narrowest", async () => {
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		Object.defineProperty(window, "innerWidth", { value: 700, configurable: true });
		boot(config({}));
		await readOn();
		expect(shadow().querySelector("dialog")!.classList.contains("sheet")).toBe(true);
		// The sheet look belongs to the class, not to a narrower media query.
		const css = shadow().querySelector("style")!.textContent!;
		expect(css.split("@media(max-width:600px)")[0]).toContain("dialog.modal.sheet{inset:auto 0 0");
	});

	it("opens at most one per visit, the first in the list", async () => {
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		boot(config({ kind: "slide", heading: "First" }, { kind: "slide", heading: "Second" }));
		await readOn();
		expect(shadow().querySelector("h2")!.textContent).toBe("First");
		host()!.remove();
		boot(config({ kind: "slide", heading: "First" }, { kind: "slide", heading: "Second" }));
		await readOn();
		expect(host()).toBeNull();
	});

	it("never opens while someone is typing, and opens after they leave the field", async () => {
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		boot(config({ kind: "slide" }));
		document.querySelector<HTMLInputElement>("#q")!.focus();
		await readOn();
		expect(host()).toBeNull();
		document.querySelector<HTMLInputElement>("#q")!.blur();
		document.dispatchEvent(new FocusEvent("focusout"));
		vi.advanceTimersByTime(1600);
		await ready();
		expect(host()).not.toBeNull();
	});

	it("waits for the cookie banner, then starts its timer from the answer", async () => {
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		document.documentElement.setAttribute("data-cookie-consent", "asking");
		boot(config({ kind: "slide" }));
		await readOn();
		expect(host()).toBeNull();
		document.documentElement.setAttribute("data-cookie-consent", "settled");
		document.dispatchEvent(new Event("cookie-consent:settled"));
		vi.advanceTimersByTime(20_000);
		await ready();
		expect(host()).toBeNull();
		vi.advanceTimersByTime(11_000);
		await ready();
		expect(host()).not.toBeNull();
	});

	it("keeps out of the way after a close, for as long as the owner chose", async () => {
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		boot(config({ kind: "slide", again: "week" }));
		await readOn();
		shadow().querySelector<HTMLElement>("[data-pp-close]")!.click();
		expect(host()).toBeNull();
		const memory = JSON.parse(localStorage.getItem(MEMORY_KEY)!);
		expect(memory.p.pop00000.c).toBe(Date.now());
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		vi.setSystemTime(Date.now() + 6 * DAY);
		boot(config({ kind: "slide", again: "week" }));
		await readOn();
		expect(host()).toBeNull();
		vi.setSystemTime(Date.now() + 2 * DAY);
		boot(config({ kind: "slide", again: "week" }));
		await readOn();
		expect(host()).not.toBeNull();
	});

	it("follows its dates and its device, whatever the cached page says", async () => {
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		const now = Date.now();
		boot(
			config(
				{ kind: "slide", start: now + DAY },
				{ kind: "slide", end: now - 1 },
				{ kind: "slide", devices: "phone" },
			),
		);
		await readOn();
		expect(host()).toBeNull();
	});

	it("counts views and closes", async () => {
		// The simulated browser draws nothing, so "seen" falls back to one second open.
		vi.stubGlobal("IntersectionObserver", undefined);
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		boot(config({ kind: "slide" }));
		await readOn();
		vi.advanceTimersByTime(1100);
		shadow().querySelector<HTMLElement>("[data-pp-close]")!.click();
		await ready();
		await ready();
		expect(beacons.map((b) => JSON.parse(b).e).sort()).toEqual(["closed", "seen"]);
	});
});

describe("click openers", () => {
	it("open from a link to #popup-<name> or data-popup, even on the first page", async () => {
		document.body.innerHTML = '<a id=a href="#popup-p0">Open</a>';
		boot(config({ trigger: "click" }));
		await ready();
		document.querySelector<HTMLElement>("#a")!.click();
		await ready();
		const dialog = shadow().querySelector("dialog")!;
		expect(dialog.hasAttribute("open")).toBe(true);
		// Clicked: centred, not a sheet, even on a phone.
		expect(dialog.classList.contains("sheet")).toBe(false);
	});

	it("open from a menu's /#popup-<name> link on any page the popup shows on", async () => {
		history.replaceState(null, "", "/blog/some-post");
		document.body.innerHTML = '<nav><a id=a href="/#popup-p0">Newsletter</a></nav>';
		boot(config({ trigger: "click" }));
		await ready();
		document.querySelector<HTMLElement>("#a")!.click();
		await ready();
		expect(shadow().querySelector("dialog")!.hasAttribute("open")).toBe(true);
		expect(location.pathname).toBe("/blog/some-post");
		history.replaceState(null, "", "/");
	});
});

describe("top bars", () => {
	it("are hidden before the page draws when closed recently, out of dates or for another device", () => {
		localStorage.setItem(
			MEMORY_KEY,
			JSON.stringify({ p: { pop00000: { c: Date.now() - DAY } }, f: {} }),
		);
		boot(config({ kind: "bar" }, { kind: "bar" }, { kind: "bar" }));
		// The first is closed, the second shows, the third waits: only one bar at a time.
		const style = document.head.querySelector("style")!.textContent!;
		expect(style).toContain("#popups-bar-pop00000{display:none!important}");
		expect(style).not.toContain("pop10000");
		expect(style).toContain("#popups-bar-pop20000{display:none!important}");
	});
});

describe("forms", () => {
	const definition = {
		pages: [
			{
				fields: [
					{
						id: "e",
						type: "email",
						label: "Email address",
						name: "email",
						required: true,
						width: "full",
					},
					{
						id: "f",
						type: "text",
						label: "First name",
						name: "first",
						required: false,
						width: "full",
						condition: { field: "email", op: "filled" },
					},
				],
			},
		],
		settings: { spamProtection: "honeypot", submitLabel: "Join the list" },
	};

	function stubForms(answers: Record<string, () => Response>) {
		const calls: Array<{ url: string; body: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { body?: string }) => {
				calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
				const key = Object.keys(answers).find((k) => url.endsWith(k));
				return key ? answers[key]!() : new Response("{}", { status: 404 });
			}),
		);
		return calls;
	}

	it("draws the form from the forms plugin's definition and sends it to its submit route", async () => {
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		const calls = stubForms({
			definition: () => new Response(JSON.stringify({ success: true, data: definition })),
			submit: () =>
				new Response(
					JSON.stringify({ success: true, data: { success: true, message: "Welcome aboard." } }),
				),
		});
		const submitted = vi.fn();
		document.addEventListener("emdash:form-submitted", submitted);
		boot(config({ contains: "form", form: "newsletter", thanks: "Thanks, you're on the list" }));
		await readOn();
		await ready();
		const form = shadow().querySelector("form")!;
		expect(form.querySelector<HTMLInputElement>("[name=email]")!.required).toBe(true);
		expect(form.textContent).toContain("(optional)");
		expect(form.querySelector("[name=_hp]")).not.toBeNull();
		// The condition hides the first name until the email is filled.
		expect(form.querySelector<HTMLElement>("[data-condition]")!.hidden).toBe(true);
		const email = form.querySelector<HTMLInputElement>("[name=email]")!;
		email.value = "jo@example.com";
		email.dispatchEvent(new Event("input", { bubbles: true }));
		expect(form.querySelector<HTMLElement>("[data-condition]")!.hidden).toBe(false);
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		await ready();
		await ready();
		const sent = calls.find((c) => c.url.endsWith("submit"))!;
		expect(sent.url).toBe("/_emdash/api/plugins/emdash-forms/submit");
		expect(sent.body).toEqual({
			formId: "newsletter",
			data: { email: "jo@example.com", first: "", _hp: "" },
		});
		expect(shadow().querySelector(".ok h2")!.textContent).toBe("Thanks, you're on the list");
		expect(shadow().querySelector(".ok")!.textContent).toContain("Welcome aboard.");
		expect(document.querySelector("[data-form-status]")!.className).toBe(
			"ec-form-status ec-form-status--success",
		);
		expect(submitted).toHaveBeenCalledTimes(1);
		expect(JSON.parse(localStorage.getItem(MEMORY_KEY)!).f.newsletter).toBe(1);
	});

	it("stays closed and tells the owner when the form is missing or cannot work in a popup", async () => {
		sessionStorage.setItem(VISIT_KEY, JSON.stringify({ n: 3 }));
		const calls = stubForms({
			definition: () =>
				new Response(
					JSON.stringify({
						success: true,
						data: { ...definition, settings: { spamProtection: "turnstile" } },
					}),
				),
			problem: () => new Response("{}"),
		});
		boot(config({ contains: "form", form: "newsletter" }));
		await readOn();
		await ready();
		expect(host()).toBeNull();
		expect(calls.find((c) => c.url.endsWith("problem"))!.body).toEqual({
			p: "pop00000",
			k: "unsupported",
		});
	});
});

describe("preview", () => {
	it("shows at once with the reason a real visitor would not see it, and remembers nothing", async () => {
		win.happyDOM.setURL("https://hartleys.test/?popups_preview=pop00000&scheme=dark");
		const closed = Date.now() - 3 * DAY;
		localStorage.setItem(MEMORY_KEY, JSON.stringify({ p: { pop00000: { c: closed } }, f: {} }));
		const item = clientItem(popup({ id: "pop00000" }), "")!;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () => new Response(JSON.stringify({ success: true, data: { item, off: false } })),
			),
		);
		boot(config());
		await ready();
		await ready();
		expect(shadow().querySelector(".pv")!.textContent).toBe(
			"Preview: nothing is counted. Hidden for a real visitor: this browser closed it 3 days ago; it shows again after a month.",
		);
		shadow().querySelector<HTMLElement>("[data-pp-close]")!.click();
		expect(JSON.parse(localStorage.getItem(MEMORY_KEY)!).p.pop00000.c).toBe(closed);
		expect(sessionStorage.getItem(VISIT_KEY)).toBeNull();
		expect(beacons).toEqual([]);
	});
});
