// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../src/requests.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type User = Awaited<ReturnType<PluginRuntimeTestHost["fixtures"]["user"]>>;

interface Site {
	host: PluginRuntimeTestHost;
	admin: User;
	admin2: User;
	editor: User;
	contributor: User;
}

async function site(config?: Record<string, unknown>): Promise<Site> {
	const runtime = await createPluginRuntimeTestHost({
		site: { name: "Harbour Street Bakery", url: "https://bakery.test", locale: "en" },
	});
	host = runtime;
	await runtime.fixtures.collection({
		slug: "pages",
		label: "Pages",
		supports: ["drafts", "revisions"],
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "text" },
		],
	});
	await runtime.fixtures.collection({
		slug: "products",
		label: "Products",
		supports: [],
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
	const admin = await runtime.fixtures.user({
		email: "ellen@agency.test",
		name: "Ellen Marsh",
		role: "admin",
	});
	const admin2 = await runtime.fixtures.user({
		email: "tom@agency.test",
		name: "Tom Achebe",
		role: "admin",
	});
	const editor = await runtime.fixtures.user({
		email: "sam@bakery.test",
		name: "Sam Reyes",
		role: "editor",
	});
	const contributor = await runtime.fixtures.user({
		email: "jo@bakery.test",
		name: "Jo Park",
		role: "contributor",
	});
	if (config) await runtime.fixtures.plugin.setting("config", config);
	return { host: runtime, admin, admin2, editor, contributor };
}

const actor = (user: User, source: "api" | "mcp" = "api") => ({
	actor: { id: user.id, role: user.role },
	origin: { source },
});

async function page(
	s: Site,
	data: Record<string, unknown> = {},
	by: User = s.editor,
): Promise<string> {
	const created = await s.host.actions.content.create("pages", {
		data: { title: "Summer menu", content: "Iced coffee £3.20 and lemon tart", ...data },
		slug: "summer-menu",
		authorId: by.id,
		actor: { id: by.id, role: by.role },
	});
	if (!created.success) throw new Error(created.error.message);
	return created.data.item.id;
}

async function edit(s: Site, id: string, data: Record<string, unknown>, by: User = s.editor) {
	const updated = await s.host.actions.content.update("pages", id, {
		data,
		actor: { id: by.id, role: by.role },
	});
	if (!updated.success) throw new Error(updated.error.message);
}

async function request(s: Site, id: string): Promise<ApprovalRequest | null> {
	return s.host.inspect.storage.get<ApprovalRequest>("requests", `pages:${id}`);
}

/** Wait for EmDash's deferred work, such as the afterPublish hook after a plugin's publish. */
async function settled(): Promise<void> {
	const tasks = (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:deferred-tasks")] as
		| Set<Promise<unknown>>
		| undefined;
	for (;;) {
		const pending = Array.from(tasks ?? []);
		if (pending.length === 0) return;
		await Promise.all(pending);
	}
}

function text(blocks: unknown): string {
	return JSON.stringify(blocks);
}

/** Find a button's value in a Block Kit response. */
function buttonValue(response: unknown, actionId: string): unknown {
	let found: unknown;
	const walk = (node: unknown) => {
		if (found !== undefined || typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (record.type === "button" && record.action_id === actionId) {
			found = record.value;
			return;
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(response);
	return found;
}

const HELD = { collections: ["pages"], preset: "others", ai: true, checks: "remind", remind: true };

describe("the publish gate", () => {
	it("holds nothing until the settings are saved", async () => {
		const s = await site();
		const id = await page(s);
		const result = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(result.success).toBe(true);
	});

	it("holds an editor's publish, makes a request, and leads with the good news", async () => {
		const s = await site(HELD);
		const id = await page(s);
		const result = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("PUBLISH_REJECTED");
		expect(result.error.message).toMatch(
			/^Sent for approval\. Not live yet\. Ellen Marsh and Tom Achebe have been asked/,
		);
		expect(result.error.message.length).toBeLessThanOrEqual(500);
		const stored = await request(s, id);
		expect(stored).toMatchObject({
			status: "waiting",
			title: "Summer menu",
			requestedBy: { name: "Sam Reyes" },
		});
	});

	it("lets an admin publish under 'Others need my OK', but not under 'I need someone else's OK'", async () => {
		const s = await site(HELD);
		const id = await page(s, {}, s.admin);
		expect((await s.host.actions.content.publish("pages", id, actor(s.admin))).success).toBe(true);
		await s.host.fixtures.plugin.setting("config", { ...HELD, preset: "me" });
		await edit(s, id, { content: "New text" }, s.admin);
		const held = await s.host.actions.content.publish("pages", id, actor(s.admin));
		expect(held.success).toBe(false);
	});

	it("never touches content types that are off", async () => {
		const s = await site(HELD);
		const created = await s.host.actions.content.create("products", {
			data: { title: "Sourdough" },
			actor: { id: s.editor.id, role: s.editor.role },
		});
		if (!created.success) throw new Error(created.error.message);
		const result = await s.host.actions.content.publish(
			"products",
			created.data.item.id,
			actor(s.editor),
		);
		expect(result.success).toBe(true);
	});

	it("holds an AI tool's publish even on a content type that is off", async () => {
		const s = await site({ ...HELD, collections: [] });
		const created = await s.host.actions.content.create("products", {
			data: { title: "Sourdough" },
			actor: { id: s.admin.id, role: s.admin.role },
		});
		if (!created.success) throw new Error(created.error.message);
		const result = await s.host.actions.content.publish(
			"products",
			created.data.item.id,
			actor(s.admin, "mcp"),
		);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.message).toContain("a person must OK what AI tools publish");
		expect(result.error.message).toContain("Do not try again");
	});

	it("does not email or create a second request when Publish is pressed again", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const again = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(again.success).toBe(false);
		if (again.success) return;
		expect(again.error.message).toMatch(/^Still waiting for approval\. Not live yet\./);
		expect((await request(s, id))?.history).toHaveLength(1);
	});

	it("refuses with a plain message, not a crash, when the stored request is unreadable", async () => {
		const s = await site(HELD);
		const id = await page(s);
		// A broken record the gate cannot work with: it must refuse, in its own words.
		await s.host.fixtures.plugin.storage("requests", `pages:${id}`, {
			status: "approved",
			approval: null,
			history: 5,
		});
		const result = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.message).toBe(
			"Not published: approval could not be checked just now. Nothing has changed. Try again in a minute; if it keeps happening, tell whoever looks after the site.",
		);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("draft");
	});

	it("refuses a Contributor's request about someone else's draft", async () => {
		const s = await site(HELD);
		const id = await page(s);
		const asked = await s.host.admin.act("/overview", "ask", {
			user: s.contributor,
			value: { collection: "pages", id },
		});
		expect(asked.toast).toEqual({
			type: "error",
			message: "You can only ask for approval on your own drafts.",
		});
	});
});

describe("approving", () => {
	it("approves in the panel, after which the writer's Publish goes through", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const panel = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.admin });
		expect(text(panel)).toContain("Waiting for your approval");
		expect(text(panel)).toContain("New page: not live before.");
		const value = buttonValue(panel, "approve");
		const approved = await s.host.admin.actEditorPanel("approval", "pages", id, "approve", {
			user: s.admin,
			value,
		});
		expect(approved.toast).toEqual({ type: "success", message: "Approved. Sam has been told." });
		const result = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(result.success).toBe(true);
	});

	it("approves and publishes in one step", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const panel = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.admin });
		const value = buttonValue(panel, "approve_publish");
		const done = await s.host.admin.actEditorPanel("approval", "pages", id, "approve_publish", {
			user: s.admin,
			value,
		});
		expect(done.toast?.message).toBe("Approved and published. It's live now. Sam has been told.");
		const item = await s.host.inspect.content.get("pages", id);
		expect(item?.status).toBe("published");
		// The publish hook that follows records it, and queues Sam's email.
		await settled();
		const stored = await request(s, id);
		expect(stored?.status).toBe("published");
		expect(stored?.history[0]?.text).toBe("Published by Ellen Marsh");
		const copy = await s.host.inspect.storage.list("versions");
		expect(text(copy)).toContain("Iced coffee £3.20 and lemon tart");
	});

	it("voids an approval when the page changes, and says what changed in words", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const panel = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.admin });
		await s.host.admin.actEditorPanel("approval", "pages", id, "approve", {
			user: s.admin,
			value: buttonValue(panel, "approve"),
		});
		await edit(s, id, { content: "Iced coffee £3.40 and lemon tart" });
		const writerPanel = await s.host.admin.loadEditorPanel("approval", "pages", id, {
			user: s.editor,
		});
		expect(text(writerPanel)).toContain("Changed since Ellen Marsh approved it");
		expect(text(writerPanel)).toContain('Content: \\"£3.20\\" became \\"£3.40\\".');
		const result = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.message).toMatch(
			/^Sent for approval again\. Not live yet\. This page changed after Ellen Marsh approved it/,
		);
	});

	it("nobody approves their own request", async () => {
		const s = await site({ ...HELD, preset: "me" });
		const id = await page(s, {}, s.admin);
		await s.host.actions.content.publish("pages", id, actor(s.admin));
		const own = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.admin });
		expect(text(own)).not.toContain("Waiting for your approval");
		const other = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.editor });
		expect(text(other)).toContain("Waiting for your approval");
	});

	it("records an approver's edit before approving", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		await edit(s, id, { content: "Iced coffee £3.20 and lemon tart, fixed" }, s.admin);
		// The after-save hook runs once the save has answered.
		let stored = await request(s, id);
		for (let i = 0; i < 50 && stored?.history[0]?.text.startsWith("Sam"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			stored = await request(s, id);
		}
		expect(stored?.status).toBe("waiting");
		expect(stored?.history[0]?.text).toBe("Edited by Ellen Marsh before approving: Content");
		const panel = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.admin });
		const done = await s.host.admin.actEditorPanel("approval", "pages", id, "approve_publish", {
			user: s.admin,
			value: buttonValue(panel, "approve_publish"),
		});
		expect(done.toast?.type).toBe("success");
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
	});

	it("sends back with a required note", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const empty = await s.host.admin.submitEditorPanel(
			"approval",
			"pages",
			id,
			"send_back",
			{ note: " " },
			{ user: s.admin, blockId: `sb:pages:${id}` },
		);
		expect(empty.toast?.type).toBe("error");
		const sent = await s.host.admin.submitEditorPanel(
			"approval",
			"pages",
			id,
			"send_back",
			{ note: "Iced coffee is £3.40" },
			{ user: s.admin, blockId: `sb:pages:${id}` },
		);
		expect(sent.toast?.message).toBe("Sent back to Sam with your note.");
		const writer = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.editor });
		expect(text(writer)).toContain("Sent back by Ellen Marsh");
		expect(text(writer)).not.toContain('"variant":"error"');
	});

	it("shows what changes against the live page", async () => {
		const s = await site({ ...HELD, preset: "others" });
		const id = await page(s, {}, s.admin);
		await s.host.actions.content.publish("pages", id, actor(s.admin));
		await edit(s, id, { content: "Iced coffee £3.40 and lemon tart" });
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const panel = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.admin });
		expect(text(panel)).toContain('Content: \\"£3.20\\" becomes \\"£3.40\\".');
	});
});

describe("asking without pressing Publish", () => {
	it("asks from the toolbar", async () => {
		const s = await site(HELD);
		const id = await page(s);
		const response = await s.host.admin.invokeEditorAction("ask", "pages", id, { user: s.editor });
		expect(response.toast).toEqual({
			type: "success",
			message: "Sent for approval. Ellen Marsh and Tom Achebe have been asked.",
		});
		expect((await request(s, id))?.requestedBy?.name).toBe("Sam Reyes");
	});

	it("lets a Contributor ask from the Approvals page, since EmDash gives them no plugin panels", async () => {
		const s = await site(HELD);
		const id = await page(s, {}, s.contributor);
		const list = await s.host.admin.loadPage("/overview", { user: s.contributor });
		expect(text(list)).toContain("Your drafts");
		const asked = await s.host.admin.act("/overview", "ask", {
			user: s.contributor,
			value: { collection: "pages", id },
		});
		expect(asked.toast).toEqual({
			type: "success",
			message: "Sent for approval. Ellen Marsh and Tom Achebe have been asked.",
		});
		expect((await request(s, id))?.requestedBy?.name).toBe("Jo Park");
		expect(text(asked)).not.toContain("Your drafts");
	});

	it("says approval is off on a type that is off", async () => {
		const s = await site(HELD);
		const created = await s.host.actions.content.create("products", { data: { title: "Loaf" } });
		if (!created.success) throw new Error(created.error.message);
		const response = await s.host.admin.invokeEditorAction(
			"ask",
			"products",
			created.data.item.id,
			{ user: s.editor },
		);
		expect(response.toast?.message).toBe("Approval is off for Products.");
	});
});

describe("scheduled publishing", () => {
	it("publishes an admin's own scheduled post under 'Others need my OK'", async () => {
		const s = await site(HELD);
		const id = await page(s, {}, s.admin);
		const when = new Date(Date.now() + 60_000).toISOString();
		const scheduled = await s.host.actions.content.schedule("pages", id, when, actor(s.admin));
		expect(scheduled.success).toBe(true);
		s.host.scheduled.setTime(new Date(Date.now() + 120_000));
		const run = await s.host.scheduled.run();
		expect(run.published).toEqual([{ collection: "pages", id }]);
		expect(await s.host.inspect.scheduledPolicyRejections()).toHaveLength(0);
	});

	it("refuses a post scheduled before approval was switched on, and leaves EmDash's notice", async () => {
		const s = await site();
		const id = await page(s);
		const when = new Date(Date.now() + 60_000).toISOString();
		const scheduled = await s.host.actions.content.schedule("pages", id, when, actor(s.editor));
		expect(scheduled.success).toBe(true);
		await s.host.fixtures.plugin.setting("config", HELD);
		s.host.scheduled.setTime(new Date(Date.now() + 120_000));
		await s.host.scheduled.run();
		const rejections = await s.host.inspect.scheduledPolicyRejections();
		expect(rejections).toHaveLength(1);
		expect(rejections[0]?.reason).toMatch(/^Not published: this page needs approval first/);
		expect((await request(s, id))?.status).toBe("waiting");
	});
});

describe("the Approvals page", () => {
	it("opens on Settings for an admin before anything is saved, and names the gaps", async () => {
		const s = await site();
		const response = await s.host.admin.loadPage("/overview", { user: s.admin });
		const body = text(response);
		expect(body).toContain("Approval is off until you save these settings");
		expect(body).toContain("Others need my OK before publishing (recommended for agencies)");
		expect(body).toContain("I need someone else's OK before publishing");
		expect(body).toContain("What approval can't hold");
		expect(body).toContain("Every save in Products, because it keeps no drafts.");
		expect(body).toContain('"default_tab":3');
	});

	it("saves the settings", async () => {
		const s = await site();
		const saved = await s.host.admin.submit(
			"/overview",
			"save_settings",
			{
				collections: ["pages"],
				preset: "me",
				ai: true,
				checks: "require",
			},
			{ user: s.admin },
		);
		expect(saved.toast?.type).toBe("success");
		expect(await s.host.inspect.setting("config")).toMatchObject({
			collections: ["pages"],
			preset: "me",
			checks: "require",
		});
	});

	it("refuses settings changes from non-admins", async () => {
		const s = await site(HELD);
		const saved = await s.host.admin.submit(
			"/overview",
			"save_settings",
			{ collections: [] },
			{ user: s.editor },
		);
		expect(saved.toast?.type).toBe("error");
	});

	it("lists waiting pages as rows with a Review button, and opens the review", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		const body = text(list);
		// Short tab labels, so all four fit a 390 px phone; the counts are in the numbers above.
		const tabs = [...body.matchAll(/"label":"([^"]+)","blocks"/g)].map((m) => m[1]);
		expect(tabs).toEqual(["Waiting", "Sent back", "History", "Settings"]);
		expect(body).toContain('"label":"Waiting for you","value":1');
		expect(body).toContain("Pages · asked by Sam Reyes");
		expect(body).not.toContain('"type":"table"');
		const review = await s.host.admin.act("/overview", "review", {
			user: s.admin,
			value: { key: `pages:${id}` },
		});
		expect(text(review)).toContain("Approve without review (admins)");
		expect(text(review)).toContain("Approve and publish");
		const writer = await s.host.admin.loadPage("/overview", { user: s.editor });
		expect(text(writer)).toContain("Yours waiting");
		expect(text(writer)).not.toContain('"label":"Settings"');
	});

	it("counts the things to check on each row, kept current as the SEO panel is filled in", async () => {
		const s = await site({ ...HELD, collections: ["articles"] });
		await s.host.fixtures.collection({
			slug: "articles",
			label: "Articles",
			supports: ["drafts", "revisions"],
			hasSeo: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const created = await s.host.actions.content.create("articles", {
			data: { title: "Opening hours" },
			slug: "opening-hours",
			authorId: s.editor.id,
			actor: { id: s.editor.id, role: s.editor.role },
		});
		if (!created.success) throw new Error(created.error.message);
		const id = created.data.item.id;
		await s.host.actions.content.publish("articles", id, actor(s.editor));
		const before = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(before).toContain("Articles · asked by Sam Reyes · just now · 2 things to check");

		const updated = await s.host.actions.content.update("articles", id, {
			seo: { description: "When the bakery is open" },
			actor: { id: s.editor.id, role: s.editor.role },
		});
		if (!updated.success) throw new Error(updated.error.message);
		await settled();
		const after = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(after).toContain("Articles · asked by Sam Reyes · just now · 1 thing to check");
	});

	it("keeps a text copy on the History tab", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		await s.host.admin.act("/overview", "approve_publish", {
			user: s.admin,
			value: { key: `pages:${id}` },
		});
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		expect(text(list)).toContain("Show the approved text");
		expect(text(list)).toContain("Content: Iced coffee £3.20 and lemon tart");
	});

	it("shows the widget count", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const widget = await s.host.admin.loadWidget("approvals", { user: s.admin });
		expect(text(widget)).toContain("Waiting for you");
		expect(text(widget)).toContain("Summer menu");
	});
});

/** A site where the admin is the only person who can approve: one admin and a Contributor. */
async function soloSite(config: Record<string, unknown>) {
	const runtime = await createPluginRuntimeTestHost({
		site: { name: "Harbour Street Bakery", url: "https://bakery.test", locale: "en" },
	});
	host = runtime;
	await runtime.fixtures.collection({
		slug: "pages",
		label: "Pages",
		supports: ["drafts", "revisions"],
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "text" },
		],
	});
	const admin = await runtime.fixtures.user({
		email: "ellen@agency.test",
		name: "Ellen Marsh",
		role: "admin",
	});
	const contributor = await runtime.fixtures.user({
		email: "jo@bakery.test",
		name: "Jo Park",
		role: "contributor",
	});
	await runtime.fixtures.plugin.setting("config", config);
	const created = await runtime.actions.content.create("pages", {
		data: { title: "Summer menu", content: "Iced coffee £3.20 and lemon tart" },
		slug: "summer-menu",
		authorId: admin.id,
		actor: { id: admin.id, role: admin.role },
	});
	if (!created.success) throw new Error(created.error.message);
	return { host: runtime, admin, contributor, id: created.data.item.id };
}

describe("your own request", () => {
	const ME = { ...HELD, preset: "me" };

	async function holdOwn(s: Awaited<ReturnType<typeof soloSite>>) {
		return s.host.actions.content.publish("pages", s.id, {
			actor: { id: s.admin.id, role: s.admin.role },
			origin: { source: "api" },
		});
	}

	it("tells an admin who is the only approver that it needs a second person, and what to do", async () => {
		const s = await soloSite(ME);
		const held = await holdOwn(s);
		expect(held.success).toBe(false);
		if (held.success) return;
		expect(held.error.message).toMatch(/^Sent for approval\. Not live yet\./);
		expect(held.error.message).toContain("nobody else on this site can approve it yet");
		expect(held.error.message).toContain("Publish without review");
		expect(held.error.message).not.toContain("have been asked");
		expect(held.error.message.length).toBeLessThanOrEqual(500);
		const again = await holdOwn(s);
		expect(again.success).toBe(false);
		if (again.success) return;
		expect(again.error.message).toContain("nobody else on this site can approve it yet");
		expect(again.error.message).not.toContain("The approvers were asked");
	});

	it("lists it under 'Yours, waiting' with the reason, not as waiting for you", async () => {
		const s = await soloSite(ME);
		await holdOwn(s);
		const body = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(body).toContain('"label":"Waiting for you","value":0');
		expect(body).toContain('"label":"Yours waiting","value":1');
		expect(body).toContain("For you to approve");
		expect(body).toContain("Yours, waiting");
		expect(body).toContain("needs a second person: nobody else on this site can approve it");
		expect(body).toContain("Only you can approve on this site");
		// The empty "for you" list first, then yours with its row.
		expect(body.indexOf("For you to approve")).toBeLessThan(body.indexOf("Yours, waiting"));
		expect(body.indexOf("Yours, waiting")).toBeLessThan(body.indexOf("Summer menu"));
		const widget = text(await s.host.admin.loadWidget("approvals", { user: s.admin }));
		expect(widget).toContain('"label":"Waiting for you","value":0');
		expect(widget).toContain("1 of yours waiting");
	});

	it("offers Publish without review instead of Approve, and it publishes with a reason", async () => {
		const s = await soloSite(ME);
		await holdOwn(s);
		const review = await s.host.admin.act("/overview", "review", {
			user: s.admin,
			value: { key: `pages:${s.id}` },
		});
		expect(buttonValue(review, "approve_publish")).toBeUndefined();
		expect(buttonValue(review, "approve")).toBeUndefined();
		expect(text(review)).not.toContain('"action_id":"send_back"');
		expect(text(review)).not.toContain("Approve without review");
		expect(text(review)).toContain(
			'"submit":{"label":"Publish without review","action_id":"override_publish"}',
		);
		expect(text(review)).toContain("Nobody else on this site can approve it yet.");

		const empty = await s.host.admin.submit(
			"/overview",
			"override_publish",
			{ reason: " " },
			{ user: s.admin, blockId: `ov:pages:${s.id}` },
		);
		expect(empty.toast?.type).toBe("error");
		const done = await s.host.admin.submit(
			"/overview",
			"override_publish",
			{ reason: "Only one of us runs this site" },
			{ user: s.admin, blockId: `ov:pages:${s.id}` },
		);
		expect(done.toast?.message).toBe("Published without review. It's live now.");
		expect((await s.host.inspect.content.get("pages", s.id))?.status).toBe("published");
		await settled();
		const stored = await s.host.inspect.storage.get<ApprovalRequest>("requests", `pages:${s.id}`);
		expect(stored).toMatchObject({
			status: "published",
			approval: { override: "Only one of us runs this site", published: true },
		});
	});

	it("shows the same in the page's Approval panel", async () => {
		const s = await soloSite(ME);
		await holdOwn(s);
		const panel = await s.host.admin.loadEditorPanel("approval", "pages", s.id, { user: s.admin });
		expect(buttonValue(panel, "approve")).toBeUndefined();
		expect(text(panel)).toContain("Nobody else on this site can approve it yet.");
		expect(text(panel)).toContain('"action_id":"override_publish"');
		const done = await s.host.admin.submitEditorPanel(
			"approval",
			"pages",
			s.id,
			"override_publish",
			{ reason: "Only one of us runs this site" },
			{ user: s.admin, blockId: `ov:pages:${s.id}` },
		);
		expect(done.toast?.message).toBe("Published without review. It's live now.");
		expect(done.refresh).toBe(true);
		expect((await s.host.inspect.content.get("pages", s.id))?.status).toBe("published");
	});

	it("warns in Settings that approval needs a second person, only when it does", async () => {
		const solo = await soloSite(ME);
		const alone = text(await solo.host.admin.loadPage("/overview", { user: solo.admin }));
		expect(alone).toContain("Approval needs a second person");
		await solo.host.dispose();
		host = undefined;
		const s = await site(ME);
		const team = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(team).not.toContain("Approval needs a second person");
		expect(team).not.toContain("Only you can approve on this site");
	});

	it("shows an editor why theirs waits, and no buttons they cannot use", async () => {
		const s = await site(ME);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const list = text(await s.host.admin.loadPage("/overview", { user: s.editor }));
		expect(list).toContain("Yours, waiting");
		expect(list).toContain("waiting for Ellen Marsh and Tom Achebe");
		expect(list).toContain('"label":"Waiting for you","value":0');
		expect(list).not.toContain('"action_id":"review"');
		const review = await s.host.admin.act("/overview", "review", {
			user: s.editor,
			value: { key: `pages:${id}` },
		});
		expect(buttonValue(review, "approve")).toBeUndefined();
		expect(text(review)).not.toContain("Publish without review");
		const panel = text(
			await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.editor }),
		);
		expect(panel).toContain("Waiting for Ellen Marsh and Tom Achebe.");
		expect(panel).not.toContain("Publish without review");
		// Someone else's request keeps the approver's buttons.
		const other = await s.host.admin.act("/overview", "review", {
			user: s.admin,
			value: { key: `pages:${id}` },
		});
		expect(buttonValue(other, "approve_publish")).toBeDefined();
		expect(text(other)).toContain("Approve without review (admins)");
	});
});
