// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { emailStatus, rowText, when } from "../src/admin.js";
import { parseRecipients } from "../src/alerts.js";
import { afterExternal, afterOwnPage, verdict, type Outcome } from "../src/check.js";
import { entryPath, linksInData, scanHtml } from "../src/extract.js";
import { describe as words, foundOn, type LinkRow } from "../src/model.js";
import { isMidUpdate } from "../src/scan.js";
import { applyChange, type Alerts, type Loaded, type Summary } from "../src/state.js";
import { idFor, normalizePath, publicOrigin, shorten, toTarget } from "../src/url.js";

const SITE = "https://www.harbour.example";
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-16T10:00:00Z");

function row(extra: Partial<LinkRow> = {}): LinkRow {
	return {
		kind: "external",
		url: "https://flour.example/rye",
		host: "flour.example",
		sources: [{ c: "pages", id: "1", t: "Our starter", p: "/starter" }],
		count: 1,
		menu: false,
		content: true,
		editor: true,
		pass: 1,
		state: "pending",
		due: new Date(NOW).toISOString(),
		...extra,
	};
}

describe("addresses", () => {
	it("keeps links to this site as paths and others as full addresses", () => {
		expect(toTarget("/menu/", SITE)).toMatchObject({ url: "/menu", internal: true });
		expect(toTarget("https://harbour.example/about?x=1#team", SITE)).toMatchObject({
			url: "/about",
			internal: true,
		});
		expect(toTarget("https://Flour.example/rye#top", SITE)).toMatchObject({
			url: "https://flour.example/rye",
			internal: false,
			host: "flour.example",
		});
	});

	it("skips email, phone, anchors and EmDash's own media addresses", () => {
		for (const value of [
			"mailto:a@b.c",
			"tel:123",
			"#faq",
			"/_emdash/api/media/file/x.jpg",
			"menu",
			"",
		]) {
			expect(toTarget(value, SITE)).toBeNull();
		}
	});

	it("shortens addresses so a phone table keeps its Fix menu on screen", () => {
		expect(shorten("https://www.linkedin.com/company/harbour-street-bakery")).toBe(
			"linkedin.com/company/harbour-…",
		);
		expect(shorten("/menu")).toBe("/menu");
		expect(shorten("https://www.linkedin.com/company/harbour-street-bakery").length).toBe(30);
	});

	it("knows when a site has no public address yet", () => {
		expect(publicOrigin("")).toBeNull();
		expect(publicOrigin("http://localhost:4321")).toBeNull();
		expect(publicOrigin("http://192.168.1.4")).toBeNull();
		expect(publicOrigin(SITE)).toBe(SITE);
	});

	it("gives every address a short, stable storage id", () => {
		expect(idFor("internal", "/menu")).toBe(idFor("internal", "/menu"));
		expect(idFor("internal", "/menu")).not.toBe(idFor("external", "/menu"));
		expect(idFor("external", "https://a.example/".repeat(50)).length).toBeLessThan(16);
		expect(normalizePath("/a//b/")).toBe("/a/b");
	});
});

describe("finding links", () => {
	it("reads Portable Text links, block fields and insecure embeds", () => {
		const data = {
			title: "Home",
			body: [
				{
					_type: "block",
					children: [{ _type: "span", text: "menu", marks: ["k1"] }],
					markDefs: [{ _key: "k1", _type: "link", href: "/menu-2024" }],
				},
				{ _type: "iframe", src: "http://maps.example/embed" },
				{ _type: "image", src: "http://cdn.example/a.jpg" },
			],
			content: [
				{ _type: "marketing_hero", primary_cta_url: "/contact", secondary_cta_url: "#faq" },
			],
		};
		const found = linksInData(data, SITE).map((f) => `${f.use} ${f.url}`);
		expect(found.sort()).toEqual(
			[
				"embed http://maps.example/embed",
				"image http://cdn.example/a.jpg",
				"link /contact",
				"link /menu-2024",
			].sort(),
		);
	});

	it("reads menu and footer links and insecure items from a rendered page", () => {
		const html = `<html><header><nav><a href="/menu">Menu</a><a href='/menu-2024'>Old</a></nav></header>
			<main><a href="/not-in-menu">x</a><iframe src="http://maps.example/e"></iframe><img src="http://cdn.example/p.jpg"></main>
			<footer><a href="https://instagram.com/harbour">Instagram</a><a href="mailto:a@b.c">Mail</a></footer></html>`;
		const scan = scanHtml(html, SITE);
		expect(scan.menu.map((t) => t.url)).toEqual([
			"/menu",
			"/menu-2024",
			"https://instagram.com/harbour",
		]);
		expect(scan.active).toEqual(["http://maps.example/e"]);
		expect(scan.passive).toEqual(["http://cdn.example/p.jpg"]);
	});

	it("builds an entry's address the way EmDash does", () => {
		expect(entryPath("/{slug}", "pages", { slug: "about", id: "1" })).toBe("/about");
		expect(entryPath(null, "posts", { slug: "hello", id: "1" })).toBe("/posts/hello");
		expect(
			entryPath("/{year}/{month}/{slug}", "posts", {
				slug: "x",
				id: "1",
				publishedAt: "2026-03-04T00:00:00Z",
			}),
		).toBe("/2026/03/x");
		expect(entryPath("/{slug}", "pages", { slug: null, id: "1" })).toBeNull();
	});
});

describe("what an answer means", () => {
	const cases: Array<[string, Outcome, string]> = [
		["page there", { status: 200 }, "ok"],
		["removed", { status: 404 }, "gone"],
		["removed for good", { status: 410 }, "gone"],
		["turns checkers away", { status: 403 }, "unknown:refuses"],
		["LinkedIn", { status: 999 }, "unknown:refuses"],
		["slow down", { status: 429 }, "unknown:slow"],
		["server trouble", { status: 503 }, "server"],
		["timeout", { timedOut: true }, "unknown:timeout"],
		["no such site", { error: "getaddrinfo ENOTFOUND gone.example" }, "dead"],
		["other failure", { error: "connection reset" }, "unknown:error"],
		["moved", { status: 301, location: "https://flour.example/rye-flour" }, "moved"],
	];
	for (const [name, outcome, expected] of cases) {
		it(name, () => {
			const result = verdict("https://flour.example/rye", outcome, "GET");
			expect(result.kind === "unknown" ? `unknown:${result.reason}` : result.kind).toBe(expected);
		});
	}

	it("asks again with GET when HEAD is refused", () => {
		expect(verdict("https://a.example/", { status: 405 }, "HEAD").kind).toBe("retry");
		expect(verdict("https://a.example/", { status: 404 }, "HEAD").kind).toBe("retry");
	});

	it("calls a link to another site broken only on two 'removed' answers a day apart", () => {
		const first = afterExternal(row(), { kind: "gone" }, NOW);
		expect(first).toMatchObject({ state: "pending", fails: 1 });
		const soon = afterExternal(first, { kind: "gone" }, NOW + 2 * HOUR);
		expect(soon.state).toBe("pending");
		const later = afterExternal(first, { kind: "gone" }, NOW + 25 * HOUR);
		expect(later).toMatchObject({ state: "broken", reason: "gone", group: "link" });
		// One good answer clears it.
		expect(afterExternal(later, { kind: "ok" }, NOW + 26 * HOUR)).toMatchObject({ state: "ok" });
		expect(afterExternal(later, { kind: "ok" }, NOW + 26 * HOUR).reason).toBeUndefined();
	});

	it("never calls a site that turns checkers away broken", () => {
		let current = row();
		for (let day = 0; day < 30; day += 1) {
			current = afterExternal(
				current,
				{ kind: "unknown", reason: "refuses" },
				NOW + day * 24 * HOUR,
			);
			expect(current.state).toBe("unknown");
		}
	});

	it("a broken link does not flip back on one 'could not check'", () => {
		const broken = row({
			state: "broken",
			reason: "gone",
			group: "link",
			since: "2026-10-01T00:00:00Z",
		});
		expect(afterExternal(broken, { kind: "unknown", reason: "timeout" }, NOW).state).toBe("broken");
	});

	it("a page of this site is broken on the second error a minute later", () => {
		const page = row({ kind: "page", url: "/gallery", host: "", sources: [], editor: false });
		const first = afterOwnPage(page, { status: 500 }, NOW);
		expect(first.state).toBe("pending");
		expect(afterOwnPage(first, { status: 500 }, NOW + 61_000)).toMatchObject({
			state: "broken",
			reason: "page-error",
			group: "page",
		});
		expect(afterOwnPage(first, { status: 200 }, NOW + 61_000).state).toBe("ok");
	});
});

describe("words", () => {
	it("never shows an error number or a developer word", () => {
		const reasons = [
			"missing",
			"draft",
			"gone",
			"no-site",
			"server",
			"page-error",
			"insecure-active",
			"redirect",
			"insecure-image",
			"refuses",
			"slow",
			"timeout",
			"trouble",
			"no-live",
			"error",
		] as const;
		for (const reason of reasons) {
			const text = words({ kind: "external", reason, url: "x", detail: "/y" }, "x");
			expect(text).not.toMatch(
				/\b(404|410|500|5xx|403|429|http|cron|robots|sitemap|canonical|redirect)\b/i,
			);
		}
	});

	it("says where an address was found, menu first", () => {
		expect(
			foundOn(
				row({
					menu: true,
					count: 7,
					sources: [
						{ t: "Site menu", p: "", menu: true },
						{ t: "Home", p: "/" },
						{ t: "Wholesale", p: "/wholesale" },
					],
				}),
			),
		).toBe(" Found on: Site menu (every page), Home, Wholesale and 4 more.");
	});

	it("checks typed email addresses", () => {
		expect(
			parseRecipients("Ellen@Bakery.example\nstudio@web.example, ellen@bakery.example"),
		).toEqual({
			list: ["ellen@bakery.example", "studio@web.example"],
		});
		expect(parseRecipients("ellen@bakery.example\nnot-an-address")).toEqual({
			wrong: "not-an-address",
		});
	});
});

describe("phone-safe rows", () => {
	const long =
		"https://www.example-flour-mill-and-bakery-supplies.example/products/rye/organic-stoneground";
	const reasons = [
		"missing",
		"draft",
		"gone",
		"no-site",
		"server",
		"page-error",
		"insecure-active",
		"redirect",
		"moved",
		"insecure-image",
		"refuses",
		"slow",
		"timeout",
		"trouble",
		"no-live",
		"error",
	] as const;
	it("never holds a word longer than 30 characters, so the Fix menu stays on screen at 390 px", () => {
		// What is stored is already shortened: a detour's target, and the address itself when shown.
		const moved = afterExternal(
			row({ url: long }),
			{ kind: "moved", to: `${long}/new-place` },
			NOW,
		);
		for (const reason of reasons) {
			const text = rowText(
				{
					id: "x",
					kind: "external",
					url: long,
					reason,
					...(moved.detail ? { detail: moved.detail } : {}),
					sources: [{ t: "Our sourdough starter", p: "/starter" }],
					count: 1,
					menu: false,
					editor: true,
					since: "2026-10-10T00:00:00Z",
				},
				null,
			);
			for (const word of text.split(/\s+/))
				expect(word.length, `${reason}: ${word}`).toBeLessThanOrEqual(31);
		}
	});

	it("says how long ago in words, never a clock time in the wrong zone", () => {
		const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
		expect(when(at(0), NOW)).toBe("just now");
		expect(when(at(5), NOW)).toBe("5 minutes ago");
		expect(when(at(60), NOW)).toBe("an hour ago");
		expect(when(at(180), NOW)).toBe("3 hours ago");
		expect(when(at(26 * 60), NOW)).toBe("yesterday");
		expect(when(at(4 * 24 * 60), NOW)).toBe("4 days ago");
	});
});

describe("the frozen summary", () => {
	const empty: Summary = {
		pass: 1,
		finishedAt: "2026-10-16T06:10:00Z",
		pages: 4,
		links: 10,
		fix: { site: 0, page: 0, link: 0 },
		editorFix: 0,
		look: 0,
		unknown: 1,
		rows: { site: [], page: [], link: [] },
		lookRows: [],
		unknownRows: [
			{
				id: "a",
				kind: "external",
				url: "https://x.example",
				sources: [],
				count: 1,
				menu: false,
				editor: true,
			},
		],
		live: "ok",
	};

	it("moves a row between lists and keeps the counts true", () => {
		const before = row({ state: "unknown", reason: "refuses" });
		const after = row({
			state: "broken",
			reason: "gone",
			group: "link",
			since: "2026-10-16T09:00:00Z",
		});
		const next = applyChange(empty, "a", before, after);
		expect(next).toMatchObject({ fix: { link: 1 }, editorFix: 1, unknown: 0, unknownRows: [] });
		expect(next?.rows.link.map((r) => r.id)).toEqual(["a"]);
		expect(applyChange(next!, "a", after, { ...after, state: "ok" })).toMatchObject({
			fix: { link: 0 },
			editorFix: 0,
		});
		expect(applyChange(empty, "a", before, before)).toBeNull();
	});
});

describe("the Email row, worked out on every load", () => {
	const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();
	function data(recipients: string[] | undefined, email?: Alerts["email"]): Loaded {
		return {
			scan: null,
			summary: null,
			queue: { hosts: {} },
			options: { outbound: true, ...(recipients ? { recipients } : {}) },
			alerts: { pending: [], sent: [], ...(email ? { email } : {}) },
			checklist: { rows: {} },
		};
	}
	const list = ["ellen@acme.test", "studio@web.example"];

	it("says there is no email service when the site has none, even after a test that worked", () => {
		const row = emailStatus(data(list, { state: "working", at: ago(2), to: 2, list }), false, NOW);
		expect(row.status).toBe("attention");
		expect(row.text).toContain("no email service");
		expect(row.text).toContain("Settings, Email");
	});

	it("needs attention when nobody is on the list, even after a test that worked", () => {
		for (const recipients of [[], undefined]) {
			const row = emailStatus(
				data(recipients, { state: "working", at: ago(2), to: 2, list }),
				true,
				NOW,
			);
			expect(row.status).toBe("attention");
			expect(row.text).toContain("Nobody is on the list");
		}
	});

	it("is not tested yet before any email, and names who gets them", () => {
		const row = emailStatus(data(list), true, NOW);
		expect(row.status).toBe("untested");
		expect(row.text).toContain("Goes to ellen@acme.test and studio@web.example.");
		expect(row.text).toContain("press Send a test email to check now");
	});

	it("works after a test to the same list, and says when", () => {
		const row = emailStatus(data(list, { state: "working", at: ago(3), to: 2, list }), true, NOW);
		expect(row.status).toBe("working");
		expect(row.text).toContain("3 hours ago");
		expect(row.text).toContain("Goes to ellen@acme.test and studio@web.example.");
	});

	it("is not tested again after the list changed", () => {
		const row = emailStatus(
			data(["ellen@acme.test"], { state: "working", at: ago(3), to: 2, list }),
			true,
			NOW,
		);
		expect(row.status).toBe("untested");
		expect(row.text).toContain("changed since");
	});

	it("tells a failure without a service from the past, never as a fact about now", () => {
		const row = emailStatus(
			data(list, {
				state: "not-set-up",
				at: ago(26),
				to: 0,
				error:
					"No email provider is configured. Install and activate an email provider plugin, then select it in Settings > Email.",
			}),
			true,
			NOW,
		);
		expect(row.status).toBe("attention");
		expect(row.text).not.toContain("Your site has no way to send email yet");
		expect(row.text).toContain("yesterday");
		expect(row.text).toContain("press Send a test email to check now");
	});

	it("names the EmDash update when the site has a service but the sandbox could not use it", () => {
		// EmDash 1.3.x on Cloudflare: sandboxed (registry) plugins got "Email is not configured"
		// even with an email service chosen; fixed in 1.4.0 (emdash-cms/emdash#4281).
		const row = emailStatus(
			data(list, { state: "not-set-up", at: ago(2), to: 0, error: "Email is not configured" }),
			true,
			NOW,
		);
		expect(row.status).toBe("attention");
		expect(row.text).toContain("EmDash 1.4.0");
		expect(row.text).toContain("press Send a test email");
		expect(row.text).not.toContain("no email service chosen");
	});

	it("tells an email service that turned the email down apart from a missing one", () => {
		const row = emailStatus(
			data(list, { state: "failed", at: ago(1), to: 0, error: "Sender not verified" }),
			true,
			NOW,
		);
		expect(row.status).toBe("attention");
		expect(row.text).toContain("could not be sent");
		expect(row.text).not.toContain("no email service");
	});

	it("keeps long lists short", () => {
		const row = emailStatus(data([...list, "a@b.example", "c@d.example"]), true, NOW);
		expect(row.text).toContain("Goes to ellen@acme.test, studio@web.example and 2 more.");
	});
});

describe("a site in the middle of an update", () => {
	it("knows EmDash's two 'database update not finished' answers", () => {
		expect(
			isMidUpdate({
				status: 503,
				headers: new Headers({ "retry-after": "60" }),
				body: "Database migrations are required. Apply the deployment migration manifest and retry.",
			}),
		).toBe(true);
		expect(
			isMidUpdate({
				status: 503,
				body: '<!doctype html><html><body><p>This site\'s database has not been migrated yet. <a href="/_emdash/admin/setup">Set up EmDash</a></p></body></html>',
			}),
		).toBe(true);
	});

	it("leaves bot protection and other errors alone", () => {
		expect(
			isMidUpdate({
				status: 503,
				headers: new Headers({ "retry-after": "60" }),
				body: "<html><title>Just a moment...</title><body>Checking your browser</body></html>",
			}),
		).toBe(false);
		expect(isMidUpdate({ status: 500, body: "Database migrations are required." })).toBe(false);
	});
});
