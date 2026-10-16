// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import {
	expect,
	test,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Page,
} from "@playwright/test";

// Lead Delivery on the demo site. No real service is called: HubSpot places stay off or are
// only confirmed and cancelled, other apps point at a `.invalid` host, and email goes to the
// dev console provider (`/_emdash/api/dev/emails`). On localhost a site cannot call itself, so
// the email way is the one that works end to end here; the web way is posted to directly.

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

/** One Block Kit interaction, as the admin page sends it. */
async function interact(data: Record<string, unknown>) {
	const response = await post(`${API}/admin`, data);
	expect(response.status()).toBe(200);
	return ((await response.json()) as { data: { blocks: unknown[]; toast?: { message: string } } })
		.data;
}

async function privateKey(): Promise<string> {
	const page = await interact({ type: "page_load", page: "/enquiries" });
	const match = /inbound\?key=([A-Za-z0-9]{32})/.exec(JSON.stringify(page.blocks));
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

async function open(page: Page, tab?: string): Promise<void> {
	await page.goto(PAGE);
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole("button", { name: "Get Started" }).click();
	});
	await expect(page.getByRole("tab", { name: "Enquiries", exact: true })).toBeVisible({
		timeout: 60_000,
	});
	if (tab) await page.getByRole("tab", { name: tab, exact: true }).click();
}

test.beforeAll(async ({ browser }) => {
	await signIn(browser);
	await admin.delete("/_emdash/api/dev/emails", { headers: { "X-EmDash-Request": "1" } });
});

test.afterAll(async () => {
	await adminContext?.close();
});

test("the first visit shows three tabs and the three setup steps", async () => {
	const page = await adminContext.newPage();
	await open(page);
	await expect(page.getByRole("tab")).toHaveText([
		"Enquiries",
		"Where enquiries go",
		"Connect forms",
	]);
	await expect(page.getByText("Send every enquiry where you work")).toBeVisible();
	await expect(page.getByText("Step 1: connect your forms.")).toBeVisible();
	await expect(page.getByText("Step 2: choose where enquiries go")).toBeVisible();
	await expect(page.getByText("Step 3: send a test")).toBeVisible();
	// The page sits under Marketing in the sidebar, as a WordPress user expects.
	await expect(page.getByRole("button", { name: "Marketing" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Lead delivery" })).toHaveAttribute(
		"href",
		"/_emdash/admin/plugins/lead-delivery/enquiries",
	);
	await page.close();
});

test("connecting forms: the check recommends the email way on a site that cannot call itself", async () => {
	const page = await adminContext.newPage();
	await open(page, "Connect forms");
	await expect(page.getByText("How a form gets connected")).toBeVisible();
	await expect(page.getByText("Not checked yet")).toBeVisible();
	await page.getByRole("button", { name: "Check this site" }).click();
	await expect(
		page.getByText("Cannot send to its own address, so your forms will hand enquiries over"),
	).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();

	// A form is added by its short name; the site cannot look it up here, which is not an error.
	await page.getByRole("textbox", { name: /Add a form: its short name/ }).fill(FORM);
	await page.getByRole("button", { name: "Add form" }).click();
	await expect(
		page.getByText(
			"Saved. This site could not look the form up, so its fields will be learned from its first enquiry.",
		),
	).toBeVisible({ timeout: 30_000 });
	await expect(
		page.getByRole("cell", { name: `${FORM} (${FORM}) · no enquiry yet` }),
	).toBeVisible();
	await expect(page.getByRole("cell", { name: "Waiting" })).toBeVisible();

	// The instructions name the private email address; the reset is confirmed first.
	await page.getByText("Instructions for your web person").click();
	await expect(page.getByText(/notifyEmails/).first()).toBeVisible();
	await page.getByRole("button", { name: "Reset the private address" }).click();
	await expect(page.getByText("Reset the private address?")).toBeVisible();
	await expect(page.getByText(/Every connected form stops sending to Lead delivery/)).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	await page.close();
});

test("adding an email place through the form", async () => {
	const page = await adminContext.newPage();
	await open(page, "Where enquiries go");
	await expect(page.getByText("Nothing yet. Add a place")).toBeVisible();
	await page.getByRole("button", { name: "Add a place" }).click();
	await expect(page.getByText("Where should enquiries go?")).toBeVisible();
	await page
		.getByRole("textbox", { name: /Send each enquiry to/ })
		.fill("orders@acme.test, anna@acme.test");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Saved.", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("heading", { name: "Email to orders@acme.test" })).toBeVisible();
	await page.getByRole("button", { name: "Back to all places" }).click();
	await expect(
		page.getByRole("cell", { name: /Email to orders@acme\.test · All forms/ }),
	).toBeVisible();
	await expect(page.getByRole("cell", { name: "Not used yet" })).toBeVisible();
	await page.close();
});

test("the email way end to end: a form sent on the site reaches the inbox, the private email never does", async () => {
	const key = await privateKey();
	const privateAddress = `enquiries-${key}@lead-delivery.invalid`;
	const created = await post("/_emdash/api/plugins/emdash-forms/forms/create", {
		name: "Lead test",
		slug: FORM,
		pages: [
			{
				fields: [
					{ id: "name", type: "text", label: "Your name", name: "name", required: true },
					{ id: "email", type: "email", label: "Email address", name: "email", required: true },
					{ id: "message", type: "textarea", label: "Message", name: "message", required: false },
				],
			},
		],
		settings: { spamProtection: "none", notifyEmails: [privateAddress] },
	});
	if (created.status() === 409) {
		// Another spec made the form first: point its notifications here.
		const list = await post("/_emdash/api/plugins/emdash-forms/forms/list", {});
		const forms = ((await list.json()) as { data: { items: Array<{ id: string; slug: string }> } })
			.data.items;
		const id = forms.find((f) => f.slug === FORM)!.id;
		await post("/_emdash/api/plugins/emdash-forms/forms/update", {
			id,
			settings: { notifyEmails: [privateAddress], digestEnabled: false },
		});
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

	await expect
		// Picked up by the every-minute task.
		.poll(async () => (await devEmails()).some((e) => e.message.to === "orders@acme.test"), {
			timeout: 100_000,
			intervals: [2_000],
		})
		.toBe(true);
	const emails = await devEmails();
	const enquiry = emails.find((e) => e.message.to === "orders@acme.test")!.message;
	expect(enquiry.cc).toEqual(["anna@acme.test"]);
	expect(enquiry.subject).toMatch(/: new enquiry from Tom Reyes \(Lead test\)$/);
	expect(enquiry.text).toContain("Message: Three tiers, lemon and elderflower.");
	expect(emails.some((e) => e.message.to.endsWith("@lead-delivery.invalid"))).toBe(false);

	await open(page);
	await expect(
		page.getByRole("cell", { name: /Tom Reyes · Lead test → Email to orders@acme\.test/ }),
	).toBeVisible();
	await expect(page.getByRole("cell", { name: "Delivered" }).first()).toBeVisible();
	await expect(page.getByText("Received", { exact: true })).toBeVisible();
	await page.getByRole("tab", { name: "Connect forms" }).click();
	await expect(page.getByRole("cell", { name: "Connected" })).toBeVisible();
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

test("an app that cannot be reached is tried again, never shown in red", async ({ request }) => {
	const saved = await interact({
		type: "form_submit",
		action_id: "save_place",
		block_id: "place:new",
		values: {
			kind: "app",
			app: "zapier",
			url: "https://hooks.lead-delivery-test.invalid/catch/1",
			name: "Zapier",
			forms: ["all"],
			on: true,
			no_duplicates: false,
		},
	});
	expect(saved.toast?.message).toBe("Saved.");
	const key = await privateKey();
	await request.post(`${API}/inbound?key=${key}`, {
		data: {
			event: "form.submission",
			formId: FORM,
			formName: "Lead test",
			submissionId: "01WEBWAY000000000000000002",
			data: { name: "Ben Ode", email: "ben@mailinator.com" },
			submittedAt: new Date().toISOString(),
		},
	});
	const page = await adminContext.newPage();
	await open(page);
	const row = page.getByRole("row", { name: /Ben Ode · Lead test → Zapier/ });
	await expect(row).toBeVisible();
	await expect(row.getByRole("cell", { name: "Trying again" })).toBeVisible();
	await expect(row.getByText(/try 2 of 8, next in/)).toBeVisible();
	await expect(row.getByRole("button", { name: "Send now" })).toBeVisible();
	// The throwaway address is flagged, not dropped.
	await expect(
		page.getByRole("row", { name: /Ben Ode · Lead test → Email to orders.*Throwaway address/ }),
	).toBeVisible();
	// Trying again is not an error.
	await expect(page.locator('[role="alert"]').filter({ hasText: "could not reach" })).toHaveCount(
		0,
	);
	await page.close();
});

test("a HubSpot place: the paste is read, matching is offered, and a test asks first", async () => {
	const page = await adminContext.newPage();
	await open(page, "Where enquiries go");
	await page.getByRole("button", { name: "Add a place" }).click();
	await page.getByText(/^HubSpot\. Recommended if you use HubSpot/).click();
	await page
		.getByRole("textbox", { name: /Your HubSpot form/ })
		.fill(
			'hbspt.forms.create({ portalId: "4410287", formId: "9f1c2b3a-1111-2222-3333-444455556666" })',
		);
	// Off, so nothing is ever sent to HubSpot from these tests.
	await page.getByRole("switch", { name: /Turned on/ }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText(/Saved\. Found HubSpot account 4410287\./)).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText("HubSpot form in account 4410287")).toBeVisible();
	await expect(page.getByText(/Lead test: 2 of 2 fields matched/)).toBeVisible();

	await page.getByRole("button", { name: "Send a test" }).first().click();
	await expect(page.getByText("Send a test to HubSpot?")).toBeVisible();
	await expect(page.getByText(/This adds a contact called .* to HubSpot/)).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	await page.close();
});

test("on a phone the status and the action of every row stay on screen", async ({ browser }) => {
	const phone = await browser.newContext({
		storageState: await adminContext.storageState(),
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	const page = await phone.newPage();
	await open(page);
	const row = page.getByRole("row", { name: /Ben Ode · Lead test → Zapier/ });
	await expect(row).toBeVisible();
	for (const target of [
		row.getByRole("cell", { name: "Trying again" }),
		row.getByRole("button", { name: "Send now" }),
	]) {
		const box = await target.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	}
	await phone.close();
});

test("the dashboard widget counts this week's enquiries", async () => {
	const widget = await interact({ type: "page_load", page: "widget:enquiries" });
	const text = JSON.stringify(widget.blocks);
	expect(text).toContain('"label":"Received"');
	expect(text).toContain("Open Lead delivery");
});

// Screenshots for the README and the registry listing: DEMO_SITE_SCREENSHOTS=1.
test("screenshots", async ({ browser }) => {
	test.skip(process.env.DEMO_SITE_SCREENSHOTS !== "1", "screenshots only on request");
	const dir = "../../packages/plugin-lead-delivery/images";
	for (const [width, suffix] of [
		[1280, ""],
		[390, "-phone"],
	] as const) {
		const context = await browser.newContext({
			storageState: await adminContext.storageState(),
			viewport: { width, height: width > 400 ? 900 : 844 },
			deviceScaleFactor: 2,
		});
		const page = await context.newPage();
		await open(page);
		await page.waitForTimeout(500);
		await page.screenshot({ path: `${dir}/enquiries${suffix}.png`, fullPage: true });
		await page.getByRole("tab", { name: "Where enquiries go" }).click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: `${dir}/where-enquiries-go${suffix}.png`, fullPage: true });
		await page.getByRole("tab", { name: "Connect forms" }).click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: `${dir}/connect-forms${suffix}.png`, fullPage: true });
		await context.close();
	}
});
