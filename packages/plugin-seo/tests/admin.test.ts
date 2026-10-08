// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { PageMetadataContribution } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import type { SeoConfig } from "../src/config.js";

const PAGE = "/seo";

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
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
	await host.fixtures.collection({
		slug: "services",
		label: "Services",
		urlPattern: "/services/{slug}",
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
	return host;
}

/** Every block on the page, including those inside tabs and accordions. */
function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) => {
		if (block.type === "tab") return [block, ...block.panels.flatMap((p) => flatten(p.blocks))];
		if (block.type === "accordion") return [block, ...flatten(block.blocks)];
		return [block];
	});
}

function texts(response: BlockResponse): string {
	return JSON.stringify(response.blocks);
}

async function config(runtime: PluginRuntimeTestHost): Promise<SeoConfig | null> {
	return runtime.inspect.kv.get<SeoConfig>("config");
}

describe("SEO page", () => {
	it("shows an admin the three tabs and the first-run steps", async () => {
		const runtime = await start();
		const response = await runtime.admin.loadPage(PAGE);

		const tabs = response.blocks.find((block) => block.type === "tab");
		expect(tabs?.type === "tab" && tabs.panels.map((panel) => panel.label)).toEqual([
			"Overview",
			"Who you are",
			"Page types",
		]);
		expect(texts(response)).toContain("SEO is already working");
		expect(texts(response)).toContain("Setup: 0 of 2 done");
	});

	it("guesses each page type from the collection's name", async () => {
		const runtime = await start();
		const response = await runtime.admin.loadPage(PAGE);
		const table = flatten(response.blocks).find((block) => block.type === "table");
		expect(table?.type === "table" && table.rows.map((row) => [row.name, row.shown])).toEqual([
			["Pages", "Web page"],
			["Services", "Service"],
		]);
	});

	it("shows an editor a read-only page and ignores their changes", async () => {
		const runtime = await start();
		const editor = await runtime.fixtures.user({ email: "editor@acme.test", role: "editor" });

		const response = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(response.blocks.some((block) => block.type === "tab")).toBe(false);
		expect(flatten(response.blocks).some((block) => block.type === "form")).toBe(false);
		expect(texts(response)).toContain("managed by your site admin");

		await runtime.admin.submit(PAGE, "save_identity", { name: "Hacked" }, { user: editor });
		expect(await config(runtime)).toBeNull();
	});
});

describe("Who you are", () => {
	it("saves a local business and marks the step done", async () => {
		const runtime = await start();
		const response = await runtime.admin.submit(PAGE, "save_identity", {
			kind: "local",
			business: "FoodEstablishment",
			name: "Acme Bakery",
			alternate_name: "",
			description: "Bread baked every morning.",
			logo_media: "",
			logo_url: "https://acme.test/logo.png",
		});

		expect(response.toast).toEqual({
			type: "success",
			message: "Saved. Google will pick this up next time it visits.",
		});
		expect(await config(runtime)).toMatchObject({
			site: {
				type: "FoodEstablishment",
				name: "Acme Bakery",
				description: "Bread baked every morning.",
				logo: "https://acme.test/logo.png",
			},
			steps: { identity: true, types: false },
		});
		expect(texts(response)).toContain("Setup: 1 of 2 done");
		// A local business gets the opening hours section, and is asked for its address.
		expect(texts(response)).toContain("Opening hours");
		expect(texts(response)).toContain(
			"Add your address so Google can list you as a local business",
		);
	});

	it("keeps what other forms saved when one form is submitted", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_contact", {
			email: "hello@acme.test",
			telephone: "+1 555 0100",
			street: "1 Main St",
			town: "Springfield",
			country: "us",
			price_range: "$$",
		});
		// The admin only touched the name; the form sends nothing else.
		await runtime.admin.submit(PAGE, "save_identity", { name: "Acme Inc" });

		expect(await config(runtime)).toMatchObject({
			site: {
				type: "Organization",
				name: "Acme Inc",
				email: "hello@acme.test",
				telephone: "+1 555 0100",
				address: {
					streetAddress: "1 Main St",
					addressLocality: "Springfield",
					addressCountry: "US",
				},
				priceRange: "$$",
			},
		});
	});

	it("rejects a logo address that is not a web address", async () => {
		const runtime = await start();
		const response = await runtime.admin.submit(PAGE, "save_identity", {
			name: "Acme",
			logo_url: "ftp://acme.test/logo.png",
		});
		expect(response.toast?.type).toBe("error");
		expect(response.toast?.message).toContain("https://");
		expect(await config(runtime)).toBeNull();
	});

	it("accepts a public logo link from Media and refuses a sign-in-only one", async () => {
		const runtime = await start();
		// "Copy URL" in Media gives a site-relative public link.
		await runtime.admin.submit(PAGE, "save_identity", {
			name: "Acme",
			logo_url: "/_emdash/api/media/file/logo.png",
		});
		expect((await config(runtime))?.site.logo).toBe(
			"https://acme.test/_emdash/api/media/file/logo.png",
		);

		const refused = await runtime.admin.submit(PAGE, "save_identity", {
			name: "Acme",
			logo_url: "/_emdash/api/media/asset/01ABC/logo.png",
		});
		expect(refused.toast?.type).toBe("error");
		expect(refused.toast?.message).toContain("only works when signed in");
	});

	it("reads split opening hours and names the day it cannot read", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_identity", { kind: "local", name: "Acme Bakery" });
		await runtime.admin.submit(PAGE, "save_hours", {
			hours_monday: "9-17",
			hours_tuesday: "12:00-14:30, 18:00-22:00",
			hours_sunday: "",
		});
		expect((await config(runtime))?.site.openingHours).toEqual([
			{ days: ["Monday"], opens: "09:00", closes: "17:00" },
			{ days: ["Tuesday"], opens: "12:00", closes: "14:30" },
			{ days: ["Tuesday"], opens: "18:00", closes: "22:00" },
		]);

		const response = await runtime.admin.submit(PAGE, "save_hours", { hours_friday: "morning" });
		expect(response.toast).toEqual({
			type: "error",
			message:
				"Couldn't read the hours for Friday. Write them like 9:00-17:00, with at most two ranges.",
		});
		expect((await config(runtime))?.site.openingHours).toHaveLength(3);
	});

	it("saves profile links and areas, one per line", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_profiles", {
			profiles: "https://www.instagram.com/acme\n\nhttps://www.facebook.com/acme",
			areas: "Springfield\nShelbyville",
		});
		expect(await config(runtime)).toMatchObject({
			site: {
				sameAs: ["https://www.instagram.com/acme", "https://www.facebook.com/acme"],
				areaServed: ["Springfield", "Shelbyville"],
			},
		});

		const response = await runtime.admin.submit(PAGE, "save_profiles", { profiles: "instagram" });
		expect(response.toast?.type).toBe("error");
	});
});

describe("Page types", () => {
	it("opens the change form for one page type", async () => {
		const runtime = await start();
		const response = await runtime.admin.act(PAGE, "edit_type", { value: "services" });
		const form = flatten(response.blocks).find(
			(block) => block.type === "form" && block.block_id === "page_type",
		);
		expect(form?.type === "form" && form.submit.action_id).toBe("save_type:services");
	});

	it("hides a page type from search, warns about it, and accepts 'This is intended'", async () => {
		const runtime = await start();
		const entry = await runtime.fixtures.content("services", {
			slug: "cleaning",
			data: { title: "Cleaning" },
			status: "published",
		});

		const saved = await runtime.admin.submit(PAGE, "save_type:services", {
			type: "Service",
			noindex: true,
		});
		expect(texts(saved)).toContain("Some pages are hidden from Google");
		expect(await config(runtime)).toMatchObject({
			collections: { services: { type: "Service", noindex: true } },
			steps: { types: true },
		});

		// The public page now carries noindex.
		const contributions = (await runtime.transport.invokeHook("page:metadata", {
			page: {
				url: "https://acme.test/services/cleaning",
				path: "/services/cleaning",
				locale: null,
				kind: "content",
				pageType: "website",
				title: "Cleaning",
				description: null,
				canonical: null,
				image: null,
				content: { collection: "services", id: entry.id, slug: "cleaning" },
			},
		})) as PageMetadataContribution[];
		expect(contributions).toContainEqual({
			kind: "meta",
			name: "robots",
			content: "noindex, follow",
		});

		const acknowledged = await runtime.admin.act(PAGE, "hidden_ok");
		expect(texts(acknowledged)).not.toContain("Some pages are hidden from Google");
		expect(await config(runtime)).toMatchObject({
			collections: { services: { noindex: true, hiddenOk: true } },
		});
	});

	it("marks the step done when the guessed types already look right", async () => {
		const runtime = await start();
		const response = await runtime.admin.act(PAGE, "types_ok");
		expect((await config(runtime))?.steps).toEqual({ identity: false, types: true });
		expect(texts(response)).not.toContain("These look right");
	});

	it("saves the advanced snippet settings", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_advanced", {
			breadcrumbs: false,
			snippet: "none",
			image_preview: "standard",
		});
		expect(await config(runtime)).toMatchObject({
			breadcrumbs: false,
			robots: { nosnippet: true, maxImagePreview: "standard" },
		});
	});
});
