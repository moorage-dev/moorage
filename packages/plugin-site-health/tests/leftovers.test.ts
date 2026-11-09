// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { leftoversIn, oldHostsIn, type LeftContext } from "../src/leftovers.js";
import { describe as describeRow, shortFor, type LinkRow } from "../src/model.js";
import { toTarget } from "../src/url.js";

const SITE = "https://bakery.example";
const PLAIN: LeftContext = { siteUrl: SITE, oldHosts: [], datedOwn: false };

function text(value: string, key = "t") {
	return {
		_type: "block",
		_key: `b${key}`,
		children: [{ _type: "span", _key: `s${key}`, text: value, marks: [] }],
		markDefs: [],
	};
}

function link(label: string, href: string, key: string) {
	return {
		_type: "block",
		_key: `b${key}`,
		children: [{ _type: "span", _key: `s${key}`, text: label, marks: [key] }],
		markDefs: [{ _key: key, _type: "link", href }],
	};
}

function found(data: unknown, context: LeftContext = PLAIN, slug: string | null = "contact") {
	return leftoversIn({ slug, data }, context).map((l) => `${l.type} ${l.text}`);
}

describe("left over from WordPress: shortcodes", () => {
	it("finds a shortcode in an HTML block and in plain text", () => {
		const data = {
			title: "Contact",
			content: [
				{
					_type: "htmlBlock",
					_key: "h1",
					html: '[contact-form-7 id="9ee95fa" title="Contact form 1"]',
				},
				text("Our ovens: [gallery] and more.", "g"),
				text('[caption id="a1" align="alignleft"]A loaf[/caption]', "c"),
			],
		};
		expect(found(data)).toEqual([
			'shortcode [contact-form-7 id="9ee95fa" title="Contact form 1"]',
			"shortcode [gallery]",
			'shortcode [caption id="a1" align="alignleft"]',
		]);
	});

	it("leaves ordinary square brackets alone", () => {
		const data = {
			title: "Notes [draft]",
			content: [
				text("As the baker said [1], it rises [sic]."),
				text("[Editor's note: closed on Mondays]", "e"),
				text("See [the menu](https://bakery.example/menu) and [x].", "m"),
				text("[ ] tick box, [a-z] letters, [note]", "n"),
				{ _type: "code", _key: "k", code: '[contact-form-7 id="1"]', language: "text" },
			],
		};
		expect(found(data)).toEqual([]);
	});

	it("names each shortcode once per page, whatever its settings", () => {
		const data = {
			content: [
				text("[gallery]", "a"),
				text("[gallery]", "b"),
				text('[caption id="attachment_1"]A[/caption] [caption id="attachment_2"]B[/caption]', "c"),
			],
		};
		expect(found(data)).toEqual(["shortcode [gallery]", 'shortcode [caption id="attachment_1"]']);
		// The same shortcode on many pages is one row (its key), found on each of them.
		const keys = (n: number) =>
			leftoversIn(
				{ slug: "p", data: { content: [text(`[caption id="attachment_${n}"]x[/caption]`)] } },
				PLAIN,
			).map((l) => l.key);
		expect(keys(1)).toEqual(keys(2));
	});
});

describe("left over from WordPress: empty HTML blocks", () => {
	it("finds an empty block and the WordPress block it came from", () => {
		const data = {
			content: [
				{ _type: "htmlBlock", _key: "a", html: "" },
				{
					_type: "htmlBlock",
					_key: "b",
					html: '<!-- wp:latest-posts {"postsToShow":3} /-->',
					originalBlockName: "core/latest-posts",
				},
				{ _type: "htmlBlock", _key: "c", html: "  <div class='x'> </div>&nbsp;" },
			],
		};
		const list = leftoversIn({ slug: "home", data }, PLAIN);
		expect(list.map((l) => `${l.type} ${l.detail ?? ""}`)).toEqual([
			"empty-html ",
			"empty-html Latest Posts",
		]);
	});

	it("leaves an HTML block that shows something alone", () => {
		const data = {
			content: [
				{ _type: "htmlBlock", _key: "a", html: "<p>Open daily</p>" },
				{ _type: "htmlBlock", _key: "b", html: '<iframe src="https://maps.example/x"></iframe>' },
				{ _type: "htmlBlock", _key: "c", html: '<img src="/a.jpg" alt="A loaf">' },
			],
		};
		expect(found(data)).toEqual([]);
	});
});

describe("left over from WordPress: links to the old site", () => {
	it("finds WordPress addresses this site does not use", () => {
		const data = {
			content: [
				link("About", "/?p=12", "a"),
				link("Services", "?p=20", "b"),
				link("Shop", "/?page_id=7", "c"),
				link("Old picture", "https://old-bakery.example/wp-content/uploads/2024/05/oven.jpg", "d"),
				link("Old post", "https://old-bakery.example/?p=5", "e"),
				link("Fine", "/about", "f"),
				link("Fine too", "https://bakery.example/menu?p=2&q=1", "g"),
			],
		};
		expect(found(data)).toEqual([
			"old-link /?p=12",
			"old-link ?p=20",
			"old-link /?page_id=7",
			"old-link https://old-bakery.example/wp-content/uploads/2024/05/oven.jpg",
			"old-link https://old-bakery.example/?p=5",
		]);
	});

	it("knows the old site's name from its WordPress addresses", () => {
		const data = {
			content: [
				link("Old picture", "https://www.old-bakery.example/wp-content/uploads/a.jpg", "a"),
				link("Ours", "https://bakery.example/wp-content/x.jpg", "b"),
				link("A friend", "https://friend.example/2024/05/sourdough/", "c"),
			],
		};
		expect(oldHostsIn(data, SITE)).toEqual(["old-bakery.example"]);
	});

	it("flags dated and category addresses only on the old site, or here when this site has no dated addresses", () => {
		const data = {
			content: [
				link("Post", "https://old-bakery.example/2024/05/sourdough/", "a"),
				link("News", "https://old-bakery.example/category/news/", "b"),
				link("About", "https://old-bakery.example/about-us/", "c"),
				link("Paper", "https://news.example/2024/05/12/bread-prices/", "d"),
				link("Here", "/2023/11/rye/", "e"),
			],
		};
		// Before the old site is known: only this site's dated address.
		expect(found(data)).toEqual(["old-link /2023/11/rye/"]);
		const known = { ...PLAIN, oldHosts: ["old-bakery.example"] };
		expect(found(data, known)).toEqual([
			"old-link https://old-bakery.example/2024/05/sourdough/",
			"old-link https://old-bakery.example/category/news/",
			"old-link https://old-bakery.example/about-us/",
			"old-link /2023/11/rye/",
		]);
		// A site whose own posts live at dated addresses: those are its links, checked as links.
		expect(found(data, { ...known, datedOwn: true })).not.toContain("old-link /2023/11/rye/");
	});
});

describe("left over from WordPress: addresses and pictures", () => {
	it("finds a slug with WordPress's encoded letters", () => {
		expect(
			found({ title: "Τυρόπιτα" }, PLAIN, "%cf%84%cf%85%cf%81%cf%8c%cf%80%ce%b9%cf%84%ce%b1"),
		).toEqual(["encoded-slug %cf%84%cf%85%cf%81%cf%8c%cf%80%ce%b9%cf%84%ce%b1"]);
		expect(found({ title: "Rye" }, PLAIN, "rye-100")).toEqual([]);
	});

	it("finds pictures with no alt text: featured, inline and in a gallery", () => {
		const data = {
			featured_image: {
				provider: "local",
				id: "m1",
				src: "/_emdash/api/media/file/oven.jpg",
				filename: "oven.jpg",
				mimeType: "image/jpeg",
			},
			content: [
				{
					_type: "image",
					_key: "i1",
					asset: { _type: "reference", _ref: "m2", url: "/_emdash/api/media/file/loaf.jpg" },
				},
				{
					_type: "image",
					_key: "i2",
					asset: { _type: "reference", _ref: "m3" },
					alt: "A rye loaf",
				},
				{
					_type: "gallery",
					_key: "g",
					images: [
						{
							_type: "image",
							_key: "g1",
							asset: { _type: "reference", _ref: "m4", url: "/x/crumb.jpg" },
							alt: "",
						},
						{ _type: "image", _key: "g2", asset: { _type: "reference", _ref: "m5" }, alt: "Crust" },
					],
				},
			],
			logo: { id: "m6", src: "/logo.svg", alt: "Bakery" },
			brochure: { id: "f1", src: "/menu.pdf", mimeType: "application/pdf" },
		};
		const list = leftoversIn({ slug: "about", data }, PLAIN);
		expect(list.map((l) => `${l.type} ${l.text}${l.detail ? ` ${l.detail}` : ""}`)).toEqual([
			"no-alt oven.jpg featured",
			"no-alt loaf.jpg",
			"no-alt crumb.jpg",
		]);
	});
});

function words(
	shown: Pick<LinkRow, "kind" | "reason" | "detail" | "url"> & { menu?: boolean },
): string {
	return describeRow(shown, shortFor(shown));
}

function row(extra: Partial<LinkRow>): LinkRow {
	return {
		kind: "leftover",
		url: "",
		host: "",
		sources: [],
		count: 1,
		menu: false,
		content: true,
		editor: true,
		pass: 1,
		state: "left",
		due: "9999",
		...extra,
	};
}

describe("the words for each row", () => {
	it("says what it is and what to do, in plain words", () => {
		expect(
			words(
				row({ reason: "shortcode", url: '[contact-form-7 id="9ee95fa" title="Contact form 1"]' }),
			),
		).toBe(
			'[contact-form-7 id="9ee95fa" title="Contact form 1"] is a WordPress shortcode: visitors see it as plain text. Open the page and put a form block in its place, or delete it.',
		);
		expect(words(row({ reason: "empty-html", detail: "Latest Posts" }))).toBe(
			"An empty HTML block, left from WordPress's Latest Posts block, shows nothing. Open the page and delete the block.",
		);
		expect(words(row({ reason: "old-link", url: "/?p=12" }))).toBe(
			"/?p=12 is a WordPress address this site does not use, so it opens the wrong page or none. Open the page and link those words to the page's address here.",
		);
		expect(
			words(
				row({
					reason: "old-link",
					url: "https://old-bakery.example/about-us/",
					host: "old-bakery.example",
				}),
			),
		).toBe(
			"old-bakery.example/about-us looks like an address on your old WordPress site. If it is, open the page and link those words to the page's address here: once that site is switched off, this link stops working.",
		);
		expect(
			words(row({ reason: "old-link", url: "/?p=3", menu: true, content: false, editor: false })),
		).toBe(
			"/?p=3 is a WordPress address this site does not use, so it opens the wrong page or none. Open Menus in the sidebar, under Manage, and point that item at the page's address here.",
		);
		expect(words(row({ reason: "encoded-slug", url: "%cf%84%cf%85" }))).toBe(
			"This page's address %cf%84%cf%85 is in WordPress's coded form of its letters, so it opens \"Page not found\". Open the page and type a new slug in plain letters, such as its title in Latin letters, then publish.",
		);
		expect(words(row({ reason: "no-alt", url: "oven.jpg", detail: "featured" }))).toBe(
			"The featured image oven.jpg has no alt text, which screen readers and search engines read. Open the page, select the picture and fill in its alt text.",
		);
	});
});

describe("this site's own address on this computer", () => {
	it("takes localhost and 127.0.0.1 for the same site, and nothing else", () => {
		expect(toTarget("http://127.0.0.1:4321/team-old", "http://127.0.0.1:4321")).toMatchObject({
			url: "/team-old",
			internal: true,
		});
		expect(toTarget("http://127.0.0.1:4321/team-old", "http://localhost:4321")).toMatchObject({
			url: "/team-old",
			internal: true,
		});
		expect(toTarget("http://localhost:4321/team-old", "http://127.0.0.1:4321")).toMatchObject({
			url: "/team-old",
			internal: true,
		});
		// A public site never takes a link to this computer for its own.
		expect(toTarget("http://127.0.0.1/admin", "https://bakery.example")).toMatchObject({
			internal: false,
			host: "127.0.0.1",
		});
		expect(toTarget("http://10.0.0.2/x", "http://localhost:4321")).toMatchObject({
			internal: false,
		});
	});

	it("says an address on a site that is not public yet is checked once it is", () => {
		expect(words({ kind: "internal", url: "/team-old", reason: "not-public" })).toBe(
			"/team-old matches no page we know of. Your site is not public yet, so we cannot open the address to be sure; it is checked once the site has a public address.",
		);
	});
});

describe("phone-safe leftover rows", () => {
	it("never holds a word longer than 30 characters", () => {
		const long = `[contact-form-7 id="${"9".repeat(40)}" title="Contact form 1"]`;
		const slug = "%cf%84%cf%85%cf%81%cf%8c%cf%80%ce%b9%cf%84%ce%b1-%ce%bc%ce%b5";
		for (const [reason, url] of [
			["shortcode", long],
			["encoded-slug", slug],
			["no-alt", "a-very-long-picture-name-from-wordpress-uploads.jpg"],
			["old-link", "https://old-bakery.example/2024/05/a-very-long-post-address-here/"],
		] as const) {
			const said = words({ kind: "leftover", reason, url });
			for (const word of said.split(/\s+/))
				expect(word.length, `${reason}: ${word}`).toBeLessThanOrEqual(31);
		}
	});
});
