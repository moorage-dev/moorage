// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { expect, test, type Page } from "@playwright/test";

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
) {
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
}

test("on a site that is not public yet, content links are checked and a dead address is fixed with a picked page", async ({
	page,
}) => {
	await open(page);
	await createPage(page, "christmas-orders", "Christmas orders", [], false);
	await createPage(page, "spring-menu", "Spring menu", ["/christmas-orders", "/menu-2024"], true);
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
		name: /\/menu-2024: we could not open your site to check this address/,
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
