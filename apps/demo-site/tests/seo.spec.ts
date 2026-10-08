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
