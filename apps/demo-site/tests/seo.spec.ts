// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

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

// The last two tests change the Contact page and, for a moment, the Pages collection.
test("an entry's own markup joins the one graph, and a hidden page has no page nodes", async ({
	page,
	baseURL,
}) => {
	await openSeoPage(page);
	const headers = { "X-EmDash-Request": "1" };
	const api = "/_emdash/api";
	const eventId = `${baseURL}/contact#open-day`;

	// The seed has no JSON-LD field; add one for this test. The dev server rewrites
	// emdash-env.d.ts when a collection changes, so the field is removed again below.
	const added = await page.request.post(`${api}/schema/collections/pages/fields`, {
		headers,
		data: { slug: "json_ld", label: "JSON-LD", type: "json" },
	});
	expect(added.ok()).toBe(true);
	try {
		const list = await page.request.get(`${api}/content/pages`, { headers });
		const pages = (await list.json()) as { data: { items: Array<{ id: string; slug: string }> } };
		const contact = pages.data.items.find((item) => item.slug === "contact");
		expect(contact).toBeDefined();

		const saved = await page.request.put(`${api}/content/pages/${contact?.id}`, {
			headers,
			data: {
				data: {
					json_ld: {
						"@context": "https://schema.org",
						"@type": "Event",
						"@id": eventId,
						name: "Open day",
					},
				},
			},
		});
		expect(saved.ok()).toBe(true);
		const published = await page.request.post(`${api}/content/pages/${contact?.id}/publish`, {
			headers,
		});
		expect(published.ok()).toBe(true);

		// The plugin picks the change up just after the save, so ask until it is there.
		// The first node is the site itself, whose type an earlier test changed.
		await expect
			.poll(async () => {
				await page.goto("/contact");
				const scripts = await jsonLdScripts(page);
				return scripts.length === 1
					? graphOf(scripts[0])
							.slice(1)
							.map((node) => node["@type"])
					: scripts;
			})
			.toEqual(["WebSite", "WebPage", "BreadcrumbList", "Event"]);

		const graph = graphOf((await jsonLdScripts(page))[0]);
		// The node sits in the graph without its own @context, and the page points at it.
		expect(graph[4]).toEqual({ "@type": "Event", "@id": eventId, name: "Open day" });
		expect(graph[2]?.mainEntity).toEqual({ "@id": eventId });
	} finally {
		const removed = await page.request.delete(`${api}/schema/collections/pages/fields/json_ld`, {
			headers,
		});
		expect(removed.ok()).toBe(true);
	}

	// A page kept out of search still has one script, describing the site only.
	await page.goto("/lead-test");
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^noindex/);
	const hidden = await jsonLdScripts(page);
	expect(hidden).toHaveLength(1);
	const siteOnly = graphOf(hidden[0]);
	expect(siteOnly).toHaveLength(2);
	expect(siteOnly[0]?.["@id"]).toBe(`${baseURL}/#organization`);
	expect(siteOnly[1]?.["@type"]).toBe("WebSite");
});

test("a page's own picture is described with its size, and a picture the theme shares is not asked for", async ({
	page,
	baseURL,
}) => {
	await openSeoPage(page);
	const headers = { "X-EmDash-Request": "1" };
	const api = "/_emdash/api";
	const NO_PICTURE = "This page has no picture for shared links";
	// The Overview's folded list of pages that are fine but could be better.
	const worthALook = async (): Promise<string> => {
		await page.goto("/_emdash/admin/plugins/seo/overview");
		await expect(page.getByText("Pages checked")).toBeVisible({ timeout: 30_000 });
		const fold = page.getByText(/^Worth a look \(/);
		if ((await fold.count()) === 0) return "";
		await fold.click();
		const table = page.getByRole("table").filter({ hasText: "Could be better" });
		await expect(table).toBeVisible();
		return (await table.getByRole("row").allInnerTexts()).join("\n");
	};

	// A real picture of a known size, uploaded the way the media library does it.
	const picture = await page.screenshot({ clip: { x: 0, y: 0, width: 320, height: 200 } });
	const upload = await page.request.post(`${api}/media`, {
		headers,
		multipart: {
			file: { name: "cover.png", mimeType: "image/png", buffer: picture },
		},
	});
	expect(upload.ok(), await upload.text()).toBe(true);
	const media = ((await upload.json()) as { data: { item: Record<string, unknown> } }).data.item;
	const storageKey = String(media.storageKey);

	// The seed has no image field; add one for this test (contact.astro passes `cover` on as
	// the page's picture) and take it away again below, as the dev server rewrites emdash-env.d.ts.
	const added = await page.request.post(`${api}/schema/collections/pages/fields`, {
		headers,
		data: { slug: "cover", label: "Cover", type: "image" },
	});
	expect(added.ok(), await added.text()).toBe(true);
	try {
		const list = await page.request.get(`${api}/content/pages`, { headers });
		const pages = (await list.json()) as { data: { items: Array<{ id: string; slug: string }> } };
		const contact = pages.data.items.find((item) => item.slug === "contact");
		expect(contact).toBeDefined();
		const save = async (data: Record<string, unknown>) => {
			const saved = await page.request.put(`${api}/content/pages/${contact?.id}`, {
				headers,
				data: { data, seo: { description: "How to reach the team, and where to find us." } },
			});
			expect(saved.ok(), await saved.text()).toBe(true);
			const published = await page.request.post(`${api}/content/pages/${contact?.id}/publish`, {
				headers,
			});
			expect(published.ok()).toBe(true);
		};

		// With a description and no picture, Contact is fine but "worth a look".
		await save({ cover: null });
		const asked = new RegExp(`Contact.*${NO_PICTURE}`);
		await expect.poll(worthALook, { timeout: 30_000 }).toMatch(asked);

		// Give the entry a picture. The saved entry is checked without knowing what the theme
		// will do with that field; only a render shows that it is shared.
		// Only the media id is sent: EmDash fills in the size and the storage key when it saves
		// an image field, which is what the plugin reads.
		await save({ cover: { id: String(media.id) } });
		const imageUrl = `${baseURL}/_emdash/api/media/file/${storageKey}`;
		await expect
			.poll(async () => {
				await page.goto("/contact");
				const graph = graphOf((await jsonLdScripts(page))[0]);
				return graph.find((node) => node["@type"] === "ImageObject") ?? null;
			})
			.toEqual({
				"@type": "ImageObject",
				"@id": imageUrl,
				url: imageUrl,
				contentUrl: imageUrl,
				width: 320,
				height: 200,
			});
		// It is the picture shared links show, and still the only script.
		await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", imageUrl);
		expect(await jsonLdScripts(page)).toHaveLength(1);
		const webpage = graphOf((await jsonLdScripts(page))[0]).find(
			(node) => node["@id"] === `${baseURL}/contact`,
		);
		expect(webpage?.primaryImageOfPage).toEqual({ "@id": imageUrl });

		// Having been rendered with a picture, Contact is no longer asked for one...
		// (It may still be listed for other advice, such as having little text.)
		await expect.poll(worthALook, { timeout: 30_000 }).not.toMatch(asked);
		// ...and a full check, which reads saved entries only, does not bring the advice back.
		await page.getByRole("button", { name: "Check all pages again" }).click();
		await expect(page.getByText("All pages checked.")).toBeVisible({ timeout: 60_000 });
		expect(await worthALook()).not.toMatch(asked);
	} finally {
		const removed = await page.request.delete(`${api}/schema/collections/pages/fields/cover`, {
			headers,
		});
		const deleted = await page.request.delete(`${api}/media/${String(media.id)}`, { headers });
		expect(removed.ok()).toBe(true);
		expect(deleted.ok()).toBe(true);
	}
});
