// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { expectHelpLine, helpLinks, setHidden } from "./help-line.js";

// Content Approval with three people: Ellen (Admin, approves), Sam (Editor, writes) and
// Jo (Contributor). Dev sign-in only ever makes an Admin, so each person signs in once,
// takes a name of their own, and Ellen then gives Sam and Jo their roles.

const API = "/_emdash/api";
const HEADERS = { "X-EmDash-Request": "1" };
const APPROVALS = "/_emdash/admin/plugins/approvals/overview";
const ROLE = { contributor: 20, editor: 40 };

// APPROVALS_SCREENSHOTS=1 also saves the listing screenshots into the plugin's images folder, under
// new names (the website reuses a picture by its file name), with the site named as a real one.
const SCREENSHOTS = process.env.APPROVALS_SCREENSHOTS === "1";
const SITE_TITLE = "Harbour Street Bakery";
// The version the pictures ship in, in their file names.
const VERSION = "0-3-0";
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

/** A personal access token for this Admin. EmDash's MCP endpoint takes tokens only, no session. */
async function apiToken(by: Person, scopes: string[]): Promise<{ id: string; token: string }> {
	const response = await by.page.request.post(`${API}/admin/api-tokens`, {
		headers: HEADERS,
		data: { name: `approvals e2e ${Date.now()}`, scopes },
	});
	expect(response.ok(), await response.text()).toBe(true);
	const body = (await response.json()) as { data: { token: string; info: { id: string } } };
	return { id: body.data.info.id, token: body.data.token };
}

async function removeToken(by: Person, id: string): Promise<void> {
	const response = await by.page.request.delete(`${API}/admin/api-tokens/${id}`, {
		headers: HEADERS,
	});
	expect(response.ok(), await response.text()).toBe(true);
}

/** Switch the plugin's MCP tools on or off, as an Admin does in EmDash's plugin settings. */
async function mcpTools(by: Person, enabled: boolean): Promise<void> {
	const response = await by.page.request.put(`${API}/admin/plugins/approvals/mcp`, {
		headers: HEADERS,
		data: { enabled },
	});
	expect(response.ok(), await response.text()).toBe(true);
}

/** One JSON-RPC call to EmDash's MCP endpoint; it answers in one server-sent event. */
async function mcp(token: string, method: string, params: unknown = {}): Promise<unknown> {
	const response = await fetch(new URL(`${API}/mcp`, test.info().project.use.baseURL), {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const text = await response.text();
	expect(response.ok, text).toBe(true);
	const line = text.split("\n").find((l) => l.startsWith("data: "));
	const message = JSON.parse(line ? line.slice(6) : text) as { result?: unknown; error?: unknown };
	expect(message.error, text).toBeUndefined();
	return message.result;
}

function toolNames(result: unknown): string[] {
	return ((result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
}

/** A tool's answer: the JSON in its text content. */
function toolData(result: unknown): Record<string, unknown> {
	const r = result as { isError?: boolean; content: Array<{ text: string }> };
	expect(r.isError, r.content[0]?.text).toBeFalsy();
	return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
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

	// Ellen starts alone: the first tests run on a one-admin site. Sam and Jo join later.
	test.beforeAll(async ({ browser }) => {
		test.setTimeout(180_000);
		ellen = await signIn(browser);
		await updateUser(ellen, ellen.id, { name: "Ellen Marsh", email: "ellen@agency.test" });
		if (SCREENSHOTS) await siteTitle(SITE_TITLE);
	});

	async function siteTitle(title: string): Promise<void> {
		const saved = await ellen.page.request.post(`${API}/settings`, {
			headers: HEADERS,
			data: { title },
		});
		expect(saved.ok(), await saved.text()).toBe(true);
	}

	async function saveSettings(values: Record<string, unknown>): Promise<void> {
		const saved = await ellen.page.request.post(`${API}/plugins/approvals/admin`, {
			headers: HEADERS,
			data: { type: "form_submit", action_id: "save_settings", values },
		});
		expect(saved.ok(), await saved.text()).toBe(true);
	}

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
		if (SCREENSHOTS) await siteTitle("Acme");
		for (const person of [ellen, sam, jo]) await person?.context.close();
	});

	test("the Settings tab states the gaps in plain words, and turns approval on", async () => {
		// Scheduled before approval is on: Settings names it, as approval will hold it.
		const later = await createPage(ellen, "Autumn menu", "Pumpkin bread from October");
		created.push(later);
		const scheduled = await ellen.page.request.post(`${API}/content/pages/${later}/schedule`, {
			headers: HEADERS,
			data: { scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
		});
		expect(scheduled.ok(), await scheduled.text()).toBe(true);
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
		await expect(page.getByText("Hold what AI tools publish for approval")).toBeVisible();
		await expect(page.getByRole("heading", { name: "What approval can't hold" })).toBeVisible();
		await expect(
			page.getByText(/The SEO panel, categories, tags and bylines of a page that is already live/),
		).toBeVisible();
		await expect(
			page.getByText(/Taking a page off the site \(Unpublish\) is not held, by choice/),
		).toBeVisible();
		await expect(page.getByText(/Autumn menu \(Pages, \d+ \w+, \d\d:\d\d UTC\)/)).toBeVisible();
		// No developer words on the owner's page.
		await expect(page.getByText(/MCP|slug|webhook|fingerprint/)).toHaveCount(0);

		await page.getByRole("checkbox", { name: "Pages" }).check();
		await shot(page, `settings-${VERSION}`);
		await shot(page, `settings-${VERSION}-phone`, 390);
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(
			page.getByText("Saved. Publishing now asks for approval where you chose."),
		).toBeVisible();
		await expect(page.getByText("Approval is off until you save these settings")).toHaveCount(0);
		await expect(
			page.getByText(/Already scheduled, and will need approval before they go live: Autumn menu/),
		).toBeVisible();
		const unscheduled = await ellen.page.request.delete(`${API}/content/pages/${later}/schedule`, {
			headers: HEADERS,
		});
		expect(unscheduled.ok(), await unscheduled.text()).toBe(true);
	});

	test("alone under 'I need someone else's OK', Ellen's own page waits, and she publishes it without review", async () => {
		await saveSettings({
			collections: ["pages"],
			preset: "me",
			ai: true,
			checks: "remind",
			remind: true,
		});
		const hours = await createPage(ellen, "Opening hours", "Open 8 till 4, Monday to Saturday");
		created.push(hours);
		const page = await front(ellen);
		await page.goto(`/_emdash/admin/content/pages/${hours}`);
		await page.getByRole("button", { name: "Publish now" }).click({ timeout: 60_000 });
		await page.getByRole("dialog").getByRole("button", { name: "Publish now" }).click();
		await expect(
			page.getByText(
				/^Sent for approval\. Not live yet\. Approval needs a second person: nobody else on this site can approve it yet\. To publish it now, use Publish without review in Approvals\./,
			),
		).toBeVisible();
		expect(await status(ellen, hours)).toBe("draft");

		await leave(ellen);
		await expect(page.getByText("Only you can approve on this site")).toBeVisible({
			timeout: 60_000,
		});
		await expect(page.getByRole("heading", { name: "For you to approve" })).toBeVisible();
		await expect(page.getByText("Nothing waiting for you")).toBeVisible();
		await expect(page.getByRole("heading", { name: "Yours, waiting" })).toBeVisible();
		await expect(page.getByText("Opening hours", { exact: true })).toBeVisible();
		await expect(
			page.getByText(/needs a second person: nobody else on this site can approve it/),
		).toBeVisible();

		await page.getByRole("button", { name: "Publish without review" }).click();
		await expect(page.getByText("Nobody else on this site can approve it yet.")).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve and publish" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Send back" })).toHaveCount(0);
		// A reason is required.
		await page.getByRole("button", { name: "Publish without review" }).click();
		await expect(page.getByText("Write the reason first.")).toBeVisible();
		await page.getByRole("textbox", { name: "Reason" }).fill("I run this site on my own.");
		await page.getByRole("button", { name: "Publish without review" }).click();
		await expect(page.getByText("Published without review. It's live now.")).toBeVisible();
		await expect.poll(() => status(ellen, hours)).toBe("published");
		// A decision ends on a short confirmation; the list is one click away.
		await page.getByRole("button", { name: "‹ Back to the list" }).click();
		await expect(page.getByRole("heading", { name: "For you to approve" })).toBeVisible();

		await saveSettings({
			collections: ["pages"],
			preset: "others",
			ai: true,
			checks: "remind",
			remind: true,
		});
	});

	test("Sam and Jo join the site", async ({ browser }) => {
		test.setTimeout(180_000);
		sam = await signIn(browser);
		await updateUser(sam, sam.id, { name: "Sam Reyes", email: "sam@bakery.test" });
		await updateUser(ellen, sam.id, { role: ROLE.editor });
		jo = await signIn(browser);
		await updateUser(jo, jo.id, { name: "Jo Park", email: "jo@bakery.test" });
		await updateUser(ellen, jo.id, { role: ROLE.contributor });
	});

	let menu: string;
	let picnic: string;

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
		await shot(page, `held-publish-${VERSION}`);
		expect(await status(sam, menu)).toBe("draft");

		await page.getByRole("button", { name: "Approval", exact: true }).click();
		await expect(page.getByText("Waiting for approval", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: "Add a note for the approver (optional)" }),
		).toBeVisible();
		// The person who asked can take it back from the panel.
		await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toBeVisible();
		if (SCREENSHOTS) {
			// The held publish's toast covers the panel: wait for it to go.
			const failed = page.getByText("Failed to publish");
			await expect(failed).toHaveCount(0, { timeout: 30_000 });
			const panelTop = page.getByRole("button", { name: "Approval", exact: true });
			await shot(page, `withdraw-panel-${VERSION}`, 1280, panelTop);
			// On a phone the editor's settings, plugin panels included, open as a sheet.
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			const waiting = page.getByText("Waiting for approval", { exact: true });
			if (!(await waiting.isVisible())) await panelTop.click();
			await expect(waiting).toBeVisible();
			await shot(page, `withdraw-panel-${VERSION}-phone`, 390, panelTop);
			await page.keyboard.press("Escape");
			await page.setViewportSize({ width: 1280, height: 900 });
		}

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
					/^(Acme|Harbour Street Bakery|localhost:\d+): Sam Reyes asked you to approve "Summer menu"$/,
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
		// Every tab is on screen, with room to spare: Linux fonts (CI) are wider than macOS ones.
		const tabs = page.getByRole("tab");
		await expect(tabs).toHaveCount(4);
		const offScreen = await tabs.evaluateAll((list) =>
			list
				.filter((tab) => tab.getBoundingClientRect().right > window.innerWidth - 16)
				.map((tab) => `${tab.textContent} (${Math.round(tab.getBoundingClientRect().right)})`),
		);
		expect(offScreen).toEqual([]);
		await shot(page, `waiting-${VERSION}-phone`, 390);
		await shot(page, `waiting-${VERSION}`);
		await page.setViewportSize({ width: 1280, height: 900 });

		await review.click();
		await expect(page.getByText("What changes when this goes live")).toBeVisible();
		await expect(page.getByText("New page: not live before.")).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve and publish" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
		await expect(page.getByText("Approve without review (admins)")).toBeVisible();
		await shot(page, `review-${VERSION}`);
		await shot(page, `review-${VERSION}-phone`, 390);
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
		// Sam's email goes out from a background task a moment later.
		await expect
			.poll(
				async () => {
					const mail = await page.request.get(`${API}/dev/emails`, { headers: HEADERS });
					const body = (await mail.json()) as {
						data: { items: Array<{ message: { subject: string; to: string } }> };
					};
					return body.data.items
						.filter((m) => m.message.to === "sam@bakery.test")
						.map((m) => m.message.subject);
				},
				{ timeout: 90_000 },
			)
			.toContainEqual(expect.stringMatching(/: Approved and published: "Summer menu"$/));
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
		await shot(ellen.page, `review-panel-${VERSION}`, 1280, panelTop);
		if (SCREENSHOTS) {
			// On a phone the editor's settings, plugin panels included, open as a sheet.
			await ellen.page.setViewportSize({ width: 390, height: 844 });
			await ellen.page.getByRole("button", { name: "Settings", exact: true }).click();
			const waiting = ellen.page.getByText("Waiting for your approval");
			if (!(await waiting.isVisible())) await panelTop.click();
			await expect(waiting).toBeVisible();
			await shot(ellen.page, `review-panel-${VERSION}-phone`, 390, panelTop);
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
		picnic = draft;
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

	test("an AI assistant reads the queue and a page's approval through MCP, once Ellen switches the tools on", async () => {
		// Off until an Admin switches them on: the token alone does not list them.
		const token = await apiToken(ellen, ["mcp:tools:approvals"]);
		try {
			const before = await mcp(token.token, "tools/list");
			expect(toolNames(before)).not.toContain("approvals__queue");
			await mcpTools(ellen, true);
			const listed = toolNames(await mcp(token.token, "tools/list"));
			expect(listed).toEqual(expect.arrayContaining(["approvals__queue", "approvals__status"]));

			const queue = toolData(
				await mcp(token.token, "tools/call", { name: "approvals__queue", arguments: {} }),
			);
			expect(queue.approvalOn).toBe(true);
			expect(queue.forYou).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						title: "Picnic ideas",
						collection: "pages",
						id: picnic,
						askedBy: "Jo Park",
						kind: "publish",
					}),
				]),
			);
			expect(JSON.stringify(queue)).not.toMatch(/@bakery\.test|@agency\.test/);

			const approval = toolData(
				await mcp(token.token, "tools/call", {
					name: "approvals__status",
					arguments: { collection: "pages", id: picnic },
				}),
			);
			expect(approval).toMatchObject({
				title: "Picnic ideas",
				state: "waiting",
				askedBy: "Jo Park",
				youMayDecide: true,
				approvalOn: true,
			});
			expect(JSON.stringify(approval)).not.toMatch(/@bakery\.test|@agency\.test/);
		} finally {
			await mcpTools(ellen, false);
			await removeToken(ellen, token.id);
		}
	});

	// Wanted (item 2 of the 2026-11 round): an AI tool that changes a live page's SEO panel through
	// MCP leaves a line in the page's history. Not possible on EmDash 1.5.0: EmDash saves it live
	// at once and tells plugins the save came from MCP only on publish, so content:afterSave cannot
	// tell this save from one in the editor (mcp/server.ts builds the save's actor without
	// `source: "mcp"`). Switch this on when EmDash passes the source with the save.
	test.fixme("an AI tool's change to a live page's search title is noted in its history", async () => {
		const token = await apiToken(ellen, ["content:read", "content:write"]);
		try {
			const read = await ellen.page.request.get(`${API}/content/pages/${menu}`, {
				headers: HEADERS,
			});
			const body = (await read.json()) as { data: { _rev?: string; item: { status: string } } };
			expect(body.data.item.status).toBe("published");
			const saved = toolData(
				await mcp(token.token, "tools/call", {
					name: "content_update",
					arguments: {
						collection: "pages",
						id: menu,
						_rev: body.data["_rev"],
						seo: { title: "Summer menu, by an AI tool" },
					},
				}),
			);
			expect(saved).toBeTruthy();
			await openPanel(ellen, menu);
			await expect(
				ellen.page.getByText(/Search title and description changed by an AI tool through MCP/),
			).toBeVisible({ timeout: 30_000 });
			await leave(ellen);
		} finally {
			await removeToken(ellen, token.id);
		}
	});

	test("Ellen sees the help line and can hide it in Settings; Sam and Jo never see it", async () => {
		const guide = "approve-pages-before-they-go-live-on-emdash";
		for (const person of [sam, jo]) {
			const page = await front(person);
			await page.goto(APPROVALS);
			await expect(page.getByRole("heading", { name: "Approvals" }).first()).toBeVisible({
				timeout: 60_000,
			});
			await expect(page.locator("main")).not.toContainText(/moorage/i);
		}
		const page = await front(ellen);
		await page.goto(APPROVALS);
		await expect(page.getByRole("tab", { name: "Settings" })).toBeVisible({ timeout: 60_000 });
		await expectHelpLine(page, guide);
		await page.getByRole("tab", { name: "Settings" }).click();
		await expectHelpLine(page, guide);
		// The switch is part of the settings form, saved with the rest.
		await setHidden(page, true);
		await expect(page.getByText(/^Saved\./)).toBeVisible();
		await expect(helpLinks(page)).toHaveCount(0);
		await page.goto(APPROVALS);
		await expect(page.getByRole("tab", { name: "Settings" })).toBeVisible({ timeout: 60_000 });
		await expect(helpLinks(page)).toHaveCount(0);
		await expect(page.getByText(/Pages · asked by Jo Park/)).toBeVisible();

		await page.getByRole("tab", { name: "Settings" }).click();
		await setHidden(page, false);
		await expect(helpLinks(page)).toHaveCount(3);
		await expectHelpLine(page, guide);
	});

	test("Jo withdraws her request from 'Yours, waiting'; Ellen no longer sees it", async () => {
		const page = await front(jo);
		await page.goto(APPROVALS);
		await expect(page.getByRole("heading", { name: "Yours, waiting" })).toBeVisible({
			timeout: 60_000,
		});
		await shot(page, `yours-waiting-${VERSION}`);
		await shot(page, `yours-waiting-${VERSION}-phone`, 390);
		await page.getByRole("button", { name: "Withdraw", exact: true }).click();
		const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
		await expect(dialog.getByText("Withdraw this request?")).toBeVisible();
		await dialog.getByRole("button", { name: "Withdraw", exact: true }).click();
		await expect(
			page.getByText("Withdrawn. The approvers no longer see it; ask again when it is ready."),
		).toBeVisible();
		await page.getByRole("button", { name: "‹ Back to the list" }).click();
		await expect(page.getByText("Nothing of yours waiting")).toBeVisible();
		await expect(page.getByRole("button", { name: "Ask for approval" })).toBeVisible();

		await front(ellen);
		await ellen.page.goto(APPROVALS);
		await expect(ellen.page.getByRole("heading", { name: "For you to approve" })).toBeVisible({
			timeout: 60_000,
		});
		await expect(ellen.page.getByText(/Pages · asked by Jo Park/)).toHaveCount(0);
	});

	// EmDash 1.3.1 shows plugin editor buttons and panels to a Contributor on their own draft but
	// answers their requests with 403: it asks for content:edit_own (Author and up) before any plugin
	// code runs, and a plugin cannot hide them by role. The README sends Contributors to the
	// Approvals page instead. When EmDash fixes this, this test fails: then update it and the README.
	test("Jo, a Contributor, gets EmDash's own failure from the editor's plugin button", async () => {
		const draft = await createPage(jo, "Bake sale", "Saturday bake sale");
		created.push(draft);
		const page = await front(jo);
		try {
			await page.goto(`/_emdash/admin/content/pages/${draft}`);
			const ask = page.getByRole("button", { name: "Ask for approval" });
			await expect(ask).toBeVisible({ timeout: 60_000 });
			const answered = page.waitForResponse((response) =>
				response.url().includes("/plugin-extensions/approvals/action/ask"),
			);
			await ask.click();
			expect((await answered).status()).toBe(403);
			await expect(page.getByText("Plugin action failed")).toBeVisible();
			await page.getByRole("button", { name: "Approval", exact: true }).click();
			await expect(page.getByText("Plugin panel unavailable.")).toBeVisible();
		} finally {
			await leave(jo);
		}
	});
	let batch: string[] = [];

	test("Ellen approves and publishes three pages at once from the Waiting list", async () => {
		batch = [];
		for (const [title, headline] of [
			["Bread prices", "Sourdough 4.50"],
			["Cake of the week", "Lemon drizzle"],
			["Holiday hours", "Closed on the 25th"],
		] as const) {
			const id = await createPage(sam, title, headline);
			created.push(id);
			batch.push(id);
			expect((await publishByApi(sam, id)).ok).toBe(false);
		}
		const page = await front(ellen);
		await page.goto(APPROVALS);
		await expect(page.getByRole("heading", { name: "For you to approve" })).toBeVisible({
			timeout: 60_000,
		});
		// Each row says what it is and what it changes.
		await expect(
			page.getByText(/Pages · asked by Sam Reyes · .* · new page/).first(),
		).toBeVisible();
		await page.getByText("Decide several at once").click();
		// "All N waiting for you" is a choice in the form; the boxes show for "Only the ones I tick".
		await expect(page.getByRole("radio", { name: /^All \d+ waiting for you$/ })).toBeVisible();
		for (const title of ["Bread prices", "Cake of the week", "Holiday hours"])
			await page.getByRole("checkbox", { name: new RegExp(`^${title} · Pages`) }).click();
		await expect(page.getByRole("checkbox", { name: /^Summer menu · Pages/ })).not.toBeChecked();
		await page.getByRole("button", { name: "Check selection", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Approve and publish these 3?" })).toBeVisible();
		for (const title of ["Bread prices", "Cake of the week", "Holiday hours"])
			await expect(page.getByText(title, { exact: true })).toBeVisible();
		await expect(page.getByText("Summer menu", { exact: true })).toHaveCount(0);
		const pressed = Date.now();
		await page.getByRole("button", { name: "Approve and publish 3" }).click();
		// The press starts background runs (one-shot tasks) and shows the list with a banner.
		await expect(
			page.getByText("Approving and publishing 3 pages. You can leave this page."),
		).toBeVisible();
		// The run publishes from a cron invocation, as Ellen's decision: measured here.
		for (const id of batch)
			await expect.poll(() => status(ellen, id), { timeout: 120_000 }).toBe("published");
		console.info(`bulk background run: 3 pages live ${Date.now() - pressed} ms after the press`);
		await expect
			.poll(
				async () => {
					await page.reload();
					// The page draws its blocks after it loads: wait for them.
					await page
						.getByRole("heading", { name: "For you to approve" })
						.waitFor({ timeout: 30_000 });
					return (await page.getByText("Approved 3 of 3 pages.").count()) > 0;
				},
				{ timeout: 60_000 },
			)
			.toBe(true);
		console.info(`bulk background run: results shown ${Date.now() - pressed} ms after the press`);
		await page.getByText("Each page").click();
		await expect(page.getByText(/^Approved and published\. It's live now\./).first()).toBeVisible();
		await page.getByRole("button", { name: "Dismiss" }).click();
		await expect(page.getByText("Approved 3 of 3 pages.")).toHaveCount(0);
		await expect(page.getByRole("heading", { name: "For you to approve" })).toBeVisible();
		// Recorded as Ellen's decision, though a background run published it.
		await openPanel(ellen, batch[0]!);
		await expect(page.getByText(/Approved by Ellen Marsh/).first()).toBeVisible();
		await leave(ellen);
		await page.goto(APPROVALS);
		// Summer menu, left unticked, still waits.
		await expect(page.getByText("Summer menu", { exact: true })).toBeVisible();
	});

	test("a content type without a title field, like Releases, is named by its declared title field, never Untitled", async () => {
		const schema = async (method: "post" | "put", path: string, data: unknown) => {
			const response = await ellen.page.request[method](`${API}/schema/collections${path}`, {
				headers: HEADERS,
				data,
			});
			expect(response.ok(), await response.text()).toBe(true);
		};
		await schema("post", "", {
			slug: "releases",
			label: "Releases",
			labelSingular: "Release",
			supports: ["drafts", "revisions"],
		});
		try {
			for (const [slug, label, type] of [
				["plugin", "Plugin", "string"],
				["release_version", "Version", "string"],
				["summary", "Summary", "text"],
			] as const)
				await schema("post", "/releases/fields", { slug, label, type });
			await schema("put", "/releases", { titleField: "release_version" });
			await saveSettings({
				collections: ["pages", "releases"],
				preset: "others",
				ai: true,
				checks: "remind",
				remind: true,
			});
			const made = await sam.page.request.post(`${API}/content/releases`, {
				headers: HEADERS,
				data: {
					slug: "seo-0-3-1",
					data: { plugin: "seo", release_version: "0.3.1", summary: "Fixes." },
				},
			});
			expect(made.ok(), await made.text()).toBe(true);
			const id = ((await made.json()) as { data: { item: { id: string } } }).data.item.id;
			const held = await sam.page.request.post(`${API}/content/releases/${id}/publish`, {
				headers: HEADERS,
			});
			expect(held.ok()).toBe(false);
			const page = await front(ellen);
			await page.goto(APPROVALS);
			await expect(page.getByText("0.3.1", { exact: true })).toBeVisible({ timeout: 60_000 });
			await expect(page.getByText(/Releases · asked by Sam Reyes/).first()).toBeVisible();
			await expect(page.locator("main")).not.toContainText("Untitled");
			const trashed = await ellen.page.request.delete(`${API}/content/releases/${id}`, {
				headers: HEADERS,
			});
			expect(trashed.ok(), await trashed.text()).toBe(true);
			await ellen.page.request.delete(`${API}/content/releases/${id}/permanent`, {
				headers: HEADERS,
			});
		} finally {
			await saveSettings({
				collections: ["pages"],
				preset: "others",
				ai: true,
				checks: "remind",
				remind: true,
			});
			await ellen.page.request.delete(`${API}/schema/collections/releases?force=true`, {
				headers: HEADERS,
			});
		}
	});
	test("an AI reviewer reads what changed, is refused while AI approval is off, then approves and sends back once Ellen allows it", async () => {
		const first = await createPage(sam, "Scones", "Fresh scones daily");
		const second = await createPage(sam, "Jam", "Strawberry jam");
		created.push(first, second);
		for (const id of [first, second]) expect((await publishByApi(sam, id)).ok).toBe(false);
		const settings = {
			collections: ["pages"],
			preset: "others",
			ai: true,
			checks: "remind",
			remind: true,
		};
		const token = await apiToken(ellen, ["mcp:tools:approvals"]);
		try {
			await mcpTools(ellen, true);
			const listed = toolNames(await mcp(token.token, "tools/list"));
			expect(listed).toEqual(
				expect.arrayContaining([
					"approvals__changes",
					"approvals__approve",
					"approvals__send_back",
					"approvals__ask_approval",
				]),
			);
			const changes = toolData(
				await mcp(token.token, "tools/call", {
					name: "approvals__changes",
					arguments: { collection: "pages", id: first },
				}),
			);
			expect(changes).toMatchObject({ title: "Scones", state: "waiting", liveNow: false });
			expect(changes.fields).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ field: "title", before: null, after: "Scones" }),
				]),
			);
			const refused = toolData(
				await mcp(token.token, "tools/call", {
					name: "approvals__approve",
					arguments: { collection: "pages", id: first, version: changes.version },
				}),
			);
			expect(refused.error).toBe(
				"AI tools may not approve or send back on this site. An Admin can switch this on in Approvals > Settings: AI tools may approve.",
			);
			expect(await status(ellen, first)).toBe("draft");

			await saveSettings({ ...settings, aiApprove: true });
			const approved = toolData(
				await mcp(token.token, "tools/call", {
					name: "approvals__approve",
					arguments: { collection: "pages", id: first, version: changes.version },
				}),
			);
			expect(approved).toMatchObject({
				ok: true,
				state: "published",
				published: true,
				title: "Scones",
			});
			await expect.poll(() => status(ellen, first)).toBe("published");
			const sent = toolData(
				await mcp(token.token, "tools/call", {
					name: "approvals__send_back",
					arguments: { request: `pages:${second}`, reason: "Say which fruit" },
				}),
			);
			expect(sent).toMatchObject({ ok: true, state: "sent_back" });
			await openPanel(sam, second);
			await expect(
				sam.page.getByText(/^Sent back by an AI tool acting for Ellen Marsh/),
			).toBeVisible();
			await leave(sam);
		} finally {
			await saveSettings(settings);
			await mcpTools(ellen, false);
			await removeToken(ellen, token.id);
		}
	});
});
