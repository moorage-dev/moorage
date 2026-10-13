// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import {
	COOKIE,
	decide,
	encodeChoice,
	mustAsk,
	readChoice,
	today,
	type Decision,
} from "./consent.js";
import type { ClientConfig } from "./types.js";

/**
 * The script that runs in the visitor's browser, in the page head.
 *
 * It owns the consent state: nothing from a tracking company is requested
 * until `apply` runs with the visitor's answer (or the site's rule for visitors
 * who are not asked). It ships inline in every public page, so it is written
 * for size: one function, short names, no helpers that are used once.
 *
 * The order of work:
 * 1. Stop at once on preview links and in the visual editor.
 * 2. Tell Google tags that nothing is allowed yet (Consent Mode defaults).
 * 3. When the page has been read: find out whether this visitor must be asked,
 *    then either show the banner or load what is allowed.
 */

type Fn = (...args: unknown[]) => void;
type Queue = Fn & { q?: unknown[]; queue?: unknown[]; callMethod?: Fn } & Record<string, unknown>;

interface Globals {
	dataLayer?: unknown[];
	gtag?: Fn;
	clarity?: Queue;
	fbq?: Queue;
	_fbq?: Queue;
	_hsp?: unknown[];
	disableHubSpotCookieBanner?: boolean;
	requestIdleCallback?: (run: () => void) => void;
}

/** Where the visitor's country is remembered, as `DE.20374` (code, then the day it was learned). */
export const GEO_KEY = "cookie_consent_geo";

const GRANTED = "granted";
const DENIED = "denied";

// Dark colours, used alone or inside a media query depending on the setting.
const DARK = ":host{--f:#f2f2f2;--g:#1c1c1c}";

// System fonts, nothing fetched. Buttons share one style, so no answer is favoured.
const CSS =
	':host{--f:#141414;--g:#fff;--e:#8a8a8a}*{box-sizing:border-box}h2,p{margin:0}h2{font-size:18px}[hidden]{display:none!important}.b,.s,dialog{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--f);background:var(--g);border:1px solid var(--e)}.b{position:fixed;inset:auto 0 0;display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;max-height:90vh;overflow:auto;padding:16px 20px;border-width:1px 0 0}.b>div:first-child{flex:1 1 320px}.left,.right{inset:auto auto 16px 16px;width:min(420px,calc(100vw - 32px));border-width:1px;border-radius:10px}.right{inset:auto 16px 16px auto}a{color:inherit}.r{display:flex;flex-wrap:wrap;gap:8px}button{font:inherit;font-weight:600;min-height:44px;padding:8px 16px;color:var(--g);background:var(--f);border:2px solid var(--f);border-radius:8px;cursor:pointer}.s{position:fixed;inset:auto auto 12px 12px;min-height:0;padding:4px 10px;font-size:13px;font-weight:400;border-radius:8px}:focus-visible{outline:3px solid var(--f);outline-offset:2px}dialog{width:min(520px,calc(100vw - 32px));max-height:90vh;padding:20px;border-radius:10px}dialog::backdrop{background:#0008}label{display:block;margin-top:16px}input{width:20px;height:20px;vertical-align:-4px}dialog .r{margin-top:20px}@media(prefers-reduced-motion:no-preference){.b{animation:i .25s}}@keyframes i{from{opacity:0}}';

export function boot(c: ClientConfig): void {
	const w = window as unknown as Window & Globals;
	const d = document;
	const here = w.location;

	// Preview links and the visual editor are never tracked and never show the banner.
	if (/[?&]_preview=/.test(here.search) || /(^|; )emdash-edit-mode=true/.test(d.cookie)) return;

	const local = (key: string, value?: string): string | null => {
		try {
			if (value !== undefined) w.localStorage.setItem(key, value);
			return w.localStorage.getItem(key);
		} catch {
			return null;
		}
	};

	const layer = (w.dataLayer = w.dataLayer || []);
	const gtag = (w.gtag =
		w.gtag ||
		function () {
			// Google's tag reads the `arguments` object itself, not an array.
			// oxlint-disable-next-line prefer-rest-params
			layer.push(arguments);
		});
	const signal = (kind: string, a: boolean, m: boolean) =>
		gtag("consent", kind, {
			ad_storage: m ? GRANTED : DENIED,
			ad_user_data: m ? GRANTED : DENIED,
			ad_personalization: m ? GRANTED : DENIED,
			analytics_storage: a ? GRANTED : DENIED,
		});
	// Consent Mode v2: everything denied until the visitor's answer is known.
	if (c.who) signal("default", false, false);

	const gpc =
		(w.navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
	const day = today(Date.now());
	let saved = readChoice(d.cookie);
	let country: string | undefined;
	let state: Decision = { a: false, m: false, ask: false };
	// A browser that has been signed in to the admin is staff, not a visitor.
	let staff = !!local("emdash-editor");

	const done: Record<string, 1> = {};
	const once = (key: string): boolean => !done[key] && !!(done[key] = 1);

	const load = (src: string, attrs?: Record<string, string>) => {
		const script = d.createElement("script");
		script.async = true;
		script.src = src;
		for (const name in attrs) script.setAttribute(name, attrs[name]!);
		d.head.appendChild(script);
	};

	/** The only place a tracking company's script is ever requested. */
	const apply = (a: boolean, m: boolean) => {
		if (c.who && !state.ask) {
			signal("update", a, m);
			layer.push({ event: "cookie_consent_update", analytics: a, marketing: m });
		}
		if (staff) return;
		const google = "https://www.googletagmanager.com/";
		if (c.gtm && (c.gtmNow || a || m) && once("gtm")) {
			layer.push({ "gtm.start": Date.now(), event: "gtm.js" });
			load(google + "gtm.js?id=" + c.gtm);
		}
		for (const id of [a && c.ga, m && c.aw]) {
			if (id && once(id)) {
				if (once("gtag")) {
					gtag("js", new Date());
					load(google + "gtag/js?id=" + id);
				}
				gtag("config", id);
			}
		}
		// A tool that is already running is told when consent is taken back.
		if (c.cl && (a || done.cl)) {
			if (once("cl")) {
				w.clarity =
					w.clarity ||
					(function () {
						// oxlint-disable-next-line prefer-rest-params
						(w.clarity!.q = w.clarity!.q || []).push(arguments);
					} as Queue);
				load("https://www.clarity.ms/tag/" + c.cl);
			}
			w.clarity!("consentv2", {
				ad_Storage: m ? GRANTED : DENIED,
				analytics_Storage: a ? GRANTED : DENIED,
			});
		}
		if (c.fb && m && once("fb")) {
			const fbq = (w.fbq = function () {
				// oxlint-disable-next-line prefer-rest-params
				const args = arguments;
				if (fbq.callMethod) fbq.callMethod.apply(fbq, args as never);
				else fbq.queue!.push(args);
			} as Queue);
			w._fbq = w._fbq || fbq;
			fbq.push = fbq;
			fbq.loaded = true;
			fbq.version = "2.0";
			fbq.queue = [];
			load("https://connect.facebook.net/en_US/fbevents.js");
			fbq("init", c.fb);
			fbq("track", "PageView");
		}
		if (c.hs && (m || done.hs)) {
			(w._hsp = w._hsp || []).push([
				"setHubSpotConsent",
				{ analytics: a, advertisement: m, functionality: true },
			]);
			if (once("hs")) {
				w.disableHubSpotCookieBanner = true;
				load("https://js" + (c.hsEu ? "-eu1" : "") + ".hs-scripts.com/" + c.hs + ".js", {
					id: "hs-script-loader",
				});
			}
		}
		if (c.cf && (a || !c.cfWait) && once("cf")) {
			load("https://static.cloudflareinsights.com/beacon.min.js", {
				"data-cf-beacon": JSON.stringify({ token: c.cf }),
			});
		}
	};

	/** An enquiry happened. Only its kind is sent, never a number, an address or a form value. */
	const lead = (kind: string) => {
		layer.push({ event: "enquiry", enquiry_type: kind });
		if (done.gtag) gtag("event", "generate_lead", { lead_source: kind });
		if (done.fb) w.fbq!("track", kind === "form" ? "Lead" : "Contact");
	};

	// ── Banner ──────────────────────────────────────────────────

	let root: ShadowRoot | undefined;
	const part = <T extends HTMLElement>(selector: string) => root!.querySelector<T>(selector)!;
	const box = (name: string) => root!.querySelector<HTMLInputElement>("[name=" + name + "]");
	const esc = (text: string) => text.replace(/[&<>"]/g, (ch) => "&#" + ch.charCodeAt(0) + ";");

	const show = () => {
		part(".b").hidden = !state.ask;
		part(".s").hidden = state.ask || !c.btn;
	};

	const open = () => {
		const marketing = box("m");
		if (box("a")) box("a")!.checked = state.a;
		if (marketing) {
			marketing.checked = state.m;
			marketing.disabled = gpc;
		}
		part(".g").hidden = !gpc;
		part<HTMLDialogElement>("dialog").showModal();
	};

	/** Forget the cookies of tools the visitor no longer allows, on this host and its parent domains. */
	const wipe = (a: boolean, m: boolean) => {
		for (const pair of d.cookie.split("; ")) {
			const name = pair.split("=")[0]!;
			if (
				(!a && /^_(ga|gid|gat|cl[cs]k)/.test(name)) ||
				(!m && /^(_gcl|_fb[pc]|hubspotutk|__hs)/.test(name))
			) {
				const gone = name + "=;path=/;max-age=0";
				const host = here.hostname.split(".");
				d.cookie = gone;
				for (; host.length; host.shift()) d.cookie = gone + ";domain=" + host.join(".");
			}
		}
	};

	const choose = (a: boolean, m: boolean) => {
		m = m && !gpc;
		const before = state;
		saved = {
			v: c.v,
			a,
			m,
			d: day,
			id: Math.random().toString(36).slice(2) + Date.now().toString(36),
		};
		d.cookie =
			COOKIE +
			"=" +
			encodeChoice(saved) +
			";path=/;samesite=lax;max-age=" +
			c.days * 86400 +
			(here.protocol === "https:" ? ";secure" : "");
		// A beacon is sent in the background and survives the reload below.
		if (c.rec && w.navigator.sendBeacon) {
			w.navigator.sendBeacon(
				c.api + "record",
				new Blob([JSON.stringify({ id: saved.id, a, m, v: c.v, country: country || null })], {
					type: "application/json",
				}),
			);
		}
		// Taking consent back: the tools are told, their cookies are deleted, and because a
		// running tool cannot be stopped the page starts again without them.
		const restart = (before.a && !a) || (before.m && !m);
		state = { a, m, ask: false };
		apply(a, m);
		if (restart) {
			wipe(a, m);
			here.reload();
			return;
		}
		part<HTMLDialogElement>("dialog").close();
		show();
	};

	const build = () => {
		const t = c.t;
		const host = d.createElement("div");
		const button = (key: string, label: string) =>
			"<button type=button data-k=" + key + ">" + esc(label) + "</button>";
		const row = (key: string, name: string, text: string, tools?: string[]) =>
			tools && !tools.length
				? ""
				: "<label><input type=checkbox name=" +
					key +
					(tools ? "" : " checked disabled") +
					"> <b>" +
					esc(name) +
					"</b></label><p>" +
					esc(text + (tools ? " " + t.uses + " " + tools.join(", ") + "." : "")) +
					"</p>";
		host.id = "cookie-consent";
		// Out of the page flow, so adding it never moves the page.
		host.style.cssText = "position:fixed;z-index:2147483646";
		root = host.attachShadow({ mode: "open" });
		root.innerHTML =
			"<style>" +
			CSS +
			(c.scheme === "dark"
				? DARK
				: c.scheme === "auto"
					? "@media(prefers-color-scheme:dark){" + DARK + "}"
					: "") +
			'</style><div class="b ' +
			c.pos +
			'" role=region aria-label="' +
			esc(t.title) +
			'" hidden><div><h2>' +
			esc(t.title) +
			"</h2><p>" +
			esc(t.text) +
			(c.policy ? ' <a href="' + esc(c.policy) + '">' + esc(t.policy) + "</a>" : "") +
			"</p></div><div class=r>" +
			button("a", t.accept) +
			button("r", t.reject) +
			button("c", t.choose) +
			"</div></div><button type=button class=s data-k=c hidden>" +
			esc(t.settings) +
			"</button><dialog aria-labelledby=h><h2 id=h>" +
			esc(t.panel) +
			"</h2>" +
			row("n", t.need, t.needText) +
			row("a", t.an, t.anText, c.an) +
			row("m", t.mk, t.mkText, c.mk) +
			"<p class=g hidden>" +
			esc(t.gpc) +
			"</p><div class=r>" +
			button("s", t.save) +
			button("a", t.accept) +
			button("r", t.reject) +
			"</div></dialog>";
		root.addEventListener("click", (event) => {
			const key = (event.target as Element).getAttribute("data-k");
			if (key === "c") open();
			else if (key === "s") choose(!!box("a")?.checked, !!box("m")?.checked);
			else if (key) choose(key === "a", key === "a");
		});
		d.body.prepend(host);
	};

	// ── Start ───────────────────────────────────────────────────

	const run = () => {
		let zone: string | undefined;
		try {
			zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		} catch {
			// Unknown time zone: the visitor is asked.
		}
		state = decide(c, saved, mustAsk(country, zone), gpc, day);
		if (c.who) {
			build();
			show();
		}
		const go = () => apply(state.a, state.m);
		// Visitors who are not asked get their tags when the browser is idle.
		if (saved || state.ask || !w.requestIdleCallback) go();
		else w.requestIdleCallback(go);
	};

	const start = () => {
		// A signed-in editor has the EmDash toolbar in the page.
		if (d.getElementById("emdash-toolbar")) staff = true;
		const known = /^([A-Z]*)\.(\d+)$/.exec(local(GEO_KEY) || "");
		if (c.who !== 1) run();
		else if (known && day - +known[2]! < 30) {
			country = known[1];
			run();
		} else {
			w.fetch(c.api + "geo")
				.then((response) => response.json())
				.then((body: { data: { country?: unknown } }) => {
					const code = String(body.data.country || "");
					country = /^[A-Z]{2}$/.test(code) ? code : "";
					local(GEO_KEY, country + "." + day);
				})
				// The country stays unknown; the time zone decides.
				.catch(() => {})
				.then(run);
		}
	};

	d.addEventListener("click", (event) => {
		const target = event.target as Element;
		if (!target.closest) return;
		if (root && target.closest("[data-cookie-settings]")) {
			event.preventDefault();
			open();
		}
		const link = c.ev && target.closest('a[href^="tel:"],a[href^="mailto:"]');
		if (link) lead(link.getAttribute("href")![0] === "t" ? "phone" : "email");
	});

	if (c.ev) {
		// The official forms plugin marks its status line with this class when a form was sent.
		new MutationObserver((changes) => {
			for (const change of changes) {
				if ((change.target as Element).matches("[data-form-status].ec-form-status--success")) {
					lead("form");
				}
			}
		}).observe(d.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] });
	}

	if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", start);
	else start();
}
