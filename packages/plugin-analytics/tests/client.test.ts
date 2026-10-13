// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { boot, GEO_KEY } from "../src/client/boot.js";
import { COOKIE, encodeChoice, today } from "../src/client/consent.js";
import type { ClientConfig } from "../src/client/types.js";
import { normalizeConfig } from "../src/config.js";
import { clientConfig } from "../src/fragment.js";

/**
 * The browser script against a simulated page. The real-browser proof (network
 * requests, keyboard, the forms plugin) is in apps/demo-site/tests/analytics.spec.ts;
 * these tests cover the branches that are awkward to reach there.
 */

type Win = typeof window & {
	dataLayer?: unknown[];
	gtag?: unknown;
	fbq?: unknown;
	_fbq?: unknown;
	clarity?: unknown;
	_hsp?: unknown;
	happyDOM: { setURL(url: string): void };
};
const win = window as Win;

function settings(raw: Record<string, unknown> = {}): ClientConfig {
	return clientConfig(
		normalizeConfig({
			tools: { ga4: "G-AB12CD34EF", meta: "123456789012345", clarity: "ab12cd34ef" },
			banner: { policyUrl: "/privacy" },
			...raw,
		}),
		"analytics-consent",
	);
}

/** Addresses of the scripts the page has asked for. */
function requested(): string[] {
	return [...document.head.querySelectorAll("script")].map((script) => script.src);
}

function shadow(): ShadowRoot {
	const host = document.querySelector("#cookie-consent");
	if (!host?.shadowRoot) throw new Error("no banner was built");
	return host.shadowRoot;
}

const bannerShown = () => !shadow().querySelector<HTMLElement>(".b")!.hidden;
const press = (key: string, within: ParentNode = shadow()) =>
	within.querySelector<HTMLElement>(`[data-k=${key}]`)!.click();

/** Let the country lookup and the start-up promises finish. */
async function ready(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function country(code: string | null): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ json: async () => ({ success: true, data: { country: code } }) })),
	);
}

function events(): unknown[] {
	return (win.dataLayer ?? []).map((entry) =>
		Object.prototype.toString.call(entry) === "[object Arguments]"
			? Array.from(entry as ArrayLike<unknown>)
			: entry,
	);
}

beforeEach(() => {
	win.happyDOM.setURL("https://acme.test/");
	document.head.innerHTML = "";
	document.body.innerHTML = "";
	for (const pair of document.cookie.split("; ")) {
		document.cookie = `${pair.split("=")[0]}=;path=/;max-age=0`;
	}
	localStorage.clear();
	for (const name of ["dataLayer", "gtag", "fbq", "_fbq", "clarity", "_hsp"] as const) {
		delete win[name];
	}
	Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(() => true), configurable: true });
	Object.defineProperty(navigator, "globalPrivacyControl", {
		value: undefined,
		configurable: true,
	});
	country("DE");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("before an answer", () => {
	it("sets Google's consent defaults to denied straight away, and asks for nothing", async () => {
		boot(settings());
		expect(events()).toEqual([
			[
				"consent",
				"default",
				{
					ad_storage: "denied",
					ad_user_data: "denied",
					ad_personalization: "denied",
					analytics_storage: "denied",
				},
			],
		]);
		await ready();
		expect(bannerShown()).toBe(true);
		expect(requested()).toEqual([]);
		expect(document.cookie).toBe("");
	});

	it("does nothing at all on a preview link or in the visual editor", async () => {
		win.happyDOM.setURL("https://acme.test/post?_preview=token");
		boot(settings());
		await ready();
		expect(win.dataLayer).toBeUndefined();
		expect(document.querySelector("#cookie-consent")).toBeNull();

		win.happyDOM.setURL("https://acme.test/");
		document.cookie = "emdash-edit-mode=true;path=/";
		boot(settings());
		await ready();
		expect(win.dataLayer).toBeUndefined();
	});

	it("writes banner text as text, never as markup", async () => {
		const config = settings();
		config.t.title = `<img src=x onerror="window.hacked=1">`;
		config.t.text = `"><script>window.hacked=1</script>`;
		config.an = [`<b id="injected">x</b>`];
		boot(config);
		await ready();
		expect(shadow().querySelector("img")).toBeNull();
		expect(shadow().querySelector("script")).toBeNull();
		expect(shadow().querySelector("#injected")).toBeNull();
		expect(shadow().querySelector("h2")?.textContent).toBe(`<img src=x onerror="window.hacked=1">`);
	});
});

describe("answers", () => {
	it("Accept all loads each tool once and remembers the answer", async () => {
		boot(settings());
		await ready();
		press("a");
		expect(requested()).toEqual([
			"https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF",
			"https://www.clarity.ms/tag/ab12cd34ef",
			"https://connect.facebook.net/en_US/fbevents.js",
		]);
		expect(bannerShown()).toBe(false);
		expect(document.cookie).toMatch(new RegExp(`^${COOKIE}=[a-z0-9]+\\.11\\.\\d+\\.[a-z0-9]+$`));
		expect(navigator.sendBeacon).toHaveBeenCalledTimes(1);
		expect(events()).toContainEqual({
			event: "cookie_consent_update",
			analytics: true,
			marketing: true,
		});
	});

	it("Reject all loads nothing and still remembers", async () => {
		boot(settings());
		await ready();
		press("r");
		expect(requested()).toEqual([]);
		expect(document.cookie).toMatch(/\.00\./);
		expect(bannerShown()).toBe(false);
	});

	it("a saved answer is followed on the next page without asking", async () => {
		const config = settings();
		document.cookie = `${COOKIE}=${encodeChoice({ v: config.v, a: true, m: false, d: today(Date.now()), id: "abc123" })};path=/`;
		boot(config);
		await ready();
		expect(bannerShown()).toBe(false);
		expect(requested()).toEqual([
			"https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF",
			"https://www.clarity.ms/tag/ab12cd34ef",
		]);
	});

	it("an answer given for a different list of tools is asked again", async () => {
		document.cookie = `${COOKIE}=${encodeChoice({ v: "old", a: true, m: true, d: today(Date.now()), id: "abc123" })};path=/`;
		boot(settings());
		await ready();
		expect(bannerShown()).toBe(true);
		expect(requested()).toEqual([]);
	});

	it("an answer older than the limit is asked again", async () => {
		const config = settings();
		document.cookie = `${COOKIE}=${encodeChoice({ v: config.v, a: true, m: true, d: today(Date.now()) - 200, id: "abc123" })};path=/`;
		boot(config);
		await ready();
		expect(bannerShown()).toBe(true);
	});

	it("taking consent back deletes the tools' cookies and reloads the page", async () => {
		const reload = vi.fn();
		vi.spyOn(window.location, "reload").mockImplementation(reload);
		boot(settings());
		await ready();
		press("a");
		document.cookie = "_ga=GA1.1;path=/";
		document.cookie = "_fbp=fb.1;path=/";
		document.cookie = "theme=dark;path=/";
		press("r", shadow().querySelector("dialog")!);
		expect(reload).toHaveBeenCalledTimes(1);
		// The tools were told before the page went away.
		const denied = {
			ad_storage: "denied",
			ad_user_data: "denied",
			ad_personalization: "denied",
			analytics_storage: "denied",
		};
		expect(events().slice(-2)).toEqual([
			["consent", "update", denied],
			{ event: "cookie_consent_update", analytics: false, marketing: false },
		]);
		const clarity = (win.clarity as unknown as { q: ArrayLike<unknown>[] }).q.map((call) =>
			Array.from(call),
		);
		expect(clarity.at(-1)).toEqual([
			"consentv2",
			{ ad_Storage: "denied", analytics_Storage: "denied" },
		]);
		// The simulated cookie jar can leave an empty entry behind; the browser test checks real removal.
		expect(document.cookie).not.toMatch(/_ga=[^;]/);
		expect(document.cookie).not.toMatch(/_fbp=[^;]/);
		expect(document.cookie).toContain("theme=dark");
		expect(document.cookie).toMatch(/\.00\./);
	});
});

describe("who is asked", () => {
	it("loads without asking outside Europe, and remembers the country for later pages", async () => {
		country("US");
		boot(settings());
		await ready();
		expect(bannerShown()).toBe(false);
		expect(requested()).toHaveLength(3);
		expect(localStorage.getItem(GEO_KEY)).toBe(`US.${today(Date.now())}`);

		// Next page: no lookup.
		document.head.innerHTML = "";
		document.body.innerHTML = "";
		const lookup = vi.fn();
		vi.stubGlobal("fetch", lookup);
		boot(settings());
		await ready();
		expect(lookup).not.toHaveBeenCalled();
		expect(requested()).toHaveLength(3);
	});

	it("asks when the country lookup fails and the time zone is European", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("offline"))),
		);
		vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
			resolvedOptions: () => ({ timeZone: "Europe/Madrid" }),
		} as Intl.DateTimeFormat);
		boot(settings());
		await ready();
		expect(bannerShown()).toBe(true);
		expect(localStorage.getItem(GEO_KEY)).toBeNull();
		vi.restoreAllMocks();
	});

	it("Global Privacy Control turns Marketing off even on Accept all", async () => {
		Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
		boot(settings());
		await ready();
		press("a");
		expect(requested()).toEqual([
			"https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF",
			"https://www.clarity.ms/tag/ab12cd34ef",
		]);
		expect(document.cookie).toMatch(/\.10\./);
	});

	it("a browser that has signed in to the admin sees the banner but loads nothing", async () => {
		localStorage.setItem("emdash-editor", "1");
		boot(settings());
		await ready();
		expect(bannerShown()).toBe(true);
		press("a");
		expect(requested()).toEqual([]);
	});

	it("builds no banner when another consent tool is in charge", async () => {
		boot(settings({ banner: { audience: "none" } }));
		await ready();
		expect(document.querySelector("#cookie-consent")).toBeNull();
		expect(requested()).toHaveLength(3);
		// No consent signals either: the other tool sends its own.
		expect(events().filter((entry) => Array.isArray(entry) && entry[0] === "consent")).toEqual([]);
	});
});

describe("enquiries", () => {
	it("counts a phone click and a sent form, by kind only", async () => {
		country("US");
		document.body.innerHTML = `<a id="call" href="tel:+15550100"><span>Call</span></a>
			<form><div data-form-status class="ec-form-status"></div></form>`;
		boot(settings());
		await ready();
		document.querySelector<HTMLElement>("#call span")!.click();
		const status = document.querySelector("[data-form-status]")!;
		status.className = "ec-form-status ec-form-status--error";
		await ready();
		expect(events()).not.toContainEqual({ event: "enquiry", enquiry_type: "form" });
		status.className = "ec-form-status ec-form-status--success";
		await ready();

		expect(events()).toContainEqual({ event: "enquiry", enquiry_type: "phone" });
		expect(events()).toContainEqual(["event", "generate_lead", { lead_source: "phone" }]);
		expect(events()).toContainEqual({ event: "enquiry", enquiry_type: "form" });
		expect(events()).toContainEqual(["event", "generate_lead", { lead_source: "form" }]);
		expect(JSON.stringify(events())).not.toContain("5550100");
	});
});
