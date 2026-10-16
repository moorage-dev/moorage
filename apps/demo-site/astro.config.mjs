import node from "@astrojs/node";
import react from "@astrojs/react";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { analyticsPlugin } from "@moorage/plugin-analytics";
import restore from "@moorage/plugin-restore";
import seo from "@moorage/plugin-seo";
import icon from "astro-iconset";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

import { simulateCloudflare } from "./simulated-cloudflare.mjs";

// Web fonts are downloaded from Google at build time, which fails a build whenever
// that download does. This is a test fixture, so it uses system fonts unless asked:
// DEMO_SITE_FONTS=1 pnpm dev   (for screenshots that should look like the stock template)
const webFonts = process.env.DEMO_SITE_FONTS === "1";

// The SEO plugin runs sandboxed by default. DEMO_SITE_SEO=in-process lists it under plugins: []
// instead, the way a site without a sandbox runner (the Workers free plan) installs it; CI runs
// the SEO browser tests both ways.
const seoInProcess = process.env.DEMO_SITE_SEO === "in-process";
// Restore the same way (DEMO_SITE_RESTORE=in-process). It never reaches Cloudflare: see simulated-cloudflare.mjs.
const restoreInProcess = process.env.DEMO_SITE_RESTORE === "in-process";
const databaseUrl = process.env.DEMO_SITE_DB ?? "file:./data.db";
simulateCloudflare(databaseUrl);

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		icon({
			// Only ship the Phosphor icons actually referenced in templates,
			// not the full @iconify-json/ph set.
			include: {
				ph: [
					"chart-bar",
					"check-circle",
					"clock",
					"cloud",
					"code",
					"currency-dollar",
					"envelope",
					"globe",
					"heart",
					"lifebuoy",
					"lightning",
					"lock",
					"shield-check",
					"sparkle",
					"star",
					"users-three",
				],
			},
		}),
		emdash({
			plugins: [
				formsPlugin(),
				analyticsPlugin(),
				...(seoInProcess ? [seo] : []),
				...(restoreInProcess ? [restore] : []),
			],
			sandboxed: [...(seoInProcess ? [] : [seo]), ...(restoreInProcess ? [] : [restore])],
			sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
			...(webFonts ? {} : { fonts: false }),
			// Browser tests point this at their own database so they never touch yours.
			database: sqlite({ url: databaseUrl }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
	],
	fonts: webFonts
		? [
				{
					provider: fontProviders.google(),
					name: "Inter",
					cssVariable: "--font-body",
					weights: [400, 500, 600, 700, 800],
					fallbacks: ["sans-serif"],
				},
			]
		: [],
	devToolbar: { enabled: false },
});
