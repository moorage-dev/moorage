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

// The fastest of seven: other work on the machine (every package's tests at once) only ever
// slows a run down, so the fastest is the closest to the code's own cost.
function fastest(run: () => void): number {
	const times: number[] = [];
	for (let i = 0; i < 7; i += 1) {
		const start = performance.now();
		run();
		times.push(performance.now() - start);
	}
	return Math.min(...times);
}

describe("CPU per run", () => {
	it("reads the links of a batch of 50 long pages in well under the limit", () => {
		const entries = Array.from({ length: 50 }, (_, i) => bigEntry(i));
		const ms = fastest(() => {
			for (const entry of entries) linksInData(entry, SITE);
		});
		// Milliseconds differ from machine to machine (CI measured 60 where a laptop measures 12),
		// so compare with a fixed piece of work on the same machine: copying the same pages
		// through JSON. Reading the links takes about twice that.
		const copy = fastest(() => {
			for (const entry of entries) JSON.parse(JSON.stringify(entry));
		});
		expect(ms).toBeLessThan(Math.max(copy, 1) * 4);
	});

	it("scans two 200 KB pages in well under the limit", () => {
		const html = `<header><nav>${'<a href="/menu">Menu</a>'.repeat(40)}</nav></header><main>${'<p>Bread and <img src="/a.jpg"> cake.</p>'.repeat(4500)}</main><footer><a href="https://instagram.com/acme">i</a></footer>`;
		const ms = fastest(() => {
			scanHtml(html, SITE);
			scanHtml(html, SITE);
		});
		expect(ms).toBeLessThan(20);
	});
});
