import node from "@astrojs/node";
import react from "@astrojs/react";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { analyticsPlugin } from "@moorage/plugin-analytics";
import approvals from "@moorage/plugin-approvals";
import leadDelivery from "@moorage/plugin-lead-delivery";
import { popupsPlugin } from "@moorage/plugin-popups";
import restore from "@moorage/plugin-restore";
import seo from "@moorage/plugin-seo";
import siteHealth from "@moorage/plugin-site-health";
import icon from "astro-iconset";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

import { parseSelfAlias, selfAlias } from "./self-alias.mjs";
import { simulateCloudflare } from "./simulated-cloudflare.mjs";

// Web fonts are downloaded from Google at build time, which fails a build whenever
// that download does. This is a test fixture, so it uses system fonts unless asked:
// DEMO_SITE_FONTS=1 pnpm dev   (for screenshots that should look like the stock template)
const webFonts = process.env.DEMO_SITE_FONTS === "1";

// The SEO plugin runs sandboxed by default. DEMO_SITE_SEO=in-process lists it under plugins: []
// instead, the way a site without a sandbox runner (the Workers free plan) installs it; CI runs
// the SEO browser tests both ways.
// DEMO_SITE_IN_PROCESS=1 moves every sandbox-format plugin into the site's process at once (one CI run);
// DEMO_SITE_<NAME>=in-process still does it for one plugin.
const inProcess = (name) =>
	process.env.DEMO_SITE_IN_PROCESS === "1" || process.env[name] === "in-process";
const seoInProcess = inProcess("DEMO_SITE_SEO");
// The same for Site Health (DEMO_SITE_SITE_HEALTH=in-process).
const healthInProcess = inProcess("DEMO_SITE_SITE_HEALTH");
// Restore the same way (DEMO_SITE_RESTORE=in-process). It never reaches Cloudflare: see simulated-cloudflare.mjs.
const restoreInProcess = inProcess("DEMO_SITE_RESTORE");
const databaseUrl = process.env.DEMO_SITE_DB ?? "file:./data.db";
simulateCloudflare(databaseUrl);
// Test fixture, off by default: lets the site call its own address under a made-up public
// name, for Lead Delivery's one-click connect (see self-alias.mjs).
const alias = parseSelfAlias(process.env.DEMO_SITE_SELF_ALIAS);
selfAlias(process.env.DEMO_SITE_SELF_ALIAS);
// The same for Content Approval (DEMO_SITE_APPROVALS=in-process).
const approvalsInProcess = inProcess("DEMO_SITE_APPROVALS");
// The same for Lead Delivery (DEMO_SITE_LEAD_DELIVERY=in-process).
const leadInProcess = inProcess("DEMO_SITE_LEAD_DELIVERY");

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
				popupsPlugin(),
				...(seoInProcess ? [seo] : []),
				...(healthInProcess ? [siteHealth] : []),
				...(restoreInProcess ? [restore] : []),
				...(approvalsInProcess ? [approvals] : []),
				...(leadInProcess ? [leadDelivery] : []),
			],
			sandboxed: [
				...(seoInProcess ? [] : [seo]),
				...(healthInProcess ? [] : [siteHealth]),
				...(restoreInProcess ? [] : [restore]),
				...(approvalsInProcess ? [] : [approvals]),
				...(leadInProcess ? [] : [leadDelivery]),
			],
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
	...(alias ? { server: { allowedHosts: [alias.host] } } : {}),
});
