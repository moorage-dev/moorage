// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Lead Delivery's one-click connect, end to end: the admin sees a code, types it on EmDash's
// approval page (opened empty), presses Authorize, comes back and presses Done, connect; the
// form's webhook is set, the access is thrown away, and a form sent on the site arrives.
//
// One-click is offered only where the site can call its own address, which localhost never can.
// So this runs only under the test-only alias (self-alias.mjs), on its own server and database:
//   DEMO_SITE_PORT=4490 DEMO_SITE_SELF_ALIAS=1 pnpm exec playwright test lead-delivery-connect
// (add DEMO_SITE_IN_PROCESS=1 for the in-process run; DEMO_SITE_SHOTS_DIR=<dir> for screenshots).
// Without the alias, lead-delivery.spec.ts checks that the screen offers only the written way.

const PAGE = "/_emdash/admin/plugins/lead-delivery/enquiries";
const FORM = "lead-test";
const FORM_NAME = "Lead test";

test.skip(process.env.DEMO_SITE_SELF_ALIAS !== "1", "needs DEMO_SITE_SELF_ALIAS=1");
test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;
/** A signed-in page the API calls are made from: only the browser knows the made-up name. */
let apiPage: Page;

async function call(
	method: string,
	path: string,
	data?: unknown,
): Promise<{ status: number; body: any }> {
	return apiPage.evaluate(
		async ([m, p, d]) => {
			const response = await fetch(p as string, {
				method: m as string,
				headers: { "X-EmDash-Request": "1", "content-type": "application/json" },
				...(d === undefined ? {} : { body: JSON.stringify(d) }),
			});
			const text = await response.text();
			let body: unknown = text;
			try {
				body = JSON.parse(text);
			} catch {
				// not JSON
			}
			return { status: response.status, body };
		},
		[method, path, data] as const,
	);
}

const post = (path: string, data: unknown) => call("POST", path, data);

async function devEmails(): Promise<
	Array<{ message: { to: string; subject: string; text: string } }>
> {
	const { body } = await call("GET", "/_emdash/api/dev/emails");
	const data = body?.data;
	return (Array.isArray(data) ? data : (data?.items ?? [])) as Array<{
		message: { to: string; subject: string; text: string };
	}>;
}

async function forms(): Promise<
	Array<{ id: string; slug: string; settings: { webhookUrl?: string } }>
> {
	return (await post("/_emdash/api/plugins/emdash-forms/forms/list", {})).body.data.items;
}

async function formWebhook(): Promise<string | undefined> {
	return (await forms()).find((f) => f.slug === FORM)?.settings.webhookUrl;
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

/** A full-page screenshot of the admin, which scrolls inside its own panel. */
async function shot(page: Page, path: string, width: number) {
	const base = { width, height: width > 400 ? 900 : 844 };
	await page.waitForTimeout(500);
	const tallest = await page.evaluate(() =>
		Math.max(...[...document.querySelectorAll("body *")].map((el) => el.scrollHeight)),
	);
	await page.setViewportSize({ width, height: Math.min(Math.max(tallest, base.height), 5000) });
	await page.waitForTimeout(300);
	await page.screenshot({ path, fullPage: true });
	await page.setViewportSize(base);
}

/** The code on the Connect screen. */
async function shownCode(page: Page): Promise<string> {
	const text = await page
		.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
		.first()
		.textContent();
	return (text ?? "").trim();
}

test.beforeAll(async ({ browser }) => {
	adminContext = await browser.newContext();
	const page = await adminContext.newPage();
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
	await page.close();
	apiPage = await adminContext.newPage();
	await apiPage.goto("/");
	const created = await post("/_emdash/api/plugins/emdash-forms/forms/create", {
		name: FORM_NAME,
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
		settings: { spamProtection: "none" },
	});
	expect(created.status, JSON.stringify(created.body)).toBe(200);
	await call("DELETE", "/_emdash/api/dev/emails");
});

test.afterAll(async () => {
	await adminContext?.close();
});

test("one-click connect: the code screen, an empty approval page, and a denial that changes nothing", async ({
	baseURL,
}) => {
	const shots = process.env.DEMO_SITE_SHOTS_DIR;
	const page = await adminContext.newPage();
	await open(page);
	await page.getByRole("button", { name: "+ New delivery" }).first().click();
	await page
		.getByRole("textbox", { name: /Its short name \(Forms lists it under each form's name\)/ })
		.fill(FORM);
	await page.getByRole("button", { name: "Continue" }).click();
	await page.getByRole("textbox", { name: /Send each enquiry to/ }).fill("orders@acme.test");
	await page.getByRole("button", { name: "Save and send a test" }).click();

	// "Check this site" found that the site can call itself, so the one-step way comes first.
	await expect(page.getByRole("heading", { name: `Connect ${FORM_NAME}` })).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByText("Your code")).toBeVisible();
	const code = await shownCode(page);
	expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
	await expect(page.getByText(`2. Type ${code} in its Device code box.`)).toBeVisible();
	// The link opens EmDash's approval page with nothing filled in, in a new tab.
	const link = page.getByRole("link", { name: "Open the approval page" });
	await expect(link).toHaveAttribute("href", `${baseURL}/_emdash/admin/device`);
	await expect(link).toHaveAttribute("target", "_blank");
	if (shots) await shot(page, `${shots}/connect.png`, 1280);

	// Pressed too early: not approved yet, and the code stays.
	await page.getByRole("button", { name: "Done, connect" }).click();
	await expect(page.getByText(/EmDash has not been approved yet/)).toBeVisible({ timeout: 30_000 });
	expect(await shownCode(page)).toBe(code);

	// EmDash's page opens empty: the admin types the code they just saw.
	const approval = await adminContext.newPage();
	await approval.goto(String(await link.getAttribute("href")));
	await expect(approval.getByRole("heading", { name: "Authorize Device" })).toBeVisible({
		timeout: 60_000,
	});
	await expect(approval.locator("#user-code")).toHaveValue("");
	if (shots) await shot(approval, `${shots}/connect-approval-page-empty.png`, 1280);
	await approval.locator("#user-code").fill(code);
	await expect(approval.getByText("This device is requesting permission to use:")).toBeVisible({
		timeout: 30_000,
	});
	if (shots) await shot(approval, `${shots}/connect-approval-page.png`, 1280);
	await approval.getByRole("button", { name: "Deny" }).click();
	await expect(approval.getByText("Authorization denied")).toBeVisible({ timeout: 30_000 });
	await approval.close();

	await page.getByRole("button", { name: "Done, connect" }).click();
	await expect(page.getByText(/The approval was turned down, so nothing was changed/)).toBeVisible({
		timeout: 30_000,
	});
	expect(await shownCode(page)).not.toBe(code);
	expect(await formWebhook()).toBeUndefined();
	await page.getByRole("button", { name: "Skip for now" }).click();
	await expect(page.getByText(`Not sending yet: ${FORM_NAME} is not connected`)).toBeVisible();
	await page.close();
});

test("one-click connect: approved in EmDash, the form is connected and a form sent on the site arrives", async ({
	browser,
	baseURL,
}) => {
	const shots = process.env.DEMO_SITE_SHOTS_DIR;
	const page = await adminContext.newPage();
	await open(page);
	await page.getByRole("button", { name: "Open" }).first().click();
	await page.getByRole("button", { name: "Connect this form" }).click();
	await expect(page.getByRole("heading", { name: `Connect ${FORM_NAME}` })).toBeVisible();
	const first = await shownCode(page);

	// On a phone: leaving the screen (Open the delivery) throws the code away, so coming back
	// through Connect this form gives a new one.
	const phone = await browser.newContext({
		storageState: await adminContext.storageState(),
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
	});
	const small = await phone.newPage();
	await open(small);
	await small.getByRole("button", { name: "Open" }).first().click();
	await small.getByRole("button", { name: "Connect this form" }).click();
	await expect(small.getByRole("heading", { name: `Connect ${FORM_NAME}` })).toBeVisible();
	const code = await shownCode(small);
	expect(code).not.toBe(first);
	if (shots) await shot(small, `${shots}/connect-phone.png`, 390);
	await phone.close();

	// The desktop screen still shows the old code: Done, connect says which code is current.
	await page.getByRole("button", { name: "Done, connect" }).click();
	await expect(page.getByText(`replaced by a newer one: ${code}`)).toBeVisible({ timeout: 30_000 });
	expect(await shownCode(page)).toBe(code);

	const approval = await adminContext.newPage();
	await approval.goto(`${baseURL}/_emdash/admin/device`);
	await approval.locator("#user-code").fill(code);
	await expect(approval.getByRole("button", { name: "Authorize" })).toBeVisible({
		timeout: 60_000,
	});
	await approval.getByRole("button", { name: "Authorize" }).click();
	await expect(approval.getByText("Device authorized")).toBeVisible({ timeout: 30_000 });
	await approval.close();

	await page.getByRole("button", { name: "Done, connect" }).click();
	await expect(
		page.getByText(
			`${FORM_NAME} is connected. Send yourself an enquiry through it on your site to check.`,
		),
	).toBeVisible({ timeout: 60_000 });
	await expect(
		page.getByRole("heading", { name: `${FORM_NAME} → orders@acme.test` }),
	).toBeVisible();
	await expect(page.getByText(/Not sending yet: Lead test is connected/)).toBeVisible();
	if (shots) await shot(page, `${shots}/connect-done.png`, 1280);
	expect(await formWebhook()).toMatch(
		new RegExp(`^${baseURL}/_emdash/api/plugins/lead-delivery/inbound\\?key=[A-Za-z0-9]{32}$`),
	);
	// Nothing about the access is left in the page.
	expect(await page.content()).not.toMatch(/ec_o[ar]t_|device_code|access_token|refresh_token/);

	// A form sent on the site now reaches the inbox, straight from the form.
	await page.goto("/lead-test");
	await page.getByLabel("Your name").fill("Tom Reyes");
	await page.getByLabel("Email address").fill("tom@example.com");
	await page.getByLabel("Message").fill("Three tiers, lemon and elderflower.");
	await page.getByRole("button", { name: /Submit|Send/ }).click();
	await expect(page.getByText(/Thank you|Thanks/).first()).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			async () =>
				(await devEmails()).some(
					(e) =>
						e.message.to === "orders@acme.test" &&
						e.message.subject.includes("new enquiry from Tom Reyes"),
				),
			{ timeout: 100_000, intervals: [2_000] },
		)
		.toBe(true);
	// No alert about access left behind: it was thrown away.
	expect(JSON.stringify(await devEmails())).not.toContain("could not be thrown away");
	await page.close();
});
