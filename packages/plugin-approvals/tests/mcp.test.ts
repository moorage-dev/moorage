// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The MCP tools `queue` and `status`: what each role gets back through the plugin's routes, in
// the real sandbox, with EmDash's own permission check in front (routes.request).

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../src/requests.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await settled();
	await host?.dispose();
	host = undefined;
});

type User = Awaited<ReturnType<PluginRuntimeTestHost["fixtures"]["user"]>>;

interface Site {
	host: PluginRuntimeTestHost;
	admin: User;
	editor: User;
	author: User;
	contributor: User;
	subscriber: User;
	/** An Author with no name: EmDash shows their email address in its place. */
	nameless: User;
}

const HELD = { collections: ["pages"], preset: "others", ai: true, checks: "remind", remind: true };

async function site(config: Record<string, unknown> | null = HELD): Promise<Site> {
	const runtime = await createPluginRuntimeTestHost({
		site: { name: "Harbour Street Bakery", url: "https://bakery.test", locale: "en" },
	});
	host = runtime;
	await runtime.fixtures.collection({
		slug: "pages",
		label: "Pages",
		supports: ["drafts", "revisions", "seo"],
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "text" },
		],
	});
	const user = (
		email: string,
		name: string | undefined,
		role: "admin" | "editor" | "author" | "contributor" | "subscriber",
	) => runtime.fixtures.user({ email, ...(name ? { name } : {}), role });
	const s: Site = {
		host: runtime,
		admin: await user("ellen@agency.test", "Ellen Marsh", "admin"),
		editor: await user("sam@bakery.test", "Sam Reyes", "editor"),
		author: await user("ana@bakery.test", "Ana Lopes", "author"),
		contributor: await user("jo@bakery.test", "Jo Park", "contributor"),
		subscriber: await user("reader@bakery.test", "Rae Reader", "subscriber"),
		nameless: await user("no.name@bakery.test", undefined, "author"),
	};
	if (config) await runtime.fixtures.plugin.setting("config", config);
	return s;
}

async function page(s: Site, by: User, title: string): Promise<string> {
	const created = await s.host.actions.content.create("pages", {
		data: { title, content: "Iced coffee £3.20 and lemon tart" },
		slug: title.toLowerCase().replace(/\s+/g, "-"),
		authorId: by.id,
		actor: { id: by.id, role: by.role },
	});
	if (!created.success) throw new Error(created.error.message);
	return created.data.item.id;
}

/** A page `by` sent for approval by pressing Publish. */
async function waiting(s: Site, by: User, title: string): Promise<string> {
	const id = await page(s, by, title);
	const held = await s.host.actions.content.publish("pages", id, {
		actor: { id: by.id, role: by.role },
		origin: { source: "api" },
	});
	if (held.success) throw new Error("expected the publish to be held");
	await settled();
	return id;
}

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

/** Call a tool's route as EmDash's MCP server does: POST JSON, as this person. */
async function call(
	s: Site,
	route: string,
	by: User,
	input: unknown = {},
	{ mcp = true }: { mcp?: boolean } = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
	// EmDash's MCP server calls a tool's route with the request it received, at /_emdash/api/mcp.
	const response = await s.host.actions.routes.request(route, {
		user: by,
		body: input,
		headers: { "X-EmDash-Request": "1" },
		...(mcp ? { url: "https://bakery.test/_emdash/api/mcp" } : {}),
	});
	const body = (await response.json()) as { data?: Record<string, unknown> };
	return { status: response.status, data: body.data ?? (body as Record<string, unknown>) };
}

const EMAIL = /[^\s"]+@[^\s"]+\.[a-z]+/i;

describe("the manifest", () => {
	it("declares the reviewer's tools: changes to read, approve and send_back marked destructive", async () => {
		const s = await site();
		const tools = s.host.manifest.mcp?.tools ?? [];
		expect(tools.find((t) => t.name === "changes")).toMatchObject({
			route: "mcp/changes",
			permission: "content:read_drafts",
			destructive: false,
		});
		for (const name of ["approve", "send_back"]) {
			expect(tools.find((t) => t.name === name)).toMatchObject({
				route: `mcp/${name.replace("_", "-")}`,
				permission: "content:publish_any",
				destructive: true,
			});
		}
		expect(tools.find((t) => t.name === "send_back")?.inputSchema).toMatchObject({
			required: ["reason"],
		});
		expect(tools.find((t) => t.name === "ask_approval")).toMatchObject({
			route: "mcp/ask",
			permission: "content:read_drafts",
			destructive: false,
		});
		for (const tool of tools) expect(tool.description).not.toMatch(/moorage|hosting/i);
	});

	it("declares both read tools, read-only, on content:read routes", async () => {
		const s = await site();
		const tools = s.host.manifest.mcp?.tools ?? [];
		expect(tools.map((t) => t.name).sort()).toEqual([
			"approve",
			"ask_approval",
			"changes",
			"queue",
			"send_back",
			"status",
		]);
		const queue = tools.find((t) => t.name === "queue")!;
		expect(queue).toMatchObject({
			route: "mcp/queue",
			permission: "content:read",
			destructive: false,
			inputSchema: { type: "object" },
		});
		const status = tools.find((t) => t.name === "status")!;
		expect(status).toMatchObject({
			route: "mcp/status",
			permission: "content:read",
			destructive: false,
			inputSchema: { type: "object", required: ["collection", "id"] },
		});
		for (const tool of tools) {
			expect(tool.description).not.toMatch(/moorage|hosting/i);
		}
	});
});

describe("tool queue", () => {
	it("gives an approver what waits for them, by name, without emails", async () => {
		const s = await site();
		const id = await waiting(s, s.editor, "Summer menu");
		await waiting(s, s.nameless, "Bake sale");
		const { status, data } = await call(s, "mcp/queue", s.admin);
		expect(status).toBe(200);
		expect(data.approvalOn).toBe(true);
		expect(data.counts).toEqual({ forYou: 2, yours: 0, sentBack: 0 });
		const forYou = data.forYou as Array<Record<string, unknown>>;
		expect(forYou[0]).toMatchObject({
			title: "Summer menu",
			collection: "pages",
			collectionLabel: "Pages",
			id,
			askedBy: "Sam Reyes",
			fromAiTool: false,
			kind: "publish",
		});
		expect(typeof forYou[0]!.askedAt).toBe("string");
		// The person without a name is "Someone", never their address.
		expect(forYou[1]).toMatchObject({ title: "Bake sale", askedBy: "Someone" });
		expect(JSON.stringify(data)).not.toMatch(EMAIL);
	});

	it("gives a writer only their own waiting pages", async () => {
		const s = await site();
		await waiting(s, s.editor, "Summer menu");
		const mine = await waiting(s, s.author, "Autumn menu");
		const { data } = await call(s, "mcp/queue", s.author);
		expect(data.forYou).toBeUndefined();
		expect(data.counts).toEqual({ yours: 1, sentBack: 0 });
		expect((data.yours as Array<{ id: string }>).map((r) => r.id)).toEqual([mine]);
	});

	it("gives an approver their own request under yours", async () => {
		const s = await site({ ...HELD, preset: "me" });
		const own = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/queue", s.editor);
		expect(data.counts).toEqual({ forYou: 0, yours: 1, sentBack: 0 });
		expect((data.yours as Array<{ id: string }>)[0]!.id).toBe(own);
	});

	it("names a request an earlier version stored as Untitled", async () => {
		const s = await site();
		const id = await waiting(s, s.editor, "Summer menu");
		const key = `pages:${id}`;
		const stored = await s.host.inspect.storage.get<ApprovalRequest>("requests", key);
		await s.host.fixtures.plugin.storage("requests", key, { ...stored, title: "Untitled" });
		const { data } = await call(s, "mcp/queue", s.admin);
		expect((data.forYou as Array<{ title: string }>)[0]!.title).toBe("Summer menu");
	});

	it("gives a Subscriber nothing", async () => {
		const s = await site();
		await waiting(s, s.editor, "Summer menu");
		const { status, data } = await call(s, "mcp/queue", s.subscriber);
		expect(status).toBe(200);
		expect(data.yours).toEqual([]);
		expect(JSON.stringify(data)).not.toContain("Summer menu");
	});

	it("says approval is off before the settings are saved", async () => {
		const s = await site(null);
		const { data } = await call(s, "mcp/queue", s.admin);
		expect(data.approvalOn).toBe(false);
		expect(data.forYou).toEqual([]);
	});
});

describe("tool status", () => {
	it("refuses input without a collection and an id", async () => {
		const s = await site();
		for (const input of [{}, { collection: "pages" }, { collection: "", id: "x" }, null]) {
			const { data } = await call(s, "mcp/status", s.admin, input);
			expect(data.error).toBe("Give the content type (collection) and the entry's id.");
		}
	});

	it("says when there is no such entry", async () => {
		const s = await site();
		const { data } = await call(s, "mcp/status", s.admin, { collection: "pages", id: "nope" });
		expect(data.error).toBe('No entry "nope" in pages.');
	});

	it("tells an approver a page waits, who asked and when, with its history", async () => {
		const s = await site();
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/status", s.admin, { collection: "pages", id });
		expect(data).toMatchObject({
			collection: "pages",
			collectionLabel: "Pages",
			id,
			title: "Summer menu",
			approvalOn: true,
			needsApproval: { whenYouPublish: false, whenAnAiToolPublishes: true },
			state: "waiting",
			kind: "publish",
			askedBy: "Sam Reyes",
			fromAiTool: false,
			youMayDecide: true,
		});
		const history = data.history as Array<{ at: string; text: string }>;
		expect(history.length).toBeGreaterThan(0);
		expect(history[0]!.text).toMatch(/Sam Reyes/);
	});

	it("tells a writer that their own Publish is held", async () => {
		const s = await site();
		const id = await page(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/status", s.editor, { collection: "pages", id });
		expect(data).toMatchObject({
			approvalOn: true,
			needsApproval: { whenYouPublish: true, whenAnAiToolPublishes: true },
			state: "none",
		});
	});

	it("says when the version changed after its approval", async () => {
		const s = await site();
		const id = await waiting(s, s.editor, "Summer menu");
		await s.host.admin.act("/overview", "approve", {
			user: s.admin,
			value: { key: `pages:${id}` },
		});
		await settled();
		let { data } = await call(s, "mcp/status", s.editor, { collection: "pages", id });
		expect(data).toMatchObject({ state: "approved", approvedBy: "Ellen Marsh" });
		expect(data.changedSinceApproval).toBe(false);
		const updated = await s.host.actions.content.update("pages", id, {
			data: { content: "Iced coffee £3.40" },
			actor: { id: s.editor.id, role: s.editor.role },
		});
		if (!updated.success) throw new Error(updated.error.message);
		await settled();
		({ data } = await call(s, "mcp/status", s.editor, { collection: "pages", id }));
		expect(data.changedSinceApproval).toBe(true);
	});

	it("shows an Author their own page, not someone else's", async () => {
		const s = await site();
		const theirs = await waiting(s, s.editor, "Summer menu");
		const mine = await waiting(s, s.author, "Autumn menu");
		const own = await call(s, "mcp/status", s.author, { collection: "pages", id: mine });
		expect(own.data.state).toBe("waiting");
		const other = await call(s, "mcp/status", s.author, { collection: "pages", id: theirs });
		expect(other.data).toEqual({
			error: "You can see the approval of your own pages only.",
		});
	});

	it("shows a Subscriber nothing", async () => {
		const s = await site();
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/status", s.subscriber, { collection: "pages", id });
		expect(data).toEqual({ error: "You can see the approval of your own pages only." });
	});

	it("never returns an email address", async () => {
		const s = await site();
		const id = await waiting(s, s.nameless, "Bake sale");
		const { data } = await call(s, "mcp/status", s.admin, { collection: "pages", id });
		expect(data.askedBy).toBe("Someone");
		expect(JSON.stringify(data)).not.toMatch(EMAIL);
	});
});

const AI_ON = { ...HELD, aiApprove: true };

/** The version `changes` returns for an entry, as an Admin sees it. */
async function version(s: Site, id: string): Promise<string> {
	const { data } = await call(s, "mcp/changes", s.admin, { collection: "pages", id });
	return data.version as string;
}

describe("tool changes", () => {
	it("shows a new page field by field, with nothing before", async () => {
		const s = await site();
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/changes", s.admin, { collection: "pages", id });
		expect(data).toMatchObject({
			collection: "pages",
			id,
			title: "Summer menu",
			state: "waiting",
			liveNow: false,
			youMayDecide: true,
		});
		expect(typeof data.version).toBe("string");
		expect(data.fields).toEqual([
			{ field: "title", label: "Title", before: null, after: "Summer menu", change: "new" },
			{
				field: "content",
				label: "Content",
				before: null,
				after: "Iced coffee £3.20 and lemon tart",
				change: "new",
			},
		]);
		expect(String(data.notShown)).toMatch(/SEO panel/);
	});

	it("shows only what differs from the live page, before and after, from a request id", async () => {
		const s = await site(AI_ON);
		const id = await waiting(s, s.editor, "Summer menu");
		await call(s, "mcp/approve", s.admin, {
			collection: "pages",
			id,
			version: await version(s, id),
		});
		await settled();
		const updated = await s.host.actions.content.update("pages", id, {
			data: { content: "Iced coffee £3.40 and lemon tart" },
			actor: { id: s.editor.id, role: s.editor.role },
		});
		if (!updated.success) throw new Error(updated.error.message);
		await s.host.actions.content.publish("pages", id, {
			actor: { id: s.editor.id, role: s.editor.role },
			origin: { source: "api" },
		});
		await settled();
		const { data } = await call(s, "mcp/changes", s.admin, { request: `pages:${id}` });
		expect(data.liveNow).toBe(true);
		expect(data.fields).toEqual([
			{
				field: "content",
				label: "Content",
				before: "Iced coffee £3.20 and lemon tart",
				after: "Iced coffee £3.40 and lemon tart",
				change: '"£3.20" becomes "£3.40".',
			},
		]);
	});

	it("refuses an entry with no request", async () => {
		const s = await site();
		const id = await page(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/changes", s.admin, { collection: "pages", id });
		expect(data).toEqual({ error: "Nothing waits for approval on this entry: it has no request." });
	});

	it("shows a change past 2,000 characters, and says what it did not show", async () => {
		const s = await site();
		const long = (end: string) =>
			`${"Bread and butter. ".repeat(180)}Price ${end}. ${"Cake. ".repeat(100)}`;
		const id = await page(s, s.editor, "Summer menu");
		const set = async (content: string) => {
			const updated = await s.host.actions.content.update("pages", id, {
				data: { content },
				actor: { id: s.admin.id, role: s.admin.role },
			});
			if (!updated.success) throw new Error(updated.error.message);
		};
		await set(long("3.20"));
		const live = await s.host.actions.content.publish("pages", id, {
			actor: { id: s.admin.id, role: s.admin.role },
			origin: { source: "api" },
		});
		expect(live.success).toBe(true);
		await settled();
		await set(long("3.40"));
		await s.host.actions.content.publish("pages", id, {
			actor: { id: s.editor.id, role: s.editor.role },
			origin: { source: "api" },
		});
		await settled();
		const { data } = await call(s, "mcp/changes", s.admin, { collection: "pages", id });
		const fields = data.fields as Array<Record<string, unknown>>;
		expect(fields).toHaveLength(1);
		const field = fields[0]!;
		expect(field.change).toBe('"3.20." becomes "3.40.".');
		expect(field.truncated).toBe(true);
		expect(field.beforeLength).toBe(long("3.20").trim().length);
		expect(String(field.before)).toContain("Price 3.20");
		expect(String(field.after)).toContain("Price 3.40");
		expect(String(field.after).length).toBeLessThanOrEqual(2002);
		expect(String(data.notShown)).toMatch(/truncated/);
		const tool = s.host.manifest.mcp?.tools.find((t) => t.name === "changes");
		expect(tool?.description).toMatch(/truncated/);
	});

	it("shows an Author only their own pages", async () => {
		const s = await site();
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/changes", s.author, { collection: "pages", id });
		expect(data).toEqual({ error: "You can see the approval of your own pages only." });
	});
});

describe("tools approve and send_back", () => {
	it("approve refuses without the version the AI tool checked", async () => {
		const s = await site(AI_ON);
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/approve", s.admin, { collection: "pages", id });
		expect(data.error).toBe(
			"Give the version: call changes first and pass its version, so only what you checked is approved.",
		);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("draft");
		const tool = s.host.manifest.mcp?.tools.find((t) => t.name === "approve");
		expect(tool?.inputSchema).toMatchObject({ required: ["version"] });
	});

	it("approve says when a request to schedule was published now", async () => {
		const s = await site(AI_ON);
		const id = await page(s, s.editor, "Summer menu");
		const held = await s.host.actions.content.schedule(
			"pages",
			id,
			new Date(Date.now() + 86_400_000).toISOString(),
			{
				actor: { id: s.editor.id, role: s.editor.role },
				origin: { source: "api" },
			},
		);
		expect(held.success).toBe(false);
		const { data } = await call(s, "mcp/approve", s.admin, {
			collection: "pages",
			id,
			version: await version(s, id),
		});
		await settled();
		expect(data).toMatchObject({ ok: true, state: "published", published: true });
		expect(String(data.message)).toContain("This was a request to schedule; it is published now.");
		const off = await page(s, s.editor, "Bake sale");
		await s.host.actions.content.schedule(
			"pages",
			off,
			new Date(Date.now() + 86_400_000).toISOString(),
			{
				actor: { id: s.editor.id, role: s.editor.role },
				origin: { source: "api" },
			},
		);
		const later = await call(s, "mcp/approve", s.admin, {
			collection: "pages",
			id: off,
			version: await version(s, off),
			publish: false,
		});
		expect(later.data).toMatchObject({ ok: true, state: "approved", published: false });
		const tool = s.host.manifest.mcp?.tools.find((t) => t.name === "approve");
		expect(tool?.description).toMatch(/request to schedule is published now/);
	});

	it("refuse while AI approval is off, and say where to switch it on", async () => {
		const s = await site();
		const id = await waiting(s, s.editor, "Summer menu");
		for (const route of ["mcp/approve", "mcp/send-back"]) {
			const { data } = await call(s, route, s.admin, { collection: "pages", id, reason: "x" });
			expect(data.error).toBe(
				"AI tools may not approve or send back on this site. An Admin can switch this on in Approvals > Settings: AI tools may approve.",
			);
		}
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("draft");
	});

	it("approve and publish, recorded as an AI tool acting for the person", async () => {
		const s = await site(AI_ON);
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/approve", s.admin, {
			collection: "pages",
			id,
			version: await version(s, id),
		});
		await settled();
		expect(data).toMatchObject({ ok: true, state: "published" });
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
		const stored = await s.host.inspect.storage.get<ApprovalRequest>("requests", `pages:${id}`);
		expect(stored?.history.map((h) => h.text)).toContain(
			"An AI tool acting for Ellen Marsh approved",
		);
		expect(stored?.history[0]?.text).toBe("Published by an AI tool acting for Ellen Marsh");
	});

	it("approve without publishing when asked", async () => {
		const s = await site(AI_ON);
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/approve", s.admin, {
			collection: "pages",
			id,
			version: await version(s, id),
			publish: false,
		});
		expect(data).toMatchObject({ ok: true, state: "approved" });
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("draft");
	});

	it("may approve a request made by the same person when AI approval is on", async () => {
		const s = await site({ ...AI_ON, preset: "me" });
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/approve", s.editor, {
			collection: "pages",
			id,
			version: await version(s, id),
		});
		await settled();
		expect(data).toMatchObject({ ok: true, state: "published" });
	});

	it("refuse a version other than the one given", async () => {
		const s = await site(AI_ON);
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(s, "mcp/approve", s.admin, {
			collection: "pages",
			id,
			version: "an older version",
		});
		expect(data.error).toMatch(/This page changed/);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("draft");
	});

	it("refuse someone who does not approve on this site", async () => {
		const s = await site(AI_ON);
		const id = await waiting(s, s.author, "Summer menu");
		const { data } = await call(s, "mcp/approve", s.editor, {
			collection: "pages",
			id,
			version: await version(s, id),
		});
		expect(data.error).toBe("You can't approve on this site.");
	});

	it("refuse a call that did not come through an AI tool (MCP)", async () => {
		const s = await site({ ...AI_ON, preset: "me" });
		const id = await waiting(s, s.editor, "Summer menu");
		const { data } = await call(
			s,
			"mcp/approve",
			s.editor,
			{ collection: "pages", id, version: await version(s, id) },
			{ mcp: false },
		);
		expect(data.error).toMatch(/only through an AI tool connected with MCP/);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("draft");
	});

	it("send back with a reason, which is required", async () => {
		const s = await site(AI_ON);
		const id = await waiting(s, s.editor, "Summer menu");
		const empty = await call(s, "mcp/send-back", s.admin, { collection: "pages", id, reason: "" });
		expect(empty.data.error).toBe("Give the reason: what should change.");
		const { data } = await call(s, "mcp/send-back", s.admin, {
			collection: "pages",
			id,
			reason: "Prices are out of date",
		});
		expect(data).toMatchObject({ ok: true, state: "sent_back" });
		const stored = await s.host.inspect.storage.get<ApprovalRequest>("requests", `pages:${id}`);
		expect(stored?.sentBack?.note).toBe("Prices are out of date");
		expect(stored?.history[0]?.text).toBe(
			'An AI tool acting for Ellen Marsh sent it back: "Prices are out of date"',
		);
	});
});

describe("tool ask_approval", () => {
	it("asks on a content type not ticked when what AI tools publish is held", async () => {
		const s = await site({ ...HELD, collections: [] });
		const id = await page(s, s.author, "Summer menu");
		const { data } = await call(s, "mcp/ask", s.author, { collection: "pages", id });
		expect(data).toMatchObject({ ok: true });
		expect(String(data.message)).toMatch(/^Sent for approval\./);
	});

	it("says approval is off on a type not ticked when AI publishing is not held", async () => {
		const off = await site({ ...HELD, collections: [], ai: false });
		const other = await page(off, off.author, "Summer menu");
		const refused = await call(off, "mcp/ask", off.author, { collection: "pages", id: other });
		expect(String(refused.data.message)).toBe("Approval is off for Pages.");
	});

	it("asks for approval of a draft without a publish, as from an AI tool", async () => {
		const s = await site();
		const id = await page(s, s.author, "Summer menu");
		const { data } = await call(s, "mcp/ask", s.author, { collection: "pages", id });
		expect(data).toMatchObject({ ok: true });
		expect(String(data.message)).toMatch(/^Sent for approval\./);
		const stored = await s.host.inspect.storage.get<ApprovalRequest>("requests", `pages:${id}`);
		expect(stored).toMatchObject({ status: "waiting", ai: true });
		expect(stored?.history[0]?.text).toMatch(/^An AI tool \(Ana Lopes\) asked for approval/);
	});
});
