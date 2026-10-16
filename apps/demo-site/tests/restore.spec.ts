// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Restore on the demo site, against the simulated Cloudflare in simulated-cloudflare.mjs (the
// demo site never reaches Cloudflare). Runs sandboxed by default, in-process with
// DEMO_SITE_RESTORE=in-process. RESTORE_SCREENSHOTS=1 also writes the listing screenshots.

import { DatabaseSync } from "node:sqlite";

import { expect, test, type Page } from "@playwright/test";

const PORT = Number(process.env.DEMO_SITE_PORT ?? 4399);
const DB = `e2e-${PORT}.db`;
const PAGE = "/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/restore/restore";
const SHOTS =
	process.env.RESTORE_SCREENSHOTS === "1" ? "../../packages/plugin-restore/images" : null;
const HOUR = 3_600_000;

test.describe.configure({ mode: "serial" });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function db(): DatabaseSync {
	return new DatabaseSync(DB);
}

/** Read or change one of Restore's own entries, wherever this mode keeps them. */
function editEntry(
	key: string,
	change: (value: Record<string, unknown>) => Record<string, unknown>,
) {
	const d = db();
	const sandboxed = d
		.prepare(
			"SELECT data FROM _plugin_storage WHERE plugin_id = 'restore' AND collection = '__kv' AND id = ?",
		)
		.get(key) as { data: string } | undefined;
	if (sandboxed) {
		d.prepare(
			"UPDATE _plugin_storage SET data = ? WHERE plugin_id = 'restore' AND collection = '__kv' AND id = ?",
		).run(JSON.stringify(change(JSON.parse(sandboxed.data))), key);
	}
	const inProcess = d
		.prepare("SELECT value FROM options WHERE name = ?")
		.get(`plugin:restore:${key}`) as { value: string } | undefined;
	if (inProcess) {
		d.prepare("UPDATE options SET value = ? WHERE name = ?").run(
			JSON.stringify(change(JSON.parse(inProcess.value))),
			`plugin:restore:${key}`,
		);
	}
	d.close();
	if (!sandboxed && !inProcess) throw new Error(`Restore has no ${key} entry`);
}

async function open(page: Page) {
	await page.goto(PAGE);
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	await expect(page.getByRole("heading", { name: "Restore", exact: true })).toBeVisible({
		timeout: 60_000,
	});
}

async function shot(page: Page, name: string) {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test("before setup it says what it is not, and connecting finds the site and every site the key reaches", async ({
	page,
}) => {
	await open(page);
	await expect(page.getByText("What this does, and what it is not")).toBeVisible();
	await expect(page.getByText("Not an off-site backup")).toBeVisible();
	await expect(page.getByText("Set it up on the day a site launches.")).toBeVisible();
	await expect(page.getByRole("link", { name: /Open Cloudflare to make the key/ })).toHaveAttribute(
		"href",
		/dash\.cloudflare\.com.*permissionGroupKeys/,
	);
	await shot(page, "setup");

	await page.getByLabel("Key from Cloudflare").fill("demo-key");
	await page.getByRole("button", { name: "Check and save" }).click();
	await expect(page.getByText("This key can change 2 sites, not only this one")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText(/demo-site \(this site\), another-site/)).toBeVisible();
	// The demo site has no time zone yet: times are in UTC, and the page says why.
	await expect(
		page.getByText("Times are in UTC, because this site has no time zone set."),
	).toBeVisible();
});

test("going back to just before a change: enquiries first, lost text, tick, red dialog, done, undo", async ({
	page,
}) => {
	// Put the timeline in place: Restore set up two hours ago, then a page edit and an enquiry.
	const d = db();
	d.prepare("UPDATE _emdash_migrations SET timestamp = ?").run(ago(3 * HOUR));
	d.prepare(
		"INSERT INTO options (name, value) VALUES ('site:timezone', '\"Asia/Kolkata\"') ON CONFLICT (name) DO UPDATE SET value = excluded.value",
	).run();
	d.prepare("UPDATE users SET created_at = ?, updated_at = ?").run(ago(3 * HOUR), ago(3 * HOUR));
	// The person dev-bypass signs in ("You"); other specs rename it and leave more users behind.
	const admin = d.prepare("SELECT id FROM users WHERE email = 'dev@emdash.local'").get() as {
		id: string;
	};
	const pricing = d.prepare("SELECT id FROM ec_pages WHERE slug = 'pricing'").get() as {
		id: string;
	};
	d.prepare("UPDATE ec_pages SET created_at = ?, updated_at = ? WHERE slug <> 'pricing'").run(
		ago(3 * HOUR),
		ago(3 * HOUR),
	);
	d.prepare("UPDATE ec_pages SET created_at = ?, updated_at = ? WHERE id = ?").run(
		ago(3 * HOUR),
		ago(40 * 60_000),
		pricing.id,
	);
	d.prepare("UPDATE revisions SET created_at = ?").run(ago(3 * HOUR));
	d.prepare(
		"INSERT INTO revisions (id, collection, entry_id, data, author_id, created_at) VALUES ('e2e-rev', 'pages', ?, '{}', ?, ?)",
	).run(pricing.id, admin.id, ago(40 * 60_000));
	// A good edit after the mistake: its text is shown to copy before going back.
	const home = d.prepare("SELECT id FROM ec_pages WHERE slug = 'home'").get() as { id: string };
	d.prepare("UPDATE ec_pages SET updated_at = ? WHERE id = ?").run(ago(30 * 60_000), home.id);
	d.prepare(
		"INSERT INTO revisions (id, collection, entry_id, data, author_id, created_at) VALUES ('e2e-rev-2', 'pages', ?, '{}', ?, ?)",
	).run(home.id, admin.id, ago(30 * 60_000));
	d.prepare("UPDATE media SET created_at = ?").run(ago(3 * HOUR));
	d.prepare(
		"INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES ('emdash-forms', 'submissions', 'e2e-enquiry', ?, ?, ?)",
	).run(
		JSON.stringify({
			formId: "contact",
			data: { name: "Jane Hollis", email: "jane@example.com" },
			createdAt: ago(20 * 60_000),
		}),
		ago(20 * 60_000),
		ago(20 * 60_000),
	);
	d.close();
	editEntry("connection", (connection) => ({ ...connection, setupAt: ago(2 * HOUR) }));

	await open(page);
	const row = page.getByRole("row", { name: /Pricing \(page\) edited · You/ });
	await expect(row).toBeVisible({ timeout: 60_000 });
	await expect(
		page.getByText("Newest first. Times are in India Standard Time (IST)."),
	).toBeVisible();
	await expect(page.getByRole("row", { name: /Enquiry from a form · A visitor/ })).toBeVisible();
	await shot(page, "pick-a-moment");
	await row.getByRole("button", { name: /^Go back to \d\d:\d\d$/ }).click();

	// Enquiries first: named, and nothing to confirm until they are dealt with.
	await expect(
		page.getByText(/\d+ enquir(y|ies) came in since \d\d:\d\d and will be removed/),
	).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/Jane Hollis \(jane@example\.com\)/)).toBeVisible();
	await expect(page.getByRole("link", { name: /Download in Forms > Submissions/ })).toBeVisible();
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	await page.getByRole("button", { name: /reached us, continue/ }).click();

	// The text of the edit that will be lost, the warning, and the tick before the red button.
	await expect(page.getByText("Text of edits that will be lost")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/Home \(page\), edited by you/)).toBeVisible();
	await expect(
		page.getByText(/Anyone removed since \d\d:\d\d gets their access back/),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /^Put the site back to/ })).toHaveCount(0);
	await page.getByRole("checkbox", { name: /I understand the \d+ changes? made since/ }).check();
	const red = page.getByRole("button", { name: /^Put the site back to \d\d:\d\d$/ });
	await expect(red).toBeVisible({ timeout: 30_000 });
	await shot(page, "review");
	await red.click();

	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText(/changes? made since then will be undone/)).toBeVisible();
	await dialog.getByRole("button", { name: "Put the site back" }).click();

	await expect(page.getByText(/^Done\. Your site is back to /)).toBeVisible({ timeout: 30_000 });
	const undo = page.getByRole("button", { name: "Undo this restore" });
	await expect(undo).toBeVisible();
	await shot(page, "done");

	// Undo is a restore too, with its own dialog. Wait out the one-minute gap between restores.
	const d2 = db();
	const rows = d2
		.prepare(
			"SELECT id, data FROM _plugin_storage WHERE plugin_id = 'restore' AND collection = 'restores'",
		)
		.all() as Array<{
		id: string;
		data: string;
	}>;
	for (const r of rows) {
		d2.prepare(
			"UPDATE _plugin_storage SET data = ? WHERE plugin_id = 'restore' AND collection = 'restores' AND id = ?",
		).run(JSON.stringify({ ...JSON.parse(r.data), at: ago(5 * 60_000) }), r.id);
	}
	d2.close();
	await undo.click();
	await page.getByRole("dialog").getByRole("button", { name: "Undo the restore" }).click();
	await expect(page.getByText(/^Done\. Your site is back to /)).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("row", { name: /Undo done/ })).toBeVisible();
});

test("on a phone, every row keeps its button on screen", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await open(page);
	const buttons = page.getByRole("button", { name: /^(Go back to \d\d:\d\d|Undo)$/ });
	await expect(buttons.first()).toBeVisible({ timeout: 30_000 });
	for (const button of await buttons.all()) {
		const box = await button.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	}
	await shot(page, "phone");
});
