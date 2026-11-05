// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { PageMetadataContribution } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import type { SeoConfig } from "../src/config.js";
import { GUIDE_URL, HELP_LINE, HIDE_ACTION } from "../src/help-line.js";

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
	return runtime.inspect.setting<SeoConfig>("config");
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

describe("the page counts", () => {
	async function checked(runtime: PluginRuntimeTestHost): Promise<BlockResponse> {
		await runtime.admin.loadPage(PAGE);
		for (let step = 0; step < 20; step += 1) {
			const scan = await runtime.inspect.kv.get<{ status: string; sweep?: unknown }>("scan");
			if (scan?.status === "done" && !scan.sweep) break;
			await runtime.transport.invokeHook("cron", { name: "seo-scan" });
		}
		return runtime.admin.loadPage(PAGE);
	}

	function counts(response: BlockResponse): Record<string, unknown> {
		const stats = flatten(response.blocks).find((block) => block.type === "stats");
		return Object.fromEntries(
			(stats?.type === "stats" ? stats.items : []).map((item) => [item.label, item.value]),
		);
	}

	it("add up: hidden pages are in none of the three cards", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", {
			collections: { services: { noindex: true, hiddenOk: true } },
		});
		for (const slug of ["one", "two", "three"]) {
			await runtime.fixtures.content("pages", { slug, data: { title: slug }, status: "published" });
		}
		for (const slug of ["cakes", "bread"]) {
			await runtime.fixtures.content("services", {
				slug,
				data: { title: slug },
				status: "published",
			});
		}
		const response = await checked(runtime);
		const shown = counts(response);
		expect(shown["Pages checked"]).toBe(3);
		expect(Number(shown["Nothing to fix"]) + Number(shown["To fix"])).toBe(3);
		expect(texts(response)).toContain("2 pages are hidden from Google and not counted above");
	});

	it("a site whose pages are all hidden says so, not that it has no pages", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", {
			collections: {
				pages: { noindex: true, hiddenOk: true },
				services: { noindex: true, hiddenOk: true },
			},
		});
		await runtime.fixtures.content("pages", {
			slug: "one",
			data: { title: "One" },
			status: "published",
		});
		const response = await checked(runtime);
		expect(counts(response)["Pages checked"]).toBe(0);
		expect(texts(response)).not.toContain("No published pages yet");
		expect(texts(response)).toContain("1 page is hidden from Google");
		const widget = await runtime.admin.loadWidget("seo");
		expect(texts(widget)).not.toContain("Your pages are being checked.");
		expect(texts(widget)).toContain("Every page is hidden from Google");
	});
});

describe("the help line", () => {
	const line = (response: BlockResponse) =>
		response.blocks.find((block) => block.type === "actions" && block.block_id === HELP_LINE);

	it("ends an admin's page, under every tab, with the guide, the plugins and the maker", async () => {
		const runtime = await start();
		const response = await runtime.admin.loadPage(PAGE);
		// The last block, outside the tabs, so it shows whichever tab is open.
		expect(response.blocks.at(-1)).toEqual({
			type: "actions",
			block_id: HELP_LINE,
			elements: [
				{ type: "link", label: "Help", target: { kind: "external", url: GUIDE_URL } },
				{
					type: "link",
					label: "More free plugins",
					target: { kind: "external", url: "https://moorage.dev/plugins" },
				},
				{
					type: "link",
					label: "by Moorage",
					target: { kind: "external", url: "https://moorage.dev" },
				},
			],
		});
		expect(GUIDE_URL).toBe("https://moorage.dev/guides/add-schema-markup-to-emdash");
		expect(validateBlockResponse(response, { pluginPagePaths: [PAGE] }).valid).toBe(true);
		// After any change too, and only once.
		const saved = await runtime.admin.submit(PAGE, "save_identity", { name: "Acme" });
		expect(saved.blocks.filter((block) => block.block_id === HELP_LINE)).toHaveLength(1);
	});

	it("never shows to editors, authors or contributors, nor on the widget or the editor panel", async () => {
		const runtime = await start();
		const entry = await runtime.fixtures.content("pages", {
			slug: "about",
			data: { title: "About" },
			status: "published",
		});
		const editor = await runtime.fixtures.user({ email: "editor@acme.test", role: "editor" });
		expect(texts(await runtime.admin.loadPage(PAGE, { user: editor }))).not.toMatch(/moorage/i);
		// Authors and contributors cannot open the page at all.
		for (const role of ["author", "contributor"] as const) {
			const user = await runtime.fixtures.user({ email: `${role}@acme.test`, role });
			await expect(runtime.admin.loadPage(PAGE, { user })).rejects.toThrow(/403/);
		}
		expect(JSON.stringify(await runtime.admin.loadWidget("seo"))).not.toMatch(/moorage/i);
		const panel = await runtime.admin.loadEditorPanel("preview", "pages", entry.id);
		expect(JSON.stringify(panel)).not.toMatch(/moorage/i);
	});

	it("hides with the switch in Settings, keeps it through other saves, and shows again", async () => {
		const runtime = await start();
		const switchOf = (response: BlockResponse) =>
			flatten(response.blocks).find(
				(block) => block.type === "form" && block.submit?.action_id === HIDE_ACTION,
			);
		expect(switchOf(await runtime.admin.loadPage(PAGE))).toBeDefined();

		const hidden = await runtime.admin.submit(PAGE, HIDE_ACTION, { hide_help_line: true });
		// The very response that saved it already leaves it out.
		expect(line(hidden)).toBeUndefined();
		expect((await config(runtime))?.hideHelpLine).toBe(true);
		expect(line(await runtime.admin.loadPage(PAGE))).toBeUndefined();

		// Saving another setting, or this form untouched, keeps it hidden.
		await runtime.admin.submit(PAGE, "save_advanced", { breadcrumbs: false });
		await runtime.admin.submit(PAGE, HIDE_ACTION, {});
		expect((await config(runtime))?.hideHelpLine).toBe(true);
		expect(line(await runtime.admin.loadPage(PAGE))).toBeUndefined();

		const shown = await runtime.admin.submit(PAGE, HIDE_ACTION, { hide_help_line: false });
		expect(line(shown)).toBeDefined();
	});

	it("shows on a site whose settings were saved before the switch existed", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", { breadcrumbs: true });
		expect(line(await runtime.admin.loadPage(PAGE))).toBeDefined();
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

describe("copying settings to another site", () => {
	const SOURCE = {
		site: {
			type: "FoodEstablishment",
			name: "Acme Bakery",
			sameAs: ["https://www.instagram.com/acmebakery"],
			telephone: "+44 20 7946 0000",
			address: { streetAddress: "1 Main St", addressLocality: "Springfield" },
			openingHours: [{ days: ["Monday"], opens: "08:00", closes: "17:00" }],
			areaServed: [],
		},
		collections: { services: { type: "Service", noindex: true, hiddenOk: true } },
		steps: { identity: true, types: true },
		hideHelpLine: true,
	};

	/** The code block an admin copies from the Settings tab. */
	function exported(response: BlockResponse): string {
		const code = flatten(response.blocks).find(
			(block) => block.type === "code" && block.block_id === "settings_export",
		);
		return code?.type === "code" ? code.code : "";
	}

	function applyButton(response: BlockResponse) {
		const actions = flatten(response.blocks).find(
			(block) => block.type === "actions" && block.block_id === "settings_import_confirm",
		);
		const button =
			actions?.type === "actions"
				? actions.elements.find(
						(element) => element.type === "button" && element.action_id === "apply_settings",
					)
				: undefined;
		return button?.type === "button" ? button : undefined;
	}

	it("shows the settings as code to copy, without the per-site switches", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", SOURCE);
		const text = exported(await runtime.admin.loadPage(PAGE));
		const parsed = JSON.parse(text) as Record<string, unknown>;
		expect(parsed.format).toBe("emdash-seo-settings");
		expect(parsed).toMatchObject({ site: { name: "Acme Bakery", type: "FoodEstablishment" } });
		expect(parsed).toMatchObject({ collections: { services: { type: "Service", noindex: true } } });
		// Per-site choices stay on the site: the help line switch, setup steps, confirmations.
		expect(text).not.toContain("hideHelpLine");
		expect(text).not.toContain("steps");
		expect(text).not.toContain("hiddenOk");
	});

	it("checks a paste, shows what will change, saves nothing until applied, then saves it", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", SOURCE);
		const text = exported(await runtime.admin.loadPage(PAGE));
		await runtime.fixtures.plugin.setting("config", null);

		const checked = await runtime.admin.submit(PAGE, "check_settings", { settings: text });
		expect(checked.toast?.type).toBe("success");
		const shown = texts(checked);
		expect(shown).toContain("What will change");
		expect(shown).toContain("Acme Bakery");
		expect(shown).toContain("Restaurant, cafe or bakery");
		// Hiding content from Google is the change that can do damage, so it is called out.
		expect(shown).toContain("These settings hide every page in Services from Google");
		expect(validateBlockResponse(checked, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});
		expect(await config(runtime)).toBeNull();

		const button = applyButton(checked);
		expect(button).toBeDefined();
		const applied = await runtime.admin.act(PAGE, "apply_settings", { value: button?.value });
		expect(applied.toast?.type).toBe("success");
		const saved = await config(runtime);
		expect(saved?.site).toMatchObject({
			type: "FoodEstablishment",
			name: "Acme Bakery",
			telephone: "+44 20 7946 0000",
			openingHours: [{ days: ["Monday"], opens: "08:00", closes: "17:00" }],
		});
		// Hidden again needs this site's own confirmation; the help line stays as it was here.
		expect(saved?.collections.services).toEqual({ type: "Service", noindex: true });
		expect(saved?.hideHelpLine).toBe(false);
		expect(saved?.steps.identity).toBe(true);
		expect(texts(applied)).toContain("Some pages are hidden from Google");
	});

	it("copies every content type as it is, guessed types and shown ones too", async () => {
		const runtime = await start();
		// The source relies on the guesses: Pages as Web page, Services as Service, both shown.
		const text = exported(await runtime.admin.loadPage(PAGE));
		expect(JSON.parse(text)).toMatchObject({
			collections: {
				pages: { type: "WebPage", noindex: false },
				services: { type: "Service", noindex: false },
			},
		});
		// This site changed both, and had its hidden Services confirmed.
		await runtime.fixtures.plugin.setting("config", {
			collections: {
				pages: { type: "AboutPage" },
				services: { noindex: true, hiddenOk: true },
			},
		});
		const checked = await runtime.admin.submit(PAGE, "check_settings", { settings: text });
		await runtime.admin.act(PAGE, "apply_settings", { value: applyButton(checked)?.value });
		expect((await config(runtime))?.collections).toEqual({
			pages: { type: "WebPage", noindex: false },
			services: { type: "Service", noindex: false },
		});
	});

	it("keeps this site's confirmation for a content type it already hid", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", {
			collections: { services: { noindex: true, hiddenOk: true } },
		});
		const paste = JSON.stringify({
			format: "emdash-seo-settings",
			version: 1,
			site: { type: "Organization", name: "Acme Two" },
			collections: { services: { type: "Service", noindex: true } },
		});
		const checked = await runtime.admin.submit(PAGE, "check_settings", { settings: paste });
		expect(texts(checked)).not.toContain("These settings hide every page");
		const applied = await runtime.admin.act(PAGE, "apply_settings", {
			value: applyButton(checked)?.value,
		});
		expect((await config(runtime))?.collections.services).toEqual({
			type: "Service",
			noindex: true,
			hiddenOk: true,
		});
		expect(texts(applied)).not.toContain("Some pages are hidden from Google");
	});

	it("says when nothing would change", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", SOURCE);
		const text = exported(await runtime.admin.loadPage(PAGE));
		const checked = await runtime.admin.submit(PAGE, "check_settings", { settings: text });
		expect(texts(checked)).toContain("Nothing would change");
		expect(applyButton(checked)).toBeUndefined();
	});

	it("leaves out content types this site does not have, and says so", async () => {
		const runtime = await start();
		const paste = JSON.stringify({
			format: "emdash-seo-settings",
			version: 1,
			site: { type: "Organization", name: "Acme" },
			collections: { recipes: { type: "Article" }, pages: { type: "AboutPage" } },
		});
		const checked = await runtime.admin.submit(PAGE, "check_settings", { settings: paste });
		expect(texts(checked)).toContain("Left out, as this site has no such content: recipes");
		await runtime.admin.act(PAGE, "apply_settings", { value: applyButton(checked)?.value });
		const saved = await config(runtime);
		expect(saved?.collections.pages?.type).toBe("AboutPage");
		expect(saved?.collections.recipes).toBeUndefined();
	});

	it("imports a paste as the forms would save it, and never the markup field", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", {
			site: { type: "Organization", priceRange: "$$" },
		});
		const paste = JSON.stringify({
			format: "emdash-seo-settings",
			version: 1,
			site: {
				type: "Store",
				name: "Acme Shop",
				foundingDate: "2012",
				sameAs: ["instagram.com/acme", "", "https://www.facebook.com/acme"],
				address: { streetAddress: "1 Main St", addressCountry: "gb" },
				openingHours: [
					{ days: ["Monday", "Tuesday"], opens: "9:00", closes: "17:00" },
					{ days: ["Monday"], opens: "18:00", closes: "20:00" },
				],
			},
			robots: { maxSnippet: 50, maxVideoPreview: 30, maxImagePreview: "standard" },
			jsonLdField: "custom_markup",
		});
		const checked = await runtime.admin.submit(PAGE, "check_settings", { settings: paste });
		expect(checked.toast?.type).toBe("success");
		const shown = texts(checked);
		expect(JSON.stringify(applyButton(checked)?.value)).not.toContain("custom_markup");
		expect(shown).not.toContain("Field for a page's own markup");
		expect(shown).toContain("Video previews in search results");
		expect(shown).toContain("https://instagram.com/acme");
		expect(shown).toContain("Not shown");
		expect(shown).toContain("A local business customers visit (shop, cafe, clinic)");
		expect(shown).toContain("Small");
		await runtime.admin.act(PAGE, "apply_settings", { value: applyButton(checked)?.value });
		const saved = await config(runtime);
		expect(saved?.jsonLdField).toBe("json_ld");
		expect(saved?.site.foundingDate).toBe("2012");
		expect(saved?.site.sameAs).toEqual([
			"https://instagram.com/acme",
			"https://www.facebook.com/acme",
		]);
		expect(saved?.site.address?.addressCountry).toBe("GB");
		expect(saved?.site.openingHours).toEqual([
			{ days: ["Monday"], opens: "09:00", closes: "17:00" },
			{ days: ["Monday"], opens: "18:00", closes: "20:00" },
			{ days: ["Tuesday"], opens: "09:00", closes: "17:00" },
		]);
		expect(saved?.robots).toMatchObject({
			maxSnippet: 160,
			maxVideoPreview: 160,
			maxImagePreview: "standard",
			nosnippet: false,
		});
	});

	it("keeps what no form edits on this site: map position, VAT and tax numbers, employees", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.setting("config", {
			site: {
				type: "Organization",
				name: "Here",
				geo: { latitude: 1, longitude: 2 },
				vatID: "GB1",
				taxID: "T1",
				numberOfEmployees: 5,
			},
		});
		const own = exported(await runtime.admin.loadPage(PAGE));
		for (const key of ["geo", "vatID", "taxID", "numberOfEmployees", "jsonLdField"]) {
			expect(own, key).not.toContain(`"${key}"`);
		}
		const paste = JSON.stringify({
			format: "emdash-seo-settings",
			version: 1,
			site: {
				type: "Organization",
				name: "There",
				geo: { latitude: 9, longitude: 9 },
				vatID: "GB9",
				taxID: "T9",
				numberOfEmployees: 99,
			},
		});
		const checked = await runtime.admin.submit(PAGE, "check_settings", { settings: paste });
		const value = JSON.stringify(applyButton(checked)?.value);
		for (const key of ["geo", "vatID", "taxID", "numberOfEmployees"]) {
			expect(value, key).not.toContain(`"${key}"`);
		}
		const table = flatten(checked.blocks).find(
			(block) => block.type === "table" && block.page_action_id === "transfer_table",
		);
		const rows = JSON.stringify(table);
		expect(rows).toContain("There");
		for (const row of ["Map position", "VAT number", "Tax number", "Employees"]) {
			expect(rows, row).not.toContain(row);
		}
		await runtime.admin.act(PAGE, "apply_settings", { value: applyButton(checked)?.value });
		expect((await config(runtime))?.site).toMatchObject({
			name: "There",
			geo: { latitude: 1, longitude: 2 },
			vatID: "GB1",
			taxID: "T1",
			numberOfEmployees: 5,
		});
	});

	it("drops pasted hours when the site is not a local business, and maps no text to -1", async () => {
		const runtime = await start();
		const paste = JSON.stringify({
			format: "emdash-seo-settings",
			version: 1,
			site: {
				type: "Organization",
				openingHours: [{ days: ["Monday"], opens: "09:00", closes: "17:00" }],
			},
			robots: { nosnippet: true, maxSnippet: 160, maxVideoPreview: -5 },
		});
		const checked = await runtime.admin.submit(PAGE, "check_settings", { settings: paste });
		expect(checked.toast?.type).toBe("success");
		expect(texts(checked)).not.toContain("Mon 09:00");
		await runtime.admin.act(PAGE, "apply_settings", { value: applyButton(checked)?.value });
		const saved = await config(runtime);
		expect(saved?.site.openingHours).toEqual([]);
		expect(saved?.robots).toMatchObject({ nosnippet: true, maxSnippet: -1, maxVideoPreview: -1 });
	});

	it("refuses what is not settings from this plugin, or settings the forms would refuse", async () => {
		const runtime = await start();
		const settings = (site: Record<string, unknown>) =>
			JSON.stringify({ format: "emdash-seo-settings", version: 1, site });
		for (const [paste, message] of [
			["", "Paste the settings first."],
			["source,target,code\n/a,/b,301", "This is not a copy of SEO settings"],
			['{"site":{"name":"Acme"}}', "This is not a copy of SEO settings"],
			[settings({ type: "Spaceport" }), "kind of site"],
			[
				settings({
					type: "Store",
					openingHours: [{ days: ["Monday"], opens: "8am", closes: "5pm" }],
				}),
				"opening hours",
			],
			[settings({ type: "Organization", logo: "javascript:alert(1)" }), "logo"],
			[settings({ type: "Organization", sameAs: ["not a link"] }), "profile"],
			[settings({ type: "Organization", sameAs: ["https://localhost/me"] }), "profile"],
			[settings({ type: "Organization", foundingDate: "May 2012" }), "founding date"],
			[
				settings({
					type: "Store",
					openingHours: [
						{ days: ["Monday"], opens: "08:00", closes: "10:00" },
						{ days: ["Monday"], opens: "11:00", closes: "13:00" },
						{ days: ["Monday"], opens: "14:00", closes: "17:00" },
					],
				}),
				"opening hours",
			],
			[
				settings({
					type: "Store",
					openingHours: [{ days: ["Funday"], opens: "08:00", closes: "10:00" }],
				}),
				"opening hours",
			],
		] as const) {
			const response = await runtime.admin.submit(PAGE, "check_settings", { settings: paste });
			expect(response.toast?.type, paste).toBe("error");
			expect(response.toast?.message, paste).toContain(message);
			expect(applyButton(response), paste).toBeUndefined();
		}
		// A changed button value is checked again before anything is saved.
		const refused = await runtime.admin.act(PAGE, "apply_settings", {
			value: { format: "emdash-seo-settings", version: 1, site: { type: "Spaceport" } },
		});
		expect(refused.toast?.type).toBe("error");
		expect(await config(runtime)).toBeNull();
	});

	it("lets only an admin see and apply settings", async () => {
		const runtime = await start();
		const editor = await runtime.fixtures.user({ email: "editor@acme.test", role: "editor" });
		const page = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(texts(page)).not.toContain("emdash-seo-settings");
		await runtime.admin.act(PAGE, "apply_settings", {
			value: {
				format: "emdash-seo-settings",
				version: 1,
				site: { type: "Person", name: "Hacked" },
			},
			user: editor,
		});
		expect(await config(runtime)).toBeNull();
	});
});
