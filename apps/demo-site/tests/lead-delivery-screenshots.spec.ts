// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import {
	expect,
	test,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Page,
} from "@playwright/test";

// Lead Delivery's README and registry pictures, on a site set up as a bakery's (no test names):
//   DEMO_SITE_PORT=4499 DEMO_SITE_SCREENSHOTS=1 pnpm --filter demo-site exec playwright test tests/lead-delivery-screenshots.spec.ts
// Skipped otherwise. Run it on its own: it names the site and the admin, and makes its own deliveries.
// DEMO_SITE_SHOTS_DIR=<folder> writes elsewhere (for the comparison with the mockup). The pictures get new
// names when the plugin changes (the website reuses a picture by its file name): <name>-<version>.png.
// No real service is called: HubSpot is turned off before any enquiry, Zapier points at a `.invalid`
// host, and email goes to the dev console provider (`/_emdash/api/dev/emails`).

const SHOTS = process.env.DEMO_SITE_SCREENSHOTS === "1";
const VERSION = "0-4-0";
const API = "/_emdash/api/plugins/lead-delivery";
const PAGE = "/_emdash/admin/plugins/lead-delivery/enquiries";
const FORM = "cake-order";
const FORM_NAME = "Cake order";
const INBOX = `${FORM_NAME} → Shop inbox`;
const H = { "X-EmDash-Request": "1" };

let adminContext: BrowserContext;
let admin: APIRequestContext;

test.describe.configure({ mode: "serial" });
test.skip(!SHOTS, "screenshots only on request");

async function post(path: string, data: unknown) {
	return admin.post(path, { headers: H, data });
}

type Screen = { blocks: unknown[]; toast?: { message: string; type: string } };

async function interact(data: Record<string, unknown>): Promise<Screen> {
	const response = await post(`${API}/admin`, data);
	expect(response.status()).toBe(200);
	return ((await response.json()) as { data: Screen }).data;
}

async function privateKey(): Promise<string> {
	const home = JSON.stringify((await interact({ type: "page_load", page: "/enquiries" })).blocks);
	const id = /"action_id":"open","label":"Open","value":"([a-z0-9]+)"/.exec(home)![1];
	const screen = await interact({
		type: "block_action",
		action_id: "connect",
		value: { id, form: FORM },
	});
	return /enquiries-([A-Za-z0-9]{32})@lead-delivery\.invalid/.exec(
		JSON.stringify(screen.blocks),
	)![1]!;
}

type Email = { message: { to: string; cc?: string[]; subject: string; text: string } };

async function devEmails(): Promise<Email[]> {
	const body = (await (await admin.get("/_emdash/api/dev/emails")).json()) as {
		data?: { items?: unknown[] } | unknown[];
	};
	const data = body.data;
	return (Array.isArray(data) ? data : (data?.items ?? [])) as Email[];
}

async function open(page: Page): Promise<void> {
	await page.goto(PAGE);
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	await expect(page.getByRole("heading", { name: "Lead delivery", exact: true })).toBeVisible({
		timeout: 60_000,
	});
}

function row(page: Page, name: RegExp | string) {
	return page.getByRole("row", { name });
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	adminContext = await browser.newContext();
	const page = await adminContext.newPage();
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
	await page.close();
	admin = adminContext.request;
	const me = (await (await admin.get("/_emdash/api/auth/me", { headers: H })).json()) as {
		data: { id: string };
	};
	const named = await admin.put(`/_emdash/api/admin/users/${me.data.id}`, {
		headers: H,
		data: { name: "Ellen Marsh", email: "ellen@harbourstreetbakery.test" },
	});
	expect(named.ok(), await named.text()).toBe(true);
	const titled = await post("/_emdash/api/settings", { title: "Harbour Street Bakery" });
	expect(titled.ok(), await titled.text()).toBe(true);
	await admin.delete("/_emdash/api/dev/emails", { headers: H });
});

test.afterAll(async () => {
	await adminContext?.close();
});

test("a bakery's deliveries and enquiries", async ({ request }) => {
	test.setTimeout(400_000);
	const page = await adminContext.newPage();
	await open(page);

	// Email: the shop's inbox, with a copy to the owner.
	await page.getByRole("button", { name: "+ New delivery" }).click();
	await page
		.getByRole("textbox", { name: /Its short name \(Forms lists it under each form's name\)/ })
		.fill(FORM);
	await page.getByRole("button", { name: "Continue" }).click();
	const name = page.getByRole("textbox", { name: /Name \(only admins see it\)/ });
	await expect(name).toBeVisible({ timeout: 30_000 });
	await name.fill(INBOX);
	await page
		.getByRole("textbox", { name: /Send each enquiry to/ })
		.fill("orders@harbourstreetbakery.test, ellen@harbourstreetbakery.test");
	await page.getByRole("button", { name: "Save and send a test" }).click();
	await page.getByRole("button", { name: "Skip for now" }).click({ timeout: 30_000 });
	await expect(page.getByRole("heading", { name: INBOX })).toBeVisible();

	// Enquiries arrive the web way (on localhost a site cannot call itself), which teaches the form's name.
	const key = await privateKey();
	const people = [
		[
			"Sam Ode",
			"sam.ode@example.com",
			"A two-tier lemon cake for 40 guests on 14 June. Can you deliver?",
		],
		["Priya Nair", "priya.nair@example.com", "Do you make a gluten-free sourdough?"],
		["Tom Becker", "tom.becker@example.com", "Six dozen cinnamon buns for our office on Friday."],
	] as const;
	let n = 0;
	const send = async (who: string, email: string, message: string) => {
		n++;
		const sent = await request.post(`${API}/inbound?key=${key}`, {
			data: {
				event: "form.submission",
				formId: FORM,
				formName: FORM_NAME,
				submissionId: `01SHOTS0000000000000000${String(n).padStart(3, "0")}`,
				data: { name: who, email, message },
				files: [],
				submittedAt: new Date().toISOString(),
			},
		});
		expect(await sent.text()).toBe("Received.");
	};
	for (const [who, email, message] of people) await send(who, email, message);

	// Zapier, for the order spreadsheet; its address cannot be reached, so it is tried again.
	await interact({
		type: "form_submit",
		action_id: "new_save",
		block_id: `new2:app:${FORM}`,
		values: {
			app: "zapier",
			url: "https://hooks.lead-delivery-test.invalid/catch/1",
			name: `${FORM_NAME} → Order sheet`,
		},
	});

	// HubSpot, read from its embed code, then turned off so nothing is ever sent there.
	await open(page);
	await page.getByRole("button", { name: "+ New delivery" }).click();
	await expect(page.getByRole("combobox", { name: "Which form?" })).toContainText(FORM_NAME);
	await page.getByRole("radio", { name: /^HubSpot: each enquiry becomes/ }).click();
	await page.getByRole("button", { name: "Continue" }).click();
	await page
		.getByRole("textbox", { name: /Your HubSpot form's share link or embed code/ })
		.fill(
			'hbspt.forms.create({ portalId: "4410287", formId: "9f1c2b3a-1111-2222-3333-444455556666" })',
		);
	await expect(page.getByRole("combobox", { name: "Name", exact: true })).toContainText(
		"First and last name",
	);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText(/Found HubSpot account 4410287/)).toBeVisible({ timeout: 30_000 });
	await page.getByRole("button", { name: "Turn off" }).click();
	await expect(page.getByText("Turned off: nothing is sent until you turn it on")).toBeVisible({
		timeout: 30_000,
	});

	// One more, after Zapier was added, and one that looks like spam: marked, still sent.
	await send(
		"Ana Lima",
		"ana.lima@example.com",
		"Birthday cake, chocolate, 'Happy 7th Leo' on top.",
	);
	await send(
		"Rank Boost",
		"seo@mailinator.com",
		"Grow your traffic fast! See example.com, example.net and example.org",
	);

	// Wait for the every-minute run: the inbox has its enquiries, Zapier is on its second try.
	await expect
		.poll(
			async () =>
				(await devEmails()).filter(
					(e) =>
						e.message.to === "orders@harbourstreetbakery.test" &&
						e.message.subject.includes("new enquiry"),
				).length,
			{ timeout: 150_000, intervals: [3_000] },
		)
		.toBeGreaterThanOrEqual(5);
	await open(page);
	await expect(async () => {
		await page.reload();
		await expect(
			row(page, /Ana Lima · Cake order → Order sheet/).getByText(/try 2 of 8/),
		).toBeVisible({
			timeout: 5_000,
		});
	}).toPass({ timeout: 150_000, intervals: [3_000] });
	await page.close();
});

test("screenshots", async ({ browser }) => {
	const dir = process.env.DEMO_SITE_SHOTS_DIR ?? "../../packages/plugin-lead-delivery/images";
	const sam = (await devEmails()).find(
		(e) =>
			e.message.to === "orders@harbourstreetbakery.test" &&
			e.message.subject.includes("from Sam Ode"),
	)!.message;
	for (const [width, suffix] of [
		[1280, ""],
		[390, "-phone"],
	] as const) {
		const context = await browser.newContext({
			storageState: await adminContext.storageState(),
			viewport: { width, height: width > 400 ? 900 : 844 },
			deviceScaleFactor: 2,
			colorScheme: "light",
		});
		const page = await context.newPage();
		const base = { width, height: width > 400 ? 900 : 844 };
		const shot = async (name: string) => {
			await page.waitForTimeout(500);
			// The admin scrolls inside its own panel, so a full-page shot needs a viewport as tall as it.
			const tallest = await page.evaluate(() =>
				Math.max(...[...document.querySelectorAll("body *")].map((el) => el.scrollHeight)),
			);
			await page.setViewportSize({ width, height: Math.min(Math.max(tallest, base.height), 5000) });
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${dir}/${name}-${VERSION}${suffix}.png`, fullPage: true });
			await page.setViewportSize(base);
		};
		await open(page);
		await shot("home");
		await page.getByRole("button", { name: "+ New delivery" }).first().click();
		await expect(page.getByRole("heading", { name: "New delivery" })).toBeVisible();
		await shot("new-delivery");
		await page.getByRole("button", { name: "← Back to Lead delivery" }).click();
		await page
			.getByRole("table")
			.first()
			.getByRole("row", { name: new RegExp(`^${INBOX}`) })
			.getByRole("button", { name: "Open" })
			.click();
		await expect(page.getByRole("heading", { name: INBOX })).toBeVisible();
		await shot("delivery");
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await expect(page.getByRole("heading", { name: `Edit ${INBOX}` })).toBeVisible();
		await shot("edit");
		// The delivered email, as a mail program shows plain text.
		const escape = (s: string) =>
			s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		await page.setContent(
			`<body style="margin:0;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f4f4f5;color:#18181b">
			<div style="max-width:720px;margin:16px auto;background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:16px 18px">
			<div style="font-weight:600;font-size:17px">${escape(sam.subject)}</div>
			<div style="color:#71717a;font-size:13px;margin:4px 0 12px">To: ${escape(sam.to)}${sam.cc?.length ? ` · Copy: ${escape(sam.cc.join(", "))}` : ""}</div>
			<pre style="white-space:pre-wrap;font:inherit;margin:0">${escape(sam.text)}</pre></div></body>`,
		);
		await shot("email");
		await context.close();
	}
});
