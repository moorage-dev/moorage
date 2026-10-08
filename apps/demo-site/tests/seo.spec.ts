// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import { expect, test, type Page } from "@playwright/test";

type SchemaNode = Record<string, unknown>;

async function jsonLdScripts(page: Page): Promise<unknown[]> {
	const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
	return scripts.map((text) => JSON.parse(text) as unknown);
}

function graphOf(script: unknown): SchemaNode[] {
	return (script as { "@graph"?: SchemaNode[] })["@graph"] ?? [];
}

test("home page has one linked schema graph and no second core script", async ({ page }) => {
	await page.goto("/");
	const scripts = await jsonLdScripts(page);
	expect(scripts).toHaveLength(1);

	const graph = graphOf(scripts[0]);
	const types = graph.map((node) => node["@type"]);
	expect(types).toEqual(["Organization", "WebSite", "WebPage"]);

	const [organization, website, webpage] = graph;
	expect(website?.publisher).toEqual({ "@id": organization?.["@id"] });
	expect(webpage?.isPartOf).toEqual({ "@id": website?.["@id"] });
	expect(webpage?.about).toEqual({ "@id": organization?.["@id"] });
});

test("inner page adds breadcrumbs and an indexable robots tag", async ({ page }) => {
	await page.goto("/pricing");
	const scripts = await jsonLdScripts(page);
	expect(scripts).toHaveLength(1);

	const graph = graphOf(scripts[0]);
	expect(graph.map((node) => node["@type"])).toEqual([
		"Organization",
		"WebSite",
		"WebPage",
		"BreadcrumbList",
	]);
	const breadcrumbs = graph[3]?.itemListElement as SchemaNode[];
	expect(breadcrumbs.map((crumb) => crumb.name)).toEqual(["Home", "Pricing"]);

	const robots = page.locator('meta[name="robots"]');
	await expect(robots).toHaveCount(1);
	await expect(robots).toHaveAttribute("content", /^index, follow, max-snippet:-1/);
});

test("an admin describes the business and the page head follows", async ({ page }) => {
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/seo/seo");
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	await expect(page.getByText("SEO is already working")).toBeVisible({ timeout: 60_000 });

	await page.getByRole("tab", { name: "Who you are" }).click();
	await page.getByText("A local business customers visit").click();
	await page.getByRole("textbox", { name: "Name", exact: true }).fill("Acme Bakery");
	await page.getByRole("button", { name: "Save" }).first().click();
	await expect(
		page.getByText("Saved. Google will pick this up next time it visits."),
	).toBeVisible();
	// The admin stays on the tab they were working in.
	await expect(page.getByRole("tab", { name: "Who you are" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page.getByText("Opening hours")).toBeVisible();

	// Without an address Google would reject a local business, so the site is
	// still described as an organisation and the address section is open.
	await page.goto("/");
	expect(graphOf((await jsonLdScripts(page))[0])[0]).toMatchObject({
		"@type": "Organization",
		name: "Acme Bakery",
	});

	await page.goBack();
	await page.getByRole("tab", { name: "Who you are" }).click();
	await page.getByRole("textbox", { name: "Street address" }).fill("1 Main St");
	await page.getByRole("textbox", { name: "Town or city" }).fill("Springfield");
	await page.getByRole("button", { name: "Save" }).nth(1).click();
	await expect(
		page.getByText("Saved. Google will pick this up next time it visits."),
	).toBeVisible();

	await page.goto("/");
	expect(graphOf((await jsonLdScripts(page))[0])[0]).toMatchObject({
		"@type": "LocalBusiness",
		name: "Acme Bakery",
		address: {
			"@type": "PostalAddress",
			streetAddress: "1 Main St",
			addressLocality: "Springfield",
		},
	});
});

test("an admin imports redirects from a pasted list and they work", async ({ page }) => {
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/seo/seo");
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	await page.getByRole("tab", { name: "Redirects" }).click({ timeout: 60_000 });

	await page
		.getByRole("textbox", { name: /Paste your list/ })
		.fill("source,target,regex,code\n/old-pricing/,/pricing,0,301\n^/legacy/(\\d+)$,/x,1,301");
	await page.getByRole("button", { name: "Check list" }).click();
	await expect(page.getByText("1 ready, 1 skipped")).toBeVisible();
	await expect(page.getByText("Pattern needs a human to rewrite it")).toBeVisible();

	await page.getByRole("button", { name: "Add 1 redirect" }).click();
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await expect(page.getByText("1 redirect added", { exact: true })).toBeVisible();

	// The old address now really sends visitors to the new one.
	const response = await page.request.get("/old-pricing", { maxRedirects: 0 });
	expect(response.status()).toBe(301);
	expect(response.headers().location).toBe("/pricing");
});

test("pages to fix are listed, and fixing one in the editor clears it", async ({ page }) => {
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/seo/seo");
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});

	await page.getByRole("button", { name: "Check my pages" }).click({ timeout: 60_000 });
	// The seed's three pages have no search description.
	await expect(page.getByText("Pages ready: 0 of 3")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("link", { name: "Open page" })).toHaveCount(3);

	// The link opens the entry editor, where the Google preview panel explains the problem.
	await page.getByRole("link", { name: "Open page" }).first().click();
	await page.getByRole("button", { name: "Google preview" }).first().click();
	await expect(page.getByText("To fix: No search description.")).toBeVisible();

	// The editor saves by itself; wait for that save to reach the server.
	const saved = page.waitForResponse(
		(response) =>
			response.url().includes("/_emdash/api/content/") && response.request().method() !== "GET",
	);
	await page.getByRole("textbox", { name: "Meta Description" }).fill("Build products people want.");
	await page.keyboard.press("Tab");
	expect((await saved).ok()).toBe(true);

	await page.goto("/_emdash/admin/plugins/seo/seo");
	await expect(page.getByText("Pages ready: 1 of 3")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("link", { name: "Open page" })).toHaveCount(2);
});
