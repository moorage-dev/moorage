// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

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

// Dark defaults, used alone or inside a media query depending on the setting. A theme's
// --cookie-consent-* variables still win over them.
const DARK =
	":host{--g:var(--cookie-consent-background,#1c1c1c);--f:var(--cookie-consent-text,#f2f2f2);--e:var(--cookie-consent-rule,#6b6b6b);--w:0 -12px 32px -16px rgb(0 0 0/.75)}";

// A cookie, drawn in the text colour.
const ICON =
	'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="10" cy="9" r="1" fill="currentColor"/><circle cx="6.5" cy="10.5" r=".8" fill="currentColor"/></svg>';

// The look. Colours and fonts come from a theme's --cookie-consent-* variables when it sets
// them (they cross into the shadow root), else from neutral defaults; the owner's colours
// from the admin win over both. Accept and Reject share one class, so neither is favoured.
// System fonts unless the theme names its own; nothing is fetched.
const CSS =
	':host{--g:var(--cookie-consent-background,#fff);--f:var(--cookie-consent-text,#141414);--e:var(--cookie-consent-rule,#8a8a8a);--x:var(--cookie-consent-accent,var(--f));--y:var(--cookie-consent-accent-text,var(--g));--z:var(--x);--k:var(--cookie-consent-font,system-ui,-apple-system,"Segoe UI",sans-serif);--h:var(--cookie-consent-heading-font,var(--k));--w:0 -12px 32px -16px rgb(0 0 0/.28)}' +
	"*{box-sizing:border-box}h2,p{margin:0}[hidden]{display:none!important}" +
	".b,.s,dialog{font:16px/1.5 var(--k);color:var(--f);background:var(--g);border:1px solid var(--e)}" +
	"h2{font:600 19px/1.3 var(--h)}a{color:inherit}" +
	// The sheet: full width, a thin rule on top, its content kept to the page's width.
	// Set apart from the page: a surface a little darker (or lighter) than the background, and a soft
	// shadow above it. In light themes the shadow does most of the work, in dark ones the surface.
	".b{position:fixed;inset:auto 0 0;max-height:85vh;overflow:auto;padding:18px 24px calc(18px + env(safe-area-inset-bottom));border-width:1px 0 0;background:var(--cookie-consent-surface,color-mix(in srgb,var(--g) 92%,var(--f)));box-shadow:var(--cookie-consent-shadow,var(--w))}" +
	".i{max-width:var(--cookie-consent-width,1200px);margin:0 auto;display:flex;flex-wrap:wrap;gap:14px 32px;align-items:center}.i>div:first-child{flex:1 1 380px}.i p{margin-top:4px;max-width:66ch}" +
	// The corner boxes.
	".left,.right{inset:auto auto 16px 16px;width:min(420px,calc(100vw - 32px));padding:20px;border-width:1px;border-radius:10px}.right{inset:auto 16px 16px auto}.left .i>div:first-child,.right .i>div:first-child{flex-basis:100%}" +
	".r{display:flex;flex-wrap:wrap;gap:10px;align-items:center}" +
	"button{font:inherit;cursor:pointer}" +
	".p{font-weight:600;min-height:44px;padding:8px 18px;color:var(--y);background:var(--x);border:2px solid var(--z);border-radius:6px}" +
	".q{min-height:44px;padding:8px 6px;color:var(--f);background:none;border:0;text-decoration:underline;text-underline-offset:3px}" +
	// The small button that reopens the choice.
	// The small button that reopens the choice: a pill with a cookie icon, fixed in a bottom corner of the
	// screen, on the banner's surface with an edge and a soft shadow (as in the approved design).
	".s{position:fixed;inset:auto auto calc(14px + env(safe-area-inset-bottom)) 14px;display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 14px;border-radius:999px;background:var(--cookie-consent-surface,color-mix(in srgb,var(--g) 92%,var(--f)));box-shadow:0 2px 10px rgb(0 0 0/.12);font:500 13px/1 var(--k);cursor:pointer}.s svg{width:16px;height:16px;flex:none}.sr{inset:auto 14px calc(14px + env(safe-area-inset-bottom)) auto}" +
	":focus-visible{outline:3px solid var(--f);outline-offset:2px}" +
	"dialog{width:min(520px,calc(100vw - 32px));max-height:90vh;padding:24px;border-radius:10px}dialog::backdrop{background:#0008}" +
	".o{display:grid;grid-template-columns:1fr auto;gap:2px 16px;align-items:center;margin-top:18px;padding-top:14px;border-top:1px solid var(--e)}.o p{grid-column:1/-1;font-size:15px}.o em{font-style:normal;font-size:14px}" +
	// Switches: a checkbox drawn as a switch, announced as one.
	// Off: an outline with the knob on the left, in the text colour. On: filled with the button colour.
	"input{appearance:none;flex:none;width:46px;height:28px;margin:0;border:2px solid var(--f);border-radius:14px;background:transparent;position:relative;cursor:pointer}input::before{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--f);transition:left .15s}input:checked{background:var(--x);border-color:var(--x)}input:checked::before{left:21px;background:var(--y)}input:disabled{opacity:.5;cursor:default}" +
	"dialog .r{margin-top:22px}" +
	".v{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.w{display:inline-block;margin-bottom:8px;padding:2px 8px;font-size:13px;border:1px dashed var(--f);border-radius:4px}" +
	// Phones: a smaller sheet, the two answers side by side, Choose under them.
	"@media(max-width:600px){.b,.left,.right{inset:auto 0 0;width:auto;padding:14px 16px calc(14px + env(safe-area-inset-bottom));border-width:1px 0 0;border-radius:0}h2{font-size:17px}.i p{font-size:15px;line-height:1.45}.b .r{width:100%}.b .p{flex:1 1 0}dialog{padding:20px}dialog .r{flex-direction:column;align-items:stretch}}" +
	"@media(prefers-reduced-motion:no-preference){.b{animation:i .25s}}@keyframes i{from{opacity:0;transform:translateY(8px)}}";

export function boot(c: ClientConfig): void {
	const w = window as unknown as Window & Globals;
	const d = document;
	const here = w.location;

	// Preview links and the visual editor are never tracked and never show the banner.
	if (/[?&]_preview=/.test(here.search) || /(^|; )emdash-edit-mode=true/.test(d.cookie)) return;
	// The admin's "Preview the banner": shown at once, in light or dark, nothing saved, nothing loaded.
	const preview = /[?&]cookie_preview=(light|dark)/.exec(here.search)?.[1] as
		| "light"
		| "dark"
		| undefined;

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
		if (preview) return;
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

	let linkOnScreen = false;
	const show = () => {
		const sheet = part(".b");
		sheet.hidden = !state.ask;
		// While a theme link with data-cookie-settings is on screen it does the same job, so the button
		// steps aside; it comes back when the link scrolls away.
		part(".s").hidden = state.ask || !c.btn || linkOnScreen;
		// Keep whatever has keyboard focus scrolled clear of the sheet, without moving the page.
		d.documentElement.style.scrollPaddingBottom = state.ask ? sheet.offsetHeight + "px" : "";
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
		if (preview) {
			state = { a, m, ask: false };
			part<HTMLDialogElement>("dialog").close();
			show();
			part(".v").textContent = c.t.saved;
			return;
		}
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
		part(".v").textContent = c.t.saved;
	};

	const build = () => {
		const t = c.t;
		// A preview forces the light or dark look it was asked for.
		const scheme = preview || c.scheme;
		// The owner's colours from the admin, already checked for contrast on the server. A background
		// chosen there is used exactly as chosen, not tinted.
		const colors = (o?: ClientConfig["col"]) =>
			o
				? ":host{" +
					(o.g ? "--g:" + o.g + ";--f:" + o.f + ";" : "") +
					(o.x ? "--x:" + o.x + ";--y:" + o.y + ";--z:" + (o.z || o.x) : "") +
					"}" +
					(o.g ? ".b{background:var(--g)}" : "")
				: "";
		const host = d.createElement("div");
		const button = (key: string, label: string, kind = "p") =>
			"<button type=button class=" + kind + " data-k=" + key + ">" + esc(label) + "</button>";
		// Essential is always on: said in words, not shown as a ticked box that cannot be changed.
		const row = (key: string, name: string, text: string, tools?: string[]) =>
			tools && !tools.length
				? ""
				: "<div class=o><b id=l" +
					key +
					">" +
					esc(name) +
					"</b>" +
					(tools
						? "<input type=checkbox role=switch name=" + key + " aria-labelledby=l" + key + ">"
						: "<em>" + esc(t.always) + "</em>") +
					"<p>" +
					esc(text + (tools ? " " + t.uses + " " + tools.join(", ") + "." : "")) +
					"</p></div>";
		host.id = "cookie-consent";
		// Out of the page flow, so adding it never moves the page.
		host.style.cssText = "position:fixed;z-index:2147483646";
		root = host.attachShadow({ mode: "open" });
		root.innerHTML =
			"<style>" +
			CSS +
			(scheme === "dark"
				? DARK + colors(c.colDark || c.col)
				: scheme === "auto"
					? "@media(prefers-color-scheme:dark){" +
						DARK +
						"}" +
						colors(c.col) +
						(c.colDark ? "@media(prefers-color-scheme:dark){" + colors(c.colDark) + "}" : "")
					: colors(c.col)) +
			'</style><div class="b ' +
			c.pos +
			'" role=region aria-label="' +
			esc(t.title) +
			'" hidden><div class=i><div>' +
			(preview ? "<p class=w>Preview: nothing is saved and no tool loads.</p>" : "") +
			"<h2>" +
			esc(t.title) +
			"</h2><p>" +
			esc(t.text) +
			(c.policy ? ' <a href="' + esc(c.policy) + '">' + esc(t.policy) + "</a>" : "") +
			"</p></div><div class=r>" +
			button("a", t.accept) +
			button("r", t.reject) +
			button("c", t.choose, "q") +
			'</div></div></div><button type=button class="s' +
			(c.btnRight ? " sr" : "") +
			'" data-k=c aria-label="Cookie settings" hidden>' +
			ICON +
			"<span>" +
			esc(t.settings) +
			"</span></button><p class=v role=status></p><dialog aria-labelledby=h><h2 id=h>" +
			esc(t.panel) +
			"</h2>" +
			row("n", t.need, t.needText) +
			row("a", t.an, t.anText, c.an) +
			row("m", t.mk, t.mkText, c.mk) +
			"<p class=g hidden>" +
			esc(t.gpc) +
			"</p><div class=r>" +
			button("s", t.save) +
			button("r", t.reject) +
			button("a", t.accept) +
			"</div></dialog>";
		root.addEventListener("click", (event) => {
			// The icon and label inside a button count as the button.
			const key = (event.target as Element).closest("[data-k]")?.getAttribute("data-k");
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
		state = preview
			? { a: false, m: false, ask: true }
			: decide(c, saved, mustAsk(country, zone, c.who === 3), gpc, day);
		if (c.who || preview) {
			build();
			show();
			const links = d.querySelectorAll("[data-cookie-settings]");
			if (links.length && typeof IntersectionObserver === "function") {
				const seen = new Set<Element>();
				const watch = new IntersectionObserver((entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) seen.add(entry.target);
						else seen.delete(entry.target);
					}
					linkOnScreen = seen.size > 0;
					show();
				});
				links.forEach((link) => watch.observe(link));
			}
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
		if (preview) {
			// The page follows too, for themes that colour the banner with light-dark().
			d.documentElement.style.colorScheme = preview;
			run();
		}
		// Only the regional rules need the visitor's country.
		else if (c.who !== 1 && c.who !== 3) run();
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
