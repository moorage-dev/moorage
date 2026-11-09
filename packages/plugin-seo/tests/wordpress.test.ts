// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The titles and descriptions EmDash's WordPress Exporter import puts in content fields the page
// does not use (seo_title, seo_description): what the checks would have the owner copy.

import { describe, expect, it } from "vitest";

import { planCopy, stripSiteName } from "../src/wordpress.js";

describe("values the WordPress import left unused", () => {
	it("leaves the site's name off the end of a title, whichever separator WordPress used", () => {
		for (const title of [
			"Our story | Harbour Bakery",
			"Our story - Harbour Bakery",
			"Our story – harbour bakery ",
			"Our story » Harbour Bakery",
		]) {
			expect(stripSiteName(title, "Harbour Bakery")).toBe("Our story");
		}
		// Only at the end, and never down to nothing.
		expect(stripSiteName("Harbour Bakery | Our story", "Harbour Bakery")).toBe(
			"Harbour Bakery | Our story",
		);
		expect(stripSiteName("Harbour Bakery", "Harbour Bakery")).toBe("Harbour Bakery");
		expect(stripSiteName("Our story | Harbour Bakery", "")).toBe("Our story | Harbour Bakery");
		// The name in the SEO settings and EmDash's own name may differ: either is left off.
		expect(
			stripSiteName("Our story | Harbour Bakery", ["Harbour Bakery Ltd", "Harbour Bakery"]),
		).toBe("Our story");
	});

	it("never plans to write over a value in the SEO panel", () => {
		const data = { title: "About", seo_title: "Our story", seo_description: "Bakers." };
		expect(planCopy({ data, seo: { title: "Mine", description: null }, title: "About" })).toEqual({
			description: "Bakers.",
			own: true,
		});
		expect(
			planCopy({ data, seo: { title: "Our story", description: "Bakers." }, title: "About" }),
		).toEqual({ own: false });
		expect(planCopy({ data, seo: undefined, title: "About" })).toBeNull();
	});
});
