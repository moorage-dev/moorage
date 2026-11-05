// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

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
	ttq?: unknown;
	TiktokAnalyticsObject?: unknown;
	_linkedin_partner_id?: unknown;
	_linkedin_data_partner_ids?: unknown;
	cookieConsent?: unknown;
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
	document.documentElement.removeAttribute("data-cookie-consent");
	for (const pair of document.cookie.split("; ")) {
		document.cookie = `${pair.split("=")[0]}=;path=/;max-age=0`;
	}
	localStorage.clear();
	for (const name of [
		"dataLayer",
		"gtag",
		"fbq",
		"_fbq",
		"clarity",
		"_hsp",
		"ttq",
		"TiktokAnalyticsObject",
		"_linkedin_partner_id",
		"_linkedin_data_partner_ids",
		"cookieConsent",
	] as const) {
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

	it("on another address than the site's (staging, workers.dev) shows the banner but loads and records nothing", async () => {
		win.happyDOM.setURL("https://bakery-staging.example.workers.dev/");
		boot({ ...settings(), h: "bakery.test" });
		await ready();
		expect(bannerShown()).toBe(true);
		press("a");
		expect(requested()).toEqual([]);
		expect(navigator.sendBeacon).not.toHaveBeenCalled();
	});

	it("on the site's own address, with or without www, loads as usual", async () => {
		for (const address of ["https://bakery.test/", "https://www.bakery.test/"]) {
			document.head.innerHTML = "";
			document.body.innerHTML = "";
			document.cookie = `${COOKIE}=;path=/;max-age=0`;
			win.happyDOM.setURL(address);
			boot({ ...settings(), h: "bakery.test" });
			await ready();
			press("a");
			expect(requested(), address).toHaveLength(3);
		}
	});

	it("loads as usual on any other real domain: a Site URL left on its setup address must not stop tracking", async () => {
		for (const [address, host] of [
			["https://bakery.com/", "bakery-site.acme.workers.dev"],
			["https://bakery.com/", "localhost"],
			["https://staging.bakery.test/", "bakery.test"],
		] as const) {
			document.head.innerHTML = "";
			document.body.innerHTML = "";
			document.cookie = `${COOKIE}=;path=/;max-age=0`;
			win.happyDOM.setURL(address);
			boot({ ...settings(), h: host });
			await ready();
			press("a");
			expect(requested(), `${address} with ${host}`).toHaveLength(3);
		}
	});

	it("loads nothing on a workers.dev, pages.dev or local address that is not the site's", async () => {
		for (const address of [
			"https://bakery.acme.workers.dev/",
			"https://abc123.bakery.pages.dev/",
			"http://localhost:4321/",
			"http://127.0.0.1:4321/",
			"http://[::1]:4321/",
			"http://bakery.localhost/",
		]) {
			document.head.innerHTML = "";
			document.body.innerHTML = "";
			document.cookie = `${COOKIE}=;path=/;max-age=0`;
			win.happyDOM.setURL(address);
			boot({ ...settings(), h: "bakery.test" });
			await ready();
			press("a");
			expect(requested(), address).toEqual([]);
		}
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

describe("telling other scripts whether the banner waits", () => {
	const phase = () => document.documentElement.getAttribute("data-cookie-consent");

	it("is pending at once, asking while the banner waits, settled after the answer", async () => {
		const settled = vi.fn();
		document.addEventListener("cookie-consent:settled", settled);
		boot(settings());
		expect(phase()).toBe("pending");
		await ready();
		expect(phase()).toBe("asking");
		expect(settled).not.toHaveBeenCalled();
		press("r");
		expect(phase()).toBe("settled");
		expect(settled).toHaveBeenCalledTimes(1);
		document.removeEventListener("cookie-consent:settled", settled);
	});

	it("is settled straight after start-up for a visitor who is not asked", async () => {
		country("US");
		const settled = vi.fn();
		document.addEventListener("cookie-consent:settled", settled);
		boot(settings());
		await ready();
		expect(phase()).toBe("settled");
		expect(settled).toHaveBeenCalledTimes(1);
		document.removeEventListener("cookie-consent:settled", settled);
	});

	it("sets nothing on a site where the banner can never appear", async () => {
		boot(settings({ banner: { audience: "none" } }));
		await ready();
		expect(phase()).toBeNull();
	});
});

describe("held videos and maps on a site with no Marketing tools", () => {
	it("Choose offers a Videos and maps switch, which releases them and is withdrawn like the others", async () => {
		const reload = vi.fn();
		vi.spyOn(window.location, "reload").mockImplementation(reload);
		boot(settings({ tools: { ga4: "G-AB12CD34EF" }, heldEmbeds: ["YouTube"] }));
		await ready();
		expect(shadow().querySelector(".b")!.textContent).toContain(
			"Videos and maps from YouTube set their own cookies, so they wait for your choice.",
		);
		press("c");
		const dialog = shadow().querySelector("dialog")!;
		expect(dialog.textContent).toContain(
			"Videos and mapsShows videos and maps from other sites, which set their own cookies. Used by: YouTube.",
		);
		shadow().querySelector<HTMLInputElement>("[name=m]")!.click();
		press("s", dialog);
		expect((window as unknown as { cookieConsent: unknown }).cookieConsent).toEqual({
			analytics: false,
			marketing: true,
		});
		expect(document.cookie).toMatch(/\.01\./);
		// No tracking tool came with it.
		expect(requested()).toEqual([]);
		press("c");
		press("r", dialog);
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

describe("the site's language", () => {
	afterEach(() => document.documentElement.removeAttribute("lang"));

	/** Answer the country route and the words route, and note what was asked for. */
	function routes(words: (lang: string) => unknown): string[] {
		const asked: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				asked.push(url);
				if (url.includes("/words?")) {
					const lang = new URL(url, "https://acme.test").searchParams.get("l") ?? "";
					const body = words(lang);
					if (body instanceof Error) throw body;
					return { json: async () => body };
				}
				return { json: async () => ({ success: true, data: { country: "DE" } }) };
			}),
		);
		return asked;
	}

	it("on a German page the banner speaks German, fetched once from the site", async () => {
		document.documentElement.setAttribute("lang", "de-DE");
		const config = settings();
		const asked = routes(() => ({
			success: true,
			data: {
				t: { ...config.t, title: "Dürfen wir Cookies verwenden?", accept: "Alle akzeptieren" },
			},
		}));
		boot(config);
		await ready();
		expect(asked.filter((url) => url.includes("/words?"))).toEqual([
			`/_emdash/api/plugins/analytics-consent/words?l=de&w=${config.w}`,
		]);
		expect(bannerShown()).toBe(true);
		expect(shadow().querySelector("h2")?.textContent).toBe("Dürfen wir Cookies verwenden?");
		expect(shadow().querySelector("[data-k=a]")?.textContent).toBe("Alle akzeptieren");
	});

	it("on an English page, or one in a language it does not know, asks for nothing more", async () => {
		for (const lang of ["en", "en-GB", "pl", ""]) {
			document.documentElement.setAttribute("lang", lang);
			document.body.innerHTML = "";
			const asked = routes(() => ({}));
			boot(settings());
			await ready();
			expect(
				asked.filter((url) => url.includes("/words?")),
				lang,
			).toEqual([]);
			expect(shadow().querySelector("h2")?.textContent).toBe("Can we use cookies?");
		}
	});

	it("falls back to English when the words cannot be fetched", async () => {
		document.documentElement.setAttribute("lang", "fr");
		routes(() => new Error("offline"));
		boot(settings());
		await ready();
		expect(bannerShown()).toBe(true);
		expect(shadow().querySelector("h2")?.textContent).toBe("Can we use cookies?");
	});
});

describe("Astro's <ClientRouter />", () => {
	/** What the router does on a page change: a new body, the new page's attributes on <html>. */
	function swap(body: string): void {
		const next = document.createElement("body");
		next.innerHTML = body;
		document.body.replaceWith(next);
		// A copy: removing attributes changes the live list.
		for (const { name } of Array.from(document.documentElement.attributes)) {
			document.documentElement.removeAttribute(name);
		}
		document.documentElement.setAttribute("lang", "en");
		document.dispatchEvent(new Event("astro:after-swap"));
	}
	const panelOpen = () => shadow().querySelector("dialog")!.open;
	const pill = () => shadow().querySelector<HTMLElement>(".s")!;
	const click = (element: Element) =>
		!element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	const link = (selector: string) => document.querySelector(selector)!;

	it("keeps the banner, its state and the Cookies button on the next page", async () => {
		boot(settings());
		await ready();
		swap("<p>Second page</p>");
		expect(document.querySelector("#cookie-consent")).not.toBeNull();
		expect(bannerShown()).toBe(true);
		expect(document.documentElement.getAttribute("data-cookie-consent")).toBe("asking");
		press("a");
		swap("<p>Third page</p>");
		expect(document.querySelector("#cookie-consent")).not.toBeNull();
		expect(bannerShown()).toBe(false);
		expect(pill().hidden).toBe(false);
		expect(document.documentElement.getAttribute("data-cookie-consent")).toBe("settled");
		// The tools were loaded once, on the first page, and stay loaded.
		expect(requested()).toHaveLength(3);
	});

	it("a link to #cookie-settings on the new page opens the choices", async () => {
		boot(settings());
		await ready();
		press("r");
		swap('<a id=m href="/#cookie-settings">Cookie settings</a>');
		expect(click(link("#m"))).toBe(true);
		expect(panelOpen()).toBe(true);
	});
});

describe("the consent state other scripts can read", () => {
	const state = () => (window as unknown as { cookieConsent?: unknown }).cookieConsent;

	it("is unknown until the visitor's rule is known, then says what is allowed", async () => {
		boot(settings());
		expect(state()).toBeUndefined();
		await ready();
		expect(state()).toEqual({ analytics: false, marketing: false });
		press("c");
		shadow().querySelector<HTMLInputElement>("[name=a]")!.click();
		press("s", shadow().querySelector("dialog")!);
		expect(state()).toEqual({ analytics: true, marketing: false });
	});

	it("follows a saved answer, and the rule for visitors who are not asked", async () => {
		country("US");
		boot(settings());
		await ready();
		expect(state()).toEqual({ analytics: true, marketing: true });
	});

	it("cannot be changed by other scripts", async () => {
		boot(settings());
		await ready();
		const w = window as unknown as { cookieConsent: { marketing: boolean } };
		expect(() => {
			w.cookieConsent.marketing = true;
		}).toThrow();
		try {
			(w as { cookieConsent: unknown }).cookieConsent = { analytics: true, marketing: true };
		} catch {
			// Strict mode throws; either way nothing changes.
		}
		expect(state()).toEqual({ analytics: false, marketing: false });
	});

	it("is announced with each change, and once settled, with the answer", async () => {
		const changes: unknown[] = [];
		const settled: unknown[] = [];
		const onChange = (event: Event) => changes.push((event as CustomEvent).detail);
		const onSettled = (event: Event) => settled.push((event as CustomEvent).detail);
		document.addEventListener("cookie-consent:change", onChange);
		document.addEventListener("cookie-consent:settled", onSettled);
		boot(settings());
		await ready();
		press("a");
		expect(changes).toEqual([
			{ analytics: false, marketing: false },
			{ analytics: true, marketing: true },
		]);
		expect(settled).toEqual([{ analytics: true, marketing: true }]);
		document.removeEventListener("cookie-consent:change", onChange);
		document.removeEventListener("cookie-consent:settled", onSettled);
	});
});

describe("links to #cookie-settings", () => {
	/** A stand-in for the browser's IntersectionObserver, so a test can say when a link is on screen. */
	class Watcher {
		static all: Watcher[] = [];
		readonly watched = new Set<Element>();
		constructor(private readonly report: (entries: unknown[]) => void) {
			Watcher.all.push(this);
		}
		observe(target: Element) {
			this.watched.add(target);
		}
		unobserve() {}
		disconnect() {}
		/** Tell the script that `target` came on screen, or left it. */
		static seen(target: Element, on: boolean) {
			for (const watcher of Watcher.all) {
				if (watcher.watched.has(target)) watcher.report([{ target, isIntersecting: on }]);
			}
		}
	}

	beforeEach(() => {
		Watcher.all = [];
		vi.stubGlobal("IntersectionObserver", Watcher);
	});

	const panelOpen = () => shadow().querySelector("dialog")!.open;
	const pill = () => shadow().querySelector<HTMLElement>(".s")!;
	/** Click as a visitor would; true when the script kept the browser from following the link. */
	const click = (element: Element) =>
		!element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	const link = (selector: string) => document.querySelector(selector)!;

	it("a menu item to /#cookie-settings opens the cookie choices, on any page, without leaving it", async () => {
		win.happyDOM.setURL("https://acme.test/pricing");
		document.body.innerHTML = '<nav><a id=m href="/#cookie-settings">Cookie settings</a></nav>';
		boot(settings());
		await ready();
		press("r");
		expect(panelOpen()).toBe(false);
		expect(click(link("#m"))).toBe(true);
		expect(panelOpen()).toBe(true);
		expect(window.location.href).toBe("https://acme.test/pricing");
	});

	it("a link in a page's text to #cookie-settings, or to a full address on this site, does the same", async () => {
		// Not asked (outside Europe): the panel is still there to say no.
		country("US");
		document.body.innerHTML =
			'<article><p>Change <a id=t href="#cookie-settings">your cookie choices</a> or <a id=f href="https://acme.test/privacy#cookie-settings">here</a>.</p></article>';
		boot(settings());
		await ready();
		expect(bannerShown()).toBe(false);
		expect(click(link("#t"))).toBe(true);
		expect(panelOpen()).toBe(true);
		shadow().querySelector("dialog")!.close();
		expect(click(link("#f"))).toBe(true);
		expect(panelOpen()).toBe(true);
		expect(window.location.hash).toBe("");
	});

	it("leaves other links alone", async () => {
		document.body.innerHTML =
			'<a id=a href="#cookie-settings-old">a</a><a id=b href="https://other.test/#cookie-settings">b</a><a id=c href="#cookies">c</a>';
		boot(settings());
		await ready();
		for (const id of ["#a", "#b", "#c"]) {
			let followed: boolean | undefined;
			// Seen after the script has had its turn; then the simulated browser is kept from leaving.
			window.addEventListener(
				"click",
				(event) => {
					followed = !event.defaultPrevented;
					event.preventDefault();
				},
				{ once: true },
			);
			click(link(id));
			expect(followed).toBe(true);
			expect(panelOpen()).toBe(false);
		}
	});

	it("works for a link added after the page loaded, such as a menu drawn later", async () => {
		country("US");
		boot(settings());
		await ready();
		const late = document.createElement("a");
		late.href = "/#cookie-settings";
		late.textContent = "Cookie settings";
		document.body.append(late);
		expect(click(late)).toBe(true);
		expect(panelOpen()).toBe(true);
	});

	it("the floating button steps aside while a link to #cookie-settings is on screen, and comes back", async () => {
		country("US");
		document.body.innerHTML =
			'<footer><a id=m href="/#cookie-settings">Cookie settings</a></footer>';
		boot(settings());
		await ready();
		expect(pill().hidden).toBe(false);
		Watcher.seen(link("#m"), true);
		expect(pill().hidden).toBe(true);
		Watcher.seen(link("#m"), false);
		expect(pill().hidden).toBe(false);
	});

	it("arriving at an address ending in #cookie-settings opens the choices and tidies the address", async () => {
		country("US");
		win.happyDOM.setURL("https://acme.test/?ref=menu#cookie-settings");
		boot(settings());
		await ready();
		expect(panelOpen()).toBe(true);
		expect(window.location.href).toBe("https://acme.test/?ref=menu");
	});

	it("still opens from anything marked data-cookie-settings, as before", async () => {
		document.body.innerHTML = "<button id=o data-cookie-settings>Cookies</button>";
		boot(settings());
		await ready();
		expect(click(link("#o"))).toBe(true);
		expect(panelOpen()).toBe(true);
	});

	it("on a site where nothing asks, the link opens nothing and does not leave the page", async () => {
		win.happyDOM.setURL("https://acme.test/pricing");
		document.body.innerHTML = '<a id=m href="/#cookie-settings">Cookie settings</a>';
		boot(settings({ tools: { cloudflare: "0123456789abcdef0123456789abcdef" } }));
		await ready();
		expect(document.querySelector("#cookie-consent")).toBeNull();
		expect(click(link("#m"))).toBe(true);
		expect(window.location.href).toBe("https://acme.test/pricing");
	});
});

describe("the four tools added in 0.4", () => {
	const UUID = "94db1cb1-74f4-4a40-ad6c-962362670409";
	const four = {
		plausible: "bakery.de",
		umami: UUID,
		linkedin: "1234567",
		tiktok: "CABC123DEF456GHI789J",
	};
	const scripts = () =>
		[...document.head.querySelectorAll("script")].map((script) => ({
			src: script.src,
			data: Object.fromEntries(
				[...script.attributes]
					.filter((attribute) => attribute.name.startsWith("data-"))
					.map((attribute) => [attribute.name, attribute.value]),
			),
		}));

	it("Plausible and Umami count visits without cookies, so they start before any answer", async () => {
		boot(settings({ tools: four }));
		await ready();
		expect(bannerShown()).toBe(true);
		expect(scripts()).toEqual([
			{ src: "https://plausible.io/js/script.js", data: { "data-domain": "bakery.de" } },
			{ src: "https://cloud.umami.is/script.js", data: { "data-website-id": UUID } },
		]);
	});

	it("alone they need no banner at all", async () => {
		boot(settings({ tools: { plausible: "bakery.de", umami: UUID } }));
		await ready();
		expect(document.querySelector("#cookie-consent")).toBeNull();
		expect(requested()).toHaveLength(2);
	});

	it("LinkedIn and TikTok wait for Marketing", async () => {
		boot(settings({ tools: four }));
		await ready();
		press("c");
		const dialog = shadow().querySelector("dialog")!;
		expect(dialog.textContent).toContain("Used by: LinkedIn Insight Tag, TikTok Pixel.");
		shadow().querySelector<HTMLInputElement>("[name=a]")?.click();
		press("s", dialog);
		expect(requested()).toHaveLength(2);
		document.head.innerHTML = "";
		boot(settings({ tools: four }));
		await ready();
		press("a");
		expect(requested()).toEqual([
			"https://plausible.io/js/script.js",
			"https://cloud.umami.is/script.js",
			"https://snap.licdn.com/li.lms-analytics/insight.min.js",
			"https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=CABC123DEF456GHI789J&lib=ttq",
		]);
		const w = window as unknown as {
			_linkedin_data_partner_ids?: string[];
			TiktokAnalyticsObject?: string;
			ttq?: unknown[] & { _i?: Record<string, unknown> };
		};
		expect(w._linkedin_data_partner_ids).toEqual(["1234567"]);
		expect(w.TiktokAnalyticsObject).toBe("ttq");
		expect(Object.keys(w.ttq?._i ?? {})).toEqual(["CABC123DEF456GHI789J"]);
		expect(w.ttq?.[0]).toEqual(["page"]);
	});

	it("taking Marketing back deletes LinkedIn's and TikTok's cookies", async () => {
		vi.spyOn(window.location, "reload").mockImplementation(() => {});
		boot(settings({ tools: four }));
		await ready();
		press("a");
		document.cookie = "li_fat_id=x;path=/";
		document.cookie = "_ttp=x;path=/";
		document.cookie = "theme=dark;path=/";
		press("r", shadow().querySelector("dialog")!);
		expect(document.cookie).not.toMatch(/li_fat_id=[^;]/);
		expect(document.cookie).not.toMatch(/_ttp=[^;]/);
		expect(document.cookie).toContain("theme=dark");
	});
});

describe("an English site after the update", () => {
	it("shows exactly the banner and panel it showed in 0.3.3", async () => {
		boot(settings());
		await ready();
		// Everything after the style sheet: the words and the markup visitors get.
		expect(shadow().innerHTML.replace(/^<style>.*?<\/style>/s, "")).toMatchInlineSnapshot(
			`"<div class="b bar" role="region" aria-label="Can we use cookies?"><div class="i"><div><h2>Can we use cookies?</h2><p>We would like to use analytics cookies to see how this site is used, and marketing cookies to measure our ads. Essential cookies are always on. <a href="/privacy">Privacy policy</a></p></div><div class="r"><button type="button" class="p" data-k="a">Accept all</button><button type="button" class="p" data-k="r">Reject all</button><button type="button" class="q" data-k="c">Choose</button></div></div></div><button type="button" class="s" data-k="c" aria-label="Cookie settings" hidden=""><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"></circle><circle cx="6" cy="6" r="1"></circle><circle cx="10" cy="9" r="1"></circle><circle cx="6.5" cy="10.5" r=".8"></circle></svg><span>Cookies</span></button><p class="v" role="status"></p><dialog aria-labelledby="h"><h2 id="h">Your cookie choices</h2><div class="o"><b id="ln">Essential</b><em>Always on</em><p>Remembers your answer, so you are not asked on every page.</p></div><div class="o"><b id="la">Analytics</b><input type="checkbox" role="switch" name="a" aria-labelledby="la"><p>Shows us how visitors use this site, so we can improve it. Used by: Google Analytics, Microsoft Clarity.</p></div><div class="o"><b id="lm">Marketing</b><input type="checkbox" role="switch" name="m" aria-labelledby="lm"><p>Lets us measure our advertising and show you relevant ads elsewhere. Used by: Meta Pixel.</p></div><p class="g" hidden="">Your browser asks sites not to share your data (Global Privacy Control), so Marketing stays off.</p><div class="r"><button type="button" class="p" data-k="s">Save my choices</button><button type="button" class="p" data-k="r">Reject all</button><button type="button" class="p" data-k="a">Accept all</button></div></dialog>"`,
		);
	});
});
