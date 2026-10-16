// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { linksInData, scanHtml } from "../src/extract.js";

// A sandboxed run may use about 50 ms of CPU in all. These are the two heavy
// pieces of a run, timed on inputs larger than a run sees, so a change that
// makes them slow fails here before it fails on a live site.
const SITE = "https://acme.test";

function bigEntry(n: number) {
	return {
		title: `Page ${n}`,
		body: Array.from({ length: 120 }, (_, i) => ({
			_type: "block",
			_key: `b${i}`,
			children: [
				{
					_type: "span",
					_key: `s${i}`,
					text: "Fresh bread every morning. ".repeat(8),
					marks: [`k${i}`],
				},
			],
			markDefs: [
				{ _key: `k${i}`, _type: "link", href: i % 3 ? `/page-${i}` : `https://site${i}.example/x` },
			],
		})),
	};
}

function median(run: () => void): number {
	const times: number[] = [];
	for (let i = 0; i < 7; i += 1) {
		const start = performance.now();
		run();
		times.push(performance.now() - start);
	}
	return [...times].sort((a, b) => a - b)[3] ?? 0;
}

describe("CPU per run", () => {
	it("reads the links of a batch of 50 long pages in well under the limit", () => {
		const entries = Array.from({ length: 50 }, (_, i) => bigEntry(i));
		const ms = median(() => {
			for (const entry of entries) linksInData(entry, SITE);
		});
		expect(ms).toBeLessThan(20);
	});

	it("scans two 200 KB pages in well under the limit", () => {
		const html = `<header><nav>${'<a href="/menu">Menu</a>'.repeat(40)}</nav></header><main>${'<p>Bread and <img src="/a.jpg"> cake.</p>'.repeat(4500)}</main><footer><a href="https://instagram.com/acme">i</a></footer>`;
		const ms = median(() => {
			scanHtml(html, SITE);
			scanHtml(html, SITE);
		});
		expect(ms).toBeLessThan(20);
	});
});
