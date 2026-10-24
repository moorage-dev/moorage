// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { gzipSync } from "node:zlib";

import type { RouteContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	colorProblems,
	isSafeLink,
	normalizeStore,
	parsePaths,
	pathMatches,
	showsOn,
	simplify,
	uniqueHandle,
} from "../src/config.js";
import { checkForm, describeCheck, judgeDefinition, listForms } from "../src/forms.js";
import { clientItem, isPopupPreview, pageFragments, scriptJson, tagLink } from "../src/fragment.js";
import { alertEmail, createPlugin, publicMediaUrl } from "../src/index.js";
import { addCount, parseCount, rate, readRows, toCsv, totals } from "../src/stats.js";
import { describeMoment, fromMoment, toMoment } from "../src/time.js";
import { fakeContext, popup } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 16, 12);
const page = (
	path: string,
	extra: Partial<{ url: string; collection: string; editMode: boolean; preview: boolean }> = {},
) => ({
	path,
	url: `https://hartleys.test${path}`,
	editMode: false,
	preview: false,
	...extra,
});

describe("time in the site's time zone", () => {
	it("turns a day and a half-hour into the exact moment, and back", () => {
		const ms = toMoment("2026-11-01", "09:00", "Europe/London")!;
		expect(new Date(ms).toISOString()).toBe("2026-11-01T09:00:00.000Z");
		const summer = toMoment("2026-07-01", "09:30", "Europe/London")!;
		expect(new Date(summer).toISOString()).toBe("2026-07-01T08:30:00.000Z");
		expect(fromMoment(summer, "Europe/London")).toEqual({ date: "2026-07-01", clock: "09:30" });
		expect(new Date(toMoment("2026-12-31", "18:00", "America/New_York")!).toISOString()).toBe(
			"2026-12-31T23:00:00.000Z",
		);
	});

	it("handles the nights the clocks change", () => {
		// 01:30 does not exist in London on 29 March 2026: moved on by the hour that was skipped.
		expect(new Date(toMoment("2026-03-29", "01:30", "Europe/London")!).toISOString()).toBe(
			"2026-03-29T01:30:00.000Z",
		);
		// 01:30 happens twice on 25 October 2026: the first one (still summer time).
		expect(new Date(toMoment("2026-10-25", "01:30", "Europe/London")!).toISOString()).toBe(
			"2026-10-25T00:30:00.000Z",
		);
	});

	it("refuses days that do not exist and describes moments plainly", () => {
		expect(toMoment("2026-02-30", "09:00", "UTC")).toBeNull();
		expect(toMoment("tomorrow", "09:00", "UTC")).toBeNull();
		expect(describeMoment(Date.UTC(2026, 11, 27, 14), "UTC", NOW)).toBe("27 Dec, 14:00");
		expect(describeMoment(Date.UTC(2027, 0, 2), "UTC", NOW)).toBe("2 Jan 2027");
	});
});

describe("checks on what is saved", () => {
	it("allows only safe links", () => {
		expect(isSafeLink("/cakes")).toBe(true);
		expect(isSafeLink("https://shop.example/x")).toBe(true);
		expect(isSafeLink("mailto:jo@example.com")).toBe(true);
		expect(isSafeLink("tel:+44 20 7946 0000")).toBe(true);
		expect(isSafeLink("javascript:alert(1)")).toBe(false);
		expect(isSafeLink("//evil.example")).toBe(false);
		expect(isSafeLink('/a"onmouseover=x')).toBe(false);
	});

	it("refuses unreadable colours with the reason", () => {
		expect(colorProblems({ background: "#fbf8f3", text: "#2b2420", accent: "#8a3b12" })).toEqual(
			[],
		);
		expect(colorProblems({ background: "#ffffff", text: "#bbbbbb", accent: "#8a3b12" })[0]).toMatch(
			/hard to read/,
		);
		expect(colorProblems({ background: "#ffffff", text: "", accent: "" })[0]).toMatch(/all three/);
	});

	it("reads addresses as plain prefixes", () => {
		expect(parsePaths("/contact\nhttps://x.test/order?a=1\n/\n cakes/ ")).toEqual([
			"/contact",
			"/order",
			"/cakes/",
		]);
		expect(pathMatches("/cakes/lemon", "/cakes/")).toBe(true);
		expect(pathMatches("/cakes", "/cakes/")).toBe(true);
		expect(pathMatches("/cakeshop", "/cakes")).toBe(false);
		expect(pathMatches("/contact/thanks", "/contact")).toBe(true);
	});

	it("gives every popup its own simple name", () => {
		expect(simplify("Monthly letter!")).toBe("monthly-letter");
		expect(simplify("Crème brûlée")).toBe("creme-brulee");
		expect(uniqueHandle("Offer", ["offer", "offer-2"])).toBe("offer-3");
		const store = normalizeStore({
			popups: [popup({ id: "aaaa1111" }), popup({ id: "bbbb2222" })],
		});
		expect(store.popups.map((p) => p.handle)).toEqual(["monthly-letter", "monthly-letter-2"]);
	});

	it("keeps a top bar as the only kind that opens on load, and first page only for popups", () => {
		expect(popup({ kind: "slide", trigger: "load" }).trigger).toBe("read");
		expect(popup({ kind: "slide", firstPage: true }).firstPage).toBe(false);
		expect(popup({ kind: "modal", firstPage: true }).firstPage).toBe(true);
	});
});

describe("where a popup shows", () => {
	it("matches every page, prefixes or collections, never the excluded pages", () => {
		expect(showsOn(popup({ exclude: ["/contact"] }), { path: "/contact" })).toBe(false);
		expect(
			showsOn(popup({ where: "prefix", prefixes: ["/cakes/"] }), { path: "/cakes/lemon" }),
		).toBe(true);
		expect(showsOn(popup({ where: "prefix", prefixes: ["/cakes/"] }), { path: "/breads" })).toBe(
			false,
		);
		expect(
			showsOn(popup({ where: "collections", collections: ["posts"] }), {
				path: "/x",
				collection: "posts",
			}),
		).toBe(true);
		expect(showsOn(popup({ where: "collections", collections: ["posts"] }), { path: "/x" })).toBe(
			false,
		);
	});
});

describe("campaign tags on button links", () => {
	const p = { handle: "christmas-cakes", kind: "slide" as const };
	it("tags links to other websites only", () => {
		expect(tagLink("https://shop.example/cakes", p, "https://hartleys.test")).toBe(
			"https://shop.example/cakes?utm_source=popups&utm_medium=slide-in&utm_campaign=christmas-cakes",
		);
		expect(tagLink("https://hartleys.test/cakes", p, "https://hartleys.test")).toBe(
			"https://hartleys.test/cakes",
		);
		expect(tagLink("/cakes", p, "https://hartleys.test")).toBe("/cakes");
		expect(tagLink("mailto:jo@x.test", p, "")).toBe("mailto:jo@x.test");
		expect(tagLink("https://shop.example/?utm_source=mail", p, "")).toBe(
			"https://shop.example/?utm_source=mail",
		);
	});
});

describe("the page hook", () => {
	const store = normalizeStore({
		popups: [
			popup({
				id: "bar00001",
				kind: "bar",
				name: "Boxing Day hours",
				heading: "Open on Boxing Day, 10:00 to 14:00.",
				buttonLabel: "See all opening hours",
				buttonUrl: "/hours",
			}),
			popup({ id: "mod00001", where: "prefix", prefixes: ["/journal/"] }),
			popup({ id: "off00001", on: false }),
			popup({ id: "end00001", end: NOW - 1000 }),
			popup({ id: "inl00001", kind: "inline" }),
		],
	});

	it("adds one script and the top bar to a matching page", () => {
		const out = pageFragments(store, "popups", page("/journal/rye"), NOW);
		expect(out.map((f) => `${f.kind}@${f.placement}`)).toEqual([
			"inline-script@head",
			"html@body:start",
		]);
		const code = (out[0] as { code: string }).code;
		expect(code).toContain('"i":"bar00001"');
		expect(code).toContain('"i":"mod00001"');
		expect(code).not.toContain("off00001");
		expect(code).not.toContain("end00001");
		expect(code).not.toContain("inl00001");
		const html = (out[1] as { html: string }).html;
		expect(html).toContain('<template shadowrootmode="open">');
		expect(html).toContain("Open on Boxing Day, 10:00 to 14:00.");
		expect(html).toContain('aria-label="Close"');
	});

	it("adds nothing in the editor, on previews, in the admin, or with nothing live", () => {
		expect(pageFragments(store, "popups", page("/", { editMode: true }), NOW)).toEqual([]);
		expect(pageFragments(store, "popups", page("/", { preview: true }), NOW)).toEqual([]);
		expect(pageFragments(store, "popups", page("/_emdash/admin"), NOW)).toEqual([]);
		expect(pageFragments(normalizeStore({}), "popups", page("/"), NOW)).toEqual([]);
	});

	it("adds the preview loader for a preview link even with nothing live, without the bars", () => {
		expect(isPopupPreview("https://x.test/?popups_preview=abcd1234&scheme=dark")).toBe(true);
		const out = pageFragments(
			normalizeStore({}),
			"popups",
			page("/", { url: "https://hartleys.test/?popups_preview=abcd1234" }),
			NOW,
		);
		expect(out).toHaveLength(1);
		expect(out[0]!.kind).toBe("inline-script");
	});

	it("tells a preview whether the popup is set for this page, and nothing of a draft's words", () => {
		const drafts = normalizeStore({
			popups: [
				popup({
					id: "bar00002",
					kind: "bar",
					on: false,
					heading: "Secret news",
					exclude: ["/plugins"],
				}),
				popup({ id: "box00002", kind: "inline", on: false }),
			],
		});
		const code = (path: string, id: string) =>
			(
				pageFragments(
					drafts,
					"popups",
					page(path, { url: `https://hartleys.test${path}?popups_preview=${id}` }),
					NOW,
				)[0] as { code: string }
			).code;
		expect(code("/", "bar00002")).toContain('"here":1');
		expect(code("/", "bar00002")).not.toContain("Secret news");
		expect(code("/plugins", "bar00002")).not.toContain('"here"');
		expect(code("/plugins", "box00002")).toContain('"here":1');
		expect(code("/", "zzzz9999")).not.toContain('"here"');
	});

	it("writes settings as script-safe JSON", () => {
		expect(scriptJson({ h: "</script><script>alert(1)</script>" })).not.toContain("<");
		const evil = normalizeStore({ popups: [popup({ heading: "</script><b>" })] });
		const code = (pageFragments(evil, "popups", page("/"), NOW)[0] as { code: string }).code;
		expect(code).not.toContain("</script>");
	});

	it("keeps the browser script small", () => {
		const code = (pageFragments(store, "popups", page("/journal/x"), NOW)[0] as { code: string })
			.code;
		// Everything, including the form drawing and the stylesheet: at most 9 KB over the wire.
		expect(gzipSync(code).length).toBeLessThan(9 * 1024);
	});

	it("never sends a form to a top bar, and gives the decline words", () => {
		const item = clientItem(popup({ kind: "bar", contains: "form", form: "newsletter" }), "")!;
		expect(item.c.form).toBeUndefined();
		expect(clientItem(popup({ decline: "not-now" }), "")!.c.no).toBe("Not now");
		expect(clientItem(popup({ decline: "none" }), "")!.c.no).toBe("");
	});
});

describe("the form check", () => {
	const answer =
		(status: number, body: unknown = {}) =>
		async () =>
			new Response(JSON.stringify(body), { status });
	it("knows a missing, paused, unusable or fine form", async () => {
		expect(await checkForm("https://x.test", "newsleter", true, answer(404))).toEqual({
			result: "missing",
		});
		expect(await checkForm("https://x.test", "news", true, answer(410))).toEqual({
			result: "paused",
		});
		expect(
			await checkForm(
				"https://x.test",
				"news",
				true,
				answer(200, {
					success: true,
					data: { name: "Newsletter", pages: [], settings: { spamProtection: "turnstile" } },
				}),
			),
		).toEqual({ result: "turnstile" });
		expect(
			await checkForm(
				"https://x.test",
				"news",
				false,
				answer(200, {
					success: true,
					data: { name: "Newsletter", pages: [], settings: { spamProtection: "turnstile" } },
				}),
			),
		).toEqual({ result: "ok", name: "Newsletter" });
		expect(judgeDefinition({ pages: [{ fields: [{ type: "file" }] }] }, true)).toEqual({
			result: "files",
		});
		expect(
			await checkForm("https://x.test", "news", true, async () => {
				throw new Error("offline");
			}),
		).toEqual({ result: "unchecked" });
		expect(await checkForm(undefined, "news", true)).toEqual({ result: "unchecked" });
	});

	it("says it in plain words, refusing only what cannot work", () => {
		expect(describeCheck({ result: "missing" }, "newsleter")).toEqual({
			refuse: true,
			text: 'There is no form called "newsleter". Open Forms, copy the short name from the list, and paste it here.',
		});
		expect(describeCheck({ result: "paused" }, "x")?.refuse).toBe(false);
		expect(describeCheck({ result: "unchecked" }, "x")?.refuse).toBe(false);
		expect(describeCheck({ result: "ok", name: "" }, "x")).toBeNull();
	});
});

describe("asking its own site when localhost means two addresses", () => {
	// A Node server started on "localhost" listens on one address (::1 or 127.0.0.1), and the
	// browser finds it, but the server's own fetch of "localhost" may only try the other one.
	type Call = { url: string; cookie: string | null };
	function server(listening: "127.0.0.1" | "[::1]", body: unknown) {
		const calls: Call[] = [];
		const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
			calls.push({ url, cookie: init.headers?.cookie ?? null });
			if (new URL(url).host !== `${listening}:4399`) {
				throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
			}
			return new Response(JSON.stringify(body));
		};
		return { calls, fetchImpl: fetchImpl as never };
	}
	const list = { success: true, data: { items: [{ slug: "newsletter", name: "Newsletter" }] } };
	const forms = [{ slug: "newsletter", name: "Newsletter", paused: false }];

	for (const listening of ["127.0.0.1", "[::1]"] as const) {
		it(`finds the forms when the server listens on ${listening} only, the cookie staying on this server`, async () => {
			const { calls, fetchImpl } = server(listening, list);
			expect(await listForms("http://localhost:4399", "session=abc", fetchImpl)).toEqual(forms);
			for (const call of calls) {
				expect(["localhost:4399", "127.0.0.1:4399", "[::1]:4399"]).toContain(
					new URL(call.url).host,
				);
				expect(new URL(call.url).pathname).toBe("/_emdash/api/plugins/emdash-forms/forms/list");
			}
			expect(calls.at(-1)).toEqual({
				url: `http://${listening}:4399/_emdash/api/plugins/emdash-forms/forms/list`,
				cookie: "session=abc",
			});
		});

		it(`checks a form and finds a picture when the server listens on ${listening} only`, async () => {
			const definition = server(listening, { success: true, data: { name: "Newsletter" } });
			expect(
				await checkForm("http://localhost:4399", "newsletter", true, definition.fetchImpl),
			).toEqual({ result: "ok", name: "Newsletter" });
			const media = server(listening, { success: true, data: { item: { storageKey: "a.jpg" } } });
			const ctx = {
				request: new Request("http://localhost:4399/x", { headers: { cookie: "session=abc" } }),
			};
			expect(
				await publicMediaUrl(
					ctx,
					"http://localhost:4399",
					"01M51QJACT77N6PC8DYEM64AAZ",
					media.fetchImpl,
				),
			).toBe("/_emdash/api/media/file/a.jpg");
			for (const call of media.calls) {
				expect(["localhost:4399", "127.0.0.1:4399", "[::1]:4399"]).toContain(
					new URL(call.url).host,
				);
			}
			expect(media.calls.at(-1)).toEqual({
				url: `http://${listening}:4399/_emdash/api/media/01M51QJACT77N6PC8DYEM64AAZ`,
				cookie: "session=abc",
			});
		});
	}

	it("asks any other address once, and never sends the cookie anywhere else", async () => {
		const calls: Call[] = [];
		const refused = (async (url: string, init: { headers?: Record<string, string> }) => {
			calls.push({ url, cookie: init.headers?.cookie ?? null });
			throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
		}) as never;
		expect(await listForms("https://hartleys.test", "session=abc", refused)).toBeNull();
		expect(await listForms("http://127.0.0.1:4399", "session=abc", refused)).toBeNull();
		expect(calls.map((c) => c.url)).toEqual([
			"https://hartleys.test/_emdash/api/plugins/emdash-forms/forms/list",
			"http://127.0.0.1:4399/_emdash/api/plugins/emdash-forms/forms/list",
		]);
	});

	it("takes the server's answer as it is: an error page or a timeout is not retried elsewhere", async () => {
		const urls: string[] = [];
		const notAllowed = (async (url: string) => {
			urls.push(url);
			return new Response("{}", { status: 403 });
		}) as never;
		expect(await listForms("http://localhost:4399", "session=abc", notAllowed)).toBeNull();
		expect(urls).toEqual(["http://localhost:4399/_emdash/api/plugins/emdash-forms/forms/list"]);
		urls.length = 0;
		const slow = (async (url: string) => {
			urls.push(url);
			throw new DOMException("The operation was aborted.", "AbortError");
		}) as never;
		expect(await listForms("http://localhost:4399", "session=abc", slow)).toBeNull();
		expect(urls).toHaveLength(1);
	});
});

describe("results", () => {
	it("takes only the exact shape, counts only live popups, and adds atomically", async () => {
		expect(parseCount({ p: "abcd1234", e: "seen", m: true })).toEqual({
			popup: "abcd1234",
			event: "seen",
			phone: true,
		});
		expect(parseCount({ p: "abcd1234", e: "seen", m: true, x: 1 })).toBeNull();
		expect(parseCount({ p: "abcd1234", e: "hacked", m: true })).toBeNull();
		const fake = fakeContext();
		const live = [popup(), popup({ id: "off00001", on: false })];
		expect(
			await addCount(fake.ctx, live, { popup: "off00001", event: "seen", phone: false }, NOW),
		).toBe("not-live");
		expect(
			await addCount(fake.ctx, live, { popup: "nope0000", event: "seen", phone: false }, NOW),
		).toBe("not-live");
		await addCount(fake.ctx, live, { popup: "abcd1234", event: "seen", phone: true }, NOW);
		await addCount(fake.ctx, live, { popup: "abcd1234", event: "seen", phone: false }, NOW);
		await addCount(fake.ctx, live, { popup: "abcd1234", event: "sent", phone: false }, NOW);
		expect(fake.rows.get("abcd1234:2026-10-16")).toMatchObject({
			seen: 2,
			phone: 1,
			sent: 1,
			clicked: 0,
		});
	});

	it("keeps each count on the site's own day, not the UTC day", async () => {
		const fake = fakeContext();
		// Noon UTC on 16 October is 1 am on the 17th in Auckland and 5 am on the 16th in Los Angeles.
		await addCount(fake.ctx, [popup()], { popup: "abcd1234", event: "seen", phone: false }, NOW, "Pacific/Auckland");
		expect(fake.rows.get("abcd1234:2026-10-17")).toMatchObject({ day: "2026-10-17", seen: 1 });
		// 11 pm UTC on the 16th is still the 16th in Los Angeles but already the 17th in UTC.
		const late = Date.UTC(2026, 9, 16, 23);
		await addCount(fake.ctx, [popup()], { popup: "abcd1234", event: "seen", phone: false }, late, "America/Los_Angeles");
		expect(fake.rows.get("abcd1234:2026-10-16")).toMatchObject({ day: "2026-10-16", seen: 1 });
	});

	it("reads a long range a page at a time, oldest first", async () => {
		const fake = fakeContext();
		for (let d = 0; d < 250; d++) {
			const day = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
			fake.rows.set(`r${d}`, { popup: "abcd1234", day, seen: 1, sent: 0, clicked: 0, closed: 0, phone: 0 });
		}
		const rows = await readRows(fake.ctx, { from: "2026-01-01", to: "2026-12-31", popup: "abcd1234" });
		expect(rows).toHaveLength(250);
		expect(rows[0]!.day).toBe("2026-01-01");
		expect(fake.queries).toHaveLength(3);
	});

	it("adds up a popup's rows, rates from 100 views, and writes a safe spreadsheet", async () => {
		const fake = fakeContext();
		fake.rows.set("a:2026-10-03", {
			popup: "abcd1234",
			day: "2026-10-03",
			seen: 90,
			sent: 3,
			clicked: 0,
			closed: 10,
			phone: 40,
		});
		fake.rows.set("a:2026-10-04", {
			popup: "abcd1234",
			day: "2026-10-04",
			seen: 20,
			sent: 2,
			clicked: 0,
			closed: 5,
			phone: 10,
		});
		fake.rows.set("b:2026-10-04", {
			popup: "other001",
			day: "2026-10-04",
			seen: 7,
			sent: 0,
			clicked: 0,
			closed: 0,
			phone: 0,
		});
		const rows = await readRows(fake.ctx, { from: "2026-10-01", to: "2026-10-31", popup: "abcd1234" });
		expect(totals(rows).get("abcd1234")).toEqual({
			seen: 110,
			sent: 5,
			clicked: 0,
			closed: 15,
			phone: 50,
			since: "2026-10-03",
		});
		expect(await readRows(fake.ctx, { from: "2026-10-04", to: "2026-10-31" })).toHaveLength(2);
		expect(await readRows(fake.ctx, { from: "2026-10-04", to: "2026-10-31", popup: "abcd1234" })).toHaveLength(1);
		// Only that popup and those days were asked for.
		expect(fake.queries.at(-1)).toEqual({
			popup: "abcd1234",
			day: { gte: "2026-10-04", lte: "2026-10-31" },
		});
		expect(rate(5, 99)).toBeNull();
		expect(rate(5, 110)).toBe(5);
		const csv = toCsv(rows, new Map([["abcd1234", '=HYPERLINK("x"), "a"']]));
		expect(csv.split("\r\n")[0]).toBe("Day,Popup,Seen,Sign-ups,Button clicks,Closed,Seen on phones");
		expect(csv).toContain(`2026-10-03,"'=HYPERLINK(""x""), ""a""",90,3,0,10,40`);
	});
});

describe("routes", () => {
	afterEach(() => vi.unstubAllGlobals());
	const routes = createPlugin().routes as Record<
		string,
		{ handler: (ctx: RouteContext) => Promise<unknown> }
	>;
	const call = (
		fake: ReturnType<typeof fakeContext>,
		name: string,
		input: unknown,
		url = "https://hartleys.test/x",
	) =>
		routes[name]!.handler({
			...fake.ctx,
			input,
			request: new Request(url),
			user: { id: "u", role: 50 },
		} as unknown as RouteContext);

	it("believes a report only when the server finds the problem itself", async () => {
		const fake = fakeContext(
			{
				popups: {
					popups: [popup({ contains: "form", form: "newsletter" })],
					settings: { emails: ["jo@hartleys.test"] },
				},
			},
			{ email: true },
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({ success: true, data: { name: "N", pages: [], settings: {} } }),
					),
			),
		);
		expect(await call(fake, "problem", { p: "abcd1234", k: "missing" })).toEqual({ saved: false });
		expect(fake.sent).toHaveLength(0);
		expect(fake.kv.get("problems")).toBeUndefined();
	});

	it("stores one problem per popup and emails once a day, the site's name first", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 404 })),
		);
		const fake = fakeContext(
			{
				popups: {
					popups: [popup({ contains: "form", form: "newsleter" })],
					settings: { emails: ["jo@hartleys.test", "web@studio.test"] },
				},
			},
			{ email: true },
		);
		expect(await call(fake, "problem", { p: "abcd1234", k: "missing" })).toEqual({ saved: true });
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).toMatchObject({
			to: "jo@hartleys.test",
			cc: ["web@studio.test"],
			subject: `Hartley's Bakery: the popup "Monthly letter" cannot open`,
		});
		// A second report the same day sends nothing more.
		const kept = fake.kv.get("problems") as Record<string, { at: number }>;
		kept.abcd1234!.at -= 120_000;
		await call(fake, "problem", { p: "abcd1234", k: "paused" });
		expect(fake.sent).toHaveLength(1);
		await expect(call(fake, "problem", { p: "abcd1234", k: "other" })).rejects.toThrow();
		expect(alertEmail("", popup({ form: "x" }), "paused").subject).toBe(
			'Your site: the popup "Monthly letter" cannot open',
		);
	});

	it("lists boxes for the editor's block, and serves a live box", async () => {
		const fake = fakeContext({
			popups: {
				popups: [
					popup({
						id: "inl00001",
						kind: "inline",
						name: "Letter box",
						contains: "form",
						form: "newsletter",
					}),
					popup(),
				],
			},
		});
		expect(await call(fake, "boxes", {})).toEqual({
			items: [{ id: "inl00001", name: "Letter box" }],
		});
		const answer = (await call(fake, "box", { id: "inl00001" })) as {
			box: { form: string; handle: string };
		};
		expect(answer.box.form).toBe("newsletter");
		// For the form's hidden utm_campaign field, as in a popup.
		expect(answer.box.handle).toBe("monthly-letter");
		expect(await call(fake, "box", { id: "abcd1234" })).toEqual({ box: null });
	});

	it("downloads results as a spreadsheet from a link the admin page signed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		const fake = fakeContext({
			popups: { popups: [popup(), popup({ id: "efgh5678", handle: "spring", name: "Spring" })] },
		});
		fake.rows.set("a", {
			popup: "abcd1234",
			day: "2026-10-03",
			seen: 1,
			sent: 0,
			clicked: 0,
			closed: 0,
			phone: 0,
		});
		fake.rows.set("b", { ...fake.rows.get("a")!, popup: "efgh5678", seen: 4 });
		const shown = JSON.stringify(
			await call(fake, "admin", { type: "block_action", action_id: "period", value: "r:this-month" }),
		);
		const link = /"url":"([^"]+\/export\?[^"]+)"/.exec(shown)![1]!;
		expect(link).toMatch(
			/^https:\/\/hartleys\.test\/_emdash\/api\/plugins\/popups\/export\?from=2026-10-01&to=2026-10-16&expires=/,
		);
		const out = (await call(fake, "export", null, link)) as {
			headers: Array<[string, string]>;
			body: { value: string };
		};
		expect(out.headers).toContainEqual(["content-type", "text/csv; charset=utf-8"]);
		expect(out.headers).toContainEqual(["cache-control", "no-store"]);
		expect(out.headers.find(([name]) => name === "content-disposition")?.[1]).toMatch(
			/^attachment; filename="popups-2026-10-01-to-2026-10-16\.csv"$/,
		);
		expect(out.body.value).toContain("2026-10-03,Monthly letter,1");
		expect(out.body.value).toContain("2026-10-03,Spring,4");
		// A popup's own page: its own link, its own rows only.
		const own = JSON.stringify(
			await call(fake, "admin", { type: "block_action", action_id: "row", value: "change:abcd1234" }),
		);
		const ownLink = /"url":"([^"]+\/export\?[^"]+)"/.exec(own)![1]!;
		expect(ownLink).toContain("popup=abcd1234");
		const mine = (await call(fake, "export", null, ownLink)) as typeof out;
		expect(mine.headers.find(([name]) => name === "content-disposition")?.[1]).toMatch(
			/^attachment; filename="popup-monthly-letter-\d{4}-\d{2}-\d{2}-to-2026-10-16\.csv"$/,
		);
		expect(mine.body.value).toContain("Monthly letter");
		expect(mine.body.value).not.toContain("Spring");
		vi.useRealTimers();
		const refused = (await call(
			fake,
			"export",
			null,
			"https://hartleys.test/_emdash/api/plugins/popups/export",
		)) as { status: number; body: { value: string } };
		expect(refused.status).toBe(403);
		expect(refused.body.value).toContain("This download link has expired");
	});

	it("finds a picture's public address as the signed-in person, and only a same-site file address", async () => {
		const seen: Array<{ url: string; cookie: string | null }> = [];
		const answer =
			(item: unknown) => async (url: string, init: { headers: Record<string, string> }) => {
				seen.push({ url, cookie: init.headers.cookie ?? null });
				return new Response(JSON.stringify({ success: true, data: { item } }));
			};
		const ctx = {
			request: new Request("https://hartleys.test/x", { headers: { cookie: "session=abc" } }),
		};
		expect(
			await publicMediaUrl(
				ctx,
				"https://hartleys.test",
				"01M51QJACT77N6PC8DYEM64AAZ",
				answer({ storageKey: "01AB.jpg" }) as never,
			),
		).toBe("/_emdash/api/media/file/01AB.jpg");
		expect(seen[0]).toEqual({
			url: "https://hartleys.test/_emdash/api/media/01M51QJACT77N6PC8DYEM64AAZ",
			cookie: "session=abc",
		});
		expect(
			await publicMediaUrl(
				ctx,
				"https://hartleys.test",
				"x1234",
				answer({ url: "https://evil.example/x.jpg" }) as never,
			),
		).toBeNull();
		expect(
			await publicMediaUrl(
				ctx,
				"https://hartleys.test",
				"../../x",
				answer({ storageKey: "a.jpg" }) as never,
			),
		).toBeNull();
	});

	it("gives a signed-in editor the draft to preview", async () => {
		const fake = fakeContext({ popups: { popups: [popup({ on: false })] } });
		const answer = (await call(fake, "preview", { id: "abcd1234" })) as {
			off: boolean;
			item: { i: string };
		};
		expect(answer.off).toBe(true);
		expect(answer.item.i).toBe("abcd1234");
		expect(answer).not.toHaveProperty("unfinished");
		const draft = fakeContext({ popups: { popups: [popup({ on: false, step: 3 })] } });
		expect(await call(draft, "preview", { id: "abcd1234" })).toMatchObject({
			off: true,
			unfinished: true,
		});
	});

	it("gives a box in a page to preview too, without a way out or campaign tags", async () => {
		const fake = fakeContext({
			popups: {
				popups: [
					popup({ kind: "inline", buttonLabel: "Read", buttonUrl: "https://shop.example/x" }),
				],
			},
		});
		const answer = (await call(fake, "preview", { id: "abcd1234" })) as {
			item: { k: string; c: { no: string; b?: { u: string } } };
		};
		expect(answer.item.k).toBe("inline");
		expect(answer.item.c.no).toBe("");
		expect(answer.item.c.b?.u).toBe("https://shop.example/x");
	});
});
