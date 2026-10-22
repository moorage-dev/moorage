// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { defineConfig, devices } from "@playwright/test";

// Fixed port, away from Astro's default 4321. Astro silently moves to the next free port when
// its port is taken, so tests aimed at a default port could hit another local project.
// Parallel work (several git worktrees at once) gives each run its own port and database.
const PORT = Number(process.env.DEMO_SITE_PORT ?? 4399);
const DB = `e2e-${PORT}.db`;
// DEMO_SITE_SELF_ALIAS=1 (off by default): serve and browse the site under a made-up public name,
// so it can call its own address (Lead Delivery's one-click connect). See self-alias.mjs. The
// browser maps the name to 127.0.0.1, so the server listens there.
const ALIAS = process.env.DEMO_SITE_SELF_ALIAS === "1" ? "demo-site-self.test" : "";
const LOCAL_URL = ALIAS ? `http://127.0.0.1:${PORT}` : `http://localhost:${PORT}`;
const BASE_URL = ALIAS ? `http://${ALIAS}:${PORT}` : LOCAL_URL;

export default defineConfig({
	testDir: "./tests",
	// The first admin page load on a cold dev server bundles the whole admin app,
	// which alone can take most of Playwright's default 30 seconds on a CI runner.
	timeout: 120_000,
	// One worker: every test shares one dev server and one SQLite file, and the first
	// dev-bypass call on a fresh database creates the admin user.
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// In CI: one line per test as it finishes (the github reporter alone prints nothing until a failure),
	// annotations on failures, and an HTML report the workflow uploads when a run fails.
	reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: BASE_URL,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				...(ALIAS
					? { launchOptions: { args: [`--host-resolver-rules=MAP ${ALIAS} 127.0.0.1`] } }
					: {}),
			},
		},
	],
	webServer: {
		// Dev server, not the built one: the dev-bypass sign-in route only exists in dev.
		// --ignore-lock: Astro allows one dev server per project; this one must start next to yours.
		// A fresh database every run: tests change settings and must not depend on, or alter, your data.
		command: `rm -f ${DB} ${DB}-shm ${DB}-wal && pnpm exec astro dev --port ${PORT} --ignore-lock${ALIAS ? " --host 127.0.0.1" : ""}`,
		url: LOCAL_URL,
		// Never reuse: a server already on this port is not guaranteed to be this site.
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			EMDASH_SITE_URL: BASE_URL,
			DEMO_SITE_DB: `file:./${DB}`,
			DEMO_SITE_SEO: process.env.DEMO_SITE_SEO ?? "",
			DEMO_SITE_SITE_HEALTH: process.env.DEMO_SITE_SITE_HEALTH ?? "",
			DEMO_SITE_RESTORE: process.env.DEMO_SITE_RESTORE ?? "",
			DEMO_SITE_IN_PROCESS: process.env.DEMO_SITE_IN_PROCESS ?? "",
			DEMO_SITE_APPROVALS: process.env.DEMO_SITE_APPROVALS ?? "",
			DEMO_SITE_LEAD_DELIVERY: process.env.DEMO_SITE_LEAD_DELIVERY ?? "",
			DEMO_SITE_SELF_ALIAS: ALIAS ? `${ALIAS}=${LOCAL_URL}` : "",
		},
	},
});
