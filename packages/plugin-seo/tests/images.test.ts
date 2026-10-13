// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { PageMetadataContribution, PublicPageContext } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { buildGraph, type SchemaNode } from "../src/graph.js";
import {
	collectImages,
	findImageSize,
	imageKeys,
	MAX_IMAGES,
	type EntryImage,
} from "../src/images.js";
import type { EntryRecord } from "../src/record.js";

const SITE = "https://acme.test";
const KEY = "01KS3V5Q7Z8M2N4P6R8T0W2Y4A.webp";
const ID = "01KS3V5Q7Z8M2N4P6R8T0W2Y4A";
const FILE = `/_emdash/api/media/file/${KEY}`;

/** An image field's value as EmDash stores it for a local upload: no `src`. */
const cover = {
	id: ID,
	provider: "local",
	alt: "Loaves",
	width: 1600,
	height: 900,
	mimeType: "image/webp",
	meta: { storageKey: KEY },
};
const stored: EntryImage[] = [{ keys: [`file:${KEY}`, `file:${ID}`], width: 1600, height: 900 }];

describe("images in an entry's own fields", () => {
	it("reads an image field with its storage key, id and size", () => {
		expect(collectImages({ title: "Bread", cover })).toEqual(stored);
	});

	it("finds images inside blocks, repeaters and rich text", () => {
		const data = {
			content: [
				{ _type: "marketing_hero", headline: "Hi", image: cover },
				{
					_type: "gallery",
					items: [{ photo: { id: "01KS3V5Q7Z8M2N4P6R8T0W2Y4B", width: 800, height: 600 } }],
				},
			],
			body: [
				{ _type: "block", children: [{ _type: "span", text: "Hello" }] },
				{
					_type: "image",
					_key: "a",
					asset: { _ref: "01KS3V5Q7Z8M2N4P6R8T0W2Y4C", url: "/_emdash/api/media/file/c.png" },
					width: 640,
					height: 480,
					displayWidth: 320,
				},
			],
		};
		expect(collectImages(data)).toEqual([
			stored[0],
			{ keys: ["file:01KS3V5Q7Z8M2N4P6R8T0W2Y4B"], width: 800, height: 600 },
			{ keys: ["file:01KS3V5Q7Z8M2N4P6R8T0W2Y4C", "file:c.png"], width: 640, height: 480 },
		]);
	});

	it("knows an image hosted elsewhere by its address only", () => {
		const external = {
			id: "abc",
			provider: "external",
			src: "https://cdn.example/photos/bread.jpg",
			width: 1200,
			height: 800,
		};
		expect(collectImages({ external })).toEqual([
			{ keys: ["url:https://cdn.example/photos/bread.jpg"], width: 1200, height: 800 },
		]);
	});

	it("leaves out anything without a certain size or name", () => {
		expect(
			collectImages({
				noSize: { id: ID },
				half: { id: ID, width: 100 },
				zero: { id: ID, width: 0, height: 0 },
				text: { id: ID, width: "100", height: "50" },
				video: { id: ID, width: 1920, height: 1080, mimeType: "video/mp4" },
				box: { width: 10, height: 10 },
				resized: {
					id: "",
					provider: "external",
					src: "https://x.test/a.jpg?w=10",
					width: 9,
					height: 9,
				},
				json_ld: { image: cover },
			}),
		).toEqual([]);
	});

	it("keeps the first few, once each", () => {
		const many = Array.from({ length: 30 }, (_, index) => ({
			id: `01KS3V5Q7Z8M2N4P6R8T0W2Y${String(index).padStart(2, "0")}`,
			width: 10 + index,
			height: 10,
		}));
		const found = collectImages({ gallery: [cover, cover, ...many] });
		expect(found).toHaveLength(MAX_IMAGES);
		expect(found[0]).toEqual(stored[0]);
		expect(found[1]?.width).toBe(10);
	});
});

describe("matching the page's picture to one of them", () => {
	it("matches a media file address, relative or absolute, on any host", () => {
		const size = { width: 1600, height: 900 };
		expect(findImageSize(stored, FILE, SITE)).toEqual(size);
		expect(findImageSize(stored, `${SITE}${FILE}`, SITE)).toEqual(size);
		expect(findImageSize(stored, `https://www.acme.test${FILE}`, SITE)).toEqual(size);
		// An address built from the media id instead of the storage key.
		expect(findImageSize(stored, `/_emdash/api/media/file/${ID}`, SITE)).toEqual(size);
		// Storage with its own public address serves "<address>/<storage key>".
		expect(findImageSize(stored, `https://media.acme.test/${KEY}`, SITE)).toEqual(size);
	});

	it("matches an image hosted elsewhere by its exact address", () => {
		const external: EntryImage[] = [
			{ keys: ["url:https://cdn.example/photos/bread.jpg"], width: 1200, height: 800 },
		];
		expect(findImageSize(external, "https://cdn.example/photos/bread.jpg", SITE)).toEqual({
			width: 1200,
			height: 800,
		});
		expect(findImageSize(external, "https://cdn.example/photos/bread.jpg#top", SITE)).toEqual({
			width: 1200,
			height: 800,
		});
		expect(findImageSize(external, "https://other.example/photos/bread.jpg", SITE)).toBeUndefined();
		expect(findImageSize(external, "/photos/bread.jpg", SITE)).toBeUndefined();
	});

	it("gives no size for a resized or transformed picture", () => {
		for (const url of [
			`${FILE}?w=800`,
			`${SITE}${FILE}?width=1200&format=avif`,
			`/_image?href=${encodeURIComponent(FILE)}&w=800`,
			`/cdn-cgi/image/width=800/${SITE}${FILE}`,
			`https://media.acme.test/cdn-cgi/image/fit=cover/${KEY}`,
			`https://media.acme.test/w_300/${KEY}`,
		]) {
			expect(
				imageKeys(url, SITE).filter((key) => key.startsWith("file:")),
				url,
			).toEqual([]);
			expect(findImageSize(stored, url, SITE), url).toBeUndefined();
		}
	});

	it("gives no size when nothing matches for certain", () => {
		expect(findImageSize(stored, "/_emdash/api/media/file/other.webp", SITE)).toBeUndefined();
		expect(findImageSize(stored, "/images/hero.webp", SITE)).toBeUndefined();
		expect(findImageSize(stored, `/media/${KEY}/thumb`, SITE)).toBeUndefined();
		expect(findImageSize(stored, "not a url at all ://", SITE)).toBeUndefined();
		expect(findImageSize(stored, "data:image/png;base64,AAAA", SITE)).toBeUndefined();
		// Records written before 0.1.2 have no list.
		expect(findImageSize(undefined, FILE, SITE)).toBeUndefined();
		expect(findImageSize([], FILE, SITE)).toBeUndefined();
	});
});

describe("the ImageObject in the graph", () => {
	function page(image: string | null): PublicPageContext {
		return {
			url: `${SITE}/bread`,
			path: "/bread",
			locale: null,
			kind: "content",
			pageType: "website",
			title: "Bread | Acme",
			pageTitle: "Bread",
			description: null,
			canonical: null,
			image,
			content: { collection: "pages", id: "p1", slug: "bread" },
		};
	}
	function record(images?: EntryImage[]): EntryRecord {
		return { v: 1, publishedAt: null, updatedAt: null, authors: [], custom: [], images };
	}
	function imageNode(image: string | null, entry: EntryRecord | null): SchemaNode | undefined {
		return buildGraph({
			page: page(image),
			config: DEFAULT_CONFIG,
			record: entry,
			site: { name: "Acme", url: SITE, locale: "en" },
		}).find((node) => node["@type"] === "ImageObject");
	}

	it("carries width and height when the picture is the entry's own", () => {
		expect(imageNode(`${SITE}${FILE}`, record(stored))).toEqual({
			"@type": "ImageObject",
			"@id": `${SITE}${FILE}`,
			url: `${SITE}${FILE}`,
			contentUrl: `${SITE}${FILE}`,
			width: 1600,
			height: 900,
		});
	});

	it("has no size for another picture, a resized one, an old record or no record", () => {
		const plain = (url: string) => ({
			"@type": "ImageObject",
			"@id": `${SITE}${url}`,
			url: `${SITE}${url}`,
			contentUrl: `${SITE}${url}`,
		});
		expect(imageNode("/images/other.jpg", record(stored))).toEqual(plain("/images/other.jpg"));
		expect(imageNode(`${FILE}?w=600`, record(stored))).toEqual(plain(`${FILE}?w=600`));
		expect(imageNode(FILE, record())).toEqual(plain(FILE));
		expect(imageNode(FILE, null)).toEqual(plain(FILE));
	});
});

describe("on a real site", () => {
	let host: PluginRuntimeTestHost | undefined;
	afterEach(async () => {
		await host?.dispose();
		host = undefined;
	});

	it("remembers an entry's image when it is saved and sizes the page's picture from it", async () => {
		host = await createPluginRuntimeTestHost({
			site: { name: "Acme", url: SITE, locale: "en" },
		});
		await host.fixtures.collection({
			slug: "pages",
			label: "Pages",
			supports: ["seo"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "cover", label: "Cover", type: "image" },
			],
		});
		const entry = await host.fixtures.content("pages", {
			slug: "bread",
			data: { title: "Bread", cover },
			status: "published",
		});
		await host.transport.invokeHook("content:afterSave", {
			collection: "pages",
			content: { id: entry.id },
			isNew: false,
		});

		const saved = await host.inspect.storage.get<EntryRecord>("entries", `pages:${entry.id}`);
		expect(saved?.images).toEqual(stored);
		// An image field alone does not tell the saved-entry check that the theme shares it.
		expect(saved?.needsImage).toBe(true);

		const render = async (image: string) => {
			const contributions = (await host?.transport.invokeHook("page:metadata", {
				page: {
					url: `${SITE}/bread`,
					path: "/bread",
					locale: null,
					kind: "content",
					pageType: "website",
					title: "Bread",
					description: null,
					canonical: null,
					image,
					content: { collection: "pages", id: entry.id, slug: "bread" },
				} satisfies PublicPageContext,
			})) as PageMetadataContribution[];
			const jsonld = contributions.find((c) => c.kind === "jsonld");
			const graph = (jsonld?.kind === "jsonld" ? jsonld.graph : {}) as { "@graph"?: SchemaNode[] };
			return graph["@graph"]?.find((node) => node["@type"] === "ImageObject");
		};
		expect(await render(`${SITE}${FILE}`)).toMatchObject({ width: 1600, height: 900 });
		const resized = await render(`${SITE}${FILE}?w=400`);
		expect(resized).toBeDefined();
		expect(resized).not.toHaveProperty("width");
	});
});
