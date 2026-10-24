// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { barInner } from "./bar.js";
import { styles } from "./css.js";
import { CLOSE } from "./icons.js";
import type { ClientConfig, ClientItem, PreviewAnswer } from "./types.js";

/**
 * The script that runs in the visitor's browser, in the page head.
 *
 * The respect rules live here, because the page itself is the same for every
 * visitor (it may come from a cache): at most one popup or slide-in per visit,
 * never while the cookie banner waits, a popup never on the first page of a
 * visit (unless allowed on computers), never while someone is typing, never
 * again for someone who signed up or clicked, and again after a close only
 * when the owner allows it. What this browser has done is kept in its own
 * storage and never sent anywhere.
 *
 * The order of work:
 * 1. At once, before the page draws: hide top bars this visitor should not
 *    see, so nothing moves.
 * 2. When the page has been read: wire up the bars, the click openers, and at
 *    most one popup or slide-in that opens by itself.
 */

/** This browser's record: per popup, when it was closed (c) or that it is done (d); forms signed up to (f). */
interface Memory {
	p: Record<string, { c?: number; d?: 1 }>;
	f: Record<string, 1>;
}
/** This visit: pages seen so far, and the popup or slide-in that already opened. */
interface Visit {
	n: number;
	s?: string;
}

export const MEMORY_KEY = "popups";
export const VISIT_KEY = "popups_visit";
const DAY = 86_400_000;
const TEXT_FIELD =
	"input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select,[contenteditable]";

interface Field {
	type: string;
	label: string;
	name: string;
	placeholder?: string;
	helpText?: string;
	required: boolean;
	defaultValue?: string;
	options?: Array<{ label: string; value: string }>;
	validation?: {
		minLength?: number;
		maxLength?: number;
		min?: number;
		max?: number;
		pattern?: string;
	};
	condition?: { field: string; op: string; value?: string };
}
interface Definition {
	pages: Array<{ fields: Field[] }>;
	settings: { spamProtection?: string; submitLabel?: string };
}
type Loaded = { ok: Definition } | { problem: "missing" | "paused" | "unsupported" };

export function boot(c: ClientConfig): void {
	const w = window;
	const d = document;
	const html = d.documentElement;
	const search = w.location.search;

	// Preview links of content and the visual editor are left alone.
	if (/[?&]_preview=/.test(search) || /(^|; )emdash-edit-mode=true/.test(d.cookie)) return;
	const previewId = /[?&]popups_preview=([a-z0-9]{4,40})/.exec(search)?.[1];
	const previewScheme = /[?&]scheme=(light|dark)/.exec(search)?.[1] as "light" | "dark" | undefined;

	const store = (area: "localStorage" | "sessionStorage", key: string, value?: unknown) => {
		try {
			const s = w[area];
			if (value !== undefined) s.setItem(key, JSON.stringify(value));
			return JSON.parse(s.getItem(key) || "null");
		} catch {
			return null;
		}
	};
	const memory: Memory = store("localStorage", MEMORY_KEY) || { p: {}, f: {} };
	memory.p = memory.p || {};
	memory.f = memory.f || {};
	const visit: Visit = store("sessionStorage", VISIT_KEY) || { n: 0 };
	const firstPage = visit.n === 0;
	// A preview changes nothing: it is not a page of a visit.
	if (!previewId) store("sessionStorage", VISIT_KEY, { ...visit, n: visit.n + 1 });
	const remember = (id: string, what: { c?: number; d?: 1 }, form?: string) => {
		if (previewId) return;
		memory.p[id] = { ...memory.p[id], ...what };
		if (form) memory.f[form] = 1;
		store("localStorage", MEMORY_KEY, memory);
	};

	const now = Date.now();
	const phone = () => w.innerWidth < 768;
	const days = (n: number) => (n === 1 ? "1 day" : n + " days");

	/**
	 * Why this browser would not see the popup now, in plain words; "" when it
	 * would. `auto` is for popups that open by themselves.
	 */
	const reason = (item: ClientItem, auto: boolean): string => {
		if (item.s && now < item.s) return "it has not started yet";
		if (item.e && now >= item.e) return "it has ended";
		if (item.d === 1 && phone()) return "it is set for computers only";
		if (item.d === 2 && !phone()) return "it is set for phones only";
		const mine = memory.p[item.i] || {};
		if (mine.d || (item.c.form && memory.f[item.c.form])) {
			return "this browser already " + (item.c.form ? "signed up" : "clicked its button");
		}
		if (mine.c) {
			const ago = Math.floor((now - mine.c) / DAY);
			if (!item.a)
				return (
					"this browser closed it " +
					(ago ? days(ago) + " ago" : "today") +
					"; it does not show again after a close"
				);
			if (now - mine.c < item.a * DAY) {
				return (
					"this browser closed it " +
					(ago ? days(ago) + " ago" : "today") +
					"; it shows again after a " +
					(item.a === 7 ? "week" : "month")
				);
			}
		}
		if (!auto || item.k === "bar") return "";
		if (item.k === "modal" && firstPage && !(item.f && !phone()))
			return "this is the first page of the visit";
		if (visit.s)
			return visit.s === item.i
				? "it already showed in this visit"
				: "another popup already showed in this visit";
		return "";
	};

	// ── 1. Top bars: decided before the page draws ──────────────────

	const bars = c.items.filter((item) => item.k === "bar");
	let barShown: ClientItem | undefined;
	if (!previewId && bars.length) {
		const hide = bars.filter((bar) => {
			if (barShown || reason(bar, true)) return true;
			barShown = bar;
			return false;
		});
		if (hide.length) {
			const style = d.createElement("style");
			style.textContent = hide
				.map((bar) => "#popups-bar-" + bar.i + "{display:none!important}")
				.join("");
			d.head.appendChild(style);
		}
	}

	// ── Shared pieces ───────────────────────────────────────────────

	let staff = false;
	const count = (item: ClientItem, event: "seen" | "sent" | "clicked" | "closed") => {
		if (staff || previewId || !w.navigator.sendBeacon) return;
		w.navigator.sendBeacon(
			c.api + "count",
			new Blob([JSON.stringify({ p: item.i, e: event, m: phone() })], { type: "application/json" }),
		);
	};
	const report = (item: ClientItem, problem: string) => {
		if (previewId) return;
		w.fetch(c.api + "problem", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ p: item.i, k: problem }),
		}).catch(() => {});
	};
	/** Count "seen" once at least half of it has been on screen for a second. */
	const watchSeen = (item: ClientItem, el: Element) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = () => {
			count(item, "seen");
			watcher?.disconnect();
		};
		const watcher =
			typeof IntersectionObserver === "function"
				? new IntersectionObserver(
						(entries) => {
							for (const entry of entries) {
								clearTimeout(timer);
								if (entry.isIntersecting) timer = setTimeout(done, 1000);
							}
						},
						{ threshold: 0.5 },
					)
				: undefined;
		if (watcher) watcher.observe(el);
		else timer = setTimeout(done, 1000);
	};
	const esc = (text: string) => text.replace(/[&<>"]/g, (ch) => "&#" + ch.charCodeAt(0) + ";");

	/** True while the cookie banner (our analytics plugin) is waiting for an answer. */
	const bannerWaits = () => {
		const phase = html.getAttribute("data-cookie-consent");
		if (phase) return phase !== "settled";
		const sheet = d.getElementById("cookie-consent")?.shadowRoot?.querySelector<HTMLElement>(".b");
		return !!sheet && !sheet.hidden;
	};
	const afterBanner = (go: () => void) => {
		if (!bannerWaits()) return go();
		let done = false;
		const once = () => {
			if (done || bannerWaits()) return;
			done = true;
			clearInterval(poll);
			d.removeEventListener("cookie-consent:settled", once);
			go();
		};
		d.addEventListener("cookie-consent:settled", once);
		// Older banners send no event; look again every second.
		const poll = setInterval(once, 1000);
	};

	// ── Forms from the forms plugin ─────────────────────────────────

	const loaded: Record<string, Promise<Loaded>> = {};
	const loadForm = (name: string): Promise<Loaded> =>
		(loaded[name] =
			loaded[name] ||
			w
				.fetch(c.forms + "definition", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: name }),
				})
				.then(async (response): Promise<Loaded> => {
					if (response.status === 410) return { problem: "paused" };
					if (!response.ok) return { problem: "missing" };
					const form = ((await response.json()) as { data: Definition }).data;
					const fields = form.pages.flatMap((page) => page.fields);
					// Turnstile and file uploads only work in a box in a page in this version.
					if (
						form.settings.spamProtection === "turnstile" ||
						fields.some((f) => f.type === "file")
					) {
						return { problem: "unsupported" };
					}
					return { ok: form };
				})
				.catch((): Loaded => ({ problem: "missing" })));

	let uid = 0;
	const fieldHtml = (f: Field): string => {
		const id = "pf" + ++uid;
		const v = f.validation || {};
		const attrs =
			' name="' +
			esc(f.name) +
			'"' +
			(f.required ? " required" : "") +
			(f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : "") +
			(v.minLength ? ' minlength="' + v.minLength + '"' : "") +
			(v.maxLength ? ' maxlength="' + v.maxLength + '"' : "") +
			(v.min !== undefined ? ' min="' + v.min + '"' : "") +
			(v.max !== undefined ? ' max="' + v.max + '"' : "") +
			(v.pattern ? ' pattern="' + esc(v.pattern) + '"' : "");
		const label =
			esc(f.label) + (f.required ? "" : ' <span class="opt">' + esc(c.t.optional) + "</span>");
		const help = f.helpText ? '<span class="help">' + esc(f.helpText) + "</span>" : "";
		const choice = (type: string) =>
			"<fieldset><legend>" +
			label +
			"</legend>" +
			(f.options || [])
				.map(
					(o) =>
						'<label class="c"><input type="' +
						type +
						'" name="' +
						esc(f.name) +
						'" value="' +
						esc(o.value) +
						'"' +
						(o.value === f.defaultValue ? " checked" : "") +
						(type === "radio" && f.required ? " required" : "") +
						"> " +
						esc(o.label) +
						"</label>",
				)
				.join("") +
			"</fieldset>";
		let body: string;
		if (f.type === "hidden")
			return '<input type="hidden"' + attrs + ' value="' + esc(f.defaultValue || "") + '">';
		if (f.type === "textarea")
			body =
				'<label for="' +
				id +
				'">' +
				label +
				'</label><textarea class="in" id="' +
				id +
				'"' +
				attrs +
				">" +
				esc(f.defaultValue || "") +
				"</textarea>";
		else if (f.type === "select")
			body =
				'<label for="' +
				id +
				'">' +
				label +
				'</label><select class="in" id="' +
				id +
				'"' +
				attrs +
				">" +
				(f.options || [])
					.map(
						(o) =>
							'<option value="' +
							esc(o.value) +
							'"' +
							(o.value === f.defaultValue ? " selected" : "") +
							">" +
							esc(o.label) +
							"</option>",
					)
					.join("") +
				"</select>";
		else if (f.type === "radio") body = choice("radio");
		else if (f.type === "checkbox-group") body = choice("checkbox");
		else if (f.type === "checkbox")
			body =
				'<label class="c"><input type="checkbox"' +
				attrs +
				' value="' +
				esc(f.defaultValue || "1") +
				'"> ' +
				esc(f.label) +
				"</label>";
		else {
			const type = ["email", "tel", "url", "number", "date"].includes(f.type) ? f.type : "text";
			const auto =
				type === "email" ? ' autocomplete="email"' : type === "tel" ? ' autocomplete="tel"' : "";
			body =
				'<label for="' +
				id +
				'">' +
				label +
				'</label><input class="in" type="' +
				type +
				'" id="' +
				id +
				'"' +
				attrs +
				auto +
				' value="' +
				esc(f.defaultValue || "") +
				'">';
		}
		return (
			"<div" +
			(f.condition
				? " data-condition='" + esc(JSON.stringify(f.condition)).replace(/'/g, "&#39;") + "'"
				: "") +
			">" +
			body +
			help +
			'<span class="err" data-error-for="' +
			esc(f.name) +
			'" aria-live="polite"></span></div>'
		);
	};
	/** Show or hide fields whose condition depends on another field, as the forms plugin does. */
	const conditions = (form: HTMLFormElement) => {
		form.querySelectorAll<HTMLElement>("[data-condition]").forEach((box) => {
			const rule = JSON.parse(box.getAttribute("data-condition") || "{}") as {
				field: string;
				op: string;
				value?: string;
			};
			const input = form.elements.namedItem(rule.field) as HTMLInputElement | null;
			const value = input ? input.value : "";
			const shown =
				rule.op === "eq"
					? value === (rule.value ?? "")
					: rule.op === "neq"
						? value !== (rule.value ?? "")
						: rule.op === "filled"
							? value !== ""
							: rule.op === "empty"
								? value === ""
								: true;
			box.hidden = !shown;
			box
				.querySelectorAll<HTMLInputElement>("input,select,textarea")
				.forEach((el) => (el.disabled = !shown));
		});
	};

	// ── Opening a popup or slide-in ─────────────────────────────────

	let open: ClientItem | undefined;

	const show = (item: ClientItem, form: Definition | undefined, clicked: boolean, tag?: string) => {
		if (open) return;
		open = item;
		const before = d.activeElement as HTMLElement | null;
		const host = d.createElement("div");
		host.id = "popups";
		const modal = item.k === "modal";
		// A box in a page (only ever drawn here by a preview) sits in the page's content.
		const inline = item.k === "inline";
		if (inline) host.setAttribute("data-popups-preview-box", "");
		// Out of the page flow and one layer below the cookie banner, so the banner always wins.
		else host.style.cssText = "position:fixed;z-index:2147483645";
		const root = host.attachShadow({ mode: "open" });
		const look = previewScheme || c.sc;
		const sheet = modal && phone() && !clicked;
		const hid = "ph" + item.i;
		const content = item.c;
		const picture = content.img
			? '<img class="' +
				(modal || inline ? "pic" : "thumb") +
				'" src="' +
				esc(content.img.u) +
				'" alt="' +
				esc(content.img.a) +
				'"' +
				(content.img.w ? ' width="' + content.img.w + '"' : "") +
				(content.img.h ? ' height="' + content.img.h + '"' : "") +
				">"
			: "";
		const no = content.no
			? '<button type="button" class="q" data-pp-close>' + esc(content.no) + "</button>"
			: "";
		const action = form
			? '<form class="f" novalidate>' +
				form.pages
					.flatMap((page) => page.fields)
					.map(fieldHtml)
					.join("") +
				(form.settings.spamProtection === "honeypot"
					? '<div class="hp" aria-hidden="true"><label>Leave blank<input name="_hp" tabindex="-1" autocomplete="off"></label></div>'
					: "") +
				'<p class="msg" role="alert"></p><div class="r"><button type="submit" class="p">' +
				esc(form.settings.submitLabel || "Submit") +
				"</button>" +
				no +
				"</div></form>"
			: '<div class="r">' +
				(content.b
					? '<a class="p" href="' + esc(content.b.u) + '" data-pp-go>' + esc(content.b.l) + "</a>"
					: "") +
				no +
				"</div>";
		const inner =
			(inline
				? ""
				: '<button type="button" class="x' +
					(modal && content.img && !sheet ? " on-pic" : "") +
					'" data-pp-close aria-label="' +
					esc(c.t.close) +
					'">' +
					CLOSE +
					"</button>") +
			(modal || inline ? picture : "") +
			(tag ? '<p class="pv">' + esc(tag) + "</p>" : "") +
			(modal || inline ? "" : picture) +
			'<h2 id="' +
			hid +
			'" tabindex="-1">' +
			esc(content.h) +
			"</h2>" +
			(content.x ? "<p>" + esc(content.x) + "</p>" : "") +
			action;
		const theme = "<style>" + styles(look, c.col) + "</style>";
		if (modal) {
			root.innerHTML =
				theme +
				'<dialog class="pp modal' +
				(sheet ? " sheet" : "") +
				(form ? " hf" : "") +
				'" aria-labelledby="' +
				hid +
				'">' +
				inner +
				"</dialog>";
		} else {
			root.innerHTML =
				theme +
				'<div class="pp ' +
				(inline ? "box" : "slide" + (c.left ? " l" : "")) +
				'" role="region" aria-labelledby="' +
				hid +
				'">' +
				inner +
				'</div><p class="sr" role="status"></p>';
		}
		const box = root.querySelector<HTMLElement>(".pp")!;
		if (inline) {
			// At the top of the page's content, lined up with the page's text as a visitor sees
			// the block in a text column: the left edge and width of the first paragraph wide
			// enough to be body text (else the main heading). Measured, so it never has to go
			// inside a hero or a card; measured again when the window changes size.
			const main = d.querySelector("main") || d.body;
			main.prepend(host);
			const align = () => {
				if (!host.isConnected) {
					removeEventListener("resize", align);
					return;
				}
				const text =
					Array.from(main.querySelectorAll("p")).find(
						(p) => p.getBoundingClientRect().width >= 240,
					) || main.querySelector("h1");
				box.style.marginLeft = "";
				box.style.maxWidth = "";
				if (!text) {
					box.classList.add("c");
					return;
				}
				const at = text.getBoundingClientRect();
				box.style.marginLeft = Math.max(0, at.left - box.getBoundingClientRect().left) + "px";
				box.style.maxWidth = Math.min(640, at.width) + "px";
			};
			align();
			addEventListener("resize", align);
		} else d.body.appendChild(host);

		let gone = false;
		const close = (reasonClosed: "closed" | "done") => {
			if (gone) return;
			gone = true;
			if (reasonClosed === "closed") {
				remember(item.i, { c: Date.now() });
				count(item, "closed");
			}
			if (modal) (box as HTMLDialogElement).close();
			host.remove();
			html.style.scrollPaddingBottom = "";
			open = undefined;
			if (before && before.focus && d.contains(before)) before.focus();
		};
		let finished = false;
		root.addEventListener("click", (event) => {
			const target = event.target as Element;
			if (target.closest("[data-pp-close]")) close(finished ? "done" : "closed");
			else if (target.closest("[data-pp-go]")) {
				remember(item.i, { d: 1 });
				count(item, "clicked");
				if (previewId) event.preventDefault();
			}
			// A click on the dimmed page around a popup closes it.
			else if (modal && target === box) {
				const r = box.getBoundingClientRect();
				const e = event as MouseEvent;
				if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
					close(finished ? "done" : "closed");
			}
		});
		root.addEventListener("keydown", (event) => {
			if ((event as KeyboardEvent).key === "Escape" && !inline) {
				event.preventDefault();
				close(finished ? "done" : "closed");
			}
		});
		if (modal) {
			box.addEventListener("cancel", (event) => {
				event.preventDefault();
				close(finished ? "done" : "closed");
			});
			(box as HTMLDialogElement).showModal();
			// Focus goes to the first field; on a phone sheet to the heading, so no keyboard jumps up uninvited.
			const first = sheet
				? null
				: box.querySelector<HTMLElement>(".in,.f input:not([type=hidden])");
			(first || box.querySelector<HTMLElement>("h2"))?.focus();
		} else if (!inline) {
			// A slide-in leaves the page usable: it does not take focus. Its heading is announced once,
			// and the page keeps whatever has focus clear of it.
			root.querySelector(".sr")!.textContent = content.h;
			html.style.scrollPaddingBottom = box.offsetHeight + 16 + "px";
		}
		watchSeen(item, box);

		const formEl = box.querySelector<HTMLFormElement>("form");
		if (!formEl || !form) return;
		conditions(formEl);
		formEl.addEventListener("input", () => conditions(formEl));
		formEl.addEventListener("change", () => conditions(formEl));
		formEl.addEventListener("submit", async (event) => {
			event.preventDefault();
			const message = formEl.querySelector(".msg")!;
			message.textContent = "";
			if (!formEl.checkValidity()) {
				formEl.querySelectorAll<HTMLInputElement>("input,select,textarea").forEach((el) => {
					const err = formEl.querySelector('[data-error-for="' + el.name + '"]');
					if (err) err.textContent = el.validity.valid ? "" : el.validationMessage || c.t.required;
				});
				formEl.querySelector<HTMLElement>(":invalid")?.focus();
				return;
			}
			const button = formEl.querySelector<HTMLButtonElement>("[type=submit]")!;
			const label = button.textContent;
			let answer: { message?: string; redirect?: string } = {};
			if (!previewId) {
				button.disabled = true;
				button.textContent = c.t.sending;
				// The same shape as the forms plugin's own script sends; several ticks of one name become a list.
				const data: Record<string, unknown> = {};
				for (const [key, value] of new FormData(formEl)) {
					if (typeof value !== "string") continue;
					const had = data[key];
					data[key] =
						had === undefined ? value : Array.isArray(had) ? [...had, value] : [had, value];
				}
				// The form's own hidden campaign fields, if it has them and they are empty: the same
				// tags as the popup's button links, so Forms, its emails and Lead Delivery show the popup.
				const tags: Record<string, string> = {
					utm_source: "popups",
					utm_medium: item.k === "bar" ? "top-bar" : item.k === "slide" ? "slide-in" : "popup",
					utm_campaign: item.n,
					page_url: w.location.origin + w.location.pathname,
				};
				for (const f of form.pages.flatMap((page) => page.fields))
					if (f.type === "hidden" && tags[f.name] && !data[f.name]) data[f.name] = tags[f.name];
				try {
					const response = await w.fetch(c.forms + "submit", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ formId: content.form, data }),
					});
					const body = (await response.json()) as {
						data?: typeof answer;
						error?: { message?: string };
					};
					if (!response.ok || !body.data) throw new Error(body.error?.message || "");
					answer = body.data;
				} catch (error) {
					button.disabled = false;
					button.textContent = label;
					message.textContent = (error as Error).message || c.t.failed;
					return;
				}
				remember(item.i, { d: 1 }, content.form);
				count(item, "sent");
				// Tell the page: the analytics plugin counts a lead when a forms status line turns to success.
				const marker = d.createElement("div");
				marker.setAttribute("data-form-status", "");
				marker.className = "ec-form-status";
				marker.hidden = true;
				d.body.appendChild(marker);
				marker.className = "ec-form-status ec-form-status--success";
				d.dispatchEvent(
					new CustomEvent("emdash:form-submitted", {
						detail: { formId: content.form, source: "popups" },
					}),
				);
				if (answer.redirect && /^(https?:|\/(?!\/))/i.test(answer.redirect)) {
					w.location.href = answer.redirect;
					return;
				}
			}
			finished = true;
			// The box keeps its height and swaps to the thank-you; it never closes by itself.
			box.style.minHeight = box.offsetHeight + "px";
			box.classList.add("done");
			const thanks = previewId ? "Preview: nothing was sent." : answer.message || "";
			formEl.outerHTML =
				'<div class="ok" role="status"><span class="tick"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4"/></svg></span><h2 tabindex="-1">' +
				esc(content.ty || "") +
				"</h2>" +
				(thanks ? "<p>" + esc(thanks) + "</p>" : "") +
				'<div class="r"><button type="button" class="p" data-pp-close>' +
				esc(c.t.close) +
				"</button></div></div>";
			// The thank-you heading takes over the name of the popup.
			box.querySelector<HTMLElement>("h2#" + hid)?.remove();
			box.querySelector(".ok h2")!.id = hid;
			box
				.querySelectorAll(":scope > p:not(.pv),:scope > .pic,:scope > .thumb")
				.forEach((el) => el.remove());
			box.querySelector<HTMLElement>(".ok h2")?.focus();
		});
	};

	/** Open a popup once everything allows it: the form is there and nobody is typing. */
	const attempt = (item: ClientItem, clicked: boolean) => {
		if (open) return;
		const go = (form?: Definition) => {
			const typing = d.activeElement?.matches?.(TEXT_FIELD);
			if (!clicked && typing) {
				// Never interrupt someone typing; look again a little after they leave the field.
				d.addEventListener("focusout", () => setTimeout(() => attempt(item, false), 1500), {
					once: true,
				});
				return;
			}
			if (!clicked && bannerWaits()) return afterBanner(() => attempt(item, false));
			if (!clicked) store("sessionStorage", VISIT_KEY, { n: visit.n + 1, s: item.i });
			show(item, form, clicked);
		};
		if (!item.c.form) return go();
		loadForm(item.c.form).then((result) => {
			if ("ok" in result) go(result.ok);
			// Visitors see nothing broken: the popup stays closed and the owner is told.
			else report(item, result.problem);
		});
	};

	/** Wait for the moment a popup that opens by itself may open. */
	const arm = (item: ClientItem) => {
		afterBanner(() => {
			// The timer starts after the cookie banner has been answered.
			if (item.c.form) setTimeout(() => loadForm(item.c.form!), 0);
			if (item.t === "read") {
				let fired = false;
				const fire = () => {
					if (fired) return;
					fired = true;
					clearTimeout(timer);
					w.removeEventListener("scroll", onScroll);
					attempt(item, false);
				};
				const onScroll = () => {
					const room = html.scrollHeight - w.innerHeight;
					if (room <= 0 || w.scrollY / room >= 0.4) fire();
				};
				const timer = setTimeout(fire, 30_000);
				w.addEventListener("scroll", onScroll, { passive: true });
			} else if (item.t === "exit") {
				// Computers only: armed after ten seconds, when the pointer leaves through the top.
				setTimeout(() => {
					const leave = (event: MouseEvent) => {
						if (event.relatedTarget || event.clientY > 0) return;
						d.removeEventListener("mouseout", leave);
						attempt(item, false);
					};
					d.addEventListener("mouseout", leave);
				}, 10_000);
			}
		});
	};

	// ── 2. When the page has been read ──────────────────────────────

	const start = () => {
		// A browser that has been signed in to the admin is staff: it sees popups but is never counted.
		try {
			staff = !!w.localStorage.getItem("emdash-editor");
		} catch {
			// Storage blocked: treated as a visitor.
		}
		if (d.getElementById("emdash-toolbar")) staff = true;

		if (previewId) {
			w.fetch(c.api + "preview", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({ id: previewId }),
				credentials: "same-origin",
			})
				.then((response) => (response.ok ? response.json() : null))
				.then(async (body: { data?: PreviewAnswer } | null) => {
					const answer = body?.data;
					// No session: a visitor who copied the link sees nothing.
					if (!answer) return;
					if (previewScheme) html.style.colorScheme = previewScheme;
					const item = { ...answer.item };
					const kind = item.k;
					const inline = kind === "inline";
					// Opened by a click: no first-page or one-per-visit rule, and centred on a phone too.
					const auto = item.t !== "click";
					let form: Definition | undefined;
					if (item.c.form) {
						const result = await loadForm(item.c.form);
						if ("ok" in result) form = result.ok;
						else
							item.c = {
								...item.c,
								form: undefined,
								x:
									item.c.x +
									(inline && result.problem === "unsupported"
										? " [In the page the form shows in full; this preview cannot draw a form with Turnstile or a file upload.]"
										: " [The form cannot be shown: " +
											(result.problem === "paused"
												? "it is paused under Forms"
												: result.problem === "unsupported"
													? "it uses Turnstile or a file upload"
													: "it was not found") +
											".]"),
							};
					}
					/** Why a real visitor would not see it here and now, in plain words; "" when they would. */
					const hidden = (): string => {
						if (answer.unfinished)
							return 'it is not finished yet (press "Save and finish" in step 4)';
						if (answer.off) return "it is turned off";
						if (!c.here) return "it does not show on this page";
						// A box in a page shows to everyone inside its dates: nothing else applies.
						let why =
							item.s && now < item.s
								? "it has not started yet"
								: item.e && now >= item.e
									? "it has ended"
									: inline
										? ""
										: reason(item, auto);
						// A click opens it even after a close or a sign-up: only its dates and devices hold it back.
						if (!auto && !why.startsWith("it ")) why = "";
						if (why === "it has not started yet" && answer.startText)
							return "it starts on " + answer.startText;
						if (why === "it has ended" && answer.endText) return "it ended on " + answer.endText;
						if (why || inline) return why;
						if (item.t === "exit" && phone())
							return "phones never see one that opens when they are about to leave";
						if (kind === "bar") {
							// Only the first top bar a visitor may see is shown.
							const first = bars.find((bar) => !reason(bar, true));
							return first && first.i !== item.i ? "another top bar shows first on this page" : "";
						}
						if (!auto) return "";
						if (bannerWaits()) return "the cookie banner is still waiting for an answer";
						const first = c.items.find(
							(each) =>
								each.k !== "bar" &&
								(each.t === "read" || (each.t === "exit" && !phone())) &&
								!reason(each, true),
						);
						return first && first.i !== item.i ? "another popup opens first on this page" : "";
					};
					const when = () =>
						item.t === "click"
							? "when they click its button or link"
							: item.t === "exit"
								? "when they are about to leave (computers only)"
								: item.t === "load"
									? "as the page opens"
									: kind === "modal" && !(item.f && !phone())
										? "after they have read a while, from their second page"
										: "after they have read a while";
					const tag = () => {
						const why = hidden();
						const place =
							'where an editor places the "Popups box" block; this preview puts it at the top of the content.';
						return (
							"Preview: nothing is counted. " +
							(why ? "Hidden for a real visitor: " + why + ". " : "") +
							(inline
								? (why ? "On a page it shows " : "A real visitor sees it ") + place
								: why
									? ""
									: "A real visitor sees it " + when() + ".")
						).trim();
					};
					const draw = () => {
						d.getElementById("popups")?.remove();
						d.getElementById("popups-bar-" + item.i)?.remove();
						html.style.scrollPaddingBottom = "";
						open = undefined;
						if (kind !== "bar") return show(item, form, !auto, tag());
						// A top bar as a visitor gets it: the server's own markup, at the start of the page.
						const bar = d.createElement("div");
						bar.id = "popups-bar-" + item.i;
						bar.setAttribute("data-popups-bar", item.i);
						bar.style.display = "block";
						const root = bar.attachShadow({ mode: "open" });
						root.innerHTML =
							"<style>" +
							styles(previewScheme || c.sc, c.col) +
							"</style>" +
							barInner(item, c.t.close, tag());
						root.addEventListener("click", (event) => {
							const target = event.target as Element;
							if (target.closest("[data-pp-close]")) bar.remove();
							else if (target.closest("[data-pp-go]")) event.preventDefault();
						});
						d.body.prepend(bar);
					};
					draw();
					// Narrowing the window past a phone's width changes the layout and maybe the answer.
					let small = phone();
					w.addEventListener("resize", () => {
						// Once closed, it stays closed.
						if (
							phone() === small ||
							!d.getElementById(kind === "bar" ? "popups-bar-" + item.i : "popups")
						)
							return;
						small = phone();
						draw();
					});
				})
				.catch(() => {});
			return;
		}

		// Top bars: close, follow, count.
		for (const host of d.querySelectorAll<HTMLElement>("[data-popups-bar]")) {
			const item = bars.find((bar) => bar.i === host.getAttribute("data-popups-bar"));
			if (!item || item !== barShown || !host.shadowRoot) continue;
			const bar = host.shadowRoot.querySelector(".bar")!;
			watchSeen(item, bar);
			host.shadowRoot.addEventListener("click", (event) => {
				const target = event.target as Element;
				if (target.closest("[data-pp-close]")) {
					remember(item.i, { c: Date.now() });
					count(item, "closed");
					// The visitor asked for this, so the page may move up.
					host.style.setProperty("display", "none", "important");
				} else if (target.closest("[data-pp-go]")) {
					remember(item.i, { d: 1 });
					count(item, "clicked");
				}
			});
		}

		// Openers: a link to #popup-<name>, or anything with data-popup="<name>".
		const clickable = c.items.filter((item) => item.k !== "bar" && item.t === "click");
		if (clickable.length) {
			d.addEventListener("click", (event) => {
				const target = (event.target as Element).closest?.("a[href*='#popup-'],[data-popup]");
				if (!target) return;
				const name =
					target.getAttribute("data-popup") ||
					(target.getAttribute("href") || "").split("#popup-")[1];
				const item = clickable.find((each) => each.n === name);
				if (!item || reason(item, false).startsWith("it ")) return;
				event.preventDefault();
				attempt(item, true);
			});
		}

		// At most one popup or slide-in that opens by itself: the first in the list that may.
		const auto = c.items.find(
			(item) =>
				item.k !== "bar" &&
				(item.t === "read" || (item.t === "exit" && !phone())) &&
				!reason(item, true),
		);
		if (auto) arm(auto);
	};

	if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", start);
	else start();
}
