// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Page } from "@playwright/test";

/**
 * Make the window as tall as the admin page's content. The admin scrolls inside its own panel,
 * under a top bar, so a full-page screenshot only shows everything when the window is tall enough
 * that no panel scrolls any more. Grows until nothing scrolls (at most `max` CSS px).
 */
export async function growToContent(
	page: Page,
	width: number,
	minHeight: number,
	max = 5000,
): Promise<void> {
	let height = minHeight;
	await page.setViewportSize({ width, height });
	for (let i = 0; i < 6; i += 1) {
		await page.waitForTimeout(300);
		const overflow = await page.evaluate(() =>
			Math.max(
				0,
				...[...document.querySelectorAll("body *")]
					.filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY))
					.map((el) => el.scrollHeight - el.clientHeight),
				document.documentElement.scrollHeight - window.innerHeight,
			),
		);
		if (overflow <= 1 || height >= max) break;
		height = Math.min(height + overflow, max);
		await page.setViewportSize({ width, height });
	}
}
