// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

// Content Approval with three people: Ellen (Admin, approves), Sam (Editor, writes) and
// Jo (Contributor). Dev sign-in only ever makes an Admin, so each person signs in once,
// takes a name of their own, and Ellen then gives Sam and Jo their roles.

const API = "/_emdash/api";
const HEADERS = { "X-EmDash-Request": "1" };
const APPROVALS = "/_emdash/admin/plugins/approvals/overview";
const ROLE = { contributor: 20, editor: 40 };

// APPROVALS_SCREENSHOTS=1 also saves the listing screenshots into the plugin's images folder.
const SCREENSHOTS = process.env.APPROVALS_SCREENSHOTS === "1";
const IMAGES = new URL("../../../packages/plugin-approvals/images/", import.meta.url);

async function shot(
	page: Page,
	name: string,
	width: 1280 | 390 = 1280,
	top?: ReturnType<Page["getByText"]>,
): Promise<void> {
	if (!SCREENSHOTS) return;
	const size = page.viewportSize();
	await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
	// Let the layout settle and any toast finish sliding in.
	await page.waitForTimeout(800);
	if (top) await top.evaluate((element) => element.scrollIntoView({ block: "start" }));
	await page.screenshot({ path: new URL(`${name}.png`, IMAGES).pathname });
	if (size) await page.setViewportSize(size);
}

interface Person {
	context: BrowserContext;
	page: Page;
	id: string;
}

async function signIn(browser: Browser): Promise<Person> {
	const context = await browser.newContext();
	const page = await context.newPage();
	const welcome = page.getByRole("dialog", { name: /Welcome to EmDash/ });
	// Several people's pages share one browser; only the page in front runs its animations,
	// so the welcome dialog only finishes closing there.
	await page.addLocatorHandler(
		welcome,
		async () => {
			await page.bringToFront();
			await welcome.getByRole("button", { name: "Get Started" }).click();
		},
		{ noWaitAfter: true },
	);
	// EmDash lets one person edit a page at a time; whoever opens it last takes it over.
	const elsewhere = page
		.getByRole("alertdialog")
		.or(page.getByRole("dialog"))
		.filter({ hasText: "This entry is open somewhere else" });
	await page.addLocatorHandler(elsewhere, async () => {
		await page.bringToFront();
		await elsewhere.getByRole("button", { name: "Take over" }).click();
	});
	// Sign in on the public site, and dismiss the welcome dialog before the admin ever opens.
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/");
	await page.waitForURL((url) => url.pathname === "/");
	const dismissed = await page.request.post(`${API}/auth/me`, {
		headers: HEADERS,
		data: { action: "dismissWelcome" },
	});
	expect(dismissed.ok(), await dismissed.text()).toBe(true);
	const me = await page.request.get(`${API}/auth/me`, { headers: HEADERS });
	expect(me.ok()).toBe(true);
	const id = ((await me.json()) as { data: { id: string } }).data.id;
	return { context, page, id };
}

async function updateUser(by: Person, id: string, data: Record<string, unknown>): Promise<void> {
	const response = await by.page.request.put(`${API}/admin/users/${id}`, {
		headers: HEADERS,
		data,
	});
	expect(response.ok(), await response.text()).toBe(true);
}

async function createPage(by: Person, title: string, headline: string): Promise<string> {
	const response = await by.page.request.post(`${API}/content/pages`, {
		headers: HEADERS,
		data: {
			slug: title.toLowerCase().replaceAll(" ", "-"),
			data: {
				title,
				content: [
					{
						_type: "marketing_hero",
						_version: 1,
						_key: "hero",
						headline,
						subheadline: "",
						centered: false,
					},
				],
			},
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { data: { item: { id: string } } }).data.item.id;
}

async function editHeadline(by: Person, id: string, headline: string): Promise<void> {
	const response = await by.page.request.put(`${API}/content/pages/${id}`, {
		headers: HEADERS,
		data: {
			data: {
				content: [
					{
						_type: "marketing_hero",
						_version: 1,
						_key: "hero",
						headline,
						subheadline: "",
						centered: false,
					},
				],
			},
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
}

async function publishByApi(by: Person, id: string): Promise<{ ok: boolean; message: string }> {
	const response = await by.page.request.post(`${API}/content/pages/${id}/publish`, {
		headers: HEADERS,
	});
	const body = (await response.json()) as { error?: { message: string } };
	return { ok: response.ok(), message: body.error?.message ?? "" };
}

async function status(by: Person, id: string): Promise<string> {
	const response = await by.page.request.get(`${API}/content/pages/${id}`, { headers: HEADERS });
	return ((await response.json()) as { data: { item: { status: string } } }).data.item.status;
}

/** Put this person's page in front, where it animates and takes clicks. */
async function front(person: Person): Promise<Page> {
	await person.page.bringToFront();
	return person.page;
}

async function openPanel(person: Person, id: string): Promise<void> {
	await front(person);
	await person.page.goto(`/_emdash/admin/content/pages/${id}`);
	await person.page.getByRole("button", { name: "Approval", exact: true }).click();
}

/** Leave the editor, which hands the page's edit lock back. */
async function leave(person: Person): Promise<void> {
	const released = person.page.waitForResponse(
		(response) => response.url().includes("/lock") && response.request().method() === "DELETE",
		{ timeout: 10_000 },
	);
	await person.page.goto(APPROVALS);
	await released.catch(() => undefined);
}

test.describe.serial("Content Approval", () => {
	// Three people's admin pages on one dev server, each opening the editor: slow when cold.
	test.describe.configure({ timeout: 240_000 });
	let ellen: Person;
	let sam: Person;
	let jo: Person;
	const created: string[] = [];

	test.beforeAll(async ({ browser }) => {
		test.setTimeout(180_000);
		ellen = await signIn(browser);
		await updateUser(ellen, ellen.id, { name: "Ellen Marsh", email: "ellen@agency.test" });
		sam = await signIn(browser);
		await updateUser(sam, sam.id, { name: "Sam Reyes", email: "sam@bakery.test" });
		await updateUser(ellen, sam.id, { role: ROLE.editor });
		jo = await signIn(browser);
		await updateUser(jo, jo.id, { name: "Jo Park", email: "jo@bakery.test" });
		await updateUser(ellen, jo.id, { role: ROLE.contributor });
	});

	test.afterAll(async () => {
		// Leave the site as the other tests expect it: nothing held, no extra pages.
		const off = await ellen.page.request.post(`${API}/plugins/approvals/admin`, {
			headers: HEADERS,
			data: {
				type: "form_submit",
				action_id: "save_settings",
				values: { collections: [], ai: false },
			},
		});
		expect(off.ok(), await off.text()).toBe(true);
		for (const id of created) {
			const trashed = await ellen.page.request.delete(`${API}/content/pages/${id}`, {
				headers: HEADERS,
			});
			expect(trashed.ok(), await trashed.text()).toBe(true);
			const gone = await ellen.page.request.delete(`${API}/content/pages/${id}/permanent`, {
				headers: HEADERS,
			});
			expect(gone.ok(), await gone.text()).toBe(true);
		}
		for (const person of [ellen, sam, jo]) await person?.context.close();
	});

	test("the Settings tab states the gaps in plain words, and turns approval on", async () => {
		const page = await front(ellen);
		await page.goto(APPROVALS);
		// Before anything is saved an admin lands on Settings.
		await expect(page.getByText("Approval is off until you save these settings")).toBeVisible({
			timeout: 60_000,
		});
		await expect(
			page.getByText("Others need my OK before publishing (recommended for agencies)"),
		).toBeVisible();
		await expect(page.getByText("I need someone else's OK before publishing")).toBeVisible();
		await expect(
			page.getByText("AI tools connected to your site always need a person's OK"),
		).toBeVisible();
		await expect(page.getByRole("heading", { name: "What approval can't hold" })).toBeVisible();
		await expect(
			page.getByText(/The SEO panel, categories, tags and bylines of a page that is already live/),
		).toBeVisible();
		// No developer words on the owner's page.
		await expect(page.getByText(/MCP|slug|webhook|fingerprint/)).toHaveCount(0);

		await page.getByRole("checkbox", { name: "Pages" }).check();
		await shot(page, "settings");
		await shot(page, "settings-phone", 390);
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(
			page.getByText("Saved. Publishing now asks for approval where you chose."),
		).toBeVisible();
		await expect(page.getByText("Approval is off until you save these settings")).toHaveCount(0);
	});

	let menu: string;

	test("Sam presses Publish: held, with the good news first, and a request is made", async () => {
		menu = await createPage(sam, "Summer menu", "Iced coffee 3.20 and lemon tart");
		created.push(menu);
		const page = await front(sam);
		await page.goto(`/_emdash/admin/content/pages/${menu}`);
		// The toolbar carries the plugin's own button next to EmDash's.
		await expect(page.getByRole("button", { name: "Ask for approval" })).toBeVisible({
			timeout: 60_000,
		});
		await page.getByRole("button", { name: "Publish now" }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Publish now" }).click();
		await expect(page.getByText("Failed to publish")).toBeVisible();
		await expect(
			page.getByText(/^Sent for approval\. Not live yet\. Ellen Marsh has been asked/),
		).toBeVisible();
		await shot(page, "held-publish");
		expect(await status(sam, menu)).toBe("draft");

		await page.getByRole("button", { name: "Approval", exact: true }).click();
		await expect(page.getByText("Waiting for approval", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: "Add a note for the approver (optional)" }),
		).toBeVisible();

		// The approver was emailed; the subject starts with the site's name.
		// Sam leaves the editor, which frees the page for others to open.
		await page.goto(APPROVALS);
		await expect(page.getByText("Summer menu", { exact: true })).toBeVisible({ timeout: 60_000 });

		// The email goes out from a one-shot task a moment after the publish was held.
		await expect
			.poll(
				async () => {
					const mail = await page.request.get(`${API}/dev/emails`, { headers: HEADERS });
					const body = (await mail.json()) as {
						data: { items: Array<{ message: { subject: string; to: string } }> };
					};
					return body.data.items
						.filter((m) => m.message.to === "ellen@agency.test")
						.map((m) => m.message.subject);
				},
				{ timeout: 90_000 },
			)
			// The site was named during setup, after the plugin started, so its address stands in.
			.toContainEqual(
				expect.stringMatching(
					/^(Acme|localhost:\d+): Sam Reyes asked you to approve "Summer menu"$/,
				),
			);
	});

	test("Ellen sees the row with its Review button on a phone, and the review in words", async () => {
		const page = await front(ellen);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(APPROVALS);
		await expect(page.getByText("Summer menu", { exact: true })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText(/Pages · asked by Sam Reyes/)).toBeVisible();
		const review = page.getByRole("button", { name: "Review", exact: true });
		const box = await review.boundingBox();
		expect(box).not.toBeNull();
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
		await shot(page, "waiting-phone", 390);
		await shot(page, "waiting");
		await page.setViewportSize({ width: 1280, height: 900 });

		await review.click();
		await expect(page.getByText("What changes when this goes live")).toBeVisible();
		await expect(page.getByText("New page: not live before.")).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve and publish" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
		await expect(page.getByText("Approve without review (admins)")).toBeVisible();
		await shot(page, "review");
		await shot(page, "review-phone", 390);
	});

	test("Ellen sends it back from the panel; the form inside the editor does not save the page", async () => {
		const page = await front(ellen);
		await openPanel(ellen, menu);
		await expect(page.getByText("Waiting for your approval")).toBeVisible();
		let saves = 0;
		page.on("request", (request) => {
			if (request.method() === "PUT" && request.url().includes(`/content/pages/${menu}`)) saves++;
		});
		await page
			.getByRole("textbox", { name: /Or send it back: what should Sam change\?/ })
			.fill("Iced coffee is 3.40 from Monday.");
		await page.getByRole("button", { name: "Send back" }).click();
		await expect(page.getByText("Sent back to Sam with your note.")).toBeVisible();
		expect(saves).toBe(0);

		await openPanel(sam, menu);
		await expect(sam.page.getByText(/^Sent back by Ellen Marsh/)).toBeVisible();
		await expect(
			sam.page.getByText('"Iced coffee is 3.40 from Monday."', { exact: true }).first(),
		).toBeVisible();
		await leave(sam);
	});

	test("Sam fixes it, Ellen approves and publishes in one step", async () => {
		await editHeadline(sam, menu, "Iced coffee 3.40 and lemon tart");
		const held = await publishByApi(sam, menu);
		expect(held.ok).toBe(false);
		expect(held.message).toMatch(/^Sent for approval\. Not live yet\./);

		const page = await front(ellen);
		await openPanel(ellen, menu);
		await expect(page.getByText("Waiting for your approval")).toBeVisible();
		await page.getByRole("button", { name: "Approve and publish" }).click();
		await expect(page.getByText(/^Approved and published\. It's live now\./)).toBeVisible();
		await expect.poll(() => status(ellen, menu)).toBe("published");
		await leave(ellen);
	});

	test("an edit after approval is refused and asks again, saying what changed", async () => {
		await editHeadline(sam, menu, "Iced coffee 3.40, lemon tart and pavlova");
		const held = await publishByApi(sam, menu);
		expect(held.ok).toBe(false);
		// The live page differs from this version: the approver sees the change in words.
		await openPanel(ellen, menu);
		await expect(
			ellen.page.getByText('Content: "3.40 and" becomes "3.40,"; adds "and pavlova".', {
				exact: true,
			}),
		).toBeVisible();
		const panelTop = ellen.page.getByRole("button", { name: "Approval", exact: true });
		await shot(ellen.page, "review-panel", 1280, panelTop);
		if (SCREENSHOTS) {
			// On a phone the editor's settings, plugin panels included, open as a sheet.
			await ellen.page.setViewportSize({ width: 390, height: 844 });
			await ellen.page.getByRole("button", { name: "Settings", exact: true }).click();
			const waiting = ellen.page.getByText("Waiting for your approval");
			if (!(await waiting.isVisible())) await panelTop.click();
			await expect(waiting).toBeVisible();
			await shot(ellen.page, "review-panel-phone", 390, panelTop);
			await ellen.page.keyboard.press("Escape");
			await ellen.page.setViewportSize({ width: 1280, height: 900 });
			await ellen.page.reload();
			await panelTop.click();
		}
		await ellen.page.getByRole("button", { name: "Approve", exact: true }).click();
		await expect(ellen.page.getByText("Approved. Sam has been told.")).toBeVisible();
		await leave(ellen);

		await editHeadline(sam, menu, "Iced coffee 3.40, lemon tart and strawberry pavlova");
		const again = await publishByApi(sam, menu);
		expect(again.ok).toBe(false);
		expect(again.message).toMatch(
			/^Sent for approval again\. Not live yet\. This page changed after Ellen Marsh approved it/,
		);
	});

	test("Jo, a Contributor, asks from the Approvals page", async () => {
		const draft = await createPage(jo, "Picnic ideas", "Five summer picnic ideas");
		created.push(draft);
		const page = await front(jo);
		await page.goto(APPROVALS);
		await expect(page.getByRole("heading", { name: "Your drafts" })).toBeVisible({
			timeout: 60_000,
		});
		await expect(page.getByRole("tab", { name: "Settings" })).toHaveCount(0);
		await page.getByRole("button", { name: "Ask for approval" }).click();
		await expect(page.getByText("Sent for approval. Ellen Marsh has been asked.")).toBeVisible();

		await front(ellen);
		await ellen.page.goto(APPROVALS);
		await expect(ellen.page.getByText(/Pages · asked by Jo Park/)).toBeVisible({ timeout: 60_000 });
	});
});
