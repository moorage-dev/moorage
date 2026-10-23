// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The one quiet line at the foot of each Moorage plugin page (`src/help-line.ts` in each
 * package): for Admins only, hidden by a switch in the plugin's own settings.
 */
export const HIDE_SWITCH = "Hide the help line at the foot of this page";

/** The line's three links, found by where they point, in the page's main area. */
export function helpLinks(page: Page): Locator {
	return page.locator("main").locator('a[href^="https://moorage.dev"]');
}

/** The line is there, once, with the guide, the plugins page and the maker. */
export async function expectHelpLine(page: Page, guide: string): Promise<void> {
	const links = helpLinks(page);
	await expect(links).toHaveCount(3);
	await expect(links.nth(0)).toHaveText("Help");
	await expect(links.nth(0)).toHaveAttribute("href", `https://moorage.dev/guides/${guide}`);
	await expect(links.nth(1)).toHaveText("More free plugins");
	await expect(links.nth(1)).toHaveAttribute("href", "https://moorage.dev/plugins");
	await expect(links.nth(2)).toHaveText("by Moorage");
	await expect(links.nth(2)).toHaveAttribute("href", "https://moorage.dev/");
	// They open in a new tab, away from the admin.
	await expect(links.nth(0)).toHaveAttribute("target", "_blank");
}

/**
 * Flip the switch and press the Save of the form it is in. The settings screen must be open.
 * `submit` names the button when it is not "Save".
 */
export async function setHidden(page: Page, hidden: boolean, submit = "Save"): Promise<void> {
	const toggle = page.getByRole("switch", { name: HIDE_SWITCH });
	await expect(toggle).toBeVisible();
	if ((await toggle.isChecked()) !== hidden) await toggle.click();
	const form = page.locator("form").filter({ has: toggle });
	await form.getByRole("button", { name: submit, exact: true }).click();
}
