// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { readFile } from "node:fs/promises";

import {
	expect,
	test,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Download,
	type Page,
} from "@playwright/test";

import { expectHelpLine, helpLinks, setHidden } from "./help-line.js";

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
	return (await response.json()) as {
		data: { toast?: { type: string; message: string }; blocks: unknown[] };
	};
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
	const first = await adminPost(`${API}/admin`, {
		type: "form_submit",
		action_id: "save_s1",
		block_id: "s1:new:x",
		values: { name: def.name, kind: def.kind },
	});
	const ids = [...JSON.stringify(first.data.blocks).matchAll(/"block_id":"s2:([a-z0-9]+):/g)].map(
		(m) => m[1]!,
	);
	const id = ids[0]!;
	expect(id).toBeTruthy();
	const step = async (action: string, values: Record<string, unknown>) => {
		const out = await adminPost(`${API}/admin`, {
			type: "form_submit",
			action_id: action,
			block_id: `${action.slice(5)}:${id}:x`,
			values,
		});
		expect(out.data.toast?.type, JSON.stringify(out.data.blocks).slice(0, 500)).not.toBe("error");
	};
	await step("save_s2", def.s2);
	if (def.kind !== "inline")
		await step("save_s3", { where: "all", exclude: "", devices: "all", again: "month", ...def.s3 });
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

async function visitor(
	browser: Browser,
	options: { phone?: boolean; dark?: boolean } = {},
): Promise<Page> {
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

async function rect(page: Page, selector: string) {
	// Measured after the opening animation.
	await page.waitForTimeout(400);
	return page.evaluate((sel) => {
		const el = document.querySelector("#popups")!.shadowRoot!.querySelector(sel)!;
		const r = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		return {
			x: Math.round(r.x),
			y: Math.round(r.y),
			w: Math.round(r.width),
			h: Math.round(r.height),
			right: Math.round(innerWidth - r.right),
			bottom: Math.round(innerHeight - r.bottom),
			padding: style.paddingTop,
			radius: style.borderTopLeftRadius,
			bg: style.backgroundColor,
			font: style.fontSize,
		};
	}, selector);
}

/** Total layout shift on the page so far. */
async function shift(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			new Promise<number>((resolve) => {
				let total = 0;
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries() as Array<
						PerformanceEntry & { value: number; hadRecentInput: boolean }
					>) {
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
			settings: {
				spamProtection: "honeypot",
				confirmationMessage: "Your first letter arrives at the start of next month.",
				submitLabel: "Join the list",
			},
		},
	});
	expect([200, 409]).toContain(response.status());
});

test.afterEach(async () => {
	for (const id of made.splice(0)) {
		await adminPost(`${API}/admin`, {
			type: "block_action",
			action_id: "row",
			value: `delete:${id}`,
		});
	}
});

test.afterAll(async () => {
	await adminContext.close();
});

async function inbox(): Promise<Array<{ data: Record<string, unknown> }>> {
	const forms = (await (
		await admin.post(`${FORMS}/forms/list`, { headers: H, data: {} })
	).json()) as { data: { items: Array<{ id: string; slug: string }> } };
	const formId = forms.data.items.find((f) => f.slug === "newsletter")!.id;
	const list = (await (
		await admin.post(`${FORMS}/submissions/list`, { headers: H, data: { formId } })
	).json()) as { data: { items: Array<{ data: Record<string, unknown> }> } };
	return list.data.items;
}

test.describe("admin", () => {
	test("the page lives under Marketing and offers the site's forms to choose from", async () => {
		const page = await adminContext.newPage();
		await page.setViewportSize({ width: 1280, height: 1400 });
		await page.goto("/_emdash/admin/plugins/popups/");
		// The first admin page on a cold dev server bundles the whole admin.
		test.setTimeout(240_000);
		// The welcome dialog hides the page from the accessibility tree until it is dismissed.
		await page.locator("text=New popup").first().waitFor({ timeout: 150_000 });
		const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
		if (await welcome.isVisible().catch(() => false))
			await welcome.getByRole("button", { name: "Get Started" }).click();
		await expect(page.getByRole("heading", { name: "Popups", exact: true }).first()).toBeVisible();
		await expect(page.getByText("Marketing", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "New popup" }).click();
		await page.getByLabel("Name (only you see it)").fill("Test letter");
		await page.getByText(/^Popup: a box in the middle/).click();
		await page.getByRole("button", { name: "Next: what it says" }).click();
		await page.getByLabel(/^Heading/).fill("Hello");
		await page.getByText("A form from Forms (made once there; sign-ups land in its inbox)").click();
		await page.getByLabel("Thank-you heading, shown after the form is sent").fill("Thanks");
		// Without a form chosen, nothing is saved.
		await page.getByRole("button", { name: "Next: when and where" }).click();
		await expect(page.getByText("Choose the form.")).toBeVisible();
		// The forms made under Forms, by name: nothing to type or copy.
		await page.getByRole("combobox", { name: "Form", exact: true }).click();
		await page.getByRole("option", { name: "Newsletter", exact: true }).click();
		await page.getByRole("button", { name: "Next: when and where" }).click();
		await expect(page.getByText("3 When and where (now)", { exact: false })).toBeVisible();
		const id = /s3:([a-z0-9]+):/.exec(
			JSON.stringify(
				await (
					await admin.post(`${API}/admin`, { headers: H, data: { type: "page_load", page: "/" } })
				).json(),
			),
		)?.[1];
		const all = JSON.stringify(
			await (
				await admin.post(`${API}/admin`, { headers: H, data: { type: "page_load", page: "/" } })
			).json(),
		);
		const draft = /change:([a-z0-9]+)/.exec(all)?.[1] ?? id;
		if (draft) made.push(draft);
		await page.close();
	});

	test("on a phone the status and the buttons of every row stay on screen", async ({ browser }) => {
		test.setTimeout(240_000);
		await make({ ...FORM_POPUP, name: "Monthly letter for the bakery" });
		await make({ ...FORM_POPUP, name: "Letter, turned off", s4: { on: false } });
		// The longest statuses: "On until …" and "Starts …".
		await make({
			...FORM_POPUP,
			name: "Christmas letter",
			s4: { end_date: "2099-12-27", end_time: "14:00" },
		});
		await make({
			...FORM_POPUP,
			name: "Spring letter",
			s4: { start_date: "2099-03-01", start_time: "09:00" },
		});
		// An unfinished popup: only its first step saved.
		const first = await adminPost(`${API}/admin`, {
			type: "form_submit",
			action_id: "save_s1",
			block_id: "s1:new:x",
			values: { name: "Half made", kind: "slide" },
		});
		made.push(/"block_id":"s2:([a-z0-9]+):/.exec(JSON.stringify(first.data.blocks))![1]!);
		const phone = await browser.newContext({
			storageState: await adminContext.storageState(),
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
		});
		const page = await phone.newPage();
		await page.goto("/_emdash/admin/plugins/popups/");
		await page.locator("text=New popup").first().waitFor({ timeout: 150_000 });
		const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
		if (await welcome.isVisible().catch(() => false))
			await welcome.getByRole("button", { name: "Get Started" }).click();
		const table = page.locator("table").first();
		await expect(table.getByText("Half made", { exact: false })).toBeVisible();
		// Every status and button sits inside the table's visible box (it clips), with room to
		// spare: Linux fonts (CI) are wider than macOS ones.
		const outside = await table.evaluate((t) => {
			const box = (t.parentElement ?? t).getBoundingClientRect();
			const right = Math.min(box.right, window.innerWidth) - 12;
			return [...t.querySelectorAll("tbody tr")].flatMap((tr) =>
				[...tr.querySelectorAll("td:nth-child(1), td button")]
					.filter((el) => el.getBoundingClientRect().right > right)
					.map(
						(el) =>
							`${el.textContent} (${Math.round(el.getBoundingClientRect().right)} > ${right})`,
					),
			);
		});
		expect(outside).toEqual([]);
		// Edit and Preview are one tap away on every finished row.
		const row = table.locator("tbody tr").filter({ hasText: "Monthly letter for the bakery" });
		await expect(row.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
		await expect(row.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
		await phone.close();
	});

	test("a finished popup has its own numbers and one Save, and a refused save keeps what was typed", async () => {
		test.setTimeout(240_000);
		const id = await make({
			name: "Opening hours",
			kind: "slide",
			s2: {
				heading: "Open on Boxing Day",
				text: "Ten till two.",
				contains: "button",
				button_label: "See the hours",
				button_url: "/hours",
				decline: "no-thanks",
			},
		});
		// One view, counted the way a visitor's browser does.
		const counted = await admin.post(`${API}/count`, { data: { p: id, e: "seen", m: false } });
		expect(counted.status()).toBe(200);
		const page = await adminContext.newPage();
		await page.setViewportSize({ width: 1280, height: 1400 });
		await page.goto("/_emdash/admin/plugins/popups/");
		await page.locator("text=New popup").first().waitFor({ timeout: 150_000 });
		const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
		if (await welcome.isVisible().catch(() => false))
			await welcome.getByRole("button", { name: "Get Started" }).click();
		const row = page.locator("tbody tr").filter({ hasText: "Opening hours" });
		await row.getByRole("button", { name: "Edit", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Opening hours" })).toBeVisible();
		// Its own numbers, as on the Numbers tab: one view, too few for a percentage.
		await expect(page.getByText("Seen", { exact: true })).toBeVisible();
		await expect(page.getByText("0 clicks (not enough visitors yet)")).toBeVisible();
		await expect(page.getByRole("button", { name: "See all numbers" })).toBeVisible();
		// One Save for everything: no Save per section.
		const save = page.getByRole("button", { name: "Save changes" });
		await expect(save).toHaveCount(1);
		await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
		// Words and where, then a refused save: everything typed stays.
		const heading = page.getByLabel(/^Heading/);
		const never = page.getByLabel(/^Never on these pages/);
		await heading.fill("");
		await never.fill("/contact");
		await save.click();
		await expect(page.getByText("Write a heading.")).toBeVisible();
		await expect(never).toHaveValue("/contact");
		await expect(page.getByLabel(/^Text/)).toHaveValue("Ten till two.");
		// Fixed, one more Save keeps both parts.
		await heading.fill("Open on Boxing Day, 10 till 2");
		await save.click();
		await expect(page.getByText("Write a heading.")).toHaveCount(0);
		await expect(heading).toHaveValue("Open on Boxing Day, 10 till 2");
		await expect(never).toHaveValue("/contact");
		const list = JSON.stringify(
			await (
				await admin.post(`${API}/admin`, { headers: H, data: { type: "page_load", page: "/" } })
			).json(),
		);
		expect(list).toContain("Every page, except /contact");
		await page.getByRole("button", { name: "See all numbers" }).click();
		await expect(page.getByRole("tab", { name: "Numbers", selected: true })).toBeVisible();
		await page.close();
	});

	test("the Numbers tab downloads a spreadsheet", async () => {
		test.setTimeout(240_000);
		const page = await adminContext.newPage();
		await page.goto("/_emdash/admin/plugins/popups/");
		await page.locator("text=New popup").first().waitFor({ timeout: 150_000 });
		const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
		if (await welcome.isVisible().catch(() => false))
			await welcome.getByRole("button", { name: "Get Started" }).click();
		await page.getByRole("tab", { name: "Numbers" }).click();
		// The link opens in a new tab, which receives the file.
		const download = new Promise<Download>((resolve) => {
			adminContext.on("page", (opened) => opened.once("download", resolve));
			page.once("download", resolve);
		});
		await page.getByRole("link", { name: "Download as a spreadsheet (CSV)" }).click();
		const file = await Promise.race([download, page.waitForTimeout(15_000).then(() => null)]);
		const shown = await Promise.all(
			adminContext
				.pages()
				.filter((p) => p !== page)
				.map((p) => p.textContent("body").catch(() => "")),
		);
		expect(file, `no download arrived; the new tab says: ${shown.join(" | ")}`).not.toBeNull();
		expect(file!.suggestedFilename()).toMatch(/^popups-start-to-\d{4}-\d{2}-\d{2}\.csv$/);
		const path = await file!.path();
		const text = await readFile(path, "utf8");
		expect(text.split("\r\n")[0]).toBe("Day,Popup,Seen,Signed up,Clicked,Closed,Seen on phones");
		for (const opened of adminContext.pages()) await opened.close();
	});

	test("the download link refuses a changed, unsigned or plain request", async () => {
		const page = await adminContext.newPage();
		const blocks = JSON.stringify(
			await (
				await admin.post(`${API}/admin`, { headers: H, data: { type: "page_load", page: "/" } })
			).json(),
		);
		const link = /"url":"([^"]+\/export(?:\?[^"]*)?)"/.exec(blocks)?.[1];
		expect(link).toBeTruthy();
		const url = new URL(link!);
		const good = await page.request.get(url.href);
		expect(good.status()).toBe(200);
		expect(good.headers()["cache-control"]).toContain("no-store");
		expect(good.headers()["content-disposition"]).toMatch(/^attachment; filename="popups-/);
		const changed = new URL(url);
		changed.searchParams.set("from", "2020-01-01");
		const refused = await page.request.get(changed.href);
		expect(refused.status()).toBe(403);
		expect(await refused.text()).toContain("This download link has expired");
		expect((await page.request.get(`${url.origin}${url.pathname}`)).status()).toBe(403);
		await page.close();
	});
});

test.describe("top bar", () => {
	test("is in the page at first paint, never moves the page, and stays closed", async ({
		browser,
	}) => {
		await make({
			name: "Boxing Day hours",
			kind: "bar",
			s2: {
				heading: "Open on Boxing Day, 10:00 to 14:00.",
				text: "",
				button_label: "See all opening hours",
				button_url: "/pricing",
			},
		});
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
	test("waits for the second page, opens centred, and is closed by Esc with focus back", async ({
		browser,
	}) => {
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
		expect(
			await page.evaluate(() =>
				document.querySelector("#popups")!.shadowRoot!.activeElement?.getAttribute("name"),
			),
		).toBe("email");
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

	test("a sign-up lands in the Forms inbox, thanks the visitor and tells the analytics plugin", async ({
		browser,
	}) => {
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
		await expect(
			thanks.getByText("Your first letter arrives at the start of next month."),
		).toBeVisible();
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
		expect(
			await page.evaluate(
				() => document.querySelector("#popups")!.shadowRoot!.activeElement?.tagName,
			),
		).toBe("H2");
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
		const id = await make({
			name: "Christmas cakes",
			kind: "slide",
			s2: {
				heading: "Christmas cakes: order by 1 December",
				text: "Rich fruit or chocolate, decorated by hand.",
				picture: "none",
				contains: "button",
				button_label: "Order a cake",
				button_url: "https://shop.example/cakes",
				decline: "no-thanks",
			},
		});
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
		await expect(region.getByRole("link", { name: "Order a cake" })).toHaveAttribute(
			"href",
			"https://shop.example/cakes?utm_source=popups&utm_medium=slide-in&utm_campaign=christmas-cakes",
		);
		await page.waitForTimeout(1500);
		await region.getByRole("button", { name: "No thanks" }).click();
		await expect(region).toBeHidden();
		await page.waitForTimeout(500);
		const numbers = JSON.stringify(
			await adminPost(`${API}/admin`, { type: "page_load", page: "/" }),
		);
		expect(numbers).toContain('"name":"Christmas cakes (Slide-in) · On"');
		expect(id).toBeTruthy();
		await page.context().close();
	});
});

test.describe("box in a page", () => {
	test("shows the forms plugin's own form, and a sign-up lands in the inbox", async ({
		browser,
	}) => {
		const id = await make({
			name: "Letter box",
			kind: "inline",
			s2: {
				heading: "Get the Journal by email",
				text: "One letter a month.",
				picture: "none",
				contains: "form",
				form: "newsletter",
				thanks: "Thanks",
			},
		});
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

test.describe("box in a page, styled by the site", () => {
	test("a site's own .ec-form styles win, and without them the box keeps its look", async ({
		browser,
	}) => {
		const id = await make({
			name: "Letter box",
			kind: "inline",
			s2: {
				heading: "Get the Journal by email",
				text: "One letter a month.",
				picture: "none",
				contains: "form",
				form: "newsletter",
				thanks: "Thanks",
			},
		});
		const page = await visitor(browser);
		await page.goto(`/popups-test?box=${id}`);
		const region = page.getByRole("region", { name: "Get the Journal by email" });
		await expect(region.locator("form.ec-form")).toHaveCount(1);
		const look = () =>
			region.evaluate((box) => {
				const css = (sel: string) => getComputedStyle(box.querySelector(sel)!);
				const input = css(".ec-form-input");
				const submit = css(".ec-form-submit");
				const label = css(".ec-form-label");
				return {
					input: [input.borderTopLeftRadius, input.minHeight, input.paddingLeft],
					submit: [submit.borderTopLeftRadius, submit.minHeight],
					label: label.fontWeight,
				};
			});
		const headStyle = (text: string) =>
			page.evaluate((content) => {
				const style = document.createElement("style");
				style.textContent = content;
				document.head.prepend(style);
			}, text);
		// No form styles on this site, only a theme's bare element rules: the box's own look.
		await headStyle(
			"input,textarea,button{border-radius:3px;min-height:0;padding-left:1px}label{font-weight:300}",
		);
		expect(await look()).toEqual({
			input: ["6px", "44px", "12px"],
			submit: ["6px", "44px"],
			label: "600",
		});
		// A site's plain one-class rules, in the page head (before the box's own): they win.
		await headStyle(
			".ec-form-input{border-radius:0;min-height:50px;padding-left:4px}.ec-form-submit{border-radius:20px;min-height:48px}.ec-form-label{font-weight:400}",
		);
		expect(await look()).toEqual({
			input: ["0px", "50px", "4px"],
			submit: ["20px", "48px"],
			label: "400",
		});
		await page.context().close();
	});
});

test.describe("preview", () => {
	test("shows a draft to a signed-in editor with the reason, and nothing to a visitor", async ({
		browser,
	}) => {
		const id = await make({ ...FORM_POPUP, s4: { on: false } });
		const page = await adminContext.newPage();
		await page.goto(`/popups-test?popups_preview=${id}&scheme=dark`);
		await expect(page.getByRole("dialog")).toBeVisible();
		await expect(host(page).locator(".pv")).toHaveText(
			"Preview: nothing is counted. Hidden for a real visitor: it is turned off.",
		);
		await page.close();
		const stranger = await visitor(browser);
		await stranger.goto(`/popups-test?popups_preview=${id}`);
		await stranger.waitForTimeout(1500);
		await expect(host(stranger)).toHaveCount(0);
		await stranger.context().close();
	});
});

/**
 * Where each kind lands on screen, in the preview and for a real visitor: the
 * preview must show exactly what a visitor gets. Measured in CSS pixels
 * against the page's own width (without a scroll bar).
 */
const BAR: Make = {
	name: "Plugins news",
	kind: "bar",
	s2: { heading: "Checkout our new plugins!", text: "", button_label: "", button_url: "" },
	s3: { exclude: "/pricing" },
};
const SLIDE: Make = {
	name: "Cake offer",
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
};
const MODAL: Make = {
	name: "Letter popup",
	kind: "modal",
	s2: {
		heading: "Fresh from the oven",
		text: "One email a month.",
		picture: "none",
		contains: "button",
		button_label: "Sign me up",
		button_url: "/contact",
		decline: "no-thanks",
	},
};

/** An editor's preview tab, at a computer's or a phone's width. */
async function previewTab(id: string, path = "/popups-test", phone = false): Promise<Page> {
	const page = await adminContext.newPage();
	await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 800 });
	await page.goto(`${path}${path.includes("?") ? "&" : "?"}popups_preview=${id}&scheme=light`);
	return page;
}

/** Where an element inside a shadow root sits, against the page's own width and height. */
async function place(page: Page, hostSelector: string, selector: string) {
	const el = page.locator(hostSelector).first();
	await el.waitFor({ state: "attached" });
	await page.waitForTimeout(400);
	return page.evaluate(
		([h, sel]) => {
			const root = document.querySelector(h!)!.shadowRoot!;
			const r = root.querySelector(sel!)!.getBoundingClientRect();
			const vw = document.documentElement.clientWidth;
			const vh = window.innerHeight;
			return {
				top: Math.round(r.top),
				left: Math.round(r.left),
				right: Math.round(vw - r.right),
				bottom: Math.round(vh - r.bottom),
				width: Math.round(r.width),
				vw,
				classes: root.querySelector(sel!)!.className,
			};
		},
		[hostSelector, selector],
	);
}

const tag = (page: Page, hostSelector = "#popups") => page.locator(hostSelector).locator(".pv");

/** A slide-in 16 px from its bottom corner, 360 px wide. */
async function slideInCorner(page: Page, side: "right" | "left") {
	const r = await place(page, "#popups", ".slide");
	expect(r[side]).toBe(16);
	expect(r.bottom).toBe(16);
	expect(r.width).toBe(360);
}

/** A slide-in on a phone: a sheet across the bottom. */
async function slideInSheet(page: Page) {
	const r = await place(page, "#popups", ".slide");
	expect([r.left, r.right, r.bottom]).toEqual([0, 0, 0]);
}

/** A popup in the middle of a computer's screen, 480 px wide. */
async function modalCentred(page: Page) {
	const r = await place(page, "#popups", "dialog");
	expect(r.width).toBe(480);
	expect(Math.abs(r.left - r.right)).toBeLessThanOrEqual(16);
	expect(Math.abs(r.top - r.bottom)).toBeLessThanOrEqual(2);
}

/** A popup on a phone: a sheet across the bottom of a 390 px screen. */
async function modalSheet(page: Page) {
	const r = await place(page, "#popups", "dialog");
	expect(r.classes).toContain("sheet");
	expect([r.left, r.bottom]).toEqual([0, 0]);
	expect(r.width).toBe(390);
}

test.describe("each kind where a visitor sees it", () => {
	test.afterEach(async () => {
		await adminPost(`${API}/admin`, {
			type: "form_submit",
			action_id: "save_look",
			block_id: "look:new:x",
			values: { scheme: "auto", custom: false, corner: "right" },
		});
	});

	test("preview: a top bar is across the top of the page, not a slide-in", async () => {
		const id = await make({ ...BAR, s4: { on: false } });
		for (const phone of [false, true]) {
			const page = await previewTab(id, "/", phone);
			const region = page.getByRole("region", { name: "Announcement" });
			await expect(region).toContainText("Checkout our new plugins!");
			await expect(host(page)).toHaveCount(0);
			const r = await place(page, "[data-popups-bar]", ".bar");
			expect(r.top).toBe(0);
			expect(r.left).toBe(0);
			expect(r.width).toBe(r.vw);
			await expect(tag(page, "[data-popups-bar]")).toHaveText(
				"Preview: nothing is counted. Hidden for a real visitor: it is turned off.",
			);
			// The label sits on its own row above the bar's words, never on the same line.
			const rows = await page.evaluate(() => {
				const root = document.querySelector("[data-popups-bar]")!.shadowRoot!;
				const box = (sel: string) => root.querySelector(sel)!.getBoundingClientRect();
				const label = box(".pv");
				// Where the bar's own words are drawn, whatever element holds them.
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				let text: Node | null = null;
				while ((text = walker.nextNode()) && !text.textContent?.includes("Checkout"));
				const range = document.createRange();
				range.selectNodeContents(text!);
				return { labelBottom: label.bottom, wordsTop: range.getBoundingClientRect().top };
			});
			expect(rows.wordsTop).toBeGreaterThanOrEqual(rows.labelBottom);
			await page.close();
		}
	});

	test("visitor: a turned-on top bar is at the top at once, and not on a page it is kept off", async ({
		browser,
	}) => {
		await make(BAR);
		for (const phone of [false, true]) {
			const page = await visitor(browser, { phone });
			await page.goto("/");
			// No scrolling, no waiting: in the page as it opens.
			const r = await place(page, "[data-popups-bar]", ".bar");
			expect(r.top).toBe(0);
			expect(r.width).toBe(r.vw);
			await expect(page.getByRole("region", { name: "Announcement" })).toBeVisible();
			await page.goto("/pricing");
			await expect(page.locator("[data-popups-bar]")).toHaveCount(0);
			await page.context().close();
		}
		// The preview on a page it is kept off says so.
		const id = made[made.length - 1]!;
		const preview = await previewTab(id, "/pricing");
		await expect(tag(preview, "[data-popups-bar]")).toHaveText(
			"Preview: nothing is counted. Hidden for a real visitor: it does not show on this page.",
		);
		await preview.close();
		const home = await previewTab(id, "/");
		await expect(tag(home, "[data-popups-bar]")).toHaveText(
			"Preview: nothing is counted. A real visitor sees it as the page opens.",
		);
		await home.close();
	});

	test("preview and visitor: a slide-in sits in its corner, and is a sheet on a phone", async ({
		browser,
	}) => {
		const id = await make(SLIDE);
		const corner = slideInCorner;
		const sheet = slideInSheet;
		let page = await previewTab(id);
		await corner(page, "right");
		await page.close();
		page = await previewTab(id, "/popups-test", true);
		await sheet(page);
		await page.close();
		const desk = await visitor(browser);
		await desk.goto("/popups-test");
		await read(desk);
		await corner(desk, "right");
		await desk.context().close();
		const phone = await visitor(browser, { phone: true });
		await phone.goto("/popups-test");
		await read(phone);
		await sheet(phone);
		await phone.context().close();
		// Settings ▸ Slide-in corner: bottom left, in the preview and for a visitor.
		await adminPost(`${API}/admin`, {
			type: "form_submit",
			action_id: "save_look",
			block_id: "look:new:x",
			values: { scheme: "auto", custom: false, corner: "left" },
		});
		page = await previewTab(id);
		await corner(page, "left");
		await page.close();
		const left = await visitor(browser);
		await left.goto("/popups-test");
		await read(left);
		await corner(left, "left");
		await left.context().close();
	});

	test("preview and visitor: a popup is centred on a computer and a sheet on a phone", async ({
		browser,
	}) => {
		const id = await make({ ...MODAL, s3: { first_page: true } });
		const centred = modalCentred;
		const sheet = modalSheet;
		let page = await previewTab(id);
		await centred(page);
		await page.close();
		page = await previewTab(id, "/popups-test", true);
		await sheet(page);
		await expect(tag(page)).toHaveText(
			"Preview: nothing is counted. Hidden for a real visitor: this is the first page of the visit.",
		);
		await page.close();
		const desk = await visitor(browser);
		await desk.goto("/popups-test");
		await read(desk);
		await centred(desk);
		await desk.context().close();
		const phone = await visitor(browser, { phone: true });
		await phone.goto("/popups-test");
		await phone.goto("/popups-test");
		await read(phone);
		await sheet(phone);
		await phone.context().close();
	});

	test("preview: a popup opened by a click is centred on a phone too, and the tag says a click opens it", async () => {
		const id = await make({ ...MODAL, s3: { trigger: "click" } });
		const page = await previewTab(id, "/popups-test", true);
		const r = await place(page, "#popups", "dialog");
		expect(r.classes).not.toContain("sheet");
		expect(r.bottom).toBeGreaterThan(8);
		await expect(tag(page)).toHaveText(
			"Preview: nothing is counted. A real visitor sees it when they click its button or link.",
		);
		await page.close();
	});

	test("preview: a popup set for a collection says it does not show on another page", async () => {
		const id = await make({ ...SLIDE, s3: { where: "collections", collections: ["pages"] } });
		const page = await previewTab(id);
		await expect(tag(page)).toHaveText(
			"Preview: nothing is counted. Hidden for a real visitor: it does not show on this page.",
		);
		await page.close();
	});

	test("preview: a box in a page shows in the page's content with a label", async () => {
		const id = await make({
			name: "Letter box",
			kind: "inline",
			s2: {
				heading: "Get the Journal by email",
				text: "One letter a month.",
				picture: "none",
				contains: "button",
				button_label: "Read the Journal",
				button_url: "/pricing",
			},
			s4: { on: false },
		});
		const page = await previewTab(id);
		const region = page.getByRole("region", { name: "Get the Journal by email" });
		await expect(region).toBeVisible();
		// Inside the page's main content, in the flow (not fixed over the page).
		expect(await page.locator("main [data-popups-preview-box]").count()).toBe(1);
		await expect(tag(page, "[data-popups-preview-box]")).toHaveText(
			'Preview: nothing is counted. Hidden for a real visitor: it is turned off. On a page it shows where an editor places the "Popups box" block; this preview puts it at the top of the content.',
		);
		await page.close();
	});

	test("preview and visitor: a box in a page sits in the text column, left-aligned with the text", async ({
		browser,
	}) => {
		const id = await make({
			name: "Letter box",
			kind: "inline",
			s2: {
				heading: "Get the Journal by email",
				text: "One letter a month.",
				picture: "none",
				contains: "form",
				form: "newsletter",
				thanks: "Thanks",
			},
		});
		for (const phone of [false, true]) {
			const seen = await visitor(browser, { phone });
			await seen.goto(`/popups-test?box=${id}`);
			const box = await seen.locator(".popups-box").evaluate((el) => {
				const r = el.getBoundingClientRect();
				return { left: Math.round(r.left), width: Math.round(r.width) };
			});
			// A visitor's box starts where the text starts.
			expect(box.left).toBe(
				await seen.evaluate(() =>
					Math.round(document.querySelector("main h1")!.getBoundingClientRect().left),
				),
			);
			await seen.context().close();
			// The preview draws it at the top of the content, lined up with the text and as wide.
			const page = await previewTab(id, "/popups-test", phone);
			const preview = await place(page, "[data-popups-preview-box]", ".box");
			expect({ left: preview.left, width: preview.width }).toEqual(box);
			// Narrowing the window keeps it lined up.
			if (!phone) {
				await page.setViewportSize({ width: 900, height: 800 });
				const narrow = await place(page, "[data-popups-preview-box]", ".box");
				expect(narrow.left).toBe(
					await page.evaluate(() =>
						Math.round(document.querySelector("main h1")!.getBoundingClientRect().left),
					),
				);
			}
			await page.close();
			// The admin's Preview opens the home page (a hero, then cards): the box is at the top,
			// lined up with the hero's text, not centred on the page.
			const home = await previewTab(id, "/", phone);
			const top = await place(home, "[data-popups-preview-box]", ".box");
			const hero = await home.evaluate(() => {
				const p = Array.from(document.querySelectorAll("main p")).find(
					(el) => el.getBoundingClientRect().width >= 240,
				)!;
				const r = p.getBoundingClientRect();
				return { left: Math.round(r.left), width: Math.round(r.width) };
			});
			expect(top.left).toBe(hero.left);
			expect(top.width).toBe(Math.min(640, hero.width));
			expect(top.top).toBeLessThan(200);
			await home.close();
		}
	});
});

test.describe("with the cookie banner", () => {
	test.afterEach(async () => {
		await admin.post("/_emdash/api/plugins/analytics-consent/admin", {
			headers: H,
			data: {
				type: "form_submit",
				action_id: "save_tools",
				values: {
					ga4: "",
					gtm: "",
					ads: "",
					meta: "",
					clarity: "",
					hubspot: "",
					cloudflare: "",
					hubspot_eu: false,
					cloudflare_wait: false,
					enquiries: true,
				},
			},
		});
	});

	test("nothing opens until the visitor has answered", async ({ browser }) => {
		const save = (action: string, values: Record<string, unknown>) =>
			adminPost("/_emdash/api/plugins/analytics-consent/admin", {
				type: "form_submit",
				action_id: action,
				values,
			});
		await save("save_tools", {
			ga4: "G-TEST123456",
			gtm: "",
			ads: "",
			meta: "",
			clarity: "",
			hubspot: "",
			cloudflare: "",
			hubspot_eu: false,
			cloudflare_wait: false,
			enquiries: true,
		});
		await save("save_banner", {
			audience: "everyone",
			policy_url: "/privacy",
			position: "bar",
			scheme: "auto",
			settings_button: true,
			months: "6",
		});
		await make({ ...FORM_POPUP, s3: { first_page: true } });
		const page = await visitor(browser);
		await page.route(/googletagmanager\.com/, (route) =>
			route.fulfill({ status: 200, body: "", contentType: "application/javascript" }),
		);
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
		await expect(
			page.getByRole("dialog", { name: "Fresh from the oven, once a month" }),
		).toBeVisible();
		// One layer below the banner.
		const layers = await page.evaluate(() => [
			getComputedStyle(document.querySelector("#popups")!).zIndex,
			getComputedStyle(document.querySelector("#cookie-consent")!).zIndex,
		]);
		expect(Number(layers[0])).toBeLessThan(Number(layers[1]));
		await page.context().close();
	});
});

test("an admin sees the help line on the list and on a new popup, and the switch in Settings hides it", async () => {
	test.setTimeout(240_000);
	const guide = "add-a-popup-or-top-bar-to-emdash";
	const page = await adminContext.newPage();
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	const open = async () => {
		await page.goto("/_emdash/admin/plugins/popups/");
		await expect(page.getByRole("tab", { name: "Settings" })).toBeVisible({ timeout: 150_000 });
	};
	await open();
	await expectHelpLine(page, guide);
	await page.getByRole("button", { name: "New popup" }).click();
	await expect(page.getByLabel("Name (only you see it)")).toBeVisible();
	await expectHelpLine(page, guide);

	await open();
	await page.getByRole("tab", { name: "Settings" }).click();
	await expectHelpLine(page, guide);
	await setHidden(page, true);
	await expect(page.getByText("Saved. The help line is hidden.")).toBeVisible();
	await expect(helpLinks(page)).toHaveCount(0);
	await open();
	await expect(helpLinks(page)).toHaveCount(0);

	// Back as it was, for the tests after this one.
	await page.getByRole("tab", { name: "Settings" }).click();
	await setHidden(page, false);
	await expect(page.getByText("Saved. The help line shows again.")).toBeVisible();
	await expectHelpLine(page, guide);
	await page.close();
});
