// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import { expect, test } from "@playwright/test";

const DEV_BYPASS = "/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin";

test("home page serves the seed site", async ({ page }) => {
	const response = await page.goto("/");
	expect(response?.status()).toBe(200);
	await expect(page).toHaveTitle(/Acme/);
});

test("admin is reachable through dev-bypass", async ({ page }) => {
	await page.goto(DEV_BYPASS);
	await expect(page).toHaveURL(/\/_emdash\/admin/);
	// A fresh database greets the new dev admin with a welcome dialog that covers the sidebar.
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	// The admin is a client-rendered app; on a cold dev server Vite bundles it on first load.
	await expect(page.getByRole("link", { name: "Plugins" })).toBeVisible({ timeout: 60_000 });
});

test("seo plugin answers from the sandbox", async ({ page }) => {
	await page.goto(DEV_BYPASS);
	// Plugin routes need the session cookie and the CSRF header.
	const response = await page.request.get("/_emdash/api/plugins/seo/hello", {
		headers: { "X-EmDash-Request": "1" },
	});
	expect(response.status()).toBe(200);
	expect(await response.json()).toEqual({
		success: true,
		data: { greeting: "hello", pluginId: "seo" },
	});
});
