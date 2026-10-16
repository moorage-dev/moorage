// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Popups, in a real browser, against the approved mockup's key facts
 * (planning/plugins/popups/mockup.html): sizes, positions and words.
 *
 * Visitors use fresh browser contexts that never signed in (a signed-in
 * browser is staff and is not counted). Popups are made through the admin
 * route exactly as the admin page does, and deleted after each test.
 */

const API = "/_emdash/api/plugins/popups";
const FORMS = "/_emdash/api/plugins/emdash-forms";
const H = { "X-EmDash-Request": "1" };

let adminContext: BrowserContext;
let admin: APIRequestContext;
const made: string[] = [];

async function adminPost(path: string, data: unknown) {
	const response = await admin.post(path, { headers: H, data });
	expect(response.status(), await response.text()).toBe(200);
	return (await response.json()) as { data: { toast?: { type: string; message: string }; blocks: unknown[] } };
}

interface Make {
	name: string;
	kind: "bar" | "slide" | "modal" | "inline";
	s2: Record<string, unknown>;
	s3?: Record<string, unknown>;
	s4?: Record<string, unknown>;
}

/** Make a popup through its four steps, as the admin does. */
async function make(def: Make): Promise<string> {
	const first = await adminPost(`${API}/admin`, { type: "form_submit", action_id: "save_s1", block_id: "s1:new:x", values: { name: def.name, kind: def.kind } });
	const ids = [...JSON.stringify(first.data.blocks).matchAll(/"block_id":"s2:([a-z0-9]+):/g)].map((m) => m[1]!);
	const id = ids[0]!;
	expect(id).toBeTruthy();
	const step = async (action: string, values: Record<string, unknown>) => {
		const out = await adminPost(`${API}/admin`, { type: "form_submit", action_id: action, block_id: `${action.slice(5)}:${id}:x`, values });
		expect(out.data.toast?.type, JSON.stringify(out.data.blocks).slice(0, 500)).not.toBe("error");
	};
	await step("save_s2", def.s2);
	if (def.kind !== "inline") await step("save_s3", { where: "all", exclude: "", devices: "all", again: "month", ...def.s3 });
	await step("save_s4", { on: true, ...def.s4 });
	made.push(id);
	return id;
}

const FORM_POPUP: Make = {
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
};

async function visitor(browser: Browser, options: { phone?: boolean; dark?: boolean } = {}): Promise<Page> {
	const context = await browser.newContext({
		viewport: options.phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
		colorScheme: options.dark ? "dark" : "light",
		hasTouch: !!options.phone,
	});
	return context.newPage();
}

/** Scroll far enough for "after they have read a while". */
async function read(page: Page): Promise<void> {
	await page.mouse.wheel(0, 4000);
}

const host = (page: Page) => page.locator("#popups");
const box = (page: Page) => host(page).locator(".pp");

async function rect(page: Page, selector: string) {
	// Measured after the opening animation.
	await page.waitForTimeout(400);
	return page.evaluate((sel) => {
		const el = document.querySelector("#popups")!.shadowRoot!.querySelector(sel)!;
		const r = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), padding: style.paddingTop, radius: style.borderTopLeftRadius, bg: style.backgroundColor, font: style.fontSize };
	}, selector);
}

/** Total layout shift on the page so far. */
async function shift(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			new Promise<number>((resolve) => {
				let total = 0;
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
						if (!entry.hadRecentInput) total += entry.value;
					}
				}).observe({ type: "layout-shift", buffered: true });
				setTimeout(() => resolve(total), 500);
			}),
	);
}

test.beforeAll(async ({ browser }) => {
	adminContext = await browser.newContext();
	const page = await adminContext.newPage();
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
	await page.close();
	admin = adminContext.request;
	const response = await admin.post(`${FORMS}/forms/create`, {
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
			settings: { spamProtection: "honeypot", confirmationMessage: "Your first letter arrives at the start of next month.", submitLabel: "Join the list" },
		},
	});
	expect([200, 409]).toContain(response.status());
});

test.afterEach(async () => {
	for (const id of made.splice(0)) {
		await adminPost(`${API}/admin`, { type: "block_action", action_id: "row", value: `delete:${id}` });
	}
});

test.afterAll(async () => {
	await adminContext.close();
});

async function inbox(): Promise<Array<{ data: Record<string, unknown> }>> {
	const forms = (await (await admin.post(`${FORMS}/forms/list`, { headers: H, data: {} })).json()) as { data: { items: Array<{ id: string; slug: string }> } };
	const formId = forms.data.items.find((f) => f.slug === "newsletter")!.id;
	const list = (await (await admin.post(`${FORMS}/submissions/list`, { headers: H, data: { formId } })).json()) as { data: { items: Array<{ data: Record<string, unknown> }> } };
	return list.data.items;
}

test.describe("admin", () => {
	test("the page lives under Marketing and refuses a form that does not exist", async () => {
		const page = await adminContext.newPage();
		await page.setViewportSize({ width: 1280, height: 1400 });
		await page.goto("/_emdash/admin/plugins/popups/");
		// The first admin page on a cold dev server bundles the whole admin.
		test.setTimeout(240_000);
		// The welcome dialog hides the page from the accessibility tree until it is dismissed.
		await page.locator("text=New popup").first().waitFor({ timeout: 150_000 });
		const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
		if (await welcome.isVisible().catch(() => false)) await welcome.getByRole("button", { name: "Get Started" }).click();
		await expect(page.getByRole("heading", { name: "Popups", exact: true }).first()).toBeVisible();
		await expect(page.getByText("Marketing", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "New popup" }).click();
		await page.getByLabel("Name (only you see it)").fill("Test letter");
		await page.getByText(/^Popup: a box in the middle/).click();
		await page.getByRole("button", { name: "Next: what it says" }).click();
		await page.getByLabel(/^Heading/).fill("Hello");
		await page.getByText("A form from Forms (made once there; sign-ups land in its inbox)").click();
		await page.getByLabel(/The form's short name/).fill("newsleter");
		await page.getByLabel("Thank-you heading, shown after the form is sent").fill("Thanks");
		await page.getByRole("button", { name: "Next: when and where" }).click();
		await expect(page.getByText('There is no form called "newsleter". Open Forms, copy the short name from the list, and paste it here.')).toBeVisible();
		await page.getByLabel(/The form's short name/).fill("newsletter");
		await page.getByRole("button", { name: "Next: when and where" }).click();
		await expect(page.getByText("3 When and where (now)", { exact: false })).toBeVisible();
		const id = /s3:([a-z0-9]+):/.exec(JSON.stringify(await (await admin.post(`${API}/admin`, { headers: H, data: { type: "page_load", page: "/" } })).json()))?.[1];
		const all = JSON.stringify(await (await admin.post(`${API}/admin`, { headers: H, data: { type: "page_load", page: "/" } })).json());
		const draft = /change:([a-z0-9]+)/.exec(all)?.[1] ?? id;
		if (draft) made.push(draft);
		await page.close();
	});
});

test.describe("top bar", () => {
	test("is in the page at first paint, never moves the page, and stays closed", async ({ browser }) => {
		await make({ name: "Boxing Day hours", kind: "bar", s2: { heading: "Open on Boxing Day, 10:00 to 14:00.", text: "", button_label: "See all opening hours", button_url: "/pricing" } });
		const page = await visitor(browser);
		await page.goto("/");
		const bar = page.locator("[data-popups-bar]");
		await expect(bar).toBeVisible();
		const region = page.getByRole("region", { name: "Announcement" });
		await expect(region).toContainText("Open on Boxing Day, 10:00 to 14:00.");
		const size = await bar.boundingBox();
		expect(size!.y).toBe(0);
		expect(size!.height).toBeGreaterThanOrEqual(44);
		expect(await shift(page)).toBe(0);
		const close = region.getByRole("button", { name: "Close" });
		const closeBox = (await close.boundingBox())!;
		expect([closeBox.width, closeBox.height]).toEqual([44, 44]);
		await close.click();
		await expect(bar).toBeHidden();
		// The next page hides it before it is drawn: no flash, no shift.
		await page.goto("/pricing");
		await expect(bar).toBeHidden();
		expect(await shift(page)).toBe(0);
		await page.context().close();
	});
});

test.describe("popup with a form", () => {
	test("waits for the second page, opens centred, and is closed by Esc with focus back", async ({ browser }) => {
		await make(FORM_POPUP);
		const page = await visitor(browser);
		await page.goto("/popups-test");
		await read(page);
		await page.waitForTimeout(1500);
		await expect(host(page)).toHaveCount(0);
		await page.goto("/popups-test");
		await read(page);
		const dialog = page.getByRole("dialog", { name: "Fresh from the oven, once a month" });
		await expect(dialog).toBeVisible();
		// The mockup: 480 px wide, centred, 28 px padding, 12 px corners; close 44 px at the top right.
		const r = await rect(page, "dialog");
		expect(Math.round(r.w)).toBe(480);
		expect(Math.abs(r.x - (1280 - r.w) / 2)).toBeLessThan(2);
		expect(r.padding).toBe("28px");
		expect(r.radius).toBe("12px");
		const x = await rect(page, ".x");
		expect([x.w, x.h]).toEqual([44, 44]);
		// 8 px inside the 1 px edge, as drawn.
		expect(x.right - (1280 - r.x - r.w)).toBe(9);
		await expect(dialog.getByRole("button", { name: "Join the list" })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "No thanks" })).toBeVisible();
		await expect(dialog.getByText("(optional)")).toBeVisible();
		// Focus moved to the first field.
		expect(await page.evaluate(() => document.querySelector("#popups")!.shadowRoot!.activeElement?.getAttribute("name"))).toBe("email");
		// Tab stays inside the popup.
		for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("popups");
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		// Closed: not again in this browser for a month.
		await page.goto("/popups-test");
		await read(page);
		await page.waitForTimeout(1500);
		await expect(host(page)).toHaveCount(0);
		await page.context().close();
	});

	test("a sign-up lands in the Forms inbox, thanks the visitor and tells the analytics plugin", async ({ browser }) => {
		await make({ ...FORM_POPUP, s3: { first_page: true } });
		const before = (await inbox()).length;
		const page = await visitor(browser);
		await page.goto("/popups-test");
		await read(page);
		const dialog = page.getByRole("dialog", { name: "Fresh from the oven, once a month" });
		await expect(dialog).toBeVisible();
		await page.keyboard.type("jo@example.com");
		await dialog.getByRole("button", { name: "Join the list" }).click();
		// The box keeps its place and becomes the thank-you, named after it.
		const thanks = page.getByRole("dialog", { name: "Thanks, you're on the list" });
		await expect(thanks.getByRole("heading", { name: "Thanks, you're on the list" })).toBeFocused();
		await expect(thanks.getByText("Your first letter arrives at the start of next month.")).toBeVisible();
		await expect(page.locator("[data-form-status].ec-form-status--success")).toHaveCount(1);
		const after = await inbox();
		expect(after.length).toBe(before + 1);
		expect(after[0]!.data.email).toBe("jo@example.com");
		await thanks.getByRole("button", { name: "Close" }).last().click();
		await expect(thanks).toBeHidden();
		await page.context().close();
	});

	test("on a phone it is a sheet at the bottom, never over the first page", async ({ browser }) => {
		await make({ ...FORM_POPUP, s3: { first_page: true } });
		const page = await visitor(browser, { phone: true, dark: true });
		await page.goto("/popups-test");
		await read(page);
		await page.waitForTimeout(1500);
		// "Show on the first page" is for computers only.
		await expect(host(page)).toHaveCount(0);
		await page.goto("/popups-test");
		await read(page);
		await expect(page.getByRole("dialog")).toBeVisible();
		const r = await rect(page, "dialog");
		expect(r.x).toBe(0);
		expect(Math.round(r.w)).toBe(390);
		expect(Math.round(r.bottom)).toBe(0);
		expect(r.h).toBeLessThanOrEqual(844 * 0.62 + 1);
		expect(r.radius).toBe("12px");
		// Dark: a dark surface.
		expect(r.bg).not.toBe("rgb(255, 255, 255)");
		// No keyboard jumps up uninvited: the heading has focus, not a field.
		expect(await page.evaluate(() => document.querySelector("#popups")!.shadowRoot!.activeElement?.tagName)).toBe("H2");
		await page.context().close();
	});

	test("a click opens it at once, centred even on a phone", async ({ browser }) => {
		await make({ ...FORM_POPUP, s3: { trigger: "click" } });
		const page = await visitor(browser, { phone: true });
		await page.goto("/popups-test?opener=monthly-letter");
		await page.getByRole("button", { name: "Get the monthly letter" }).click();
		const dialog = page.getByRole("dialog", { name: "Fresh from the oven, once a month" });
		await expect(dialog).toBeVisible();
		const r = await rect(page, "dialog");
		expect(r.bottom).toBeGreaterThan(8);
		await page.getByRole("button", { name: "No thanks" }).click();
		await expect(dialog).toBeHidden();
		await page.context().close();
	});

	test("never opens while someone is typing", async ({ browser }) => {
		await make({ ...FORM_POPUP, s3: { first_page: true } });
		const page = await visitor(browser);
		await page.goto("/popups-test");
		await page.locator("#search").click();
		await read(page);
		await page.waitForTimeout(1500);
		await expect(host(page)).toHaveCount(0);
		await page.locator("h1").click();
		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });
		await page.context().close();
	});
});

test.describe("slide-in", () => {
	test("sits in the bottom right corner without taking focus, and counts", async ({ browser }) => {
		const id = await make({ name: "Christmas cakes", kind: "slide", s2: { heading: "Christmas cakes: order by 1 December", text: "Rich fruit or chocolate, decorated by hand.", picture: "none", contains: "button", button_label: "Order a cake", button_url: "https://shop.example/cakes", decline: "no-thanks" } });
		const page = await visitor(browser);
		await page.goto("/popups-test");
		await read(page);
		const region = page.getByRole("region", { name: "Christmas cakes: order by 1 December" });
		await expect(region).toBeVisible();
		const r = await rect(page, ".slide");
		expect(Math.round(r.w)).toBe(360);
		expect(Math.round(r.right)).toBe(16);
		expect(Math.round(r.bottom)).toBe(16);
		expect(r.padding).toBe("20px");
		expect(r.radius).toBe("10px");
		expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("popups");
		// Links to other websites carry campaign tags.
		await expect(region.getByRole("link", { name: "Order a cake" })).toHaveAttribute("href", "https://shop.example/cakes?utm_source=popups&utm_medium=slide-in&utm_campaign=christmas-cakes");
		await page.waitForTimeout(1500);
		await region.getByRole("button", { name: "No thanks" }).click();
		await expect(region).toBeHidden();
		await page.waitForTimeout(500);
		const numbers = JSON.stringify(await adminPost(`${API}/admin`, { type: "page_load", page: "/" }));
		expect(numbers).toContain('"name":"Christmas cakes (Slide-in)"');
		expect(id).toBeTruthy();
		await page.context().close();
	});
});

test.describe("box in a page", () => {
	test("shows the forms plugin's own form, and a sign-up lands in the inbox", async ({ browser }) => {
		const id = await make({ name: "Letter box", kind: "inline", s2: { heading: "Get the Journal by email", text: "One letter a month.", picture: "none", contains: "form", form: "newsletter", thanks: "Thanks" } });
		const page = await visitor(browser);
		await page.goto(`/popups-test?box=${id}`);
		const region = page.getByRole("region", { name: "Get the Journal by email" });
		await expect(region).toBeVisible();
		await expect(region.locator("form.ec-form")).toHaveCount(1);
		const before = (await inbox()).length;
		await region.getByLabel(/Email address/).fill("box@example.com");
		await region.getByRole("button", { name: "Join the list" }).click();
		await expect(region.locator(".ec-form-status--success")).toBeVisible();
		expect((await inbox()).length).toBe(before + 1);
		await page.context().close();
	});
});

test.describe("preview", () => {
	test("shows a draft to a signed-in editor with the reason, and nothing to a visitor", async ({ browser }) => {
		const id = await make({ ...FORM_POPUP, s4: { on: false } });
		const page = await adminContext.newPage();
		await page.goto(`/popups-test?popups_preview=${id}&scheme=dark`);
		await expect(page.getByRole("dialog")).toBeVisible();
		await expect(host(page).locator(".pv")).toHaveText("Preview: nothing is counted. Hidden for a real visitor: it is turned off.");
		await page.close();
		const stranger = await visitor(browser);
		await stranger.goto(`/popups-test?popups_preview=${id}`);
		await stranger.waitForTimeout(1500);
		await expect(host(stranger)).toHaveCount(0);
		await stranger.context().close();
	});
});

test.describe("with the cookie banner", () => {
	test.afterEach(async () => {
		await admin.post("/_emdash/api/plugins/analytics-consent/admin", { headers: H, data: { type: "form_submit", action_id: "save_tools", values: { ga4: "", gtm: "", ads: "", meta: "", clarity: "", hubspot: "", cloudflare: "", hubspot_eu: false, cloudflare_wait: false, enquiries: true } } });
	});

	test("nothing opens until the visitor has answered", async ({ browser }) => {
		const save = (action: string, values: Record<string, unknown>) => adminPost("/_emdash/api/plugins/analytics-consent/admin", { type: "form_submit", action_id: action, values });
		await save("save_tools", { ga4: "G-TEST123456", gtm: "", ads: "", meta: "", clarity: "", hubspot: "", cloudflare: "", hubspot_eu: false, cloudflare_wait: false, enquiries: true });
		await save("save_banner", { audience: "everyone", policy_url: "/privacy", position: "bar", scheme: "auto", settings_button: true, months: "6" });
		await make({ ...FORM_POPUP, s3: { first_page: true } });
		const page = await visitor(browser);
		await page.route(/googletagmanager\.com/, (route) => route.fulfill({ status: 200, body: "", contentType: "application/javascript" }));
		await page.goto("/popups-test");
		const banner = page.getByRole("region", { name: "Can we use cookies?" });
		await expect(banner).toBeVisible();
		await read(page);
		await page.waitForTimeout(1500);
		await expect(host(page)).toHaveCount(0);
		await banner.getByRole("button", { name: "Reject all" }).click();
		// The timer starts again from the answer: reading on opens it.
		await page.mouse.wheel(0, -4000);
		await read(page);
		await expect(page.getByRole("dialog", { name: "Fresh from the oven, once a month" })).toBeVisible();
		// One layer below the banner.
		const layers = await page.evaluate(() => [getComputedStyle(document.querySelector("#popups")!).zIndex, getComputedStyle(document.querySelector("#cookie-consent")!).zIndex]);
		expect(Number(layers[0])).toBeLessThan(Number(layers[1]));
		await page.context().close();
	});
});
