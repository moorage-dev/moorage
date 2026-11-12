// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { expect, test, type Page } from "@playwright/test";

import { expectHelpLine, helpLinks, setHidden } from "./help-line.js";

const PAGE = "/_emdash/admin/plugins/site-health/health";
const API = "/_emdash/api";
const HEADERS = { "X-EmDash-Request": "1" };

async function open(page: Page): Promise<void> {
	await page.goto(`/_emdash/api/setup/dev-bypass?redirect=${PAGE}`);
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	await expect(page.getByRole("tab", { name: "Problems" })).toBeVisible({ timeout: 60_000 });
}

/** Press Refresh until the first check has finished (the dev server's scheduler may be slower). */
async function waitForResults(page: Page): Promise<void> {
	await expect
		.poll(
			async () => {
				if (await page.getByText("Pages checked").first().isVisible()) return true;
				const refresh = page.getByRole("button", { name: "Refresh" });
				if (await refresh.isVisible()) await refresh.click();
				await page.waitForTimeout(300);
				return page.getByText("Pages checked").first().isVisible();
			},
			{ timeout: 60_000, intervals: [500] },
		)
		.toBe(true);
}

async function createPage(
	page: Page,
	slug: string,
	title: string,
	links: string[],
	publish: boolean,
): Promise<string> {
	const created = await page.request.post(`${API}/content/pages`, {
		headers: HEADERS,
		data: {
			slug,
			data: {
				title,
				content: links.map((url, index) => ({
					_type: "marketing_hero",
					_key: `hero${index}`,
					headline: `${title} ${index}`,
					primary_cta_label: "More",
					primary_cta_url: url,
				})),
			},
		},
	});
	expect(created.ok()).toBe(true);
	const body = (await created.json()) as { data: { item: { id: string } } };
	if (publish) {
		const published = await page.request.post(`${API}/content/pages/${body.data.item.id}/publish`, {
			headers: HEADERS,
		});
		expect(published.ok()).toBe(true);
	}
	return body.data.item.id;
}

test("on a site that is not public yet, content links are checked and a dead address is fixed with a picked page", async ({
	page,
}) => {
	await open(page);
	await createPage(page, "christmas-orders", "Christmas orders", [], false);
	const spring = await createPage(
		page,
		"spring-menu",
		"Spring menu",
		["/christmas-orders", "/menu-2024"],
		true,
	);
	// Start a full check that sees the new pages, then move it along.
	await page.reload();
	await waitForResults(page);
	const again = page.getByRole("button", { name: "Check everything again" });
	if (await again.isVisible()) await again.click();
	await waitForResults(page);
	await expect
		.poll(
			async () => {
				const refresh = page.getByRole("button", { name: "Refresh" });
				if (await refresh.isVisible()) await refresh.click();
				await page.waitForTimeout(300);
				return page
					.getByText("/christmas-orders goes to a page that is not published yet.")
					.isVisible();
			},
			{ timeout: 60_000, intervals: [500] },
		)
		.toBe(true);

	// localhost cannot be opened by plugins: one plain banner, and nothing that needed the live page is broken.
	await expect(page.getByText("This site is not public yet")).toBeVisible();
	await expect(page.getByRole("heading", { name: "One link" })).toBeVisible();
	await expect(page.getByText("Found on: Spring menu.").first()).toBeVisible();
	await expect(page.getByText("does not exist")).toHaveCount(0);

	await page.getByRole("button", { name: /Links we could not check/ }).click();
	const row = page.getByRole("row", {
		name: /\/menu-2024 matches no page we know of\. Your site is not public yet/,
	});
	await expect(row).toBeVisible();
	await row.getByRole("button", { name: "Fix" }).click();
	await page.getByRole("menuitem", { name: "Send visitors to another page" }).click();

	// Pick, don't type: the new page comes from the site's own pages.
	await expect(page.getByRole("textbox", { name: "Old address" })).toHaveValue("/menu-2024");
	await page.getByRole("combobox", { name: "Send visitors to" }).click();
	await page.getByRole("option", { name: "Pricing (/pricing)" }).click();
	await page.getByRole("button", { name: "Send visitors there" }).click();
	await expect(page.getByText("Done. /menu-2024 now goes to /pricing.")).toBeVisible();

	const response = await page.request.get("/menu-2024", { maxRedirects: 0 });
	expect(response.status()).toBe(301);
	expect(response.headers().location).toBe("/pricing");

	// The technical answer is folded away for the web person.
	await page.getByRole("button", { name: "Details for your web person" }).first().click();
	await expect(
		page.getByText("/christmas-orders: not requested, the page is not published."),
	).toBeVisible();

	// Beside the entry, the Links on this page panel names the same problem, read-only.
	await page.goto(`/_emdash/admin/content/pages/${spring}`);
	await page.getByRole("button", { name: "Links on this page", exact: true }).click();
	await expect(
		page.getByText("/christmas-orders goes to a page that is not published yet."),
	).toBeVisible({ timeout: 30_000 });
});

test("after a move from WordPress, what it left behind is listed with what to do", async ({
	page,
}) => {
	await open(page);
	// What the WordPress re-run of 2026-11-09 brought across: a Contact Form 7 shortcode as
	// text, a link to WordPress's ?p= address, and a Greek slug kept in its coded form.
	const created = await page.request.post(`${API}/content/pages`, {
		headers: HEADERS,
		data: {
			slug: "wp-contact",
			data: {
				title: "Contact us",
				content: [
					{
						_type: "marketing_hero",
						_key: "wp1",
						headline: '[contact-form-7 id="9ee95fa" title="Contact form 1"]',
						primary_cta_label: "Our story",
						primary_cta_url: "/?p=12",
					},
				],
			},
		},
	});
	expect(created.ok()).toBe(true);
	const contact = ((await created.json()) as { data: { item: { id: string } } }).data.item.id;
	const greek = await page.request.post(`${API}/content/pages`, {
		headers: HEADERS,
		data: { slug: "%cf%84%cf%85%cf%81%ce%af", data: { title: "Τυρί", content: [] } },
	});
	expect(greek.ok()).toBe(true);
	const greekId = ((await greek.json()) as { data: { item: { id: string } } }).data.item.id;
	for (const id of [contact, greekId]) {
		const published = await page.request.post(`${API}/content/pages/${id}/publish`, {
			headers: HEADERS,
		});
		expect(published.ok()).toBe(true);
	}

	await page.reload();
	await waitForResults(page);
	const again = page.getByRole("button", { name: "Check everything again" });
	if (await again.isVisible()) await again.click();
	await expect
		.poll(
			async () => {
				const refresh = page.getByRole("button", { name: "Refresh" });
				if (await refresh.isVisible()) await refresh.click();
				await page.waitForTimeout(300);
				return page.getByRole("heading", { name: "Left over from WordPress" }).isVisible();
			},
			{ timeout: 60_000, intervals: [500] },
		)
		.toBe(true);
	const shortcode = page.getByRole("row", { name: /is a WordPress shortcode/ });
	await expect(shortcode).toContainText("put a form block in its place");
	await expect(shortcode).toContainText("Found on: Contact us.");
	await expect(
		page.getByRole("row", { name: /\/\?p=12 is a WordPress address this site does not use/ }),
	).toBeVisible();
	await expect(
		page.getByRole("row", { name: /in WordPress's coded form of its letters/ }),
	).toBeVisible();

	// The Fix menu says what to do and opens the page.
	await shortcode.getByRole("button", { name: "Fix" }).click();
	await page.getByRole("menuitem", { name: "Edit Contact us" }).click();
	await expect(page.getByText("Tidy up Contact us")).toBeVisible();
	await expect(page.getByRole("link", { name: "Open Contact us" })).toBeVisible();

	// Beside the entry, the Links on this page panel lists the same, for Editors too.
	await page.goto(`/_emdash/admin/content/pages/${contact}`);
	await page.getByRole("button", { name: "Links on this page", exact: true }).click();
	await expect(page.getByText("Left over from WordPress (2)")).toBeVisible({ timeout: 30_000 });
});

test("on a phone, every row keeps its status and its Fix menu on screen", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await open(page);
	await waitForResults(page);
	const width = 390;
	for (const button of await page.getByRole("button", { name: "Fix" }).all()) {
		const box = await button.boundingBox();
		if (box) expect(box.x + box.width).toBeLessThanOrEqual(width);
	}
	// The mockup's facts: the tabs, the groups, the two-column tables.
	await expect(page.getByRole("tab", { name: "Checklist" })).toBeVisible();
	await page.getByRole("tab", { name: "Checklist" }).click();
	await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
	for (const cell of await page
		.getByRole("cell", { name: /^(Working|Needs attention|Not tested yet|Could not tell)$/ })
		.all()) {
		const box = await cell.boundingBox();
		if (box) expect(box.x + box.width).toBeLessThanOrEqual(width);
	}
	// The Email row says how email stands, with its own test button, on screen.
	await expect(page.getByText(/^Email: (Working|Needs attention|Not tested yet)\./)).toBeVisible();
	const test = page.getByRole("button", { name: "Send a test email" });
	await expect(test).toBeVisible();
	const box = await test.boundingBox();
	if (box) expect(box.x + box.width).toBeLessThanOrEqual(width);
	// The Cloudflare reminder: a line with a link, no status.
	await expect(page.getByText(/^If your site is on Cloudflare: /)).toBeVisible();
	const steps = page.getByRole("link", { name: "Cloudflare's steps" });
	await expect(steps).toHaveAttribute(
		"href",
		"https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/",
	);
	const stepsBox = await steps.boundingBox();
	if (stepsBox) expect(stepsBox.x + stepsBox.width).toBeLessThanOrEqual(width);
	await expect(page.getByText("Scheduled tasks.").first()).toBeVisible();
});

test("the dashboard widget opens Site Health", async ({ page }) => {
	await open(page);
	await page.goto("/_emdash/admin");
	const link = page.getByRole("link", { name: "Open Site Health" });
	await expect(link).toBeVisible({ timeout: 60_000 });
	await link.click();
	await expect(page.getByRole("tab", { name: "Problems" })).toBeVisible();
});

test("an admin sees the help line under both tabs, and the switch under Options hides it", async ({
	page,
}) => {
	const guide = "find-and-fix-broken-links-on-emdash";
	await open(page);
	await expectHelpLine(page, guide);
	await page.getByRole("tab", { name: "Checklist" }).click();
	await expectHelpLine(page, guide);
	const options = page.getByRole("button", { name: "Options" });
	if ((await options.getAttribute("aria-expanded")) === "false") await options.click();

	await setHidden(page, true);
	await expect(page.getByText("Saved. The help line is hidden.")).toBeVisible();
	await expect(helpLinks(page)).toHaveCount(0);
	await open(page);
	await expect(helpLinks(page)).toHaveCount(0);

	// Back as it was, for the tests after this one.
	await page.getByRole("tab", { name: "Checklist" }).click();
	if ((await options.getAttribute("aria-expanded")) === "false") await options.click();
	await setHidden(page, false);
	await expect(page.getByText("Saved. The help line shows again.")).toBeVisible();
	await expectHelpLine(page, guide);
});
