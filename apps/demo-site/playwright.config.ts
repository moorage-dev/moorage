// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import { defineConfig, devices } from "@playwright/test";

// Fixed port, away from Astro's default 4321. Astro silently moves to the next free port when
// its port is taken, so tests aimed at a default port could hit another local project.
const PORT = 4399;
const BASE_URL = `http://localhost:${PORT}`;

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
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: BASE_URL,
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		// Dev server, not the built one: the dev-bypass sign-in route only exists in dev.
		// --ignore-lock: Astro allows one dev server per project; this one must start next to yours.
		// A fresh database every run: tests change settings and must not depend on, or alter, your data.
		command: `rm -f e2e.db e2e.db-shm e2e.db-wal && pnpm exec astro dev --port ${PORT} --ignore-lock`,
		url: BASE_URL,
		// Never reuse: a server already on this port is not guaranteed to be this site.
		reuseExistingServer: false,
		timeout: 120_000,
		env: { EMDASH_SITE_URL: BASE_URL, DEMO_SITE_DB: "file:./e2e.db" },
	},
});
