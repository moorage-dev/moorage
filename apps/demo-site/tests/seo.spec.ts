// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

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

const SEO_PAGE = "/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/seo/overview";

async function openSeoPage(page: Page): Promise<void> {
	await page.goto(SEO_PAGE);
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible({ timeout: 60_000 });
}

test("the first visit shows real numbers, and answering the one question changes the page head", async ({
	page,
}) => {
	await openSeoPage(page);
	// The pages are checked without anyone pressing a button: the seed has three, none with a description.
	await expect(page.getByText("Pages checked")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("link", { name: "Open page" })).toHaveCount(3);

	// The one question is open on a new site, with nothing pre-selected.
	await page.getByText("A local business customers visit").first().click();
	await page.getByRole("combobox").first().click();
	await page.getByRole("option", { name: "Restaurant, cafe or bakery" }).click();
	await page.getByRole("textbox", { name: "Name", exact: true }).first().fill("Acme Bakery");
	await page.getByRole("textbox", { name: "Street address" }).first().fill("1 Main St");
	await page.getByRole("textbox", { name: "Town or city" }).first().fill("Springfield");
	await page.getByRole("button", { name: "Save", exact: true }).first().click();
	await expect(
		page.getByText("Saved. Google will pick this up next time it visits."),
	).toBeVisible();
	await expect(page.getByText("Tell Google who this site is for")).toHaveCount(0);
	// The Overview now follows up on what a local business still owes.
	await expect(page.getByRole("cell", { name: "Opening hours" })).toBeVisible();
	await expect(page.getByRole("cell", { name: "Phone number" })).toBeVisible();

	// Settings shows what was just entered without opening anything.
	await page.getByRole("tab", { name: "Settings" }).click();
	await expect(page.getByText("Address and phone: 1 Main St, Springfield")).toBeVisible();
	await expect(page.getByText("Opening hours (needed, not added yet)")).toBeVisible();

	await page.goto("/");
	expect(graphOf((await jsonLdScripts(page))[0])[0]).toMatchObject({
		"@type": "FoodEstablishment",
		name: "Acme Bakery",
		address: {
			"@type": "PostalAddress",
			streetAddress: "1 Main St",
			addressLocality: "Springfield",
		},
	});
});

test("an admin adds one redirect, imports a list, and both work", async ({ page }) => {
	await openSeoPage(page);
	await page.getByRole("tab", { name: "Redirects" }).click();
	await expect(page.getByText("No redirects yet")).toBeVisible();

	// Tasks are buttons above the list; pressing one opens it in place.
	await page.getByRole("button", { name: "Add a redirect" }).click();
	await page.getByRole("textbox", { name: "Redirect from" }).fill("/old-pricing");
	await page.getByRole("textbox", { name: "Redirect to" }).fill("/pricing");
	await page.getByRole("button", { name: "Add redirect" }).click();
	await expect(page.getByText("Redirect added. /old-pricing now goes to /pricing.")).toBeVisible();
	await expect(page.getByRole("cell", { name: "/old-pricing" })).toBeVisible();

	await page.getByRole("button", { name: "Import from WordPress" }).click();
	await page
		.getByRole("textbox", { name: /Your list/ })
		.fill("source,target,regex,code\n/old-contact/,/contact,0,301\n^/legacy/(\\d+)$,/x,1,301");
	await page.getByRole("button", { name: "Check list" }).click();
	await expect(page.getByText("1 ready, 1 skipped")).toBeVisible();
	await expect(
		page.getByText("Uses a pattern. Add it by hand under Manage > Redirects"),
	).toBeVisible();
	await page.getByRole("button", { name: "Add 1 redirect" }).click();
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await expect(page.getByText("1 redirect added from your list")).toBeVisible();

	// The old addresses now really send visitors to the new ones.
	for (const [from, to] of [
		["/old-pricing", "/pricing"],
		["/old-contact", "/contact"],
	]) {
		const response = await page.request.get(from ?? "", { maxRedirects: 0 });
		expect(response.status()).toBe(301);
		expect(response.headers().location).toBe(to);
	}
});

test("fixing a listed page in the editor takes it off the list", async ({ page }) => {
	await openSeoPage(page);
	await expect(page.getByRole("link", { name: "Open page" })).toHaveCount(3, { timeout: 30_000 });

	// The link opens the entry editor, where the Google preview panel explains the problem.
	await page
		.getByRole("row", { name: /Pricing/ })
		.getByRole("link", { name: "Open page" })
		.click();
	await page.getByRole("button", { name: "Google preview" }).first().click();
	await expect(page.getByText("To fix: No search description,")).toBeVisible();

	// The editor saves by itself; wait for that save to reach the server.
	const saved = page.waitForResponse(
		(response) =>
			response.url().includes("/_emdash/api/content/") && response.request().method() !== "GET",
	);
	await page.getByRole("textbox", { name: "Meta Description" }).fill("Build products people want.");
	await page.keyboard.press("Tab");
	expect((await saved).ok()).toBe(true);

	await page.goto("/_emdash/admin/plugins/seo/overview");
	await expect(page.getByRole("link", { name: "Open page" })).toHaveCount(2, { timeout: 30_000 });
});
