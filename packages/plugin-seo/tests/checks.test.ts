// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import {
	checkEntry,
	NO_SOCIAL_IMAGE,
	excerptOf,
	estimateTitlePixels,
	statusOf,
	truncateTitle,
	type CheckInput,
} from "../src/checks.js";
import { observeImage, type EntryRecord } from "../src/record.js";
import type { ScanState, Stats } from "../src/scan.js";

const PAGE = "/overview";
const LONG_TEXT =
	"We bake bread every morning from flour milled a few streets away, and deliver it by bicycle.";

function input(overrides: Partial<CheckInput> = {}): CheckInput {
	return {
		slug: "about",
		data: { title: "About us", body: LONG_TEXT },
		seo: {
			title: null,
			description: "Who we are.",
			image: "/hero.jpg",
			canonical: null,
			noIndex: false,
		},
		title: "About us",
		siteUrl: "https://acme.test",
		isArticle: false,
		authorCount: 0,
		duplicateTitle: false,
		...overrides,
	};
}

const ids = (overrides: Partial<CheckInput>) =>
	checkEntry(input(overrides)).map((issue) => issue.id);

describe("page checks", () => {
	it("finds nothing wrong with a complete page", () => {
		expect(checkEntry(input())).toEqual([]);
		expect(statusOf([], false)).toBe("ready");
	});

	it("asks for a missing description, in words an editor understands", () => {
		const issues = checkEntry(input({ seo: { ...input().seo!, description: " " } }));
		expect(issues).toEqual([
			{
				id: "no-description",
				level: "fix",
				message: "No search description, so Google writes its own summary of this page.",
				fix: "Fill in Meta Description in the page's SEO panel.",
			},
		]);
		expect(statusOf(issues, false)).toBe("fix");
	});

	it("counts the excerpt as the description, as EmDash does on the page", () => {
		const seo = { ...input().seo!, description: null };
		const data = { title: "About us", body: LONG_TEXT };
		expect(checkEntry(input({ seo, data: { ...data, excerpt: "Bread, baked daily." } }))).toEqual(
			[],
		);
		// An empty or non-text excerpt is not a description.
		for (const excerpt of ["  ", null, 12, ["Bread"]]) {
			expect(ids({ seo, data: { ...data, excerpt } })).toEqual(["no-description"]);
		}
		expect(excerptOf({ excerpt: " Bread. " })).toBe("Bread.");
	});

	it("does not ask for SEO fields on a collection without the SEO panel", () => {
		expect(ids({ seo: undefined })).toEqual([]);
	});

	it("flags a shared title and a canonical that points at another page", () => {
		expect(ids({ duplicateTitle: true })).toEqual(["duplicate-title"]);
		expect(ids({ seo: { ...input().seo!, canonical: "https://acme.test/other" } })).toEqual([
			"canonical-elsewhere",
		]);
		// A canonical to the page itself, with or without a trailing slash, is fine.
		expect(ids({ seo: { ...input().seo!, canonical: "/company/about/" } })).toEqual([]);
	});

	it("accepts a home page whose canonical is the site root", () => {
		expect(
			ids({ slug: "home", seo: { ...input().seo!, canonical: "https://acme.test/" } }),
		).toEqual([]);
		expect(
			ids({ slug: "about", seo: { ...input().seo!, canonical: "https://acme.test/" } }),
		).toEqual(["canonical-elsewhere"]);
	});

	it("flags a page whose title says nothing, such as Home", () => {
		expect(ids({ title: "Home", data: { title: "Home", body: LONG_TEXT } })).toEqual([
			"generic-title",
		]);
		// A real search title set in the SEO panel clears it.
		expect(
			ids({
				title: "Home",
				seo: { ...input().seo!, title: "Acme Bakery: fresh bread in Springfield" },
			}),
		).toEqual([]);
	});

	it("gives advice without marking the page as needing a fix", () => {
		const issues = checkEntry(
			input({
				title: "W".repeat(60),
				data: { title: "x", body: [{ _type: "image", src: "/a.jpg", alt: "" }] },
				seo: { ...input().seo!, image: null },
				isArticle: true,
			}),
		);
		expect(issues.map((issue) => [issue.id, issue.level])).toEqual([
			["title-long", "look"],
			["no-author", "look"],
			["images-without-alt", "look"],
			["nearly-empty", "look"],
		]);
		expect(statusOf(issues, false)).toBe("look");
	});

	it("says shared links have no picture only when the page has no image at all", () => {
		expect(ids({ seo: { ...input().seo!, image: null } })).toEqual(["no-social-image"]);
		expect(
			ids({
				seo: { ...input().seo!, image: null },
				data: { body: LONG_TEXT, hero: { _type: "image", src: "/a.jpg", alt: "Our bakery" } },
			}),
		).toEqual([]);
	});

	it("treats a hidden page as hidden whatever else is wrong", () => {
		expect(statusOf(checkEntry(input({ duplicateTitle: true })), true)).toBe("hidden");
	});

	it("estimates title width instead of counting characters", () => {
		expect(estimateTitlePixels("iiii")).toBeLessThan(estimateTitlePixels("WWWW"));
		expect(truncateTitle("Short title")).toBe("Short title");
		const cut = truncateTitle(
			"A very long page title that keeps going and going, well past the width Google will show",
		);
		expect(cut.endsWith("…")).toBe(true);
		expect(estimateTitlePixels(cut)).toBeLessThanOrEqual(580);
	});
});

describe("checks on a real site", () => {
	let host: PluginRuntimeTestHost | undefined;

	afterEach(async () => {
		await host?.dispose();
		host = undefined;
	});

	async function start(): Promise<PluginRuntimeTestHost> {
		host = await createPluginRuntimeTestHost({
			site: { name: "Acme", url: "https://acme.test", locale: "en" },
		});
		await host.fixtures.collection({
			slug: "pages",
			label: "Pages",
			urlPattern: "/{slug}",
			supports: ["drafts", "revisions", "seo"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "body", label: "Body", type: "text" },
			],
		});
		return host;
	}

	async function addPage(
		runtime: PluginRuntimeTestHost,
		slug: string,
		title: string,
		description?: string,
	) {
		const entry = await runtime.fixtures.content("pages", {
			slug,
			data: { title, body: LONG_TEXT },
			status: "published",
		});
		if (description !== undefined) {
			await runtime.actions.content.update("pages", entry.id, {
				seo: { description, image: "/hero.jpg" },
			});
		}
		return entry;
	}

	const record = (runtime: PluginRuntimeTestHost, id: string) =>
		runtime.inspect.storage.get<EntryRecord>("entries", `pages:${id}`);
	const flat = (blocks: Block[]): Block[] =>
		blocks.flatMap((block) =>
			block.type === "tab"
				? block.panels.flatMap((panel) => flat(panel.blocks))
				: block.type === "accordion"
					? flat(block.blocks)
					: [block],
		);
	const text = (response: BlockResponse) => JSON.stringify(response.blocks);

	/** Open the SEO page until the automatic check has finished. */
	async function checkAll(runtime: PluginRuntimeTestHost): Promise<BlockResponse> {
		let response = await runtime.admin.loadPage(PAGE);
		for (let step = 0; step < 10; step += 1) {
			const scan = await runtime.inspect.kv.get<ScanState>("scan");
			if (scan?.status === "done") break;
			response = await runtime.admin.loadPage(PAGE);
		}
		return response;
	}

	it("checks every page, counts them, and lists the ones to fix with a link", async () => {
		const runtime = await start();
		const good = await addPage(runtime, "about", "About us", "Who we are.");
		const bad = await addPage(runtime, "contact", "Contact");
		await runtime.fixtures.content("pages", {
			slug: "draft",
			data: { title: "Draft" },
			status: "draft",
		});

		const response = await checkAll(runtime);

		expect(await runtime.inspect.kv.get<ScanState>("scan")).toMatchObject({
			status: "done",
			checked: 2,
		});
		expect(await record(runtime, good.id)).toMatchObject({ status: "ready", issues: [] });
		expect(await record(runtime, bad.id)).toMatchObject({ status: "fix", title: "Contact" });
		expect((await runtime.inspect.kv.get<ScanState>("scan"))?.tally).toMatchObject({
			checked: 2,
			fix: 1,
			hidden: 0,
		});

		const stats = flat(response.blocks).find((block) => block.type === "stats");
		expect(stats?.type === "stats" && stats.items.map((item) => [item.label, item.value])).toEqual([
			["Pages checked", 2],
			["Nothing to fix", 1],
			["To fix", 1],
		]);
		const table = flat(response.blocks).find(
			(block) => block.type === "table" && block.page_action_id === "fix_table",
		);
		expect(table?.type === "table" && table.rows).toEqual([
			{
				page: "Contact",
				missing: "No search description, so Google writes its own summary of this page.",
				open: {
					type: "link",
					label: "Open page",
					target: { kind: "content", collection: "pages", id: bad.id },
				},
			},
		]);
	});

	it("reaches zero: fixing the page on a real save empties the list", async () => {
		const runtime = await start();
		const bad = await addPage(runtime, "contact", "Contact");
		await checkAll(runtime);

		await runtime.actions.content.update("pages", bad.id, {
			seo: { description: "How to reach us.", image: "/hero.jpg" },
		});
		// EmDash runs after-save hooks in the background; run it here to be certain.
		await runtime.transport.invokeHook("content:afterSave", {
			collection: "pages",
			content: { id: bad.id },
			isNew: false,
		});

		const response = await runtime.admin.loadPage(PAGE);
		expect(text(response)).toContain("No pages to fix. Nice work.");
		expect(await runtime.inspect.kv.get<Stats>("stats")).toMatchObject({ checked: 1, fix: 0 });
	});

	it("never shows a partial count: the first visit checks the pages by itself", async () => {
		const runtime = await start();
		await addPage(runtime, "about", "About us", "Who we are.");
		await addPage(runtime, "contact", "Contact");
		// Only one page has been seen by the plugin so far, as after a single save.
		const [first] = await runtime.inspect.content.list("pages");
		await runtime.transport.invokeHook("content:afterSave", {
			collection: "pages",
			content: { id: first?.id },
			isNew: false,
		});

		const response = await runtime.admin.loadPage(PAGE);
		expect(text(response)).toContain('"label":"Pages checked","value":2');
	});

	it("starts checking as soon as the plugin is switched on", async () => {
		const runtime = await start();
		await addPage(runtime, "contact", "Contact");
		await runtime.transport.invokeHook("plugin:activate", {});
		expect(await runtime.inspect.kv.get<ScanState>("scan")).toMatchObject({
			status: "done",
			checked: 1,
			tally: { checked: 1, fix: 1 },
		});
	});

	it("flags pages that share a title, and clears the flag when one is renamed", async () => {
		const runtime = await start();
		const first = await addPage(runtime, "services", "Our services", "What we do.");
		const second = await addPage(runtime, "services-2", "Our  SERVICES", "More of what we do.");
		await checkAll(runtime);

		expect((await record(runtime, first.id))?.issues?.map((issue) => issue.id)).toEqual([
			"duplicate-title",
		]);
		expect((await record(runtime, second.id))?.status).toBe("fix");

		await runtime.actions.content.update("pages", second.id, {
			data: { title: "Catering", body: LONG_TEXT },
		});
		await runtime.actions.content.publish("pages", second.id);
		await runtime.transport.invokeHook("content:afterPublish", {
			collection: "pages",
			content: { id: second.id },
		});

		expect(await record(runtime, second.id)).toMatchObject({ status: "ready", title: "Catering" });
		// The page left alone with the old title is no longer a duplicate.
		expect(await record(runtime, first.id)).toMatchObject({ status: "ready", issues: [] });
	});

	it("counts a page hidden in its SEO panel as hidden, not as something to fix", async () => {
		const runtime = await start();
		const entry = await addPage(runtime, "thanks", "Thank you");
		await runtime.actions.content.update("pages", entry.id, { seo: { noIndex: true } });
		const response = await checkAll(runtime);

		expect((await record(runtime, entry.id))?.status).toBe("hidden");
		expect(text(response)).toContain("1 page is hidden from Google and not counted: Thank you.");
	});

	it("leaves out content that has no page of its own", async () => {
		const runtime = await start();
		await runtime.fixtures.collection({
			slug: "testimonials",
			label: "Testimonials",
			routable: false,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const quote = await runtime.fixtures.content("testimonials", {
			slug: "ada",
			data: { title: "Ada" },
			status: "published",
		});
		await addPage(runtime, "about", "About us", "Who we are.");
		await checkAll(runtime);

		// A save of the testimonial builds its record, which must not be counted.
		await runtime.transport.invokeHook("content:afterSave", {
			collection: "testimonials",
			content: { id: quote.id },
			isNew: false,
		});
		expect(
			await runtime.inspect.storage.get<EntryRecord>("entries", `testimonials:${quote.id}`),
		).toMatchObject({ status: "skip", issues: [] });

		const response = await runtime.admin.loadPage(PAGE);
		expect(text(response)).toContain('"label":"Pages checked","value":1');
		expect(text(response)).toContain("No pages to fix. Nice work.");

		const panel = await runtime.admin.loadEditorPanel("preview", "testimonials", quote.id);
		expect(text(panel)).toContain("has no page of its own");
	});

	it("checks the published page, not an unpublished edit", async () => {
		const runtime = await start();
		const entry = await addPage(runtime, "about", "Old title", "Who we are.");
		await runtime.actions.content.update("pages", entry.id, {
			data: { title: "New title", body: LONG_TEXT },
		});
		await runtime.transport.invokeHook("content:afterSave", {
			collection: "pages",
			content: { id: entry.id },
			isNew: false,
		});
		expect((await record(runtime, entry.id))?.title).toBe("Old title");

		await runtime.actions.content.publish("pages", entry.id);
		await runtime.transport.invokeHook("content:afterPublish", {
			collection: "pages",
			content: { id: entry.id },
		});
		expect((await record(runtime, entry.id))?.title).toBe("New title");
	});

	it("lists advice separately from fixes, so the count of pages to fix stays honest", async () => {
		const runtime = await start();
		const entry = await runtime.fixtures.content("pages", {
			slug: "short",
			data: { title: "Short page", body: "Hi." },
			status: "published",
		});
		await runtime.actions.content.update("pages", entry.id, {
			seo: { description: "A short page.", image: "/a.jpg" },
		});
		const response = await checkAll(runtime);
		await runtime.transport.invokeHook("content:afterSave", {
			collection: "pages",
			content: { id: entry.id },
			isNew: false,
		});
		const fresh = await runtime.admin.loadPage(PAGE);

		expect(text(fresh)).toContain("No pages to fix. Nice work.");
		expect(text(fresh)).toContain("Worth a look (1)");
		expect(text(fresh)).toContain("This page has almost no text.");
		expect(response.blocks.length).toBeGreaterThan(0);
	});

	it("shows an editor the pages to fix, read-only", async () => {
		const runtime = await start();
		await addPage(runtime, "contact", "Contact");
		await checkAll(runtime);
		const editor = await runtime.fixtures.user({ email: "editor@acme.test", role: "editor" });

		const response = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(text(response)).toContain("Open page");
		expect(text(response)).not.toContain("check_pages");
	});

	it("shows the pages to fix in the dashboard widget, checking them itself", async () => {
		const runtime = await start();
		await addPage(runtime, "contact", "Contact");
		const widget = await runtime.admin.loadWidget("seo");
		expect(text(widget)).toContain('"label":"Page to fix","value":1');
		expect(text(widget)).toContain('"kind":"plugin-page","path":"/overview"');

		// The widget recounts on every load, so a fix shows without opening the SEO page.
		const [entry] = await runtime.inspect.content.list("pages");
		await runtime.actions.content.update("pages", entry?.id ?? "", {
			seo: { description: "How to reach us.", image: "/hero.jpg" },
		});
		await runtime.transport.invokeHook("content:afterSave", {
			collection: "pages",
			content: { id: entry?.id },
			isNew: false,
		});
		expect(text(await runtime.admin.loadWidget("seo"))).toContain("All pages ready");
	});
});

describe("the picture for shared links", () => {
	let host: PluginRuntimeTestHost | undefined;

	afterEach(async () => {
		await host?.dispose();
		host = undefined;
	});

	const PICTURE = "https://acme.test/theme/share.png";
	const record = (runtime: PluginRuntimeTestHost, id: string) =>
		runtime.inspect.storage.get<EntryRecord>("entries", `pages:${id}`);
	const listed = (data: EntryRecord | null) =>
		(data?.issues ?? []).some((issue) => issue.id === "no-social-image");

	/** A published page with a description and no picture of its own, saved once. */
	async function start(slug = "about") {
		host ??= await createPluginRuntimeTestHost({
			site: { name: "Acme", url: "https://acme.test", locale: "en" },
		});
		if (slug === "about") {
			await host.fixtures.collection({
				slug: "pages",
				label: "Pages",
				urlPattern: "/{slug}",
				supports: ["drafts", "revisions", "seo"],
				fields: [
					{ slug: "title", label: "Title", type: "string" },
					{ slug: "body", label: "Body", type: "text" },
				],
			});
		}
		const entry = await host.fixtures.content("pages", {
			slug,
			data: { title: `Page ${slug}`, body: LONG_TEXT },
			status: "published",
		});
		await change(host, entry.id, { description: "Who we are." }, (data) => data !== null);
		return { runtime: host, entry };
	}

	/**
	 * Change the SEO panel with a real save. EmDash runs the after-save hook in
	 * the background, so wait until the record shows the change, then save once
	 * more so nothing is still running when the test goes on.
	 */
	async function change(
		runtime: PluginRuntimeTestHost,
		id: string,
		seo: { description?: string; image?: string | null },
		settled: (data: EntryRecord | null) => boolean,
	) {
		const result = await runtime.actions.content.update("pages", id, { seo });
		expect(result.success).toBe(true);
		await expect.poll(async () => settled(await record(runtime, id))).toBe(true);
		await save(runtime, id);
	}

	async function save(runtime: PluginRuntimeTestHost, id: string) {
		await runtime.transport.invokeHook("content:afterSave", {
			collection: "pages",
			content: { id },
			isNew: false,
		});
	}

	/** One public render of the page, as the theme would pass it. */
	async function render(
		runtime: PluginRuntimeTestHost,
		entry: { id: string; slug?: string | null },
		image: string | null,
		viaPanel = false,
	) {
		await runtime.transport.invokeHook("page:metadata", {
			page: {
				url: `https://acme.test/${entry.slug}`,
				path: `/${entry.slug}`,
				locale: null,
				kind: "content",
				pageType: "website",
				title: "A page",
				description: null,
				canonical: null,
				image: viaPanel ? null : image,
				...(viaPanel ? { seo: { ogImage: image } } : {}),
				content: { collection: "pages", id: entry.id, slug: entry.slug ?? null },
			},
		});
	}

	it("is asked for when the entry has none and no render has shown one", async () => {
		const { runtime, entry } = await start();
		expect(await record(runtime, entry.id)).toMatchObject({
			status: "look",
			needsImage: true,
			issues: [NO_SOCIAL_IMAGE],
		});
		expect((await record(runtime, entry.id))?.imageSeen).toBeUndefined();
		expect(NO_SOCIAL_IMAGE.message).toBe(
			"This page has no picture for shared links, unless your site has a default sharing image.",
		);
	});

	it("is no longer asked for once the page is rendered with one, and is written once", async () => {
		const { runtime, entry } = await start();
		await render(runtime, entry, PICTURE);

		const first = await record(runtime, entry.id);
		expect(first).toMatchObject({ status: "ready", issues: [], needsImage: true, imageSeen: true });

		// EmDash may call the hook several times for one page view: nothing more changes.
		await render(runtime, entry, PICTURE);
		await render(runtime, entry, PICTURE);
		expect(await record(runtime, entry.id)).toEqual(first);
		expect(observeImage(first!, true)).toBeNull();

		// The same when the calls overlap: each may write, and each writes the same record.
		const other = await start("contact");
		await Promise.all([1, 2, 3].map(() => render(runtime, other.entry, PICTURE)));
		expect(await record(runtime, other.entry.id)).toMatchObject({
			status: "ready",
			issues: [],
			imageSeen: true,
		});
	});

	it("counts the picture EmDash resolves for og:image, not only the theme's own field", async () => {
		const { runtime, entry } = await start();
		await render(runtime, entry, PICTURE, true);
		expect(listed(await record(runtime, entry.id))).toBe(false);
	});

	it("stays quiet through a save and a full check, which cannot see the theme's picture", async () => {
		const { runtime, entry } = await start();
		await render(runtime, entry, PICTURE);

		await save(runtime, entry.id);
		expect(await record(runtime, entry.id)).toMatchObject({ status: "ready", imageSeen: true });

		// "Check all pages again" rebuilds every record from the saved entries.
		await runtime.admin.loadPage(PAGE);
		const before = (await record(runtime, entry.id))?.checkedAt;
		await runtime.admin.act(PAGE, "check_pages");
		for (let step = 0; step < 10; step += 1) {
			if ((await runtime.inspect.kv.get<ScanState>("scan"))?.status === "done") break;
			await runtime.admin.loadPage(PAGE);
		}
		const overview = JSON.stringify((await runtime.admin.loadPage(PAGE)).blocks);
		const after = await record(runtime, entry.id);
		expect(after).toMatchObject({ status: "ready", imageSeen: true, issues: [] });
		expect(after?.checkedAt).not.toBe(before);
		expect(overview).not.toContain(NO_SOCIAL_IMAGE.message);
		expect(overview).not.toContain("Worth a look");
	});

	it("is asked for again when a later render has no picture, written once", async () => {
		const { runtime, entry } = await start();
		await render(runtime, entry, PICTURE);
		await render(runtime, entry, null);

		const back = await record(runtime, entry.id);
		expect(back).toMatchObject({ status: "look", needsImage: true, issues: [NO_SOCIAL_IMAGE] });
		expect(back?.imageSeen).toBeUndefined();

		await render(runtime, entry, null);
		await render(runtime, entry, "");
		expect(await record(runtime, entry.id)).toEqual(back);

		const overview = JSON.stringify((await runtime.admin.loadPage(PAGE)).blocks);
		expect(overview).toContain("Worth a look (1)");
		expect(overview).toContain(NO_SOCIAL_IMAGE.message);
	});

	it("forgets a seen picture once the entry has its own, so removing that one is noticed", async () => {
		const { runtime, entry } = await start();
		await render(runtime, entry, PICTURE);

		await change(runtime, entry.id, { image: "/own.jpg" }, (data) => data?.needsImage === false);
		const own = await record(runtime, entry.id);
		expect(own).toMatchObject({ status: "ready", needsImage: false });
		expect(own?.imageSeen).toBeUndefined();
		// Renders with the entry's own picture have nothing to add.
		expect(observeImage(own!, true)).toBeNull();
		await render(runtime, entry, "https://acme.test/own.jpg");
		expect((await record(runtime, entry.id))?.imageSeen).toBeUndefined();

		await change(runtime, entry.id, { image: null }, (data) => data?.needsImage === true);
		expect(listed(await record(runtime, entry.id))).toBe(true);
	});

	it("clears the old warning on a record written before this was known", async () => {
		const { runtime, entry } = await start();
		const old = await record(runtime, entry.id);
		const { needsImage: _needs, ...rest } = old!;
		const before: EntryRecord = {
			...rest,
			issues: [
				{
					...NO_SOCIAL_IMAGE,
					message:
						"Shared links will show no picture, unless your site has a default sharing image.",
				},
			],
		};
		await runtime.fixtures.plugin.storage("entries", `pages:${entry.id}`, before);

		// Without a picture nothing is rewritten; with one the warning goes.
		await render(runtime, entry, null);
		expect(await record(runtime, entry.id)).toEqual(before);
		await render(runtime, entry, PICTURE);
		expect(await record(runtime, entry.id)).toMatchObject({
			status: "ready",
			issues: [],
			needsImage: true,
			imageSeen: true,
		});
	});

	it("leaves other issues, hidden pages and drafts as they are", () => {
		const base: EntryRecord = {
			v: 1,
			publishedAt: null,
			updatedAt: null,
			authors: [],
			custom: [],
			needsImage: true,
			status: "fix",
			issues: [{ id: "no-description", level: "fix", message: "m", fix: "f" }, NO_SOCIAL_IMAGE],
		};
		expect(observeImage(base, true)).toMatchObject({
			status: "fix",
			imageSeen: true,
			issues: [{ id: "no-description" }],
		});
		expect(observeImage({ ...base, issues: [NO_SOCIAL_IMAGE], status: "look" }, true)?.status).toBe(
			"ready",
		);
		for (const status of ["hidden", "draft", "skip"] as const) {
			expect(observeImage({ ...base, status }, true)?.status).toBe(status);
		}
		// Nothing to learn: the entry has its own picture, or the render says what is known.
		expect(observeImage({ ...base, needsImage: false, issues: [] }, true)).toBeNull();
		expect(observeImage({ ...base, needsImage: false, issues: [] }, false)).toBeNull();
		expect(observeImage(base, false)).toBeNull();
		expect(observeImage({ ...base, needsImage: undefined, issues: [] }, true)).toBeNull();
	});

	it("does not write in the request that first builds a page's record", async () => {
		const { runtime } = await start();
		// Never saved through a hook, so the first render builds its record.
		const entry = await runtime.fixtures.content("pages", {
			slug: "new",
			data: { title: "New page", body: LONG_TEXT },
			status: "published",
		});
		expect(await record(runtime, entry.id)).toBeNull();

		await render(runtime, entry, PICTURE);
		expect(await record(runtime, entry.id)).toMatchObject({ needsImage: true });
		expect(listed(await record(runtime, entry.id))).toBe(true);
		// The next render settles it.
		await render(runtime, entry, PICTURE);
		expect(listed(await record(runtime, entry.id))).toBe(false);
	});
});

describe("Google preview panel", () => {
	let host: PluginRuntimeTestHost | undefined;

	afterEach(async () => {
		await host?.dispose();
		host = undefined;
	});

	async function start() {
		host = await createPluginRuntimeTestHost({
			site: { name: "Acme", url: "https://acme.test", locale: "en" },
		});
		await host.fixtures.collection({
			slug: "services",
			label: "Services",
			urlPattern: "/services/{slug}",
			supports: ["seo"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "body", label: "Body", type: "text" },
			],
		});
		const entry = await host.fixtures.content("services", {
			slug: "wedding-cakes",
			data: { title: "Wedding cakes", body: LONG_TEXT },
			status: "published",
		});
		return { runtime: host, entry };
	}

	const text = (response: BlockResponse) => JSON.stringify(response.blocks);

	it("shows the saved title, address, type and what to fix", async () => {
		const { runtime, entry } = await start();
		const panel = await runtime.admin.loadEditorPanel("preview", "services", entry.id);

		expect(panel.blocks[0]).toEqual({
			type: "context",
			text: "Acme · acme.test › services › wedding-cakes",
		});
		expect(panel.blocks[1]).toEqual({ type: "header", text: "Wedding cakes" });
		expect(text(panel)).toContain("No description yet. Google will pick some text from the page.");
		expect(text(panel)).toContain('{"label":"Shown to Google as","value":"Service"}');
		expect(text(panel)).toContain("To fix: No search description,");
		expect(text(panel)).toContain("What Google sees: the published page");
		// Admin extras.
		expect(text(panel)).toContain(
			"https://search.google.com/test/rich-results?url=https%3A%2F%2Facme.test%2Fservices%2Fwedding-cakes",
		);
		expect(text(panel)).toContain("View the markup");
	});

	it("shows the excerpt as the description and says where it came from", async () => {
		host = await createPluginRuntimeTestHost({
			site: { name: "Acme", url: "https://acme.test", locale: "en" },
		});
		await host.fixtures.collection({
			slug: "posts",
			label: "Posts",
			urlPattern: "/blog/{slug}",
			supports: ["seo"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "excerpt", label: "Excerpt", type: "text" },
				{ slug: "body", label: "Body", type: "text" },
			],
		});
		const entry = await host.fixtures.content("posts", {
			slug: "sourdough",
			data: { title: "Sourdough", excerpt: "How we bake our sourdough.", body: LONG_TEXT },
			status: "published",
		});
		const panel = await host.admin.loadEditorPanel("preview", "posts", entry.id);

		expect(panel.blocks[2]).toEqual({ type: "section", text: "How we bake our sourdough." });
		expect(text(panel)).toContain("This description is the page's excerpt.");
		expect(text(panel)).not.toContain("No search description");
		expect(text(panel)).not.toContain("No description yet");
		// The markup the admin can open describes the page the same way.
		expect(text(panel)).toContain("How we bake our sourdough.");

		// With a description in the SEO panel, the note about the excerpt goes.
		await host.actions.content.update("posts", entry.id, {
			seo: { description: "Sourdough, written for search." },
		});
		const written = await host.admin.loadEditorPanel("preview", "posts", entry.id);
		expect(written.blocks[2]).toEqual({ type: "section", text: "Sourdough, written for search." });
		expect(text(written)).not.toContain("page's excerpt");
	});

	it("lets an admin change one page's type and keeps it across saves", async () => {
		const { runtime, entry } = await start();
		const saved = await runtime.admin.actEditorPanel("preview", "services", entry.id, "set_type", {
			value: "ContactPage",
		});
		expect(saved.toast?.type).toBe("success");
		expect(text(saved)).toContain('{"label":"Shown to Google as","value":"Contact page"}');

		await runtime.transport.invokeHook("content:afterSave", {
			collection: "services",
			content: { id: entry.id },
			isNew: false,
		});
		expect(
			await runtime.inspect.storage.get<EntryRecord>("entries", `services:${entry.id}`),
		).toMatchObject({ type: "ContactPage" });

		const reset = await runtime.admin.actEditorPanel("preview", "services", entry.id, "set_type", {
			value: "default",
		});
		expect(text(reset)).toContain('{"label":"Shown to Google as","value":"Service"}');
	});

	it("shows an editor the preview and checks without the admin tools", async () => {
		const { runtime, entry } = await start();
		const editor = await runtime.fixtures.user({ email: "editor@acme.test", role: "editor" });
		const panel = await runtime.admin.loadEditorPanel("preview", "services", entry.id, {
			user: editor,
		});

		expect(text(panel)).toContain("Wedding cakes");
		expect(text(panel)).not.toContain("View the markup");
		expect(text(panel)).not.toContain("Change page type");

		await runtime.admin.actEditorPanel("preview", "services", entry.id, "set_type", {
			value: "ContactPage",
			user: editor,
		});
		expect(
			(await runtime.inspect.storage.get<EntryRecord>("entries", `services:${entry.id}`))?.type,
		).toBeUndefined();
	});
});
