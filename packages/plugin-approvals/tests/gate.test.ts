// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { countNodes } from "../src/admin.js";
import { HELP_LINE } from "../src/help-line.js";
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

	it("tells a publishing AI tool that an approver will decide, when AI approval is on", async () => {
		const s = await site({ ...HELD, aiApprove: true });
		const id = await page(s, {}, s.admin);
		const result = await s.host.actions.content.publish("pages", id, actor(s.admin, "mcp"));
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.message).toMatch(
			/^Sent for approval\. Not live yet\. On this site what AI tools publish waits for approval; .*Do not publish it again: an approver will decide\.$/,
		);
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
		expect(before).toContain(
			"Articles · asked by Sam Reyes · just now · new page · 2 things to check",
		);

		const updated = await s.host.actions.content.update("articles", id, {
			seo: { description: "When the bakery is open" },
			actor: { id: s.editor.id, role: s.editor.role },
		});
		if (!updated.success) throw new Error(updated.error.message);
		await settled();
		const after = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(after).toContain(
			"Articles · asked by Sam Reyes · just now · new page · 1 thing to check",
		);
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

describe("the help line", () => {
	const lines = (response: { blocks: Array<{ block_id?: string }> }) =>
		response.blocks.filter((block) => block.block_id === HELP_LINE).length;
	const LINE = {
		type: "actions",
		block_id: HELP_LINE,
		elements: [
			{
				type: "link",
				label: "Help",
				target: {
					kind: "external",
					url: "https://moorage.dev/guides/approve-pages-before-they-go-live-on-emdash",
				},
			},
			{
				type: "link",
				label: "More free plugins",
				target: { kind: "external", url: "https://moorage.dev/plugins" },
			},
			{
				type: "link",
				label: "by Moorage",
				target: { kind: "external", url: "https://moorage.dev" },
			},
		],
	};

	it("ends every screen an admin sees: the list, before any save too, and a review", async () => {
		const fresh = await site();
		const first = await fresh.host.admin.loadPage("/overview", { user: fresh.admin });
		expect(first.blocks.at(-1)).toEqual(LINE);
		await fresh.host.dispose();

		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		expect(list.blocks.at(-1)).toEqual(LINE);
		const review = await s.host.admin.act("/overview", "review", {
			user: s.admin,
			value: { key: `pages:${id}` },
		});
		expect(lines(review)).toBe(1);
		expect(review.blocks.at(-1)).toEqual(LINE);
	});

	it("never shows to editors or contributors, nor on the widget or the editor panel", async () => {
		const s = await site(HELD);
		const id = await page(s);
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		for (const user of [s.editor, s.contributor]) {
			expect(text(await s.host.admin.loadPage("/overview", { user }))).not.toMatch(/moorage/i);
		}
		const widget = await s.host.admin.loadWidget("approvals", { user: s.admin });
		expect(text(widget)).not.toMatch(/moorage/i);
		const panel = await s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.admin });
		expect(JSON.stringify(panel)).not.toMatch(/moorage/i);
	});

	it("hides with the switch in Settings, kept through later saves, and shows again", async () => {
		const s = await site(HELD);
		const settings = { collections: ["pages"], preset: "others", ai: true, checks: "remind" };
		const hidden = await s.host.admin.submit(
			"/overview",
			"save_settings",
			{ ...settings, hide_help_line: true },
			{ user: s.admin },
		);
		expect(lines(hidden)).toBe(0);
		expect(await s.host.inspect.setting("config")).toMatchObject({ hideHelpLine: true });
		expect(lines(await s.host.admin.loadPage("/overview", { user: s.admin }))).toBe(0);

		// A later save that leaves the switch untouched keeps it.
		await s.host.admin.submit("/overview", "save_settings", settings, { user: s.admin });
		expect(lines(await s.host.admin.loadPage("/overview", { user: s.admin }))).toBe(0);

		const shown = await s.host.admin.submit(
			"/overview",
			"save_settings",
			{ ...settings, hide_help_line: false },
			{ user: s.admin },
		);
		expect(lines(shown)).toBe(1);
	});

	it("an editor cannot use the switch", async () => {
		const s = await site(HELD);
		await s.host.admin.submit(
			"/overview",
			"save_settings",
			{ hide_help_line: true },
			{ user: s.editor },
		);
		expect(lines(await s.host.admin.loadPage("/overview", { user: s.admin }))).toBe(1);
	});
});

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

/**
 * A content type like a site's Releases, with no `title` field at all. (Its declared title field,
 * `release_version` on the real site, cannot be set through the test host's fixtures: the
 * declared field is covered by entryName's own test and by the demo site's.) `Notes` has no field
 * named title or name either; `People` has `name`.
 */
async function releases(s: Site): Promise<void> {
	await s.host.fixtures.collection({
		slug: "releases",
		label: "Releases",
		supports: ["drafts", "revisions"],
		fields: [
			{ slug: "plugin", label: "Plugin", type: "string" },
			{ slug: "release_version", label: "Version", type: "string" },
			{ slug: "summary", label: "Summary", type: "text" },
			{ slug: "line", label: "Line", type: "string" },
		],
	});
	await s.host.fixtures.collection({
		slug: "notes",
		label: "Notes",
		supports: ["drafts", "revisions"],
		fields: [{ slug: "body", label: "Body", type: "text" }],
	});
	await s.host.fixtures.collection({
		slug: "people",
		label: "People",
		supports: ["drafts", "revisions"],
		fields: [{ slug: "name", label: "Name", type: "string" }],
	});
}

async function entry(
	s: Site,
	collection: string,
	data: Record<string, unknown>,
	slug: string | null,
	by: User = s.editor,
): Promise<string> {
	const created = await s.host.actions.content.create(collection, {
		data,
		...(slug ? { slug } : {}),
		authorId: by.id,
		actor: { id: by.id, role: by.role },
	});
	if (!created.success) throw new Error(created.error.message);
	return created.data.item.id;
}

const NAMED = { ...HELD, collections: ["pages", "releases", "notes", "people"] };

describe("naming a request for an entry without a title field", () => {
	it("names a release by its address name, not Untitled", async () => {
		const s = await site(NAMED);
		await releases(s);
		const id = await entry(
			s,
			"releases",
			{ plugin: "analytics", release_version: "0.4.3", summary: "HubSpot visits.", line: "x" },
			"analytics-0-4-3",
		);
		const result = await s.host.actions.content.publish("releases", id, actor(s.editor));
		expect(result.success).toBe(false);
		const stored = await s.host.inspect.storage.get<ApprovalRequest>("requests", `releases:${id}`);
		expect(stored?.title).toBe("analytics-0-4-3");
		const list = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(list).toContain('"text":"analytics-0-4-3"');
		expect(list).not.toContain("Untitled");
	});

	it("falls back to a field named name, then the slug, then the id: never Untitled", async () => {
		const s = await site(NAMED);
		await releases(s);
		const person = await entry(s, "people", { name: "Ada Baker" }, "ada");
		const note = await entry(s, "notes", { body: "Closed on Monday" }, "monday-closing");
		// The declared title field left empty: the slug names it.
		const blank = await entry(
			s,
			"releases",
			{ plugin: "seo", release_version: "", summary: "s" },
			"seo-next",
		);
		for (const [collection, id] of [
			["people", person],
			["notes", note],
			["releases", blank],
		] as const) {
			await s.host.actions.content.publish(collection, id, actor(s.editor));
		}
		const title = async (collection: string, id: string) =>
			(await s.host.inspect.storage.get<ApprovalRequest>("requests", `${collection}:${id}`))?.title;
		expect(await title("people", person)).toBe("Ada Baker");
		expect(await title("notes", note)).toBe("monday-closing");
		expect(await title("releases", blank)).toBe("seo-next");
	});

	it("names it the same when asked from the toolbar, and in the review, panel and email", async () => {
		const s = await site(NAMED);
		await releases(s);
		const id = await entry(
			s,
			"releases",
			{ plugin: "seo", release_version: "0.3.1", summary: "Fixes." },
			"seo-0-3-1",
		);
		await s.host.admin.invokeEditorAction("ask", "releases", id, { user: s.editor });
		const stored = await s.host.inspect.storage.get<ApprovalRequest>("requests", `releases:${id}`);
		expect(stored?.title).toBe("seo-0-3-1");
		const panel = text(
			await s.host.admin.loadEditorPanel("approval", "releases", id, { user: s.admin }),
		);
		expect(panel).not.toContain("Untitled");
		const review = text(
			await s.host.admin.act("/overview", "review", {
				user: s.admin,
				value: { key: `releases:${id}` },
			}),
		);
		expect(review).toContain('"text":"seo-0-3-1"');
	});

	it("repairs a request stored as Untitled by an earlier release when the list opens", async () => {
		const s = await site(NAMED);
		await releases(s);
		const id = await entry(
			s,
			"releases",
			{ plugin: "seo", release_version: "0.3.1", summary: "Fixes." },
			"seo-0-3-1",
		);
		await s.host.actions.content.publish("releases", id, actor(s.editor));
		const key = `releases:${id}`;
		const stored = await s.host.inspect.storage.get<ApprovalRequest>("requests", key);
		await s.host.fixtures.plugin.storage("requests", key, { ...stored, title: "Untitled" });
		const list = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(list).toContain('"text":"seo-0-3-1"');
		expect(list).not.toContain("Untitled");
		expect((await s.host.inspect.storage.get<ApprovalRequest>("requests", key))?.title).toBe(
			"seo-0-3-1",
		);
	});
});

/** The bulk form on the Waiting tab: its tick boxes and their values. */
function bulkForm(response: unknown): {
	options: Array<{ label: string; value: string }>;
	ticked: string[];
} | null {
	let found: { options: Array<{ label: string; value: string }>; ticked: string[] } | null = null;
	const walk = (node: unknown) => {
		if (found || typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (record.type === "checkbox" && record.action_id === "pick") {
			found = {
				options: record.options as Array<{ label: string; value: string }>,
				ticked: (record.initial_value as string[] | undefined) ?? [],
			};
			return;
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(response);
	return found;
}

/** The confirm step's button value for this person's stored selection. */
async function pickValue(
	s: Site,
	by: User,
	what: "publish" | "send_back" = "publish",
): Promise<unknown> {
	const pick = await s.host.inspect.kv.get<{ at: string }>(`state:bulk-pick:${by.id}`);
	return { pick: pick?.at, do: what };
}

/** Press a confirm step's button, let the background turns finish, and open the list again. */
async function press(
	s: Site,
	by: User,
	what: "publish" | "send_back" = "publish",
): Promise<{ started: Awaited<ReturnType<Site["host"]["admin"]["act"]>>; list: unknown }> {
	const started = await s.host.admin.act("/overview", "bulk_go", {
		user: by,
		value: await pickValue(s, by, what),
	});
	await runAll(s);
	const list = await s.host.admin.loadPage("/overview", { user: by });
	return { started, list };
}

/** The value of a button in a response, by its action and (optionally) its label. */
function buttonOf(
	response: unknown,
	action: string,
	label?: string,
): Record<string, unknown> | null {
	let found: Record<string, unknown> | null = null;
	const walk = (node: unknown) => {
		if (found || typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (
			record.type === "button" &&
			record.action_id === action &&
			(!label || record.label === label)
		) {
			found = record;
			return;
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(response);
	return found;
}

/** Run the due one-shot tasks (the bulk runs and their emails) until none are left. */
async function runAll(s: Site): Promise<void> {
	for (let i = 0; i < 30; i++) {
		await settled();
		s.host.scheduled.setTime(new Date(Date.now() + 60_000));
		const { processed } = await s.host.scheduled.run();
		if (processed === 0) return;
	}
}

async function held(s: Site, title: string, by: User = s.editor): Promise<string> {
	const id = await s.host.actions.content.create("pages", {
		data: { title, content: "Iced coffee £3.20 and lemon tart" },
		slug: title.toLowerCase().replace(/\s+/g, "-"),
		authorId: by.id,
		actor: { id: by.id, role: by.role },
	});
	if (!id.success) throw new Error(id.error.message);
	const result = await s.host.actions.content.publish("pages", id.data.item.id, actor(by));
	if (result.success) throw new Error("expected the publish to be held");
	return id.data.item.id;
}

describe("deciding from the Waiting list", () => {
	it("gives each row Approve and publish and Review, two or more an all button, and tick boxes saying what each is", async () => {
		const s = await site(HELD);
		await held(s, "Summer menu");
		const live = await held(s, "Opening hours");
		await s.host.admin.act("/overview", "approve_publish", {
			user: s.admin,
			value: { key: `pages:${live}` },
		});
		await settled();
		await edit(s, live, { title: "Opening hours", content: "Open until 9pm" });
		await s.host.actions.content.publish("pages", live, actor(s.editor));
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		const form = bulkForm(list);
		expect(form?.options).toHaveLength(2);
		expect(form?.ticked).toEqual([]);
		expect(form?.options[0]?.label).toMatch(
			/^Summer menu · Pages · asked by Sam Reyes, just now · to publish · new page$/,
		);
		expect(form?.options[1]?.label).toMatch(/^Opening hours · .* · changed: Content$/);
		const body = text(list);
		expect(body).toContain('"label":"Continue with the ticked pages"');
		expect(body).not.toContain("Which pages");
		expect(body).toContain('"action_id":"review"');
		const row = buttonOf(list, "row_approve");
		expect(row?.label).toBe("Approve and publish");
		expect(row?.confirm).toMatchObject({ title: 'Approve and publish "Summer menu"?' });
		const all = buttonOf(list, "bulk_all");
		expect(all?.label).toBe("Approve and publish all 2");
		expect(all?.confirm).toMatchObject({
			title: "Approve and publish all 2?",
			text: "All 2 pages go live now, oldest first. A page that changed since this list was drawn is skipped and stays here.",
		});
	});

	it("shows writers no new controls", async () => {
		const s = await site(HELD);
		await held(s, "Summer menu");
		await held(s, "Bake sale");
		for (const who of [s.editor, s.contributor]) {
			const body = text(await s.host.admin.loadPage("/overview", { user: who }));
			for (const action of ["row_approve", "bulk_all", "bulk_review"])
				expect(body, `${who.name}: ${action}`).not.toContain(`"action_id":"${action}"`);
		}
	});

	it("approves and publishes one from its row, in place", async () => {
		const s = await site(HELD);
		const id = await held(s, "Summer menu");
		await held(s, "Bake sale");
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		const done = await s.host.admin.act("/overview", "row_approve", {
			user: s.admin,
			value: buttonOf(list, "row_approve")!.value,
		});
		await settled();
		expect(done.toast?.type).toBe("success");
		expect(text(done)).toContain('"text":"For you to approve"');
		expect((await request(s, id))?.status).toBe("published");
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
	});

	it("refuses a row's Approve for a page edited after the list was drawn", async () => {
		const s = await site(HELD);
		const id = await held(s, "Summer menu");
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		await edit(s, id, { title: "Summer menu", content: "Iced coffee £3.40" });
		await settled();
		const done = await s.host.admin.act("/overview", "row_approve", {
			user: s.admin,
			value: buttonOf(list, "row_approve")!.value,
		});
		expect(done.toast).toEqual({
			type: "error",
			message: "This page changed while you were looking. Check the new version, then decide.",
		});
		expect((await request(s, id))?.status).toBe("waiting");
	});

	it("approves a request to schedule from its row without publishing it", async () => {
		const s = await site(HELD);
		const id = await heldSchedule(s, "Autumn menu");
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		const row = buttonOf(list, "row_approve")!;
		expect(row.label).toBe("Approve");
		expect(text(row.confirm)).toContain("approved, not published");
		await s.host.admin.act("/overview", "row_approve", { user: s.admin, value: row.value });
		await settled();
		expect((await request(s, id))?.status).toBe("approved");
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("draft");
	});

	it("refuses a row's Approve from someone who may not approve, and someone's own request", async () => {
		const s = await site({ ...HELD, preset: "me" });
		const own = await held(s, "Ellen's own", s.admin);
		const other = await held(s, "Summer menu", s.contributor);
		const mine = await s.host.admin.act("/overview", "row_approve", {
			user: s.admin,
			value: { key: `pages:${own}`, seen: (await request(s, own))!.fingerprint },
		});
		expect(mine.toast).toEqual({
			type: "error",
			message: "You asked for this approval, so someone else needs to approve it.",
		});
		const writer = await s.host.admin.act("/overview", "row_approve", {
			user: s.contributor,
			value: { key: `pages:${other}`, seen: (await request(s, other))!.fingerprint },
		});
		expect(writer.toast?.type).toBe("error");
		expect((await request(s, own))?.status).toBe("waiting");
		expect((await request(s, other))?.status).toBe("waiting");
	});

	it("Approve and publish all: decides at once exactly what the button was drawn with", async () => {
		const s = await site(HELD);
		const first = await held(s, "Summer menu");
		const second = await held(s, "Bake sale");
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		// Another tab: a third request arrives after this list was drawn.
		const later = await held(s, "Arrived later");
		const done = await s.host.admin.act("/overview", "bulk_all", {
			user: s.admin,
			value: buttonOf(list, "bulk_all")!.value,
		});
		await settled();
		expect(done.toast).toEqual({ type: "success", message: "Approved 2 of 2." });
		expect(text(done)).toContain("Approved 2 of 2 pages.");
		for (const id of [first, second]) expect((await request(s, id))?.status).toBe("published");
		expect((await request(s, later))?.status).toBe("waiting");
		// Nothing left for the background.
		expect(
			(await s.host.inspect.scheduledTasks()).some((t) => String(t.name).startsWith("bulk-")),
		).toBe(false);
	});

	it("Approve and publish all skips a page edited since the list was drawn, and leaves it ticked", async () => {
		const s = await site(HELD);
		const changed = await held(s, "Summer menu");
		const fine = await held(s, "Bake sale");
		const list = await s.host.admin.loadPage("/overview", { user: s.admin });
		await edit(s, changed, { title: "Summer menu", content: "Iced coffee £3.40" });
		await settled();
		const done = await s.host.admin.act("/overview", "bulk_all", {
			user: s.admin,
			value: buttonOf(list, "bulk_all")!.value,
		});
		await settled();
		expect(text(done)).toContain("Approved 1 of 2 pages. 1 need a look; they are ticked below.");
		expect(text(done)).toContain("This page changed while you were looking");
		expect((await request(s, fine))?.status).toBe("published");
		expect((await request(s, changed))?.status).toBe("waiting");
		const ticked = bulkForm(done)?.ticked ?? [];
		expect(ticked).toHaveLength(1);
		expect(ticked[0]).toContain(`pages:${changed}@`);
	});

	it("the ticked ones: Continue lists them, and Approve and publish N decides them at once, oldest first", async () => {
		const s = await site(HELD);
		const first = await held(s, "Summer menu");
		const second = await held(s, "Bake sale");
		const not = await held(s, "Not this one");
		const form = bulkForm(await s.host.admin.loadPage("/overview", { user: s.admin }))!;
		const confirm = await s.host.admin.submit(
			"/overview",
			"bulk_review",
			{ pick: [form.options[1]!.value, form.options[0]!.value] },
			{ user: s.admin },
		);
		const body = text(confirm);
		expect(body).toContain("Decide these 2?");
		expect(body).toContain('"label":"Approve and publish 2"');
		expect(body).not.toContain('"label":"Send back 2"');
		expect(body).toContain("To send them back instead, go back and write a note.");
		expect(body).not.toContain("Not this one");
		const done = await press(s, s.admin);
		expect(done.started.toast).toEqual({ type: "success", message: "Approved 2 of 2." });
		expect(text(done.started)).toContain("Approved and published. It's live now.");
		for (const id of [first, second]) {
			expect((await request(s, id))?.status).toBe("published");
			expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
		}
		expect((await request(s, not))?.status).toBe("waiting");
	});

	it("sends back the ticked ones with one note, which is required", async () => {
		const s = await site(HELD);
		const first = await held(s, "Summer menu");
		const second = await held(s, "Bake sale");
		const form = bulkForm(await s.host.admin.loadPage("/overview", { user: s.admin }))!;
		const pick = form.options.map((o) => o.value);
		await s.host.admin.submit("/overview", "bulk_review", { pick, reason: " " }, { user: s.admin });
		const refused = await s.host.admin.act("/overview", "bulk_go", {
			user: s.admin,
			value: await pickValue(s, s.admin, "send_back"),
		});
		expect(refused.toast).toEqual({
			type: "error",
			message: "Write a note to send them back, then press Continue.",
		});
		expect(bulkForm(refused)?.ticked).toEqual(pick);
		const confirm = await s.host.admin.submit(
			"/overview",
			"bulk_review",
			{ pick, reason: "Prices are out of date" },
			{ user: s.admin },
		);
		expect(text(confirm)).toContain('"label":"Send back 2"');
		const done = await press(s, s.admin, "send_back");
		expect(done.started.toast).toEqual({ type: "success", message: "Sent back 2 of 2." });
		for (const id of [first, second])
			expect((await request(s, id))?.sentBack?.note).toBe("Prices are out of date");
	});

	it("Continue with nothing ticked asks to tick", async () => {
		const s = await site(HELD);
		await held(s, "Summer menu");
		await held(s, "Bake sale");
		const done = await s.host.admin.submit(
			"/overview",
			"bulk_review",
			{ pick: [] },
			{ user: s.admin },
		);
		expect(done.toast).toEqual({
			type: "error",
			message: "Tick at least one page, then press Continue.",
		});
	});
});

/** A page Sam asked to schedule (held). */
async function heldSchedule(s: Site, title: string): Promise<string> {
	const created = await s.host.actions.content.create("pages", {
		data: { title, content: "Iced coffee £3.20" },
		slug: title.toLowerCase().replace(/\s+/g, "-"),
		authorId: s.editor.id,
		actor: { id: s.editor.id, role: s.editor.role },
	});
	if (!created.success) throw new Error(created.error.message);
	const id = created.data.item.id;
	const held = await s.host.actions.content.schedule(
		"pages",
		id,
		new Date(Date.now() + 86_400_000).toISOString(),
		{
			...actor(s.editor),
		},
	);
	if (held.success) throw new Error("expected the schedule to be held");
	return id;
}

/** The tick boxes' values, as the form would submit them. */
function allValues(response: unknown): string[] {
	return bulkForm(response)?.options.map((o) => o.value) ?? [];
}

describe("deciding several at once: the audit's findings", () => {
	it("approves a request to schedule without publishing it, and says so before and after", async () => {
		const s = await site(HELD);
		const now = await held(s, "Summer menu");
		const later = await heldSchedule(s, "Autumn menu");
		const pick = allValues(await s.host.admin.loadPage("/overview", { user: s.admin }));
		const confirm = await s.host.admin.submit(
			"/overview",
			"bulk_review",
			{ pick },
			{ user: s.admin },
		);
		expect(text(confirm)).toContain(
			"A request to schedule is approved, not published: its writer then schedules it.",
		);
		const done = await press(s, s.admin);
		await settled();
		expect(text(done.started)).toContain("Approved. Sam can schedule it now.");
		expect((await request(s, now))?.status).toBe("published");
		expect((await request(s, later))?.status).toBe("approved");
		expect((await s.host.inspect.content.get("pages", later))?.status).toBe("draft");
	});

	it("reports a request gone between the confirm step and the press", async () => {
		const s = await site(HELD);
		await held(s, "Summer menu");
		await held(s, "Bake sale");
		const pick = allValues(await s.host.admin.loadPage("/overview", { user: s.admin }));
		const confirm = await s.host.admin.submit(
			"/overview",
			"bulk_review",
			{ pick },
			{ user: s.admin },
		);
		expect(text(confirm)).toContain(
			"Oldest first. A page that changed since this list was drawn is skipped.",
		);
		const stored = await s.host.inspect.kv.get<{ rows: Array<{ key: string; seen: string }> }>(
			`state:bulk-pick:${s.admin.id}`,
		);
		await s.host.fixtures.plugin.kv(`state:bulk-pick:${s.admin.id}`, {
			...stored,
			rows: [...stored!.rows, { key: "pages:gone", seen: "x" }],
		});
		const after = await press(s, s.admin);
		expect(text(after.started)).toContain("This request no longer exists.");
	});

	it("refuses every row of a forged selection from someone who does not approve", async () => {
		const s = await site(HELD);
		const id = await held(s, "Summer menu", s.contributor);
		// The selection lives on the server; even one written there for an Editor is refused.
		await s.host.fixtures.plugin.kv(`state:bulk-pick:${s.editor.id}`, {
			do: "publish",
			reason: "",
			rows: [{ key: `pages:${id}`, seen: (await request(s, id))!.fingerprint }],
			at: new Date().toISOString(),
		});
		const { started } = await press(s, s.editor);
		expect(text(started)).toContain("You can't approve on this site.");
		expect(text(started)).not.toContain("Approved and published");
		expect((await request(s, id))?.status).toBe("waiting");
	});

	it("refuses a second while one goes on, and two approvers' decisions approve each page once", async () => {
		const s = await site(HELD);
		const ids: string[] = [];
		for (let i = 0; i < 8; i++) ids.push(await held(s, `Page ${i + 1}`));
		for (const by of [s.admin, s.admin2]) {
			const pick = allValues(await s.host.admin.loadPage("/overview", { user: by }));
			await s.host.admin.submit("/overview", "bulk_review", { pick }, { user: by });
		}
		const first = await s.host.admin.act("/overview", "bulk_go", {
			user: s.admin,
			value: await pickValue(s, s.admin),
		});
		expect(first.toast?.type).toBe("success");
		expect(first.toast?.message).toMatch(/^\d done\. The other \d follow in the background/);
		const pick = allValues(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(pick).toEqual([]);
		const again = await s.host.admin.act("/overview", "bulk_all", {
			user: s.admin,
			value: { rows: ids.map((id) => `pages:${id}@x`) },
		});
		expect(again.toast).toEqual({
			type: "error",
			message: "Your earlier decision on several pages is still going. Wait for it, or stop it.",
		});
		const other = await s.host.admin.act("/overview", "bulk_go", {
			user: s.admin2,
			value: await pickValue(s, s.admin2),
		});
		expect(other.toast?.type).toBe("success");
		await runAll(s);
		for (const id of ids) {
			const stored = await request(s, id);
			expect(stored?.status).toBe("published");
			expect(stored?.history.filter((h) => h.text.endsWith(" approved"))).toHaveLength(1);
		}
	});

	it("stops the background part, and dismisses its results", async () => {
		const s = await site(HELD);
		for (let i = 0; i < 8; i++) await held(s, `Page ${i + 1}`);
		const pick = allValues(await s.host.admin.loadPage("/overview", { user: s.admin }));
		await s.host.admin.submit("/overview", "bulk_review", { pick }, { user: s.admin });
		await s.host.admin.act("/overview", "bulk_go", {
			user: s.admin,
			value: await pickValue(s, s.admin),
		});
		await settled();
		const running = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(running).toMatch(/Approving 8 pages: \d done\. You can leave this page\./);
		expect(running).not.toContain('"action_id":"pick"');
		expect(running).not.toContain('"action_id":"bulk_all"');
		const stopped = await s.host.admin.act("/overview", "bulk_stop", { user: s.admin });
		expect(stopped.toast?.message).toBe(
			"Stopping. What is already decided stays decided; the rest stays in Waiting.",
		);
		await runAll(s);
		const list = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(list).toMatch(/Stopped\. Approved \d of 8 pages\./);
		expect(list).toContain("Not done: you stopped it.");
		const dismissed = text(await s.host.admin.act("/overview", "bulk_dismiss", { user: s.admin }));
		expect(dismissed).not.toContain("Stopped.");
	});
});

describe("the audit's naming and wording findings", () => {
	it("calls the first AI switch what it does, and warns on the second", async () => {
		const s = await site(HELD);
		const body = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(body).toContain('"label":"Hold what AI tools publish for approval"');
		expect(body).not.toContain("always need a person's OK");
		expect(body).toContain(
			"This includes pages the AI tool itself wrote or published: with this on, an AI tool can put its own work live without a person.",
		);
	});

	it("names old Untitled rows in the widget and on a repeat Publish", async () => {
		const s = await site(HELD);
		const id = await held(s, "Summer menu");
		const key = `pages:${id}`;
		await s.host.fixtures.plugin.storage("requests", key, {
			...(await request(s, id)),
			title: "Untitled",
		});
		const widget = text(await s.host.admin.loadWidget("approvals", { user: s.admin }));
		expect(widget).toContain('"text":"Summer menu"');
		await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect((await request(s, id))?.title).toBe("Summer menu");
	});

	it("names an old Untitled row in the send-back email", async () => {
		const s = await site(HELD);
		const id = await held(s, "Summer menu");
		const key = `pages:${id}`;
		await s.host.fixtures.plugin.storage("requests", key, {
			...(await request(s, id)),
			title: "Untitled",
		});
		await s.host.admin.submit(
			"/overview",
			"send_back",
			{ note: "Prices" },
			{
				user: s.admin,
				blockId: `sb:${key}`,
			},
		);
		const stored = await request(s, id);
		expect(stored?.status).toBe("sent_back");
		expect(stored?.title).toBe("Summer menu");
	});

	it("back-fill skips closed rows and moves past rows it cannot name", async () => {
		const s = await site(HELD);
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) ids.push(await held(s, `Page ${i + 1}`));
		// Five rows whose entries are gone (an earlier version kept them waiting), then one that exists.
		for (let i = 0; i < 5; i++) {
			const stored = await request(s, ids[i]!);
			await s.host.fixtures.plugin.storage("requests", `pages:gone${i}`, {
				...stored,
				entryId: `gone${i}`,
				title: "Untitled",
				requestedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
			});
		}
		await s.host.fixtures.plugin.storage("requests", `pages:${ids[5]}`, {
			...(await request(s, ids[5]!)),
			title: "Untitled",
		});
		await s.host.admin.loadPage("/overview", { user: s.admin });
		await s.host.admin.loadPage("/overview", { user: s.admin });
		expect((await request(s, ids[5]!))?.title).toBe("Page 6");
	});

	it("writes an AI tool in lower case mid-sentence", async () => {
		const s = await site({ ...HELD, aiApprove: true });
		const id = await held(s, "Summer menu");
		await s.host.fixtures.plugin.storage("requests", `pages:${id}`, {
			...(await request(s, id)),
			status: "approved",
			approval: {
				by: { id: s.admin.id, name: "An AI tool acting for Ellen Marsh" },
				at: new Date().toISOString(),
				fingerprint: "x",
				versionId: "",
			},
		});
		const body = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(body).toContain("Approved by an AI tool acting for Ellen Marsh");
		expect(body).not.toContain("by An AI tool");
	});
});

describe("the second audit of bulk runs", () => {
	/** Tick every waiting page and press Continue. */
	async function tickAll(s: Site, by: User, reason = "") {
		const pick = allValues(await s.host.admin.loadPage("/overview", { user: by }));
		return s.host.admin.submit("/overview", "bulk_review", { pick, reason }, { user: by });
	}

	it("a confirm step's button decides only the selection it showed (two tabs)", async () => {
		const s = await site(HELD);
		const ids = [await held(s, "Summer menu"), await held(s, "Bake sale")];
		const sendBack = await tickAll(s, s.admin, "Prices");
		// Another tab: a new selection.
		await tickAll(s, s.admin);
		const stale = await s.host.admin.act("/overview", "bulk_go", {
			user: s.admin,
			value: buttonValue(sendBack, "bulk_go"),
		});
		expect(stale.toast).toEqual({
			type: "error",
			message: "Tick the pages again, then press Continue.",
		});
		await runAll(s);
		for (const id of ids) expect((await request(s, id))?.status).toBe("waiting");
	});

	it("the Stop dialog says the pages being decided now finish first", async () => {
		const s = await site(HELD);
		for (let i = 0; i < 8; i++) await held(s, `Page ${i + 1}`);
		await tickAll(s, s.admin);
		await s.host.admin.act("/overview", "bulk_go", {
			user: s.admin,
			value: await pickValue(s, s.admin),
		});
		await settled();
		const body = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(body).toContain(
			"The pages being decided right now finish first. What is decided stays decided; the rest stays in Waiting.",
		);
	});

	it("says what happened when the settings could not be read during a background turn", async () => {
		const s = await site(HELD);
		for (let i = 0; i < 8; i++) await held(s, `Page ${i + 1}`);
		await tickAll(s, s.admin);
		await s.host.admin.act("/overview", "bulk_go", {
			user: s.admin,
			value: await pickValue(s, s.admin),
		});
		await settled();
		await s.host.fixtures.plugin.setting("config", null);
		await runAll(s);
		const lanes = JSON.stringify(await s.host.inspect.kv.list());
		expect(lanes).toContain(
			"Not done: the approval settings could not be read, so it stopped. Decide it from the list.",
		);
	});
});

describe("an earlier result after a newer decision", () => {
	it("is put away when a newer press decides everything at once, so it does not come back on reload", async () => {
		const s = await site(HELD);
		await held(s, "Page 1");
		await held(s, "Page 2");
		const pick = allValues(await s.host.admin.loadPage("/overview", { user: s.admin }));
		// The first decision ends with one that needs a look: it is ticked on the list.
		await s.host.admin.submit("/overview", "bulk_review", { pick }, { user: s.admin });
		const stored = await s.host.inspect.kv.get<{ rows: Array<{ key: string; seen: string }> }>(
			`state:bulk-pick:${s.admin.id}`,
		);
		await s.host.fixtures.plugin.kv(`state:bulk-pick:${s.admin.id}`, {
			...stored,
			rows: [...stored!.rows, { key: "pages:gone", seen: "x" }],
		});
		// A finished result of an earlier, stored run: as the background leaves it.
		await s.host.fixtures.plugin.kv(`state:bulk:${s.admin.id}`, {
			id: "old",
			do: "publish",
			reason: "",
			total: 9,
			lanes: 1,
			at: new Date(Date.now() - 3_600_000).toISOString(),
		});
		await s.host.fixtures.plugin.kv(`state:bulk:${s.admin.id}:old:0`, {
			run: "old",
			seq: 3,
			rows: [],
			results: [{ key: "pages:x", title: "Old page", state: "failed", text: "Changed." }],
			endedAt: new Date(Date.now() - 3_000_000).toISOString(),
		});
		expect(text(await s.host.admin.loadPage("/overview", { user: s.admin }))).toContain(
			"Approved 0 of 9 pages.",
		);
		await s.host.admin.act("/overview", "bulk_go", {
			user: s.admin,
			value: await pickValue(s, s.admin),
		});
		await settled();
		const reload = text(await s.host.admin.loadPage("/overview", { user: s.admin }));
		expect(reload).not.toContain("Approved 0 of 9 pages.");
		expect(reload).not.toContain("Old page");
	});
});

describe("a page with very many requests", () => {
	// EmDash returns at most 100 requests to one query, so the page never holds more than 100;
	// 100 sent back came to 1,953 values before every tab was cut (EmDash refuses over 2,000).
	it("opens with 150 sent back and 100 waiting, every tab cut to fit, each saying how many more", async () => {
		const s = await site(HELD);
		const id = await held(s, "Summer menu");
		const stored = (await s.host.inspect.storage.get<ApprovalRequest>("requests", `pages:${id}`))!;
		const at = (i: number) =>
			new Date(Date.parse("2026-11-01T00:00:00Z") + i * 60_000).toISOString();
		for (let i = 0; i < 150; i++)
			await s.host.fixtures.plugin.storage("requests", `pages:back${i}`, {
				...stored,
				entryId: `back${i}`,
				title: `Sent back ${i + 1}`,
				status: "sent_back",
				sentBack: {
					by: { id: s.admin.id, name: "Ellen Marsh" },
					at: at(i),
					note: "The prices on this page are out of date; please check them against the new menu.",
				},
				// EmDash returns at most 100 requests to one query: the most recently changed. Sent back
				// last, they fill it.
				updatedAt: at(i + 600),
			});
		for (let i = 0; i < 99; i++)
			await s.host.fixtures.plugin.storage("requests", `pages:wait${i}`, {
				...stored,
				entryId: `wait${i}`,
				title: `Waiting ${i + 1}`,
				requestedAt: at(i),
				updatedAt: at(i + 400),
			});
		const page = await s.host.admin.loadPage("/overview", { user: s.admin });
		const body = text(page);
		console.info(
			`very many: ${countNodes(page)} values, ${body.length} bytes; ${(body.match(/not listed/g) ?? []).length} cut lists; ${(body.match(/"Sent back \d+"/g) ?? []).length} sent back rows`,
		);
		expect(body).toContain('"label":"Waiting"');
		expect(countNodes(page)).toBeLessThanOrEqual(1_950);
		expect(body).toMatch(/\d+ more are not listed here, to keep this page small\./);
	});
});
