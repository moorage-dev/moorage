// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import {
	expect,
	test,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Page,
} from "@playwright/test";

/**
 * Analytics & Cookie Consent, in a real browser.
 *
 * Visitors use the plain `page` fixture, which has never signed in: a browser
 * that has opened the admin counts as staff and is never tracked. Settings are
 * changed through a second, signed-in context.
 *
 * Nothing here talks to a real tracking company. Every request to their hosts
 * is answered locally with an empty script and written down in `hits`.
 *
 * The visitor's country is forced by answering the plugin's own `geo` route:
 * `inCountry(page, "DE")`. The time zone is pinned to a non-European one, so a
 * test that forgets to set a country fails loudly instead of passing by luck.
 */

const API = "/_emdash/api/plugins/analytics-consent";
const ADMIN_PAGE =
	"/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/analytics-consent/settings";

const VENDOR_HOSTS = [
	"googletagmanager.com",
	"google-analytics.com",
	"connect.facebook.net",
	"facebook.com",
	"clarity.ms",
	"hs-scripts.com",
	"hs-analytics.net",
	"static.cloudflareinsights.com",
];

const IDS = {
	ga4: "G-TEST123456",
	ads: "AW-123456789",
	meta: "123456789012345",
	clarity: "ab12cd34ef",
	hubspot: "12345678",
};
const NO_TOOLS = { ga4: "", gtm: "", ads: "", meta: "", clarity: "", hubspot: "", cloudflare: "" };
const CLOUDFLARE_TOKEN = "0123456789abcdef0123456789abcdef";

test.use({ timezoneId: "America/Chicago" });

let adminContext: BrowserContext;
let admin: APIRequestContext;

async function signIn(browser: Browser): Promise<void> {
	adminContext = await browser.newContext();
	const page = await adminContext.newPage();
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
	await page.close();
	admin = adminContext.request;
}

/** Submit one of the admin page's forms, exactly as the admin does. */
async function save(action: string, values: Record<string, unknown>): Promise<string> {
	const response = await admin.post(`${API}/admin`, {
		headers: { "X-EmDash-Request": "1" },
		data: { type: "form_submit", action_id: action, values },
	});
	expect(response.status()).toBe(200);
	const body = (await response.json()) as { data: { toast?: { type: string; message: string } } };
	expect(body.data.toast?.type, body.data.toast?.message).toBe("success");
	return JSON.stringify(body.data);
}

async function configure(
	tools: Record<string, unknown>,
	banner: Record<string, unknown> = {},
	advanced: Record<string, unknown> = {},
): Promise<void> {
	await save("save_tools", {
		...NO_TOOLS,
		hubspot_eu: false,
		cloudflare_wait: false,
		enquiries: true,
		...tools,
	});
	await save("save_banner", {
		audience: "europe",
		policy_url: "/privacy",
		position: "bar",
		scheme: "auto",
		settings_button: true,
		months: "6",
		...banner,
	});
	await save("save_advanced", { exclude: "", gtm_loading: "choice", ...advanced });
}

function isVendor(url: URL): boolean {
	return VENDOR_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/** Answer every tracking host locally and return the list of what was asked for. */
async function stubVendors(context: BrowserContext): Promise<string[]> {
	const hits: string[] = [];
	await context.route(isVendor, async (route) => {
		hits.push(route.request().url());
		await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
	});
	return hits;
}

/** Force the visitor's country, as Cloudflare would report it. `null` means unknown. */
async function inCountry(page: Page, country: string | null): Promise<void> {
	await page.route(`**${API}/geo`, async (route) => {
		await route.fulfill({ json: { success: true, data: { country } } });
	});
}

const banner = (page: Page) => page.getByRole("region", { name: "Cookies on this site" });
const panel = (page: Page) => page.getByRole("dialog", { name: "Your cookie choices" });
const settingsButton = (page: Page) => page.getByRole("button", { name: "Cookie settings" });

/** Everything pushed to the data layer, with gtag's argument lists turned into arrays. */
async function dataLayer(page: Page): Promise<unknown[]> {
	return page.evaluate(() =>
		((window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []).map((entry) =>
			Object.prototype.toString.call(entry) === "[object Arguments]"
				? Array.from(entry as ArrayLike<unknown>)
				: entry,
		),
	);
}

/** Wait until the page has stopped asking for things, so "no request" means something. */
async function settle(page: Page): Promise<void> {
	await page.waitForLoadState("networkidle");
	await page.waitForTimeout(300);
}

test.beforeAll(async ({ browser }) => {
	await signIn(browser);
});

test.afterAll(async () => {
	// Leave the shared test site with tracking off for the other test files.
	await configure({});
	await adminContext.close();
});

test.describe("a visitor who must be asked", () => {
	test.beforeAll(async () => {
		await configure(IDS);
	});

	test("nothing is requested before an answer, and Accept all loads every tool", async ({
		page,
		context,
	}) => {
		const hits = await stubVendors(context);
		await inCountry(page, "DE");
		await page.goto("/");
		await expect(banner(page)).toBeVisible();
		await settle(page);
		expect(hits).toEqual([]);
		expect(await context.cookies()).toEqual([]);

		// The three answers look the same: no answer is favoured.
		const buttons = banner(page).getByRole("button");
		await expect(buttons).toHaveText(["Accept all", "Reject all", "Choose"]);
		const styles = await buttons.evaluateAll((all) =>
			all.map((button) => {
				const style = getComputedStyle(button);
				return [
					style.backgroundColor,
					style.color,
					style.fontWeight,
					style.fontSize,
					style.borderColor,
				];
			}),
		);
		expect(styles[1]).toEqual(styles[0]);
		expect(styles[2]).toEqual(styles[0]);
		await expect(
			banner(page).getByRole("link", { name: "Read our privacy policy" }),
		).toHaveAttribute("href", "/privacy");

		await banner(page).getByRole("button", { name: "Accept all" }).click();
		await expect(banner(page)).toBeHidden();
		await expect
			.poll(() => hits)
			.toEqual(
				expect.arrayContaining([
					`https://www.googletagmanager.com/gtag/js?id=${IDS.ga4}`,
					"https://connect.facebook.net/en_US/fbevents.js",
					`https://www.clarity.ms/tag/${IDS.clarity}`,
					`https://js.hs-scripts.com/${IDS.hubspot}.js`,
				]),
			);
		const layer = await dataLayer(page);
		expect(layer).toContainEqual([
			"consent",
			"default",
			{
				ad_storage: "denied",
				ad_user_data: "denied",
				ad_personalization: "denied",
				analytics_storage: "denied",
			},
		]);
		expect(layer).toContainEqual([
			"consent",
			"update",
			{
				ad_storage: "granted",
				ad_user_data: "granted",
				ad_personalization: "granted",
				analytics_storage: "granted",
			},
		]);
		expect(layer).toContainEqual({
			event: "cookie_consent_update",
			analytics: true,
			marketing: true,
		});
		expect(layer).toContainEqual(["config", IDS.ga4]);
		expect(layer).toContainEqual(["config", IDS.ads]);

		// The answer is remembered: the next page loads the tools without asking.
		hits.length = 0;
		await page.goto("/pricing");
		await expect(settingsButton(page)).toBeVisible();
		await expect(banner(page)).toBeHidden();
		await expect.poll(() => hits.some((url) => url.includes("gtag/js"))).toBe(true);
		const [cookie] = (await context.cookies()).filter((entry) => entry.name === "cookie_consent");
		expect(cookie?.value).toMatch(/^[a-z0-9]+\.11\.\d+\.[a-z0-9]+$/);
		// About six months.
		const days = ((cookie?.expires ?? 0) - Date.now() / 1000) / 86_400;
		expect(days).toBeGreaterThan(180);
		expect(days).toBeLessThan(185);
	});

	test("Reject all loads nothing, now or on later pages", async ({ page, context }) => {
		const hits = await stubVendors(context);
		await inCountry(page, "FR");
		await page.goto("/");
		await banner(page).getByRole("button", { name: "Reject all" }).click();
		await expect(banner(page)).toBeHidden();
		await settle(page);
		expect(hits).toEqual([]);
		expect(await dataLayer(page)).toContainEqual({
			event: "cookie_consent_update",
			analytics: false,
			marketing: false,
		});

		await page.goto("/pricing");
		await expect(settingsButton(page)).toBeVisible();
		await expect(banner(page)).toBeHidden();
		await settle(page);
		await page.reload();
		await settle(page);
		expect(hits).toEqual([]);
	});

	test("Cookie settings reopens the panel, and taking consent back stops the tools", async ({
		page,
		context,
	}) => {
		const hits = await stubVendors(context);
		await inCountry(page, "GB");
		await page.goto("/");
		await banner(page).getByRole("button", { name: "Accept all" }).click();
		await expect.poll(() => hits.length).toBeGreaterThan(0);
		// A cookie a tracking tool would have set.
		await page.evaluate(() => {
			document.cookie = "_ga=GA1.1.1.1;path=/";
			document.cookie = "_fbp=fb.1.1.1;path=/";
		});

		await settingsButton(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page).getByRole("checkbox", { name: "Analytics" })).toBeChecked();
		await expect(panel(page).getByRole("checkbox", { name: "Marketing" })).toBeChecked();
		await expect(panel(page).getByRole("checkbox", { name: "Necessary" })).toBeDisabled();
		// The tools in use are listed under the kind of cookie they belong to.
		await expect(panel(page)).toContainText("Used by: Google Analytics, Microsoft Clarity.");
		await expect(panel(page)).toContainText("Used by: Google Ads, Meta Pixel, HubSpot.");

		hits.length = 0;
		const reloaded = page.waitForEvent("load");
		await panel(page).getByRole("button", { name: "Reject all" }).click();
		await reloaded;
		await expect(settingsButton(page)).toBeVisible();
		await settle(page);
		expect(hits).toEqual([]);
		const names = (await context.cookies()).map((cookie) => cookie.name);
		expect(names).toContain("cookie_consent");
		expect(names).not.toContain("_ga");
		expect(names).not.toContain("_fbp");

		// Any link or button the theme marks with data-cookie-settings opens the panel too.
		await page.evaluate(() => {
			const link = document.createElement("a");
			link.href = "#";
			link.textContent = "Change cookie choices";
			link.setAttribute("data-cookie-settings", "");
			document.querySelector("footer")?.append(link);
		});
		await page.getByRole("link", { name: "Change cookie choices" }).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page).getByRole("checkbox", { name: "Analytics" })).not.toBeChecked();
	});

	test("the banner works from the keyboard, with a visible focus ring", async ({
		page,
		context,
	}) => {
		const hits = await stubVendors(context);
		await inCountry(page, "IE");
		await page.goto("/");
		await expect(banner(page)).toBeVisible();

		// The banner is the first thing Tab reaches: its policy link, then the three answers.
		await page.keyboard.press("Tab");
		await expect(banner(page).getByRole("link", { name: "Read our privacy policy" })).toBeFocused();
		await page.keyboard.press("Tab");
		const accept = banner(page).getByRole("button", { name: "Accept all" });
		await expect(accept).toBeFocused();
		const ring = await accept.evaluate((button) => {
			const style = getComputedStyle(button);
			return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
		});
		expect(ring.style).toBe("solid");
		expect(ring.width).toBeGreaterThanOrEqual(2);

		await page.keyboard.press("Tab");
		await expect(banner(page).getByRole("button", { name: "Reject all" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(banner(page).getByRole("button", { name: "Choose" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(panel(page)).toBeVisible();

		// Escape closes the panel without an answer, and the banner is still there.
		await page.keyboard.press("Escape");
		await expect(panel(page)).toBeHidden();
		await expect(banner(page)).toBeVisible();
		await expect(banner(page).getByRole("button", { name: "Choose" })).toBeFocused();
		await page.keyboard.press("Enter");

		// Nothing is ticked in advance. Tick Analytics only, with the keyboard.
		const analytics = panel(page).getByRole("checkbox", { name: "Analytics" });
		const marketing = panel(page).getByRole("checkbox", { name: "Marketing" });
		await expect(analytics).not.toBeChecked();
		await expect(marketing).not.toBeChecked();
		await expect(analytics).toBeFocused();
		await page.keyboard.press("Space");
		await expect(analytics).toBeChecked();
		await page.keyboard.press("Tab");
		await expect(marketing).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(panel(page).getByRole("button", { name: "Save my choices" })).toBeFocused();
		await page.keyboard.press("Enter");

		await expect(panel(page)).toBeHidden();
		await expect(banner(page)).toBeHidden();
		await expect.poll(() => hits.some((url) => url.includes(`gtag/js?id=${IDS.ga4}`))).toBe(true);
		await settle(page);
		// Analytics only: nothing from the marketing tools.
		expect(hits.filter((url) => /facebook|hs-scripts/.test(url))).toEqual([]);
		expect(await dataLayer(page)).not.toContainEqual(["config", IDS.ads]);
		const [cookie] = (await context.cookies()).filter((entry) => entry.name === "cookie_consent");
		expect(cookie?.value).toMatch(/\.10\./);
	});

	test("an unknown country falls back to the time zone, and unknown means ask", async ({
		browser,
	}) => {
		for (const [timezoneId, asked] of [
			["Europe/Berlin", true],
			["America/Chicago", false],
		] as const) {
			const context = await browser.newContext({ timezoneId });
			const hits = await stubVendors(context);
			const page = await context.newPage();
			await inCountry(page, null);
			await page.goto("/");
			if (asked) {
				await expect(banner(page)).toBeVisible();
				await settle(page);
				expect(hits).toEqual([]);
			} else {
				await expect(settingsButton(page)).toBeVisible();
				await expect(banner(page)).toBeHidden();
				await expect.poll(() => hits.length).toBeGreaterThan(0);
			}
			await context.close();
		}
	});
});

test.describe("a visitor who is not asked", () => {
	test.beforeAll(async () => {
		await configure(IDS);
	});

	test("tools load without a banner outside Europe, and can still be turned off", async ({
		page,
		context,
	}) => {
		const hits = await stubVendors(context);
		await inCountry(page, "US");
		await page.goto("/");
		await expect(settingsButton(page)).toBeVisible();
		await expect(banner(page)).toBeHidden();
		await expect
			.poll(() => hits)
			.toEqual(
				expect.arrayContaining([
					`https://www.googletagmanager.com/gtag/js?id=${IDS.ga4}`,
					"https://connect.facebook.net/en_US/fbevents.js",
				]),
			);

		hits.length = 0;
		await settingsButton(page).click();
		const reloaded = page.waitForEvent("load");
		await panel(page).getByRole("button", { name: "Reject all" }).click();
		await reloaded;
		await expect(settingsButton(page)).toBeVisible();
		await settle(page);
		expect(hits).toEqual([]);
	});

	test("Global Privacy Control keeps Marketing off", async ({ page, context }) => {
		await context.addInitScript(() => {
			Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true });
		});
		const hits = await stubVendors(context);
		await inCountry(page, "US");
		await page.goto("/");
		await expect.poll(() => hits.some((url) => url.includes("gtag/js"))).toBe(true);
		await settle(page);
		expect(hits.filter((url) => /facebook|hs-scripts/.test(url))).toEqual([]);

		await settingsButton(page).click();
		await expect(panel(page).getByRole("checkbox", { name: "Marketing" })).toBeDisabled();
		await expect(panel(page)).toContainText("Global Privacy Control");
	});

	test('"Everyone" asks outside Europe too, and "No one" never shows a banner', async ({
		page,
		context,
	}) => {
		const hits = await stubVendors(context);
		await inCountry(page, "US");
		await save("save_banner", { audience: "everyone" });
		await page.goto("/");
		await expect(banner(page)).toBeVisible();
		await settle(page);
		expect(hits).toEqual([]);

		await save("save_banner", { audience: "none" });
		await inCountry(page, "DE");
		await page.goto("/");
		await expect.poll(() => hits.some((url) => url.includes("gtag/js"))).toBe(true);
		await expect(page.locator("#cookie-consent")).toHaveCount(0);
		await save("save_banner", { audience: "europe" });
	});
});

test.describe("tools with their own rules", () => {
	test("Cloudflare Web Analytics starts without asking unless told to wait", async ({
		page,
		context,
	}) => {
		await configure({ cloudflare: CLOUDFLARE_TOKEN, ga4: IDS.ga4 });
		const hits = await stubVendors(context);
		await inCountry(page, "DE");
		await page.goto("/");
		await expect(banner(page)).toBeVisible();
		await expect.poll(() => hits).toEqual(["https://static.cloudflareinsights.com/beacon.min.js"]);
		await expect(page.locator("script[data-cf-beacon]")).toHaveAttribute(
			"data-cf-beacon",
			JSON.stringify({ token: CLOUDFLARE_TOKEN }),
		);

		await save("save_tools", { cloudflare_wait: true });
		hits.length = 0;
		await page.goto("/");
		await expect(banner(page)).toBeVisible();
		await settle(page);
		expect(hits).toEqual([]);
		await banner(page).getByRole("button", { name: "Accept all" }).click();
		await expect.poll(() => hits.some((url) => url.includes("cloudflareinsights"))).toBe(true);
	});

	test("Cloudflare Web Analytics alone needs no banner at all", async ({ page, context }) => {
		await configure({ cloudflare: CLOUDFLARE_TOKEN });
		const hits = await stubVendors(context);
		await inCountry(page, "DE");
		await page.goto("/");
		await expect.poll(() => hits.length).toBe(1);
		await expect(page.locator("#cookie-consent")).toHaveCount(0);
		expect(await context.cookies()).toEqual([]);
	});

	test("Google Tag Manager waits for an answer, then gets it in the data layer", async ({
		page,
		context,
	}) => {
		await configure({ gtm: "GTM-TEST123" });
		const hits = await stubVendors(context);
		await inCountry(page, "DE");
		await page.goto("/");
		await expect(banner(page)).toBeVisible();
		await settle(page);
		expect(hits).toEqual([]);

		await banner(page).getByRole("button", { name: "Accept all" }).click();
		await expect
			.poll(() => hits)
			.toEqual(["https://www.googletagmanager.com/gtm.js?id=GTM-TEST123"]);
		const layer = await dataLayer(page);
		const names = layer.map((entry) =>
			Array.isArray(entry) ? entry.slice(0, 2).join(" ") : (entry as { event?: string }).event,
		);
		// The answer is in the data layer before the container starts.
		expect(names).toEqual(["consent default", "consent update", "cookie_consent_update", "gtm.js"]);
	});

	test("a changed list of tools asks again", async ({ page, context }) => {
		await configure({ ga4: IDS.ga4 });
		const hits = await stubVendors(context);
		await inCountry(page, "DE");
		await page.goto("/");
		await banner(page).getByRole("button", { name: "Accept all" }).click();
		await expect(banner(page)).toBeHidden();

		await save("save_tools", { meta: IDS.meta });
		hits.length = 0;
		await page.goto("/");
		await expect(banner(page)).toBeVisible();
		await settle(page);
		expect(hits).toEqual([]);
	});
});

test.describe("pages and people that are never tracked", () => {
	test.beforeAll(async () => {
		await configure(IDS, {}, { exclude: "/pricing" });
	});

	// The script is the only thing the plugin adds; this text is inside it.
	const MARK = "cookie_consent_update";

	test("nothing is added to the admin, preview links, edit mode or excluded pages", async ({
		page,
		browser,
	}) => {
		const html = async (path: string) => (await page.request.get(path)).text();
		expect(await html("/")).toContain(MARK);
		expect(await html("/contact")).toContain(MARK);
		expect(await html("/?_preview=anything")).not.toContain(MARK);
		expect(await html("/pricing")).not.toContain(MARK);
		expect(await html("/_emdash/admin")).not.toContain(MARK);
		expect(await html("/_emdash/admin/login")).not.toContain(MARK);

		// An editor in the visual editor: the server leaves the script out.
		const editor = await browser.newContext({ storageState: await adminContext.storageState() });
		expect(await (await editor.request.get("/")).text()).toContain(MARK);
		await editor.addCookies([
			{ name: "emdash-edit-mode", value: "true", url: test.info().project.use.baseURL },
		]);
		expect(await (await editor.request.get("/")).text()).not.toContain(MARK);
		await editor.close();
	});

	test("a signed-in editor sees the banner but is not tracked", async ({ browser }) => {
		const editor = await browser.newContext({
			storageState: await adminContext.storageState(),
			timezoneId: "America/Chicago",
		});
		const hits = await stubVendors(editor);
		const page = await editor.newPage();
		await inCountry(page, "DE");
		await page.goto("/");
		await expect(page.locator("#emdash-toolbar")).toHaveCount(1);
		await banner(page).getByRole("button", { name: "Accept all" }).click();
		await expect(banner(page)).toBeHidden();
		await settle(page);
		expect(hits).toEqual([]);
		await editor.close();
	});

	test("a browser page never contacts a tracking host on its own", async ({ page, context }) => {
		// The whole public site, before any answer: one check across every page.
		const hits = await stubVendors(context);
		await inCountry(page, "DE");
		for (const path of ["/", "/pricing", "/contact", "/lead-test", "/?_preview=anything"]) {
			await page.goto(path);
			await settle(page);
		}
		expect(hits).toEqual([]);
	});
});

test.describe("enquiries", () => {
	test.beforeAll(async () => {
		await configure({ ga4: IDS.ga4, meta: IDS.meta });
		const response = await admin.post("/_emdash/api/plugins/emdash-forms/forms/create", {
			headers: { "X-EmDash-Request": "1" },
			data: {
				name: "Lead test",
				slug: "lead-test",
				pages: [
					{
						fields: [
							{ id: "name", type: "text", label: "Your name", name: "name", required: true },
							{ id: "email", type: "email", label: "Email", name: "email", required: true },
						],
					},
				],
				settings: { spamProtection: "none", confirmationMessage: "Thanks, we will be in touch." },
			},
		});
		// 409 when a retry runs against the same database: the form is already there.
		expect([200, 409]).toContain(response.status());
	});

	test("a click on a phone or email link is counted, without the number or address", async ({
		page,
		context,
	}) => {
		const hits = await stubVendors(context);
		await inCountry(page, "DE");
		await page.goto("/contact");
		// Email links would open a mail program; the click is still seen first.
		await page.evaluate(() => {
			document.addEventListener("click", (event) => event.preventDefault());
		});

		// Before an answer: noted on the page, sent to no one.
		await page.getByRole("link", { name: /hello@acme\.example/ }).click();
		expect(await dataLayer(page)).toContainEqual({ event: "enquiry", enquiry_type: "email" });
		expect(hits).toEqual([]);

		await banner(page).getByRole("button", { name: "Accept all" }).click();
		await expect.poll(() => hits.length).toBeGreaterThan(0);
		await page.getByRole("link", { name: /sales@acme\.example/ }).click();
		const layer = await dataLayer(page);
		expect(layer).toContainEqual(["event", "generate_lead", { lead_source: "email" }]);
		expect(JSON.stringify(layer)).not.toContain("acme.example");

		await page.goto("/lead-test");
		await page.evaluate(() => {
			document.addEventListener("click", (event) => event.preventDefault());
		});
		await page.getByRole("link", { name: "Call us" }).click();
		const after = await dataLayer(page);
		expect(after).toContainEqual({ event: "enquiry", enquiry_type: "phone" });
		expect(after).toContainEqual(["event", "generate_lead", { lead_source: "phone" }]);
		expect(JSON.stringify(after)).not.toContain("5550100");
	});

	test("a form sent through the forms plugin is counted as a lead, once", async ({
		page,
		context,
	}) => {
		const hits = await stubVendors(context);
		await inCountry(page, "DE");
		await page.goto("/lead-test");
		await banner(page).getByRole("button", { name: "Accept all" }).click();
		await expect.poll(() => hits.length).toBeGreaterThan(0);

		// A refused form is not a lead.
		await page.getByRole("button", { name: "Submit" }).click();
		await page.waitForTimeout(300);
		expect(await dataLayer(page)).not.toContainEqual({ event: "enquiry", enquiry_type: "form" });

		await page.getByLabel("Your name").fill("Ada Lovelace");
		await page.getByLabel("Email").fill("ada@example.com");
		await page.getByRole("button", { name: "Submit" }).click();
		await expect(page.getByText("Thanks, we will be in touch.")).toBeVisible();

		const layer = await dataLayer(page);
		const leads = layer.filter(
			(entry) => (entry as { enquiry_type?: string }).enquiry_type === "form",
		);
		expect(leads).toEqual([{ event: "enquiry", enquiry_type: "form" }]);
		expect(layer).toContainEqual(["event", "generate_lead", { lead_source: "form" }]);
		// Meta's queue holds the Lead event until its script (stubbed here) picks it up.
		const pixel = await page.evaluate(() =>
			(window as unknown as { fbq: { queue: ArrayLike<unknown>[] } }).fbq.queue.map((call) =>
				Array.from(call),
			),
		);
		expect(pixel).toContainEqual(["track", "Lead"]);
		// What was typed never leaves the form.
		expect(JSON.stringify([layer, pixel])).not.toMatch(/Ada|example\.com/);
	});

	test("turning the setting off stops counting", async ({ page, context }) => {
		await save("save_tools", { enquiries: false });
		await stubVendors(context);
		await inCountry(page, "US");
		await page.goto("/lead-test");
		await page.evaluate(() => {
			document.addEventListener("click", (event) => event.preventDefault());
		});
		await page.getByRole("link", { name: "Call us" }).click();
		expect(JSON.stringify(await dataLayer(page))).not.toContain("enquiry");
		await save("save_tools", { enquiries: true });
	});
});

test.describe("the consent record and the admin page", () => {
	test("each answer is recorded without personal details and counted on the Status tab", async ({
		page,
		context,
	}) => {
		await configure({ ga4: IDS.ga4, clarity: IDS.clarity });
		await stubVendors(context);
		await inCountry(page, "DE");
		await page.goto("/");
		const recorded = page.waitForRequest((request) => request.url().endsWith(`${API}/record`));
		await banner(page).getByRole("button", { name: "Reject all" }).click();
		const request = await recorded;
		expect(request.method()).toBe("POST");
		expect(JSON.parse(request.postData() ?? "{}")).toEqual({
			id: expect.stringMatching(/^[a-z0-9]{8,40}$/),
			a: false,
			m: false,
			v: expect.stringMatching(/^[a-z0-9]+$/),
			country: "DE",
		});

		// The public route takes nothing but that exact shape.
		for (const data of [
			{},
			{ id: "abcdefgh", a: true, m: true, v: "x", country: "DE", ip: "1.2.3.4" },
			{ id: "<script>", a: true, m: true, v: "x", country: "DE" },
			{ id: "abcdefgh", a: "yes", m: true, v: "x", country: "DE" },
			{ id: "abcdefgh", a: true, m: true, v: "x", country: "Germany" },
		]) {
			expect((await page.request.post(`${API}/record`, { data })).status()).toBe(400);
		}
		// A well-formed answer to a banner that is not the live one is dropped.
		const stale = await page.request.post(`${API}/record`, {
			data: { id: "abcdefgh", a: true, m: true, v: "stale", country: null },
		});
		expect(await stale.json()).toEqual({ success: true, data: { saved: false } });
		expect((await page.request.get(`${API}/record`)).status()).toBe(405);

		// The Status tab counts it. No address or browser detail is stored with it.
		await expect
			.poll(async () => {
				const status = await admin.post(`${API}/admin`, {
					headers: { "X-EmDash-Request": "1" },
					data: { type: "page_load", page: "/settings" },
				});
				return JSON.stringify(await status.json());
			})
			.toMatch(/"label":"Rejected all","value":[1-9]/);
	});

	test("the geo route answers with a country or nothing, and is never cached", async ({ page }) => {
		const plain = await page.request.get(`${API}/geo`);
		expect(await plain.json()).toEqual({ success: true, data: { country: null } });
		expect(plain.headers()["cache-control"]).toBe("private, no-store");
		const cloudflare = await page.request.get(`${API}/geo`, { headers: { "cf-ipcountry": "de" } });
		expect(await cloudflare.json()).toEqual({ success: true, data: { country: "DE" } });
	});

	test("an admin adds a tool on the admin page, and a wrong ID is explained", async ({
		browser,
	}) => {
		await configure({});
		const page = await adminContext.newPage();
		await page.goto(ADMIN_PAGE);
		const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole("button", { name: "Get Started" }).click();
		});
		await expect(page.getByRole("tab", { name: "Status" })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("Nothing is being tracked yet")).toBeVisible();
		// The sidebar files the page under Marketing, by its plain name.
		await expect(page.getByRole("link", { name: "Analytics", exact: true })).toBeVisible();

		await page.getByRole("tab", { name: "Tracking tools" }).click();
		const ga = page.getByRole("textbox", { name: /Google Analytics: Measurement ID/ });
		await ga.fill("UA-12345678-1");
		await page.getByRole("button", { name: "Save tools" }).click();
		await expect(page.getByText("Nothing was saved. Please fix this first:")).toBeVisible();
		await expect(page.getByText(/That is an old Universal Analytics ID \(UA-\)/)).toBeVisible();
		// What was typed is still there to correct.
		await expect(ga).toHaveValue("UA-12345678-1");

		await ga.fill(
			`<script async src="https://www.googletagmanager.com/gtag/js?id=${IDS.ga4}"></script>`,
		);
		await page.getByRole("button", { name: "Save tools" }).click();
		await expect(
			page.getByText("Saved. It can take a few minutes to reach visitors."),
		).toBeVisible();
		await expect(ga).toHaveValue(IDS.ga4);

		await page.getByRole("tab", { name: "Status" }).click();
		await expect(
			page.getByText(
				"Google Analytics: on. Waits for visitors in Europe and the UK to accept Analytics cookies. Loads straight away for everyone else.",
			),
		).toBeVisible();
		await expect(page.getByText("The banner has no link to your privacy policy")).toBeHidden();
		// The product name of the company behind the plugin never shows in the admin.
		await expect(page.locator("main")).not.toContainText(/moorage/i);
		await page.close();

		// And the visitor's page now carries the tool.
		const visitor = await browser.newContext();
		const hits = await stubVendors(visitor);
		const site = await visitor.newPage();
		await inCountry(site, "US");
		await site.goto("/");
		await expect
			.poll(() => hits)
			.toEqual([`https://www.googletagmanager.com/gtag/js?id=${IDS.ga4}`]);
		// Everything the plugin put on the page: its script and the banner it built.
		const emitted = await site.evaluate(() => {
			const scripts = [...document.scripts].map((script) => script.textContent ?? "");
			const own = scripts.filter((code) => code.includes("cookie_consent_update"));
			return (
				own.join("") + (document.querySelector("#cookie-consent")?.shadowRoot?.innerHTML ?? "")
			);
		});
		expect(emitted).toContain("Cookie settings");
		expect(emitted).not.toMatch(/moorage/i);
		await visitor.close();
	});
});
