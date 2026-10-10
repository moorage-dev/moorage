// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { PageMetadataContribution } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import type { SeoConfig } from "../src/config.js";

const PAGE = "/overview";

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
	it("shows an admin three tabs, real numbers and one open question on the first visit", async () => {
		const runtime = await start();
		const response = await runtime.admin.loadPage(PAGE);

		const tabs = response.blocks.find((block) => block.type === "tab");
		expect(tabs?.type === "tab" && tabs.panels.map((panel) => panel.label)).toEqual([
			"Overview",
			"Redirects",
			"Settings",
		]);
		const overview = tabs?.type === "tab" ? (tabs.panels[0]?.blocks ?? []) : [];
		// Numbers first, then the one thing left to answer.
		expect(overview[0]?.type).toBe("stats");
		expect(JSON.stringify(overview[1])).toContain(
			"One thing left: tell Google who this site is for",
		);
	});

	it("guesses each content type from the collection's name", async () => {
		const runtime = await start();
		const response = await runtime.admin.loadPage(PAGE);
		const table = flatten(response.blocks).find(
			(block) => block.type === "table" && block.page_action_id === "types_table",
		);
		expect(
			table?.type === "table" &&
				table.rows.map((row) => [row.name, (row.shown as { label: string }).label]),
		).toEqual([
			["Pages", "Shown to Google as: Web page"],
			["Services", "Shown to Google as: Service"],
		]);
		expect(texts(response)).toContain("Content types: Pages = Web page, Services = Service");
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

describe("what EmDash will accept", () => {
	it("returns screens that pass EmDash's validator even when the site address is unknown", async () => {
		// A freshly created site can report an empty address; one invalid link
		// anywhere makes EmDash reject the whole page.
		host = await createPluginRuntimeTestHost({ site: { name: "", url: "", locale: "en" } });
		await host.fixtures.collection({
			slug: "pages",
			label: "Pages",
			urlPattern: "/{slug}",
			supports: ["seo"],
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const entry = await host.fixtures.content("pages", {
			slug: "about",
			data: { title: "About" },
			status: "published",
		});
		await host.fixtures.redirect({ source: "/x", destination: "/y" });

		const screens = [
			await host.admin.loadPage(PAGE),
			await host.admin.loadWidget("seo"),
			await host.admin.loadEditorPanel("preview", "pages", entry.id),
			await host.admin.submit(PAGE, "check_redirects", {
				list: "/a,/b\n/c,https://other.example/d",
			}),
		];
		for (const screen of screens) {
			expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] })).toEqual({
				valid: true,
				errors: [],
			});
		}
		expect(texts(screens[0] as BlockResponse)).not.toContain("Missing-page log");
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
		// The open question is gone from the Overview once answered.
		expect(texts(response)).not.toContain("One thing left");
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

	it("saves named and other profile links, accepting links without https", async () => {
		const runtime = await start();
		const saved = await runtime.admin.submit(PAGE, "save_profiles", {
			profile_instagram: "instagram.com/acme",
			profile_facebook: "https://www.facebook.com/acme",
			profiles: "https://www.tiktok.com/@acme\n\nhttps://www.yelp.com/biz/acme",
		});
		expect((await config(runtime))?.site.sameAs).toEqual([
			"https://www.facebook.com/acme",
			"https://instagram.com/acme",
			"https://www.tiktok.com/@acme",
			"https://www.yelp.com/biz/acme",
		]);
		// Each link comes back in its own field, and the section title says what is filled.
		expect(texts(saved)).toContain('"action_id":"profile_instagram","label":"Instagram"');
		expect(texts(saved)).toContain("Your profiles elsewhere: facebook.com, instagram.com");

		const response = await runtime.admin.submit(PAGE, "save_profiles", { profiles: "not a link" });
		expect(response.toast?.type).toBe("error");
	});

	it("saves areas served with the contact details, and optional company facts", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_contact", { areas: "Springfield\nShelbyville" });
		await runtime.admin.submit(PAGE, "save_company", {
			legal_name: "Acme Trading Ltd",
			founded: "2012",
			vat_id: "GB123456789",
			employees: "12",
		});
		expect((await config(runtime))?.site).toMatchObject({
			areaServed: ["Springfield", "Shelbyville"],
			legalName: "Acme Trading Ltd",
			foundingDate: "2012",
			vatID: "GB123456789",
			numberOfEmployees: 12,
		});

		const bad = await runtime.admin.submit(PAGE, "save_company", { founded: "last year" });
		expect(bad.toast?.type).toBe("error");
	});

	it("answers the setup question from the Overview, with an address for a local business", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "setup_identity", {
			kind: "local",
			business: "FoodEstablishment",
			name: "Acme Bakery",
			street: "1 Main St",
			town: "Springfield",
		});
		expect(await config(runtime)).toMatchObject({
			site: {
				type: "FoodEstablishment",
				name: "Acme Bakery",
				address: { streetAddress: "1 Main St", addressLocality: "Springfield" },
			},
			steps: { identity: true },
		});
	});
});

describe("Content types", () => {
	it("changes a content type straight from its menu", async () => {
		const runtime = await start();
		const response = await runtime.admin.act(PAGE, "set_type", { value: "services|ContactPage" });
		expect(response.toast?.type).toBe("success");
		expect((await config(runtime))?.collections.services).toEqual({
			type: "ContactPage",
			noindex: false,
		});
		expect(texts(response)).toContain("Shown to Google as: Contact page");

		const refused = await runtime.admin.act(PAGE, "set_type", { value: "nope|ContactPage" });
		expect(refused.toast?.type).toBe("error");
	});

	it("hides a page type from search, warns about it, and accepts 'This is intended'", async () => {
		const runtime = await start();
		const entry = await runtime.fixtures.content("services", {
			slug: "cleaning",
			data: { title: "Cleaning" },
			status: "published",
		});

		const saved = await runtime.admin.act(PAGE, "set_visible", { value: "services|hide" });
		expect(saved.toast?.message).toBe(
			"These pages are now hidden from Google and other search engines.",
		);
		expect(texts(saved)).toContain("Some pages are hidden from Google");
		expect(await config(runtime)).toMatchObject({
			collections: { services: { type: "Service", noindex: true } },
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
