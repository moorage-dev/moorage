// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The MCP tools `queue` and `status`: what each role gets back through the plugin's routes, in
// the real sandbox, with EmDash's own permission check in front (routes.request).

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

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
): Promise<{ status: number; data: Record<string, unknown> }> {
	const response = await s.host.actions.routes.request(route, {
		user: by,
		body: input,
		headers: { "X-EmDash-Request": "1" },
	});
	const body = (await response.json()) as { data?: Record<string, unknown> };
	return { status: response.status, data: body.data ?? (body as Record<string, unknown>) };
}

const EMAIL = /[^\s"]+@[^\s"]+\.[a-z]+/i;

describe("the manifest", () => {
	it("declares both tools, read-only, on content:read routes", async () => {
		const s = await site();
		const tools = s.host.manifest.mcp?.tools ?? [];
		expect(tools.map((t) => t.name).sort()).toEqual(["queue", "status"]);
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
