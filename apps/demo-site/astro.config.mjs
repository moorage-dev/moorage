import node from "@astrojs/node";
import react from "@astrojs/react";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { analyticsPlugin } from "@moorage/plugin-analytics";
import seo from "@moorage/plugin-seo";
import icon from "astro-iconset";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

// Web fonts are downloaded from Google at build time, which fails a build whenever
// that download does. This is a test fixture, so it uses system fonts unless asked:
// DEMO_SITE_FONTS=1 pnpm dev   (for screenshots that should look like the stock template)
const webFonts = process.env.DEMO_SITE_FONTS === "1";

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
			plugins: [formsPlugin(), analyticsPlugin()],
			sandboxed: [seo],
			sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
			...(webFonts ? {} : { fonts: false }),
			// Browser tests point this at their own database so they never touch yours.
			database: sqlite({ url: process.env.DEMO_SITE_DB ?? "file:./data.db" }),
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
