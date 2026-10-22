// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import {
	expect,
	test,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Page,
} from "@playwright/test";

// Lead Delivery on the demo site. No real service is called: the HubSpot delivery is turned off
// before any enquiry, other apps point at a `.invalid` host, and email goes to the dev console
// provider (`/_emdash/api/dev/emails`). On localhost a site cannot call itself, so the email way
// is the one that works end to end here; the web way is posted to directly.

const API = "/_emdash/api/plugins/lead-delivery";
const PAGE = "/_emdash/admin/plugins/lead-delivery/enquiries";
const FORM = "lead-test";

let adminContext: BrowserContext;
let admin: APIRequestContext;

test.describe.configure({ mode: "serial" });

async function signIn(browser: Browser): Promise<void> {
	adminContext = await browser.newContext();
	const page = await adminContext.newPage();
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
	await page.close();
	admin = adminContext.request;
}

async function post(path: string, data: unknown) {
	return admin.post(path, { headers: { "X-EmDash-Request": "1" }, data });
}

type Screen = { blocks: unknown[]; toast?: { message: string; type: string } };

/** One Block Kit interaction, as the admin page sends it. */
async function interact(data: Record<string, unknown>): Promise<Screen> {
	const response = await post(`${API}/admin`, data);
	expect(response.status()).toBe(200);
	return ((await response.json()) as { data: Screen }).data;
}

/** The ids of the deliveries, from the Open buttons on the home table. */
async function deliveryIds(): Promise<string[]> {
	const home = JSON.stringify((await interact({ type: "page_load", page: "/enquiries" })).blocks);
	return [...home.matchAll(/"action_id":"open","label":"Open","value":"([a-z0-9]+)"/g)].map(
		(m) => m[1]!,
	);
}

/** The private key, from the Connect screen's instructions. */
async function privateKey(): Promise<string> {
	const [id] = await deliveryIds();
	const screen = await interact({
		type: "block_action",
		action_id: "connect",
		value: { id, form: FORM },
	});
	const match = /enquiries-([A-Za-z0-9]{32})@lead-delivery\.invalid/.exec(
		JSON.stringify(screen.blocks),
	);
	expect(match).not.toBeNull();
	return match![1]!;
}

async function devEmails(): Promise<
	Array<{ message: { to: string; cc?: string[]; subject: string; text: string } }>
> {
	const response = await admin.get("/_emdash/api/dev/emails");
	const body = (await response.json()) as { data?: { items?: unknown[] } | unknown[] };
	const data = body.data;
	const items = Array.isArray(data) ? data : (data?.items ?? []);
	return items as Array<{ message: { to: string; cc?: string[]; subject: string; text: string } }>;
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

/** The row of the deliveries table (or the log) whose first cell matches. */
function row(page: Page, name: RegExp | string) {
	return page.getByRole("row", { name });
}

/** A row of the Deliveries table on home (the first table). */
function delivery(page: Page, name: RegExp) {
	return page.getByRole("table").first().getByRole("row", { name });
}

test.beforeAll(async ({ browser }) => {
	await signIn(browser);
	await admin.delete("/_emdash/api/dev/emails", { headers: { "X-EmDash-Request": "1" } });
});

test.afterAll(async () => {
	await adminContext?.close();
});

test("the first visit is one page with New delivery, and no tabs", async () => {
	const page = await adminContext.newPage();
	await open(page);
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(page.getByText("Send every enquiry where you work")).toBeVisible();
	await expect(page.getByRole("button", { name: "+ New delivery" })).toHaveCount(1);
	// The page sits under Marketing in the sidebar, as a WordPress user expects.
	await expect(page.getByRole("button", { name: "Marketing" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Lead delivery" })).toHaveAttribute(
		"href",
		"/_emdash/admin/plugins/lead-delivery/enquiries",
	);
	await page.close();
});

test("New delivery: a form by its short name, an inbox, a test, then Connect this form", async () => {
	const page = await adminContext.newPage();
	await open(page);
	await page.getByRole("button", { name: "+ New delivery" }).click();
	await expect(page.getByRole("heading", { name: "New delivery" })).toBeVisible();
	await expect(
		page.getByText("Lead delivery learns your forms' names once one is connected"),
	).toBeVisible();
	// No form is known yet, so only "Another form" is offered, with its short-name box.
	await page
		.getByRole("textbox", { name: /Its short name \(Forms lists it under each form's name\)/ })
		.fill(FORM);
	await expect(page.getByRole("radio", { name: /^Email: an inbox, or several/ })).toBeChecked();
	await page.getByRole("button", { name: "Continue" }).click();

	await expect(page.getByRole("heading", { name: `${FORM} → Email` })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByRole("textbox", { name: /Name \(only admins see it\)/ })).toHaveValue(
		`${FORM} → Email`,
	);
	await page
		.getByRole("textbox", { name: /Send each enquiry to/ })
		.fill("orders@acme.test, anna@acme.test");
	await page.getByRole("button", { name: "Save and send a test" }).click();
	await expect(
		page.getByText(
			`Saved as "${FORM} → 2 inboxes". A test went to orders@acme.test, anna@acme.test`,
		),
	).toBeVisible({ timeout: 30_000 });

	// The form was never connected: the instructions for the web person come next.
	await expect(page.getByRole("heading", { name: `Connect ${FORM}` })).toBeVisible();
	await expect(page.getByText(/notifyEmails/).first()).toBeVisible();
	await expect(page.getByRole("button", { name: "I have done this" })).toBeVisible();
	await page.getByRole("button", { name: "Skip for now" }).click();
	await expect(page.getByRole("heading", { name: `${FORM} → 2 inboxes` })).toBeVisible();
	await expect(page.getByText(`Not sending yet: ${FORM} is not connected`)).toBeVisible();
	await expect(page.getByRole("button", { name: "Connect this form" })).toBeVisible();
	await expect(
		page.getByText("Sent just now. Check the inbox, and the spam folder."),
	).toBeVisible();
	await page.close();
});

test("the email way end to end: a form sent on the site reaches the inbox, the private email never does", async () => {
	const key = await privateKey();
	const privateAddress = `enquiries-${key}@lead-delivery.invalid`;
	const pages = [
		{
			fields: [
				{ id: "name", type: "text", label: "Your name", name: "name", required: true },
				{ id: "email", type: "email", label: "Email address", name: "email", required: true },
				{ id: "message", type: "textarea", label: "Message", name: "message", required: false },
			],
		},
	];
	const created = await post("/_emdash/api/plugins/emdash-forms/forms/create", {
		name: "Lead test",
		slug: FORM,
		pages,
		settings: { spamProtection: "none", notifyEmails: [privateAddress, "owner@acme.test"] },
	});
	if (created.status() === 409) {
		// Another spec made the form first, with its own fields: put these fields back and point
		// its notifications here.
		const list = await post("/_emdash/api/plugins/emdash-forms/forms/list", {});
		const forms = ((await list.json()) as { data: { items: Array<{ id: string; slug: string }> } })
			.data.items;
		const id = forms.find((f) => f.slug === FORM)!.id;
		const updated = await post("/_emdash/api/plugins/emdash-forms/forms/update", {
			id,
			pages,
			settings: {
				spamProtection: "none",
				notifyEmails: [privateAddress, "owner@acme.test"],
				digestEnabled: false,
			},
		});
		expect(updated.ok(), await updated.text()).toBe(true);
	} else {
		expect(created.status()).toBe(200);
	}

	const page = await adminContext.newPage();
	await page.goto("/lead-test");
	await page.getByLabel("Your name").fill("Tom Reyes");
	await page.getByLabel("Email address").fill("tom@example.com");
	await page.getByLabel("Message").fill("Three tiers, lemon and elderflower.");
	await page.getByRole("button", { name: /Submit|Send/ }).click();
	await expect(page.getByText(/Thank you|Thanks/).first()).toBeVisible({ timeout: 30_000 });

	const real = (e: { message: { to: string; subject: string } }) =>
		e.message.to === "orders@acme.test" && e.message.subject.includes("new enquiry");
	await expect
		// Picked up by the every-minute task.
		.poll(async () => (await devEmails()).some(real), { timeout: 100_000, intervals: [2_000] })
		.toBe(true);
	const emails = await devEmails();
	const enquiry = emails.find(real)!.message;
	expect(enquiry.cc).toEqual(["anna@acme.test"]);
	expect(enquiry.subject).toMatch(/: new enquiry from Tom Reyes \(Lead test\)$/);
	expect(enquiry.text).toContain("Message: Three tiers, lemon and elderflower.");
	// No marks, so the email starts as it always did.
	expect(enquiry.text.startsWith("Tom Reyes (tom@example.com) sent the Lead test form")).toBe(true);
	// Nothing reached the email provider for the private domain: not as the recipient, not as a copy.
	expect(JSON.stringify(emails)).not.toContain("@lead-delivery.invalid");
	// The owner's own notification from the forms plugin still arrives, unchanged.
	const own = emails.find((e) => e.message.to === "owner@acme.test")?.message;
	expect(own?.subject).toBe("New submission: Lead test");
	expect(own?.text).toContain("Your name: Tom Reyes");

	await open(page);
	await expect(row(page, /Tom Reyes · lead-test → 2 inboxes/)).toBeVisible();
	await expect(row(page, /Tom Reyes/).getByRole("cell", { name: "Delivered" })).toBeVisible();
	await expect(
		row(page, /lead-test → 2 inboxes · Email/).getByRole("cell", { name: /^Working, last/ }),
	).toBeVisible();
	await page.close();
});

test("the web way: an enquiry posted to the private address is received once", async ({
	request,
}) => {
	const key = await privateKey();
	const body = {
		event: "form.submission",
		formId: FORM,
		formName: "Lead test",
		submissionId: "01WEBWAY000000000000000001",
		data: { name: "Priya Shah", email: "priya@example.com", message: "Hello" },
		files: [],
		submittedAt: new Date().toISOString(),
	};
	const wrong = await request.post(`${API}/inbound?key=${"x".repeat(32)}`, { data: body });
	expect(wrong.status()).toBe(401);
	const first = await request.post(`${API}/inbound?key=${key}`, { data: body });
	expect(await first.text()).toBe("Received.");
	const again = await request.post(`${API}/inbound?key=${key}`, { data: body });
	expect(await again.text()).toBe("Already received.");
});

test("an app that cannot be reached is tried again, never shown in red; marks are shown, not blocked", async ({
	request,
}) => {
	const saved = await interact({
		type: "form_submit",
		action_id: "new_save",
		block_id: `new2:app:${FORM}`,
		values: {
			app: "zapier",
			url: "https://hooks.lead-delivery-test.invalid/catch/1",
			name: "Lead test → App",
		},
	});
	expect(saved.toast?.message).toMatch(
		/^Saved, but the test did not arrive: Zapier did not answer/,
	);
	const key = await privateKey();
	await request.post(`${API}/inbound?key=${key}`, {
		data: {
			event: "form.submission",
			formId: FORM,
			formName: "Lead test",
			submissionId: "01WEBWAY000000000000000002",
			data: {
				name: "Ben Ode",
				email: "ben@mailinator.com",
				message: "Grow your traffic fast! See example.com, example.net and example.org",
			},
			submittedAt: new Date().toISOString(),
		},
	});
	const page = await adminContext.newPage();
	await open(page);
	const zap = row(page, /Ben Ode · Lead test → Zapier/);
	await expect(zap).toBeVisible();
	await expect(zap.getByRole("cell", { name: "Trying again" })).toBeVisible();
	await expect(zap.getByText(/try 2 of 8, next in/)).toBeVisible();
	await expect(zap.getByRole("button", { name: "Send now" })).toBeVisible();
	// A possibly fake address and possibly spam are marked, not dropped.
	await expect(
		row(page, /Ben Ode · lead-test → 2 inboxes .*Possibly fake address · Possibly spam/),
	).toBeVisible();
	// Trying again is not an error.
	await expect(page.locator('[role="alert"]').filter({ hasText: "needs fixing" })).toHaveCount(0);
	await page.close();

	// The marks head the delivered email.
	await expect
		.poll(async () => (await devEmails()).some((e) => e.message.subject.includes("from Ben Ode")), {
			timeout: 100_000,
			intervals: [2_000],
		})
		.toBe(true);
	const marked = (await devEmails()).find((e) => e.message.subject.includes("from Ben Ode"))!;
	expect(marked.message.text.split("\n").slice(0, 2)).toEqual([
		"Marked: possibly fake address · possibly spam",
		"These marks are a guess. Lead delivery still sends marked enquiries.",
	]);
});

test("a delivery's page: two checks, repeats and spam, Edit, and the delete warning", async () => {
	const page = await adminContext.newPage();
	await open(page);
	await row(page, /lead-test → 2 inboxes · Email/)
		.getByRole("button", { name: "Open" })
		.click();
	await expect(page.getByRole("heading", { name: `${FORM} → 2 inboxes` })).toBeVisible();
	await expect(
		page.getByText("Email to orders@acme.test, anna@acme.test · from Lead test · On"),
	).toBeVisible();
	await expect(
		page.getByText(/^Arriving: last one .* \((Tom Reyes|Priya Shah|Ben Ode)\)$/),
	).toBeVisible();
	await expect(page.getByText("Sent", { exact: false }).first()).toBeVisible();

	await page
		.getByRole("radio", { name: "Don't send the same address twice within 24 hours" })
		.click();
	await page.getByRole("switch", { name: /Don't send possibly spam/ }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Saved.", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
	await expect(
		page.getByRole("radio", { name: "Don't send the same address twice within 24 hours" }),
	).toBeChecked();

	await page.getByRole("button", { name: "Delete this delivery" }).click();
	await expect(page.getByText(`Delete ${FORM} → 2 inboxes?`)).toBeVisible();
	await expect(page.getByText(/The form stays connected for its other deliveries\./)).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();

	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(page.getByRole("heading", { name: `Edit ${FORM} → 2 inboxes` })).toBeVisible();
	await expect(page.getByRole("checkbox", { name: "All forms, including new ones" })).toBeVisible();
	await expect(page.getByRole("checkbox", { name: "Lead test" })).toBeChecked();
	await expect(page.getByRole("switch", { name: /^On/ })).toBeChecked();
	await page.getByRole("button", { name: `← Back to ${FORM} → 2 inboxes` }).click();
	await page.getByRole("button", { name: "← Back to Lead delivery" }).click();
	await expect(page.getByRole("heading", { name: "Deliveries" })).toBeVisible();
	await page.close();
});

test("a HubSpot delivery: the paste is read, its form's fields are matched, and a test asks first", async () => {
	const page = await adminContext.newPage();
	await open(page);
	await page.getByRole("button", { name: "+ New delivery" }).click();
	await expect(page.getByRole("heading", { name: "New delivery" })).toBeVisible();
	// The form is known now, by its name.
	await expect(page.getByRole("combobox", { name: "Which form?" })).toContainText("Lead test");
	await page.getByRole("radio", { name: /^HubSpot: each enquiry becomes/ }).click();
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("heading", { name: "Lead test → HubSpot" })).toBeVisible({
		timeout: 30_000,
	});
	await page
		.getByRole("textbox", { name: /Your HubSpot form's share link or embed code/ })
		.fill(
			'hbspt.forms.create({ portalId: "4410287", formId: "9f1c2b3a-1111-2222-3333-444455556666" })',
		);
	await expect(page.getByRole("combobox", { name: "Name", exact: true })).toContainText(
		"First and last name",
	);
	await expect(page.getByRole("switch", { name: /Send a test to HubSpot now/ })).not.toBeChecked();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText(/Found HubSpot account 4410287/)).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("heading", { name: "Lead test → HubSpot" })).toBeVisible();
	// Off, so nothing is ever sent to HubSpot from these tests.
	await page.getByRole("button", { name: "Turn off" }).click();
	await expect(page.getByText("Turned off: nothing is sent until you turn it on")).toBeVisible({
		timeout: 30_000,
	});

	await page.getByRole("button", { name: "Send a test" }).click();
	await expect(page.getByText("Send a test to HubSpot?")).toBeVisible();
	await expect(page.getByText(/This adds a contact called .* to HubSpot/)).toBeVisible();
	await page.getByRole("button", { name: "Not now" }).click();
	await page.close();
});

test("home matches the approved mockup: order, columns, labels", async () => {
	const page = await adminContext.newPage();
	await open(page);
	const headings = page.locator("main").getByRole("heading");
	await expect(headings).toContainText(["Lead delivery", "Deliveries", "Latest enquiries"]);
	await expect(page.getByText("Received", { exact: true })).toBeVisible();
	await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("Needs fixing", { exact: true }).first()).toBeVisible();
	const deliveries = page.getByRole("table").first();
	await expect(deliveries.getByRole("columnheader")).toHaveText(["Delivery", "Status", ""]);
	const zap = deliveries.getByRole("row", { name: /^Lead test → Zapier/ });
	await expect(
		deliveries
			.getByRole("row", { name: /^Lead test → HubSpot/ })
			.getByRole("cell", { name: "Turned off" }),
	).toBeVisible();
	await expect(zap.getByRole("cell", { name: "Trying again" })).toBeVisible();
	await expect(zap.getByRole("button")).toHaveText(["Open"]);
	await expect(page.getByRole("button", { name: "See all enquiries" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Settings for the whole site" })).toBeVisible();

	// Open on a row shows that delivery's own enquiries only.
	await zap.getByRole("button", { name: "Open" }).click();
	await expect(
		page.getByRole("heading", { name: "Enquiries through this delivery" }),
	).toBeVisible();
	await expect(row(page, /Ben Ode/)).toBeVisible();
	await expect(row(page, /2 inboxes/)).toHaveCount(0);
	await page.close();
});

test("on a phone the status and the buttons of every row stay on screen", async ({ browser }) => {
	const phone = await browser.newContext({
		storageState: await adminContext.storageState(),
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	const page = await phone.newPage();
	/** Every status cell and button of the given columns sits inside the table's visible box (it clips). */
	async function allInside(): Promise<void> {
		const tables = page.locator("table");
		await expect(tables.first()).toBeVisible();
		const outside = await tables.evaluateAll((list) =>
			list.flatMap((table) => {
				const box = (table.parentElement ?? table).getBoundingClientRect();
				const right = Math.min(box.right, window.innerWidth);
				return [...table.querySelectorAll("tbody tr")].flatMap((tr) =>
					[...tr.querySelectorAll("td:nth-child(2), td:nth-child(2) > *, td button")]
						.filter((el) => el.getBoundingClientRect().right > right + 0.5)
						.map((el) => el.textContent ?? ""),
				);
			}),
		);
		expect(outside).toEqual([]);
	}
	await open(page);
	await expect(row(page, /Ben Ode · Lead test → Zapier/)).toBeVisible();
	await allInside();
	await delivery(page, /^lead-test → 2 inboxes/)
		.getByRole("button", { name: "Open" })
		.click();
	await expect(page.getByRole("heading", { name: `${FORM} → 2 inboxes` })).toBeVisible();
	await allInside();
	await phone.close();
});

test("the dashboard widget counts this week's enquiries", async () => {
	const widget = await interact({ type: "page_load", page: "widget:enquiries" });
	const text = JSON.stringify(widget.blocks);
	expect(text).toContain('"label":"Received"');
	expect(text).toContain("Open Lead delivery");
});

test("enquiries from a form no delivery takes: a banner, then one choice adds the form and sends them", async ({
	request,
}) => {
	const key = await privateKey();
	await request.post(`${API}/inbound?key=${key}`, {
		data: {
			event: "form.submission",
			formId: "other-form",
			formName: "Other form",
			submissionId: "01WEBWAY000000000000000003",
			data: { name: "Kim Lee", email: "kim@example.com", message: "Hello" },
			submittedAt: new Date().toISOString(),
		},
	});
	const page = await adminContext.newPage();
	await open(page);
	await expect(
		page.getByText("1 enquiry from Other form was not sent: no delivery takes this form"),
	).toBeVisible();
	await expect(
		row(page, /Kim Lee · Other form/).getByRole("cell", { name: "Not sent", exact: true }),
	).toBeVisible();
	await expect(row(page, /Kim Lee · Other form/).getByRole("button")).toHaveCount(0);
	await page.getByRole("button", { name: "Add Other form to a delivery" }).click();
	await expect(
		page.getByRole("heading", { name: "Send the enquiries from Other form" }),
	).toBeVisible();
	await page.getByRole("radio", { name: "Lead test → Zapier" }).click();
	await page.getByRole("button", { name: "Add and send" }).click();
	await expect(
		page.getByText('"Lead test → Zapier" now takes Other form. Sending its enquiry.'),
	).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/was not sent: no delivery takes this form/)).toHaveCount(0);
	await expect(row(page, /Kim Lee · Lead test → Zapier \(Other form\)/)).toBeVisible();
	await page.close();
});

// Screenshots for the README, the registry listing and the comparison with the mockup:
// DEMO_SITE_SCREENSHOTS=1 (optionally DEMO_SITE_SHOTS_DIR=<folder> for the comparison set).
test("screenshots", async ({ browser }) => {
	test.skip(process.env.DEMO_SITE_SCREENSHOTS !== "1", "screenshots only on request");
	const dir = process.env.DEMO_SITE_SHOTS_DIR ?? "../../packages/plugin-lead-delivery/images";
	const emails = await devEmails();
	const marked = emails.find((e) => e.message.subject.includes("from Ben Ode"))!.message;
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
			await page.screenshot({ path: `${dir}/${name}${suffix}.png`, fullPage: true });
			await page.setViewportSize(base);
		};
		await open(page);
		await shot("home");
		await page.getByRole("button", { name: "+ New delivery" }).first().click();
		await expect(page.getByRole("heading", { name: "New delivery" })).toBeVisible();
		await shot("new-delivery");
		await page.getByRole("button", { name: "← Back to Lead delivery" }).click();
		await row(page, /lead-test → 2 inboxes · Email/)
			.getByRole("button", { name: "Open" })
			.click();
		await expect(page.getByRole("heading", { name: `${FORM} → 2 inboxes` })).toBeVisible();
		await shot("delivery");
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await expect(page.getByRole("heading", { name: `Edit ${FORM} → 2 inboxes` })).toBeVisible();
		await shot("edit");
		// The delivered email, as a mail program shows plain text.
		const escape = (s: string) =>
			s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		await page.setContent(
			`<body style="margin:0;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f4f4f5;color:#18181b">
			<div style="max-width:720px;margin:16px auto;background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:16px 18px">
			<div style="font-weight:600;font-size:17px">${escape(marked.subject)}</div>
			<div style="color:#71717a;font-size:13px;margin:4px 0 12px">To: ${escape(marked.to)}${marked.cc?.length ? ` · Copy: ${escape(marked.cc.join(", "))}` : ""}</div>
			<pre style="white-space:pre-wrap;font:inherit;margin:0">${escape(marked.text)}</pre></div></body>`,
		);
		await shot("email");
		await context.close();
	}
});
