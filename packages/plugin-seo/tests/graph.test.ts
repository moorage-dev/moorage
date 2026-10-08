// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import type { PublicPageContext } from "emdash";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig, type SeoConfig } from "../src/config.js";
import { buildGraph, type SchemaNode } from "../src/graph.js";
import { parseCustomSchema, type EntryRecord } from "../src/record.js";
import { mergeRobots } from "../src/robots.js";

const SITE = { name: "Acme", url: "https://acme.test", locale: "en" };

function page(overrides: Partial<PublicPageContext> = {}): PublicPageContext {
	return {
		url: "https://acme.test/pricing",
		path: "/pricing",
		locale: null,
		kind: "custom",
		pageType: "website",
		title: "Pricing | Acme",
		pageTitle: "Pricing",
		description: "Plans and prices.",
		canonical: null,
		image: null,
		...overrides,
	};
}

function record(overrides: Partial<EntryRecord> = {}): EntryRecord {
	return {
		v: 1,
		publishedAt: "2026-09-01T10:00:00.000Z",
		updatedAt: "2026-09-02T10:00:00.000Z",
		authors: [],
		custom: [],
		...overrides,
	};
}

function graph(
	pageOverrides: Partial<PublicPageContext> = {},
	config: SeoConfig = DEFAULT_CONFIG,
	entry: EntryRecord | null = null,
): SchemaNode[] {
	return buildGraph({ page: page(pageOverrides), config, record: entry, site: SITE });
}

function byType(nodes: SchemaNode[], type: string): SchemaNode {
	const node = nodes.find((candidate) => candidate["@type"] === type);
	if (!node) throw new Error(`no ${type} node in graph`);
	return node;
}

describe("site representation", () => {
	it("emits an Organization named after the site by default", () => {
		const organization = byType(graph(), "Organization");
		expect(organization).toEqual({
			"@type": "Organization",
			"@id": "https://acme.test/#organization",
			name: "Acme",
			url: "https://acme.test/",
		});
	});

	it("adds logo and profiles from the configuration", () => {
		const config = normalizeConfig({
			site: {
				name: "Acme Inc",
				logo: "https://acme.test/logo.png",
				sameAs: ["https://www.linkedin.com/company/acme", "not a url"],
			},
		});
		const organization = byType(graph({}, config), "Organization");
		expect(organization.name).toBe("Acme Inc");
		expect(organization.sameAs).toEqual(["https://www.linkedin.com/company/acme"]);
		expect(organization.logo).toMatchObject({
			"@type": "ImageObject",
			"@id": "https://acme.test/#logo",
			url: "https://acme.test/logo.png",
		});
		expect(organization.image).toEqual({ "@id": "https://acme.test/#logo" });
	});

	it("emits a Person without organisation-only properties", () => {
		const config = normalizeConfig({
			site: { type: "Person", name: "Ada Lovelace", logo: "https://acme.test/ada.jpg" },
		});
		const person = byType(graph({}, config), "Person");
		expect(person["@id"]).toBe("https://acme.test/#person");
		expect(person.image).toBe("https://acme.test/ada.jpg");
		expect(person).not.toHaveProperty("logo");
	});

	it("emits a LocalBusiness subtype with address, geo and opening hours", () => {
		const config = normalizeConfig({
			site: {
				type: "Dentist",
				telephone: "+1 555 0100",
				priceRange: "$$",
				address: { streetAddress: "1 Main St", addressLocality: "Springfield" },
				geo: { latitude: 39.78, longitude: -89.65 },
				openingHours: [{ days: ["Monday", "Tuesday"], opens: "09:00", closes: "17:00" }],
			},
		});
		const business = byType(graph({}, config), "Dentist");
		expect(business).toMatchObject({
			telephone: "+1 555 0100",
			priceRange: "$$",
			address: {
				"@type": "PostalAddress",
				streetAddress: "1 Main St",
				addressLocality: "Springfield",
			},
			geo: { "@type": "GeoCoordinates", latitude: 39.78, longitude: -89.65 },
			openingHoursSpecification: [
				{
					"@type": "OpeningHoursSpecification",
					dayOfWeek: ["Monday", "Tuesday"],
					opens: "09:00",
					closes: "17:00",
				},
			],
		});
	});
});

describe("WebSite and WebPage", () => {
	it("links WebPage to WebSite to the site representation", () => {
		const nodes = graph();
		const website = byType(nodes, "WebSite");
		const webpage = byType(nodes, "WebPage");
		expect(website).toMatchObject({
			"@id": "https://acme.test/#website",
			name: "Acme",
			publisher: { "@id": "https://acme.test/#organization" },
			inLanguage: "en",
		});
		// Google removed the sitelinks search box; no SearchAction is emitted.
		expect(website).not.toHaveProperty("potentialAction");
		expect(webpage).toMatchObject({
			"@id": "https://acme.test/pricing",
			url: "https://acme.test/pricing",
			name: "Pricing",
			description: "Plans and prices.",
			isPartOf: { "@id": "https://acme.test/#website" },
		});
		expect(webpage).not.toHaveProperty("about");
	});

	it("marks the home page as being about the site representation", () => {
		const webpage = byType(graph({ url: "https://acme.test/", path: "/" }), "WebPage");
		expect(webpage.about).toEqual({ "@id": "https://acme.test/#organization" });
		expect(webpage).not.toHaveProperty("breadcrumb");
	});

	it("uses the canonical as the page identity and drops query strings", () => {
		expect(byType(graph({ canonical: "/plans" }), "WebPage")["@id"]).toBe(
			"https://acme.test/plans",
		);
		expect(
			byType(graph({ url: "https://acme.test/pricing?utm_source=x#top" }), "WebPage")["@id"],
		).toBe("https://acme.test/pricing");
	});

	it("uses the collection's page type", () => {
		const config = normalizeConfig({ collections: { pages: { type: "ContactPage" } } });
		const nodes = graph(
			{ kind: "content", content: { collection: "pages", id: "1", slug: "contact" } },
			config,
		);
		expect(byType(nodes, "ContactPage")["@id"]).toBe("https://acme.test/pricing");
	});

	it("lets an entry's own type win over the collection's", () => {
		const config = normalizeConfig({ collections: { pages: { type: "ContactPage" } } });
		const nodes = graph(
			{ kind: "content", content: { collection: "pages", id: "1", slug: "about" } },
			config,
			record({ type: "AboutPage" }),
		);
		expect(nodes.some((node) => node["@type"] === "AboutPage")).toBe(true);
		expect(nodes.some((node) => node["@type"] === "ContactPage")).toBe(false);
	});

	it("emits the primary image as its own node", () => {
		const nodes = graph({ image: "/media/hero.jpg" });
		expect(byType(nodes, "ImageObject")).toEqual({
			"@type": "ImageObject",
			"@id": "https://acme.test/pricing#primaryimage",
			url: "https://acme.test/media/hero.jpg",
			contentUrl: "https://acme.test/media/hero.jpg",
		});
		expect(byType(nodes, "WebPage").primaryImageOfPage).toEqual({
			"@id": "https://acme.test/pricing#primaryimage",
		});
	});
});

describe("articles", () => {
	const post = {
		url: "https://acme.test/blog/hello",
		path: "/blog/hello",
		pageType: "article",
		pageTitle: "Hello world",
		kind: "content" as const,
		content: { collection: "posts", id: "p1", slug: "hello" },
	};

	it("emits a BlogPosting with dates and byline authors", () => {
		const nodes = graph(
			post,
			DEFAULT_CONFIG,
			record({ authors: [{ name: "Ada", url: "https://ada.test" }, { name: "Grace" }] }),
		);
		expect(byType(nodes, "BlogPosting")).toMatchObject({
			"@id": "https://acme.test/blog/hello#article",
			headline: "Hello world",
			isPartOf: { "@id": "https://acme.test/blog/hello" },
			mainEntityOfPage: { "@id": "https://acme.test/blog/hello" },
			datePublished: "2026-09-01T10:00:00.000Z",
			dateModified: "2026-09-02T10:00:00.000Z",
			author: [
				{ "@type": "Person", name: "Ada", url: "https://ada.test" },
				{ "@type": "Person", name: "Grace" },
			],
			publisher: { "@id": "https://acme.test/#organization" },
		});
		// The page itself stays a WebPage; the article is a second node about it.
		expect(byType(nodes, "WebPage")["@id"]).toBe("https://acme.test/blog/hello");
	});

	it("falls back to the theme's article metadata, then to the site", () => {
		const fromTheme = byType(
			graph({
				...post,
				articleMeta: { publishedTime: "2026-01-01T00:00:00.000Z", author: "Linus" },
			}),
			"BlogPosting",
		);
		expect(fromTheme.datePublished).toBe("2026-01-01T00:00:00.000Z");
		expect(fromTheme.author).toEqual([{ "@type": "Person", name: "Linus" }]);

		expect(byType(graph(post), "BlogPosting").author).toEqual([
			{ "@id": "https://acme.test/#organization" },
		]);
	});

	it("uses the configured article type and truncates long headlines", () => {
		const config = normalizeConfig({ collections: { posts: { type: "NewsArticle" } } });
		const article = byType(graph({ ...post, pageTitle: "x".repeat(200) }, config), "NewsArticle");
		expect((article.headline as string).length).toBe(110);
	});
});

describe("breadcrumbs", () => {
	it("derives a trail from the path when the theme passes none", () => {
		const nodes = graph({ url: "https://acme.test/blog/hello-world", path: "/blog/hello-world" });
		expect(byType(nodes, "BreadcrumbList")).toEqual({
			"@type": "BreadcrumbList",
			"@id": "https://acme.test/blog/hello-world#breadcrumb",
			itemListElement: [
				{ "@type": "ListItem", position: 1, name: "Home", item: "https://acme.test/" },
				{ "@type": "ListItem", position: 2, name: "Blog", item: "https://acme.test/blog" },
				{ "@type": "ListItem", position: 3, name: "Pricing" },
			],
		});
	});

	it("uses the theme's trail verbatim", () => {
		const nodes = graph({
			breadcrumbs: [
				{ name: "Start", url: "/" },
				{ name: "Plans", url: "/pricing" },
			],
		});
		expect(byType(nodes, "BreadcrumbList").itemListElement).toEqual([
			{ "@type": "ListItem", position: 1, name: "Start", item: "https://acme.test/" },
			{ "@type": "ListItem", position: 2, name: "Plans" },
		]);
	});

	it("emits none when the theme passes an empty trail or they are switched off", () => {
		expect(graph({ breadcrumbs: [] }).some((node) => node["@type"] === "BreadcrumbList")).toBe(
			false,
		);
		const off = normalizeConfig({ breadcrumbs: false });
		expect(graph({}, off).some((node) => node["@type"] === "BreadcrumbList")).toBe(false);
	});
});

describe("robots", () => {
	const defaults = DEFAULT_CONFIG.robots;

	it("adds snippet limits to an indexable page", () => {
		expect(mergeRobots(null, false, defaults)).toBe(
			"index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1",
		);
	});

	it("never turns an editor's noindex back into index", () => {
		expect(mergeRobots("noindex, nofollow", false, defaults)).toBe("noindex, nofollow");
		expect(mergeRobots("NOINDEX", false, defaults)).toBe("noindex, follow");
		expect(mergeRobots("none", false, defaults)).toBe("noindex, nofollow");
	});

	it("applies a collection's noindex", () => {
		expect(mergeRobots(null, true, defaults)).toBe("noindex, follow");
		expect(mergeRobots("index, follow", true, defaults)).toBe("noindex, follow");
	});

	it("keeps the editor's other directives and their own limits", () => {
		expect(mergeRobots("index, noarchive, max-snippet:50", false, defaults)).toBe(
			"index, follow, noarchive, max-snippet:50, max-image-preview:large, max-video-preview:-1",
		);
	});

	it("emits nosnippet instead of a snippet limit when configured", () => {
		expect(mergeRobots(null, false, { ...defaults, nosnippet: true })).toBe(
			"index, follow, nosnippet, max-image-preview:large, max-video-preview:-1",
		);
	});
});

describe("runtime compatibility", () => {
	it("works where URL.canParse does not exist", () => {
		// The sandbox EmDash runs in development has no URL.canParse; the test
		// harness does, so this guards a failure only a real site would show.
		const original = URL.canParse;
		Object.defineProperty(URL, "canParse", { value: undefined, configurable: true });
		try {
			const config = normalizeConfig({ site: { logo: "https://acme.test/logo.png" } });
			expect(graph({ canonical: "/plans", image: "/hero.jpg" }, config)).toHaveLength(5);
		} finally {
			Object.defineProperty(URL, "canParse", { value: original, configurable: true });
		}
	});
});

describe("configuration and custom schema", () => {
	it("falls back to defaults for missing or malformed configuration", () => {
		expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig("nope")).toEqual(DEFAULT_CONFIG);
		const config = normalizeConfig({
			site: { logo: "javascript:alert(1)" },
			collections: { posts: { type: "Recipe", noindex: "yes" } },
			robots: { maxSnippet: "big", maxImagePreview: "huge" },
		});
		expect(config.site.logo).toBeUndefined();
		expect(config.collections.posts).toEqual({ type: undefined, noindex: false });
		expect(config.robots).toEqual(DEFAULT_CONFIG.robots);
	});

	it("accepts schema nodes as objects, arrays or JSON text", () => {
		const service = { "@type": "Service", name: "Cleaning" };
		expect(parseCustomSchema(service)).toEqual([service]);
		expect(parseCustomSchema([service, { name: "no type" }, "text"])).toEqual([service]);
		expect(parseCustomSchema(JSON.stringify(service))).toEqual([service]);
	});

	it("ignores empty, invalid and oversized values", () => {
		expect(parseCustomSchema(undefined)).toEqual([]);
		expect(parseCustomSchema("")).toEqual([]);
		expect(parseCustomSchema("{not json")).toEqual([]);
		expect(parseCustomSchema({ "@type": "Thing", name: "x".repeat(20_000) })).toEqual([]);
	});
});
