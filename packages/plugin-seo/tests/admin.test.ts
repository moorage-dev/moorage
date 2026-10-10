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
		expect(JSON.stringify(overview[1])).toContain("Tell Google who this site is for");
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
			["Pages", "Google treats these as: Web page"],
			["Services", "Google treats these as: Service"],
		]);
		expect(texts(response)).toContain(
			"Content types (usually right as they are): Pages as Web page; Services as Service",
		);
	});

	it("shows an editor a read-only page and ignores their changes", async () => {
		const runtime = await start();
		const editor = await runtime.fixtures.user({ email: "editor@acme.test", role: "editor" });

		const response = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(response.blocks.some((block) => block.type === "tab")).toBe(false);
		expect(flatten(response.blocks).some((block) => block.type === "form")).toBe(false);
		expect(texts(response)).toContain("set by your site admin");

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
		expect(texts(screens[0] as BlockResponse)).not.toContain("addresses visitors tried");
	});
});

describe("Who you are", () => {
	it("saves a local business, then follows up on what Google still needs", async () => {
		const runtime = await start();
		const response = await runtime.admin.submit(PAGE, "save_identity", {
			kind: "local",
			business: "FoodEstablishment",
			name: "Acme Bakery",
			description: "Bread baked every morning.",
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
			},
			steps: { identity: true },
		});
		// The open question is gone; the Overview now lists what a local business still owes.
		expect(texts(response)).not.toContain("Tell Google who this site is for");
		const owed = flatten(response.blocks).find(
			(block) => block.type === "table" && block.page_action_id === "details_table",
		);
		expect(owed?.type === "table" && owed.rows.map((row) => row.what)).toEqual([
			"Address",
			"Opening hours",
			"Phone number",
		]);
		// Sections say how much they matter and whether they are filled.
		expect(texts(response)).toContain("Address and phone (needed, not added yet)");
		expect(texts(response)).toContain("Opening hours (needed, not added yet)");
		expect(texts(response)).toContain("Your profiles elsewhere (worth adding, not added yet)");
		expect(texts(response)).toContain("More about you (optional, not added yet)");
	});

	it("stops following up once the needed details are in, and says what Google is told", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_identity", {
			kind: "local",
			business: "FoodEstablishment",
			name: "Acme Bakery",
		});
		await runtime.admin.submit(PAGE, "save_contact", {
			street: "1 Main St",
			town: "Springfield",
			telephone: "+1 555 0100",
		});
		const response = await runtime.admin.submit(PAGE, "save_hours", { hours_monday: "9-17" });

		expect(
			flatten(response.blocks).some(
				(b) => b.type === "table" && b.page_action_id === "details_table",
			),
		).toBe(false);
		expect(texts(response)).toContain(
			"Google is told: Acme Bakery, restaurant, cafe or bakery, 1 Main St, Springfield, open Mon 09:00-17:00. Change this in the Settings tab.",
		);
		expect(texts(response)).toContain("Opening hours: Mon 09:00-17:00");
	});

	it("asks a company for a logo and profiles, not for opening hours", async () => {
		const runtime = await start();
		const response = await runtime.admin.submit(PAGE, "save_identity", {
			kind: "organization",
			name: "Acme Inc",
		});
		const owed = flatten(response.blocks).find(
			(block) => block.type === "table" && block.page_action_id === "details_table",
		);
		expect(owed?.type === "table" && owed.rows.map((row) => row.what)).toEqual([
			"Logo",
			"Profiles elsewhere",
		]);
		expect(texts(response)).toContain("Opening hours (only for a local business)");
	});

	it("will not guess who the site is for", async () => {
		const runtime = await start();
		const none = await runtime.admin.submit(PAGE, "save_identity", { name: "Acme" });
		expect(none.toast).toEqual({ type: "error", message: "Choose who this site is for." });
		const noKind = await runtime.admin.submit(PAGE, "save_identity", {
			kind: "local",
			name: "Acme",
		});
		expect(noKind.toast).toEqual({ type: "error", message: "Choose the kind of business." });
		expect(await config(runtime)).toBeNull();
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
		await runtime.admin.submit(PAGE, "save_identity", { kind: "organization", name: "Acme" });
		// Later the admin only touches the name; the form sends nothing else.
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

	it("rejects a logo link that is not a web address", async () => {
		const runtime = await start();
		const response = await runtime.admin.submit(PAGE, "save_logo", {
			logo_url: "ftp://acme.test/logo.png",
		});
		expect(response.toast?.type).toBe("error");
		expect(response.toast?.message).toContain("https://");
		expect(await config(runtime)).toBeNull();
	});

	it("accepts a public logo link from Media and refuses a sign-in-only one", async () => {
		const runtime = await start();
		// "Copy URL" in Media gives a site-relative public link.
		const saved = await runtime.admin.submit(PAGE, "save_logo", {
			logo_url: "/_emdash/api/media/file/logo.png",
		});
		expect((await config(runtime))?.site.logo).toBe(
			"https://acme.test/_emdash/api/media/file/logo.png",
		);
		expect(texts(saved)).toContain("Logo: added");

		const refused = await runtime.admin.submit(PAGE, "save_logo", {
			logo_url: "/_emdash/api/media/asset/01ABC/logo.png",
		});
		expect(refused.toast?.type).toBe("error");
		expect(refused.toast?.message).toContain("only works when signed in");
	});

	it("reads split opening hours and names the day it cannot read", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_identity", {
			kind: "local",
			business: "FoodEstablishment",
			name: "Acme Bakery",
		});
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

	it("saves areas served with the address, and the optional extras", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "save_contact", { areas: "Springfield\nShelbyville" });
		await runtime.admin.submit(PAGE, "save_company", {
			alternate_name: "Acme",
			legal_name: "Acme Trading Ltd",
			founded: "2012",
		});
		expect((await config(runtime))?.site).toMatchObject({
			areaServed: ["Springfield", "Shelbyville"],
			alternateName: "Acme",
			legalName: "Acme Trading Ltd",
			foundingDate: "2012",
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
		expect(texts(response)).toContain("Google treats these as: Contact page");

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

		// Hiding is asked about first, and nothing changes until it is confirmed.
		const asked = await runtime.admin.act(PAGE, "set_visible", { value: "services|hide" });
		expect(texts(asked)).toContain("Hide every page in Services from Google?");
		expect(await config(runtime)).toBeNull();

		const saved = await runtime.admin.act(PAGE, "confirm_hide", { value: "services" });
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
