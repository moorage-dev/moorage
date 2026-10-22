// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import {
	createPluginRuntimeTestHost,
	createPluginTestHost,
	type PluginRuntimeTestHost,
	type PluginTestHost,
} from "@emdash-cms/plugin-test";
import type { PageMetadataContribution, PublicPageContext } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import type { EntryRecord } from "../src/record.js";

let host: PluginTestHost | PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

function page(overrides: Partial<PublicPageContext> = {}): PublicPageContext {
	return {
		url: "https://acme.test/about",
		path: "/about",
		locale: null,
		kind: "custom",
		pageType: "website",
		title: "About | Acme",
		pageTitle: "About",
		description: null,
		canonical: null,
		image: null,
		...overrides,
	};
}

type JsonLd = Extract<PageMetadataContribution, { kind: "jsonld" }>;

function robots(contributions: PageMetadataContribution[]): string | undefined {
	const meta = contributions.find((c) => c.kind === "meta" && c.name === "robots");
	return meta?.kind === "meta" ? meta.content : undefined;
}

function jsonLd(contributions: PageMetadataContribution[], id: string): JsonLd | undefined {
	return contributions.find((c): c is JsonLd => c.kind === "jsonld" && c.id === id);
}

function graphNodes(contribution: JsonLd | undefined): Array<Record<string, unknown>> {
	const graph = contribution?.graph as { "@graph"?: Array<Record<string, unknown>> } | undefined;
	return graph?.["@graph"] ?? [];
}

function nodeTypes(contribution: JsonLd | undefined): unknown[] {
	return graphNodes(contribution).map((node) => node["@type"]);
}

async function runtimeHost(): Promise<PluginRuntimeTestHost> {
	const runtime = await createPluginRuntimeTestHost({
		site: { name: "Acme", url: "https://acme.test", locale: "en" },
	});
	host = runtime;
	return runtime;
}

async function collection(runtime: PluginRuntimeTestHost, slug: string): Promise<void> {
	await runtime.fixtures.collection({
		slug,
		label: slug,
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
}

/** The nodes an entry's JSON-LD field added to the page's graph. */
async function customNodes(
	runtime: PluginRuntimeTestHost,
	context: PublicPageContext,
): Promise<Array<Record<string, unknown>>> {
	const nodes = graphNodes(jsonLd(await metadata(runtime, context), "primary"));
	return nodes.filter((node) => node["@type"] === "Event");
}

async function metadata(
	runtime: PluginRuntimeTestHost,
	context: PublicPageContext,
): Promise<PageMetadataContribution[]> {
	return (await runtime.transport.invokeHook("page:metadata", {
		page: context,
	})) as PageMetadataContribution[];
}

describe("hello route", () => {
	it("returns a greeting through the sandbox host", async () => {
		const plain = await createPluginTestHost();
		host = plain;
		expect(await plain.invokeRoute("hello")).toEqual({ greeting: "hello", pluginId: "seo" });
	});
});

describe("page:metadata", () => {
	it("replaces core's JSON-LD with one linked graph on a custom page", async () => {
		const runtime = await runtimeHost();
		const contributions = await metadata(runtime, page());

		const primary = jsonLd(contributions, "primary");
		expect(contributions.filter((c) => c.kind === "jsonld")).toHaveLength(1);
		expect(primary?.graph).toMatchObject({ "@context": "https://schema.org" });
		expect(nodeTypes(primary)).toEqual(["Organization", "WebSite", "WebPage", "BreadcrumbList"]);
		expect(robots(contributions)).toBe(
			"index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1",
		);
	});

	it("reads site identity and collection rules from the stored configuration", async () => {
		const runtime = await runtimeHost();
		await runtime.fixtures.plugin.kv("config", {
			site: {
				type: "Dentist",
				name: "Acme Dental",
				telephone: "+1 555 0100",
				address: { streetAddress: "1 Main St" },
			},
			collections: { pages: { type: "ContactPage", noindex: true } },
		});
		await collection(runtime, "pages");
		const entry = await runtime.fixtures.content("pages", {
			slug: "contact",
			data: { title: "Contact" },
			status: "published",
		});

		const contributions = await metadata(
			runtime,
			page({
				kind: "content",
				content: { collection: "pages", id: entry.id, slug: "contact" },
			}),
		);

		// The collection is kept out of search, so only the site itself is described.
		expect(nodeTypes(jsonLd(contributions, "primary"))).toEqual(["Dentist", "WebSite"]);
		expect(robots(contributions)).toBe("noindex, follow");
		// The entry predates the plugin: its record is built on this first render.
		expect(
			await runtime.inspect.storage.get<EntryRecord>("entries", `pages:${entry.id}`),
		).toMatchObject({ v: 1, authors: [], custom: [] });

		// Back in search (saved on the SEO page, so it shows at once), the page is
		// described with the collection's type.
		await runtime.admin.act("/overview", "set_visible", { value: "pages|show" });
		const shown = await metadata(
			runtime,
			page({
				kind: "content",
				content: { collection: "pages", id: entry.id, slug: "contact" },
			}),
		);
		expect(nodeTypes(jsonLd(shown, "primary"))).toEqual([
			"Dentist",
			"WebSite",
			"ContactPage",
			"BreadcrumbList",
		]);
	});

	it("keeps the config in the sandbox between page views, and a save shows at once", async () => {
		const runtime = await runtimeHost();
		const orgName = async () =>
			graphNodes(jsonLd(await metadata(runtime, page()), "primary")).find(
				(node) => node["@type"] === "Organization",
			)?.name;
		await runtime.admin.submit("/overview", "save_identity", {
			kind: "organization",
			name: "Acme Dental",
		});
		expect(await orgName()).toBe("Acme Dental");

		// Written straight to the database, the way a save in another isolate looks
		// from here: this isolate keeps the copy it read (for up to 30 seconds).
		await runtime.fixtures.plugin.setting("config", { site: { name: "Written elsewhere" } });
		expect(await orgName()).toBe("Acme Dental");

		// A save on the SEO page shows on the very next page view.
		const saved = await runtime.admin.submit("/overview", "save_identity", {
			kind: "organization",
			name: "Acme Clinic",
		});
		expect(saved.toast?.type).toBe("success");
		expect(await orgName()).toBe("Acme Clinic");
	});

	it("keeps an editor's noindex from the SEO panel", async () => {
		const runtime = await runtimeHost();
		const contributions = await metadata(runtime, page({ seo: { robots: "noindex, nofollow" } }));
		expect(robots(contributions)).toBe("noindex, nofollow");
	});

	it("credits byline authors and dates on an article after a real save", async () => {
		const runtime = await runtimeHost();
		await collection(runtime, "posts");
		const byline = await runtime.fixtures.byline({
			slug: "ada",
			displayName: "Ada Lovelace",
			websiteUrl: "https://ada.test",
		});
		const entry = await runtime.fixtures.content("posts", {
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			publishedAt: "2026-09-01T10:00:00.000Z",
		});
		// A real save through EmDash: the plugin's content:afterSave hook stores the record.
		await runtime.actions.content.update("posts", entry.id, {
			bylines: [{ bylineId: byline.id }],
		});
		const context = page({
			url: "https://acme.test/blog/hello",
			path: "/blog/hello",
			pageType: "article",
			pageTitle: "Hello",
			kind: "content",
			content: { collection: "posts", id: entry.id, slug: "hello" },
		});

		const contributions = await metadata(runtime, context);

		const stored = await runtime.inspect.storage.get<EntryRecord>("entries", `posts:${entry.id}`);
		expect(stored).toMatchObject({
			v: 1,
			publishedAt: "2026-09-01T10:00:00.000Z",
			authors: [{ name: "Ada Lovelace", url: "https://ada.test" }],
			custom: [],
		});

		expect(graphNodes(jsonLd(contributions, "primary"))).toContainEqual(
			expect.objectContaining({
				"@type": "BlogPosting",
				datePublished: "2026-09-01T10:00:00.000Z",
				author: [{ "@type": "Person", name: "Ada Lovelace", url: "https://ada.test" }],
			}),
		);
	});

	it("adds an entry's JSON-LD field to the one graph and links it from the page", async () => {
		const runtime = await runtimeHost();
		await runtime.fixtures.collection({
			slug: "events",
			label: "Events",
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "json_ld", label: "JSON-LD", type: "json" },
			],
		});
		const entry = await runtime.fixtures.content("events", {
			slug: "open-day",
			data: {
				title: "Open day",
				json_ld: {
					"@context": "https://schema.org",
					"@type": "Event",
					"@id": "https://acme.test/about#open-day",
					name: "Open day",
				},
			},
			status: "published",
		});

		const contributions = await metadata(
			runtime,
			page({
				kind: "content",
				content: { collection: "events", id: entry.id, slug: "open-day" },
			}),
		);

		// One script, whatever the entry adds.
		expect(contributions.filter((c) => c.kind === "jsonld")).toHaveLength(1);
		const nodes = graphNodes(jsonLd(contributions, "primary"));
		expect(nodes.at(-1)).toEqual({
			"@type": "Event",
			"@id": "https://acme.test/about#open-day",
			name: "Open day",
		});
		expect(nodes.find((node) => node["@type"] === "WebPage")?.mainEntity).toEqual({
			"@id": "https://acme.test/about#open-day",
		});
	});

	it("emits no page nodes, and one script, on a page hidden from search", async () => {
		const runtime = await runtimeHost();
		await runtime.fixtures.collection({
			slug: "services",
			label: "Services",
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "json_ld", label: "JSON-LD", type: "json" },
			],
		});
		const entry = await runtime.fixtures.content("services", {
			slug: "cleaning",
			data: { title: "Cleaning", json_ld: { "@type": "Event", "@id": "#s", name: "Cleaning" } },
			status: "published",
		});

		const contributions = await metadata(
			runtime,
			page({
				kind: "content",
				image: "/hero.jpg",
				content: { collection: "services", id: entry.id, slug: "cleaning" },
				seo: { robots: "noindex, nofollow" },
			}),
		);

		expect(robots(contributions)).toBe("noindex, nofollow");
		expect(contributions.filter((c) => c.kind === "jsonld")).toHaveLength(1);
		expect(nodeTypes(jsonLd(contributions, "primary"))).toEqual(["Organization", "WebSite"]);

		// A page with no canonical is not a hidden page: it keeps its nodes.
		const plain = await metadata(runtime, page({ canonical: null }));
		expect(nodeTypes(jsonLd(plain, "primary"))).toEqual([
			"Organization",
			"WebSite",
			"WebPage",
			"BreadcrumbList",
		]);
	});
});

describe("drafts", () => {
	it("keeps unpublished edits out of the live page's schema", async () => {
		const runtime = await runtimeHost();
		await runtime.fixtures.collection({
			slug: "services",
			label: "Services",
			supports: ["drafts", "revisions", "preview", "seo"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "json_ld", label: "JSON-LD", type: "json" },
			],
		});
		const entry = await runtime.fixtures.content("services", {
			slug: "cleaning",
			data: { title: "Cleaning", json_ld: { "@type": "Event", name: "Published" } },
			status: "published",
		});
		const context = page({
			kind: "content",
			content: { collection: "services", id: entry.id, slug: "cleaning" },
		});
		expect(await customNodes(runtime, context)).toMatchObject([{ name: "Published" }]);

		// Edit without publishing: a real save, so content:afterSave runs.
		const saved = await runtime.actions.content.update("services", entry.id, {
			data: { title: "Cleaning", json_ld: { "@type": "Event", name: "Draft" } },
		});
		expect(saved.success).toBe(true);
		// EmDash runs after-save hooks in the background; run it again here so the
		// record is certainly rebuilt while the edit is still unpublished.
		await runtime.transport.invokeHook("content:afterSave", {
			collection: "services",
			content: { id: entry.id },
			isNew: false,
		});
		const live = await runtime.inspect.content.get("services", entry.id);
		expect(live?.status).toBe("published");

		expect(await customNodes(runtime, context)).toMatchObject([{ name: "Published" }]);
	});
});

describe("entry records", () => {
	it("refreshes on save and is removed on delete", async () => {
		const runtime = await runtimeHost();
		await collection(runtime, "pages");
		const entry = await runtime.fixtures.content("pages", {
			slug: "about",
			data: { title: "About" },
			status: "published",
		});
		const key = `pages:${entry.id}`;

		await runtime.transport.invokeHook("content:afterSave", {
			collection: "pages",
			content: { id: entry.id },
			isNew: false,
		});
		expect(await runtime.inspect.storage.get<EntryRecord>("entries", key)).toMatchObject({ v: 1 });

		await runtime.transport.invokeHook("content:afterDelete", {
			collection: "pages",
			id: entry.id,
		});
		expect(await runtime.inspect.storage.get("entries", key)).toBeNull();
	});

	it("keeps the entry's schema type when the record is rebuilt", async () => {
		const runtime = await runtimeHost();
		await collection(runtime, "pages");
		const entry = await runtime.fixtures.content("pages", {
			slug: "about",
			data: { title: "About" },
			status: "published",
		});
		const key = `pages:${entry.id}`;
		await runtime.fixtures.plugin.storage("entries", key, {
			v: 1,
			publishedAt: null,
			updatedAt: null,
			authors: [],
			type: "AboutPage",
			custom: [],
		} satisfies EntryRecord);

		await runtime.transport.invokeHook("content:afterPublish", {
			collection: "pages",
			content: { id: entry.id },
		});

		expect(await runtime.inspect.storage.get<EntryRecord>("entries", key)).toMatchObject({
			type: "AboutPage",
		});
	});
});
