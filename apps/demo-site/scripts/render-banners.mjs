// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// node scripts/render-banners.mjs <fonts folder>
// Renders each plugin's registry banner, packages/plugin-*/images/banner.svg, to banner.png next to it:
// 3000 x 1000 (twice 1500 x 500) when that stays under 1 MiB, else 1500 x 500. Also renders each
// images/icon.svg to icon.png, 512 x 512 (square; the registry rounds the corners). The SVGs name their fonts
// (Newsreader); <fonts folder> holds the woff2 files moorage.dev uses (moorage-web/src/assets/fonts).
// Run from apps/demo-site (it has Playwright): pnpm --filter demo-site exec node scripts/render-banners.mjs ../../../moorage-web/src/assets/fonts
import { chromium } from "@playwright/test";

const fontsArg = process.argv[2];
if (!fontsArg || !existsSync(resolve(fontsArg, "newsreader-latin-opsz-normal.woff2"))) {
	console.error(
		"Usage: node scripts/render-banners.mjs <folder with newsreader-latin-opsz-normal.woff2>",
	);
	process.exit(1);
}
const fonts = pathToFileURL(`${resolve(fontsArg)}/`).href;
const packages = new URL("../../../packages/", import.meta.url).pathname;
const MiB = 1024 * 1024;
// A file page, so the fonts (file URLs) may load; outside the repository so no dev server reloads.
const tmp = join(tmpdir(), `moorage-banner-${process.pid}.html`);

const browser = await chromium.launch();
for (const dir of readdirSync(packages).filter((d) => d.startsWith("plugin-"))) {
	const svgPath = `${packages}${dir}/images/banner.svg`;
	if (!existsSync(svgPath)) continue;
	const svg = readFileSync(svgPath, "utf8");
	const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Newsreader";src:url("${fonts}newsreader-latin-opsz-normal.woff2") format("woff2");font-weight:200 800}
html,body{margin:0}svg{display:block;font-optical-sizing:auto}
</style></head><body>${svg}</body></html>`;
	const out = `${packages}${dir}/images/banner.png`;
	for (const scale of [2, 1]) {
		const page = await browser.newPage({
			viewport: { width: 1500, height: 500 },
			deviceScaleFactor: scale,
			colorScheme: "light",
		});
		writeFileSync(tmp, html);
		await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
		await page.evaluate(() => document.fonts.ready);
		if (!(await page.evaluate(() => document.fonts.check('66px "Newsreader"')))) {
			throw new Error("Newsreader did not load");
		}
		// Every word stays on the land, left of the shore (x 840).
		const wide = await page.evaluate(() =>
			[...document.querySelectorAll("text")]
				.filter((t) => t.getBBox().x + t.getBBox().width > 840)
				.map((t) => t.textContent),
		);
		if (wide.length) throw new Error(`${dir}: too wide: ${wide.join(" | ")}`);
		await page.locator("svg").screenshot({ path: out });
		await page.close();
		const size = statSync(out).size;
		console.log(`${out} ${1500 * scale}x${500 * scale} ${(size / 1024).toFixed(0)} KB`);
		if (size < MiB) break;
	}
}
for (const dir of readdirSync(packages).filter((d) => d.startsWith("plugin-"))) {
	const svgPath = `${packages}${dir}/images/icon.svg`;
	if (!existsSync(svgPath)) continue;
	writeFileSync(
		tmp,
		`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}svg{display:block}</style></head><body>${readFileSync(svgPath, "utf8")}</body></html>`,
	);
	const page = await browser.newPage({
		viewport: { width: 512, height: 512 },
		colorScheme: "light",
	});
	await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
	const out = `${packages}${dir}/images/icon.png`;
	await page.locator("svg").screenshot({ path: out });
	await page.close();
	console.log(`${out} 512x512 ${(statSync(out).size / 1024).toFixed(0)} KB`);
}
rmSync(tmp, { force: true });
await browser.close();
