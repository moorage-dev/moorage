// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	expect,
	test,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Page,
} from "@playwright/test";

import { growToContent } from "./full-shot.js";
import { helpLinks } from "./help-line.js";

// README and registry pictures of SEO, Site Health and Popups, and the full-size captures the
// website crops from Popups' list and Content Approval's Settings, on a site set up as a bakery's:
//   DEMO_SITE_PORT=4501 DEMO_SITE_PUBLIC_URL=https://www.harbourstreetbakery.example \
//     PLUGIN_SCREENSHOTS=1 pnpm --filter demo-site exec playwright test tests/plugin-screenshots.spec.ts
// Skipped otherwise. Run it on its own, on a fresh database (Playwright makes one): it names the site
// and the admin, and changes the demo pages. DEMO_SITE_PUBLIC_URL is the address the plugins print
// (SEO's Google preview), so no "localhost" shows. Content Approval's and Lead Delivery's README
// pictures come from their own specs (APPROVALS_SCREENSHOTS=1, lead-delivery-screenshots.spec.ts).
// The pictures get new names when a plugin changes (the website reuses a picture by its file name).
// SHOTS_RETAKES_DIR (default /tmp/moorage-retakes) gets the captures only the website uses.
//
// Site Health cannot open a local site's own pages, so after a real check its stored results and
// Checklist are replaced with what a public bakery site would get; the rest of the page is its own.

const SHOTS = process.env.PLUGIN_SCREENSHOTS === "1";
const VERSION = { seo: "0-1-11", siteHealth: "0-1-5", popups: "0-1-8" };
const API = "/_emdash/api";
const H = { "X-EmDash-Request": "1" };
const PACKAGES = resolve(import.meta.dirname, "../../../packages");
const RETAKES = resolve(process.env.SHOTS_RETAKES_DIR ?? "/tmp/moorage-retakes");
const DB = resolve(import.meta.dirname, `../e2e-${process.env.DEMO_SITE_PORT ?? 4399}.db`);
const BUSINESS = "Harbour Street Bakery";
// Nothing from the stock demo site, the dev sign-in or the test machine may show.
const FORBIDDEN = ["Acme", "Dev Admin", "localhost"];

test.describe.configure({ mode: "serial" });
test.skip(!SHOTS, "screenshots only on request");

let adminContext: BrowserContext;
let admin: APIRequestContext;
const ids: Record<string, string> = {};

async function ok(response: Promise<import("@playwright/test").APIResponse>): Promise<any> {
	const result = await response;
	expect(result.ok(), `${result.url()} -> ${result.status()} ${await result.text()}`).toBe(true);
	return result.json();
}

/** A page signed in as Ellen, at this size, scale and colour scheme. */
async function open(
	browser: Browser,
	path: string,
	viewport: { width: number; height: number },
	scale: number,
	colorScheme: "light" | "dark" = "light",
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		storageState: await adminContext.storageState(),
		viewport,
		deviceScaleFactor: scale,
		colorScheme,
	});
	const page = await context.newPage();
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	await page.goto(path);
	return { context, page };
}

/** Fail before a picture is taken if anything from the stock demo is on screen. */
async function clean(page: Page, name: string): Promise<void> {
	const visible = (await page.locator("body").innerText()).toLowerCase();
	for (const word of FORBIDDEN)
		expect(visible, `"${word}" is on screen in ${name}`).not.toContain(word.toLowerCase());
}

/** The window as it is. */
async function shot(page: Page, file: string): Promise<void> {
	await clean(page, file);
	mkdirSync(resolve(file, ".."), { recursive: true });
	await page.screenshot({ path: file });
	console.log(file);
}

/** As tall as the content, so the foot of the page (and its help line) is in the picture. */
async function fullShot(page: Page, file: string, width: number, minHeight: number) {
	await growToContent(page, width, minHeight);
	await expect(helpLinks(page)).toHaveCount(3);
	await page.waitForTimeout(300);
	await clean(page, file);
	mkdirSync(resolve(file, ".."), { recursive: true });
	await page.screenshot({ path: file, fullPage: true });
	console.log(file);
}

const sql = (query: string) => execFileSync("sqlite3", [DB, query], { encoding: "utf8" }).trim();

test.beforeAll(async ({ browser }) => {
	adminContext = await browser.newContext();
	const page = await adminContext.newPage();
	await page.goto(`${API}/setup/dev-bypass?redirect=/_emdash/admin`);
	await page.close();
	admin = adminContext.request;
	const me = await ok(admin.get(`${API}/auth/me`, { headers: H }));
	await ok(
		admin.put(`${API}/admin/users/${me.data.id}`, {
			headers: H,
			data: { name: "Ellen Marsh", email: "ellen@harbourstreetbakery.example" },
		}),
	);
	await ok(
		admin.post(`${API}/settings`, {
			headers: H,
			data: { title: BUSINESS, tagline: "Fresh bread, cakes and coffee" },
		}),
	);
	// Backup & Restore is not released; keep it out of the sidebar.
	await plugin("restore", "disable");
});

/** Turn one of the demo site's plugins off or on (`id` as in its manifest). */
async function plugin(id: string, action: "disable" | "enable"): Promise<void> {
	await ok(admin.post(`${API}/admin/plugins/${id}/${action}`, { headers: H }));
}

test.afterAll(async () => {
	await adminContext?.close();
});

// ---------- SEO: Overview, Redirects, Settings and the editor's Google preview ----------

const hero = (key: string, headline: string, subheadline: string) => ({
	_type: "marketing_hero",
	_version: 1,
	_key: key,
	headline,
	subheadline,
	centered: true,
});

const PAGES: Record<string, { slug: string; title: string; content: unknown[] }> = {
	home: {
		slug: "home",
		title: "Home",
		content: [
			hero(
				"hero",
				BUSINESS,
				"Bread, cakes and coffee from our ovens on Harbour Street, Whitby. Open from seven every morning.",
			),
		],
	},
	pricing: {
		slug: "menu",
		title: "Menu",
		content: [
			hero("menu-hero", "Fresh bread, cakes and coffee", "Baked every morning on Harbour Street."),
			{
				_type: "marketing_features",
				_version: 1,
				_key: "menu-list",
				headline: "On the counter today",
				features: [
					{ icon: "star", title: "Sourdough loaf", description: "Slow-proved overnight, £4.20." },
					{ icon: "star", title: "Lemon drizzle cake", description: "By the slice, £3.50." },
					{ icon: "star", title: "Flat white", description: "Roasted in Whitby, £3.10." },
				],
			},
		],
	},
	contact: {
		slug: "contact",
		title: "Contact",
		content: [
			hero(
				"contact-hero",
				"Come and say hello",
				"Find us at 12 Harbour Street, Whitby, or order a celebration cake by phone or email.",
			),
		],
	},
};

test("SEO", async ({ browser }) => {
	test.setTimeout(400_000);
	// The stock demo pages become the bakery's, through the same API the admin screens use.
	const list = await ok(admin.get(`${API}/content/pages`, { headers: H }));
	for (const item of list.data.items as Array<{ id: string; slug: string }>) {
		const next = PAGES[item.slug];
		if (!next) continue;
		ids[next.slug] = item.id;
		await ok(
			admin.put(`${API}/content/pages/${item.id}`, {
				headers: H,
				data: {
					slug: next.slug,
					data: { title: next.title, content: next.content },
					// One page is already in good shape, so the Overview is not all red.
					...(next.slug === "contact"
						? {
								seo: {
									description:
										"Find Harbour Street Bakery at 12 Harbour Street, Whitby. Opening times, phone and email.",
								},
							}
						: {}),
				},
			}),
		);
		await ok(admin.post(`${API}/content/pages/${item.id}/publish`, { headers: H }));
	}
	// Renaming the stock page left a redirect from its old address; remove it.
	const redirects = await ok(admin.get(`${API}/redirects`, { headers: H }));
	for (const redirect of redirects.data.items as Array<{ id: string }>)
		await ok(admin.delete(`${API}/redirects/${redirect.id}`, { headers: H }));

	// Content Approval adds its own panel and button to the editor; SEO's pictures show SEO alone.
	await plugin("approvals", "disable");
	const out = `${PACKAGES}/plugin-seo/images`;
	const { context, page } = await open(
		browser,
		"/_emdash/admin/plugins/seo/overview",
		{ width: 1440, height: 1080 },
		2,
	);
	await expect(page.getByText("Pages checked")).toBeVisible({ timeout: 120_000 });
	// The one question, answered.
	await page.getByText("A local business customers visit").first().click();
	await page.getByRole("combobox").first().click();
	await page.getByRole("option", { name: "Restaurant, cafe or bakery" }).click();
	await page.getByRole("textbox", { name: "Name", exact: true }).first().fill(BUSINESS);
	await page.getByRole("textbox", { name: "Street address" }).first().fill("12 Harbour Street");
	await page.getByRole("textbox", { name: "Town or city" }).first().fill("Whitby");
	await page.getByRole("button", { name: "Save", exact: true }).first().click();
	await expect(page.getByText("Saved. Google will pick this up")).toBeVisible();

	// A full check, so the list shows the bakery's pages and not the stock ones.
	await page.goto("/_emdash/admin/plugins/seo/overview");
	await page.getByRole("button", { name: "Check all pages again" }).click();
	await expect(page.getByText("All pages checked.")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByRole("cell", { name: "Opening hours" })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("cell", { name: "Menu", exact: true })).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByRole("link", { name: "Open page" })).toHaveCount(2);
	await page.mouse.move(700, 900);
	await expect(page.getByText("All pages checked.")).toHaveCount(0, { timeout: 30_000 });
	await expect(helpLinks(page)).toHaveCount(3);
	await page.waitForTimeout(1000);
	await shot(page, `${out}/overview-${VERSION.seo}.png`);

	// Redirects: three in the list, a fourth being typed.
	await page.getByRole("tab", { name: "Redirects" }).click();
	for (const [from, to] of [
		["/cakes-menu", "/menu"],
		["/about-us", "/contact"],
		["/opening-times", "/contact"],
	] as const) {
		await page.getByRole("button", { name: "Add a redirect" }).click();
		await page.getByRole("textbox", { name: "Redirect from" }).fill(from);
		await page.getByRole("textbox", { name: "Redirect to" }).fill(to);
		await page.getByRole("button", { name: "Add redirect" }).click();
		await expect(page.getByText(`Redirect added. ${from} now goes to ${to}.`)).toBeVisible();
	}
	await page.getByRole("button", { name: "Add a redirect" }).click();
	await page.getByRole("textbox", { name: "Redirect from" }).fill("/wedding-cakes");
	await page.getByRole("textbox", { name: "Redirect to" }).fill("/menu");
	await page.waitForTimeout(4500); // the "Redirect added" toast has gone
	await shot(page, `${out}/redirects-${VERSION.seo}.png`);

	await page.getByRole("tab", { name: "Settings" }).click();
	await expect(page.getByText("Address and phone: 12 Harbour Street, Whitby")).toBeVisible();
	await page.waitForTimeout(800);
	await shot(page, `${out}/settings-${VERSION.seo}.png`);

	// The Menu page in the editor, with the Google preview panel open. Nothing is typed: the
	// panel shows the same missing description the Overview lists.
	await page.goto(`/_emdash/admin/content/pages/${ids.menu}`);
	await page.getByRole("button", { name: "Google preview" }).first().click();
	const panel = page.getByText("What Google sees").first();
	await expect(panel).toBeVisible();
	await expect(page.getByText(/To fix.*No search description/)).toBeVisible();
	await panel.hover();
	await page.mouse.wheel(0, 3000);
	await page.waitForTimeout(800);
	await page.mouse.wheel(0, 3000);
	await page.waitForTimeout(1200);
	await shot(page, `${out}/google-preview-${VERSION.seo}.png`);
	await context.close();
	await plugin("approvals", "enable");
});

// ---------- Site Health: Problems, a Fix and the Checklist ----------

const HEALTH = "/_emdash/admin/plugins/site-health/health";

test("Site Health", async ({ browser }) => {
	test.setTimeout(400_000);
	// A real first check, so everything the page keeps exists; then wait for it to finish.
	const { context: first, page } = await open(browser, HEALTH, { width: 1280, height: 900 }, 1);
	await expect(page.getByRole("tab", { name: "Problems" })).toBeVisible({ timeout: 120_000 });
	const KV = "plugin_id = 'site-health' and collection = '__kv'";
	await expect
		.poll(
			async () => {
				const refresh = page.getByRole("button", { name: "Refresh" });
				if (await refresh.isVisible()) await refresh.click();
				await page.waitForTimeout(1000);
				return sql(
					`select json_extract(data, '$.status') from _plugin_storage where ${KV} and id = 'scan'`,
				);
			},
			{ timeout: 180_000, intervals: [1000] },
		)
		.toBe("done");
	await first.close();

	// What a public bakery site's check finds (see the plugin's src/state.ts, Summary).
	const now = Date.now();
	const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
	const summary = JSON.parse(
		sql(`select data from _plugin_storage where ${KV} and id = 'summary'`),
	) as { pass: number };
	const row = (id: string, fields: Record<string, unknown>) => ({
		id,
		sources: [],
		count: 1,
		menu: false,
		editor: true,
		...fields,
	});
	const home = { t: "Home", p: "/", c: "pages", id: ids.home };
	const value = {
		pass: summary.pass,
		finishedAt: ago(41),
		prevFinishedAt: ago(41 + 24 * 60),
		pages: 42,
		links: 318,
		fix: { site: 1, page: 2, link: 2 },
		editorFix: 3,
		look: 3,
		unknown: 4,
		live: "ok",
		rows: {
			site: [
				row("shot-site-1", {
					kind: "internal",
					url: "/menu-2024",
					reason: "missing",
					sources: [{ t: "Site menu", p: "/", menu: true }, home, { t: "Menu", p: "/menu" }],
					count: 3,
					menu: true,
					editor: false,
					since: ago(50),
				}),
			],
			page: [
				row("shot-page-1", {
					kind: "page",
					url: "/gallery",
					reason: "page-error",
					editor: false,
					since: ago(50),
				}),
				row("shot-page-2", {
					kind: "insecure",
					url: "http://maps.example/embed?q=harbour",
					reason: "insecure-active",
					sources: [{ t: "Contact", p: "/contact", c: "pages", id: ids.contact }],
					since: ago(9 * 24 * 60),
				}),
			],
			link: [
				row("shot-link-1", {
					kind: "external",
					url: "https://flourmill-supplies.example/rye",
					reason: "gone",
					sources: [{ t: "Our sourdough starter", p: "/posts/our-sourdough-starter" }],
					since: ago(11 * 24 * 60),
				}),
				row("shot-link-2", {
					kind: "internal",
					url: "/christmas-orders",
					reason: "draft",
					sources: [home],
					since: ago(3 * 24 * 60),
				}),
			],
		},
		lookRows: [
			row("shot-look-1", {
				kind: "internal",
				url: "/about-us",
				reason: "redirect",
				detail: "/contact",
				sources: [home],
			}),
			row("shot-look-2", {
				kind: "external",
				url: "http://whitby-tourism.example/",
				reason: "moved",
				detail: "https://whitby-tourism.example/",
				sources: [{ t: "Contact", p: "/contact" }],
			}),
			row("shot-look-3", {
				kind: "insecure",
				url: "http://images.example/harbour.jpg",
				reason: "insecure-image",
				sources: [home],
			}),
		],
		unknownRows: [
			row("shot-unknown-1", {
				kind: "external",
				url: "https://www.instagram.com/harbourstreetbakery",
				reason: "refuses",
				sources: [home],
			}),
			row("shot-unknown-2", {
				kind: "external",
				url: "https://www.facebook.com/harbourstreetbakery",
				reason: "refuses",
				sources: [home],
			}),
			row("shot-unknown-3", {
				kind: "external",
				url: "https://booking.example/harbour",
				reason: "timeout",
				sources: [{ t: "Contact", p: "/contact" }],
			}),
			row("shot-unknown-4", {
				kind: "external",
				url: "https://maps.example/harbour-street",
				reason: "trouble",
				sources: [{ t: "Contact", p: "/contact" }],
			}),
		],
	};
	const write = (id: string, data: unknown) =>
		sql(
			`update _plugin_storage set data = '${JSON.stringify(data).replace(/'/g, "''")}' where ${KV} and id = '${id}'`,
		);
	write("summary", value);
	// The rows a public site gets from opening its own addresses (see the plugin's src/checklist.ts).
	const checklist = JSON.parse(
		sql(`select data from _plugin_storage where ${KV} and id = 'checklist'`) || "{}",
	) as { rows?: Record<string, unknown> };
	expect(checklist.rows, "Site Health has not stored its Checklist yet").toBeTruthy();
	write("checklist", {
		checkedAt: ago(41),
		rows: {
			...checklist.rows,
			caching: {
				status: "working",
				text: "Pages can be kept ready for visitors instead of built on every visit.",
			},
			secure: { status: "working", text: "The insecure address sends visitors to the secure one." },
			www: {
				status: "attention",
				text: "The address without www does not answer. Point it at your site so it sends visitors on.",
			},
			missing: {
				status: "working",
				text: 'An address that does not exist shows your "page not found" page and tells search engines it is missing.',
			},
			search: {
				status: "working",
				text: "They are allowed in, and the list of your pages for them answers.",
			},
		},
	});

	const out = `${PACKAGES}/plugin-site-health/images`;
	for (const [width, suffix, min] of [
		[1280, "", 900],
		[390, "-phone", 844],
	] as const) {
		const { context, page } = await open(browser, HEALTH, { width, height: min }, 2);
		await expect(page.getByText("Pages checked").first()).toBeVisible({ timeout: 120_000 });
		await expect(page.getByText("/menu-2024 goes to a page that does not exist.")).toBeVisible();
		await fullShot(page, `${out}/problems-${VERSION.siteHealth}${suffix}.png`, width, min);

		await page.setViewportSize({ width, height: min });
		await page
			.getByRole("row", { name: /\/menu-2024 goes to a page that does not exist/ })
			.getByRole("button", { name: "Fix" })
			.click();
		await page.getByRole("menuitem", { name: "Send visitors to another page" }).click();
		await expect(page.getByRole("textbox", { name: "Old address" })).toHaveValue("/menu-2024");
		await page.mouse.move(0, 0);
		await fullShot(page, `${out}/fix-${VERSION.siteHealth}${suffix}.png`, width, min);

		await page.setViewportSize({ width, height: min });
		await page.goto(HEALTH);
		await page.getByRole("tab", { name: "Checklist" }).click();
		await expect(page.getByText("1 thing needs attention")).toBeVisible({ timeout: 60_000 });
		await fullShot(page, `${out}/checklist-${VERSION.siteHealth}${suffix}.png`, width, min);
		await context.close();
	}
});

// ---------- Popups: the list with four popups, one with sign-ups, and a new popup ----------

const FORMS = `${API}/plugins/emdash-forms`;
const POPUPS = `${API}/plugins/popups/admin`;

test("Popups", async ({ browser }) => {
	test.setTimeout(400_000);
	await ok(
		admin.post(`${FORMS}/forms/create`, {
			headers: H,
			data: {
				name: "Newsletter",
				slug: "newsletter",
				pages: [
					{
						fields: [
							{ id: "email", type: "email", label: "Email address", name: "email", required: true },
							{ id: "first", type: "text", label: "First name", name: "first", required: false },
						],
					},
				],
				settings: {
					spamProtection: "honeypot",
					confirmationMessage: "Your first letter arrives at the start of next month.",
					submitLabel: "Join the list",
				},
			},
		}),
	);
	type Step = Record<string, unknown>;
	async function make(popup: { name: string; kind: string; s2: Step; s3?: Step; s4?: Step }) {
		const step1 = await ok(
			admin.post(POPUPS, {
				headers: H,
				data: {
					type: "form_submit",
					action_id: "save_s1",
					block_id: "s1:new:x",
					values: { name: popup.name, kind: popup.kind },
				},
			}),
		);
		const id = [
			...JSON.stringify(step1.data.blocks).matchAll(/"block_id":"s2:([a-z0-9]+):/g),
		][0]![1]!;
		const step = async (action: string, values: Step) => {
			const res = await ok(
				admin.post(POPUPS, {
					headers: H,
					data: {
						type: "form_submit",
						action_id: action,
						block_id: `${action.slice(5)}:${id}:x`,
						values,
					},
				}),
			);
			expect(res.data.toast?.type, `${popup.name} ${action}: ${res.data.toast?.message}`).not.toBe(
				"error",
			);
		};
		await step("save_s2", popup.s2);
		if (popup.kind !== "inline")
			await step("save_s3", {
				where: "all",
				exclude: "",
				devices: "all",
				again: "month",
				...popup.s3,
			});
		await step("save_s4", { on: true, ...popup.s4 });
	}
	await make({
		name: "Monthly letter",
		kind: "modal",
		s2: {
			heading: "Fresh from the oven, once a month",
			text: "New breads, the cake of the month and the odd recipe. One email at the start of each month.",
			picture: "none",
			contains: "form",
			form: "newsletter",
			thanks: "Thanks, you're on the list",
			decline: "no-thanks",
		},
		s3: { first_page: true },
	});
	// Four visitors who never signed in sign up (before the others exist: one popup per visit).
	for (const email of [
		"ana@example.com",
		"ben@example.com",
		"cara@example.com",
		"dan@example.com",
	]) {
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		const page = await context.newPage();
		await page.goto("/popups-test");
		await page.mouse.wheel(0, 4000);
		const dialog = page.getByRole("dialog", { name: "Fresh from the oven, once a month" });
		await expect(dialog).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(1500);
		await page.keyboard.type(email);
		await dialog.getByRole("button", { name: "Join the list" }).click();
		await expect(page.getByRole("dialog", { name: "Thanks, you're on the list" })).toBeVisible();
		await page.waitForTimeout(1000);
		await context.close();
	}
	await make({
		name: "Christmas cakes",
		kind: "slide",
		s2: {
			heading: "Christmas cakes: order by 1 December",
			text: "Rich fruit or chocolate.",
			picture: "none",
			contains: "button",
			button_label: "Order a cake",
			button_url: "/pricing",
			decline: "no-thanks",
		},
		s4: { end_date: "2026-12-24", end_time: "18:00" },
	});
	await make({
		name: "Boxing Day hours",
		kind: "bar",
		s2: {
			heading: "Open on Boxing Day, 10:00 to 14:00.",
			text: "",
			button_label: "See all opening hours",
			button_url: "/contact",
		},
		s4: { end_date: "2026-12-27", end_time: "14:00" },
	});
	await make({
		name: "Letter box",
		kind: "inline",
		s2: {
			heading: "Get the Journal by email",
			text: "One letter a month: new breads, the cake of the month and the odd recipe like this one.",
			picture: "none",
			contains: "form",
			form: "newsletter",
			thanks: "Thanks",
		},
	});

	const out = `${PACKAGES}/plugin-popups/images`;
	const LIST = "/_emdash/admin/plugins/popups/";
	// The README's pictures: the whole window, at its own size, light and dark.
	for (const [device, viewport] of [
		["desktop", { width: 1280, height: 1100 }],
		["phone", { width: 390, height: 1600 }],
	] as const)
		for (const scheme of ["light", "dark"] as const) {
			const { context, page } = await open(browser, LIST, viewport, 1, scheme);
			await expect(page.getByText("Letter box").first()).toBeVisible({ timeout: 120_000 });
			await expect(helpLinks(page)).toHaveCount(3);
			await page.waitForTimeout(800);
			await shot(page, `${out}/admin-list-${VERSION.popups}-${device}-${scheme}.png`);
			await page.getByRole("button", { name: "New popup" }).first().click();
			await expect(page.getByRole("heading", { name: "New popup" })).toBeVisible();
			await expect(helpLinks(page)).toHaveCount(3);
			await page.waitForTimeout(800);
			await shot(page, `${out}/admin-new-popup-${VERSION.popups}-${device}-${scheme}.png`);
			await context.close();
		}
	// The website's crop of the list: twice the size, as tall as its content.
	for (const [width, suffix, min] of [
		[1280, "", 900],
		[390, "-phone", 844],
	] as const) {
		const { context, page } = await open(browser, LIST, { width, height: min }, 2);
		await expect(page.getByText("Letter box").first()).toBeVisible({ timeout: 120_000 });
		await fullShot(page, `${RETAKES}/popups-list${suffix}.png`, width, min);
		await context.close();
	}
});

// ---------- Content Approval: Settings before the first save, for the website's crop ----------

test("Content Approval settings, for the website", async ({ browser }) => {
	test.setTimeout(300_000);
	const stops: Record<string, number> = {};
	for (const [width, suffix, min] of [
		[1280, "", 900],
		[390, "-phone", 844],
	] as const) {
		const { context, page } = await open(
			browser,
			"/_emdash/admin/plugins/approvals/overview",
			{ width, height: min },
			2,
		);
		await expect(page.getByText("Approval is off until you save these settings")).toBeVisible({
			timeout: 120_000,
		});
		await page.getByRole("checkbox", { name: "Pages" }).check();
		await page.mouse.move(0, 0);
		await fullShot(page, `${RETAKES}/approvals-settings${suffix}.png`, width, min);
		// Where the crop stops: just above "What approval can't hold", in CSS px below the top bar.
		const box = await page.getByRole("heading", { name: "What approval can't hold" }).boundingBox();
		stops[`approvals-settings${suffix}.png`] = Math.round((box?.y ?? 0) - 58 - 24);
		await context.close();
	}
	writeFileSync(`${RETAKES}/stops.json`, `${JSON.stringify(stops, null, "\t")}\n`);
});
