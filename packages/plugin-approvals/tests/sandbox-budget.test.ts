// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Pins how many host calls (subrequests) each sandboxed invocation of Content Approval makes
// today, per hook, route and admin interaction, in the states that cost the most (B39). On
// Cloudflare one invocation may make at most 10; the 11th call and every one after it throw.
// Each count is measured on a cold isolate (host.restart() first) and pinned exactly, so any
// change in cost shows up here. Counts at or over the limit carry a TODO(B39) and stay pinned
// until the plugin is changed; the enforced tests at the end show what happens on Cloudflare
// today on each path that goes over.
//
// Pages are saved twice before they are measured, so they have a draft revision: reading what
// would go live then costs contentGet + contentGetRevision, the worst case.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { PluginBridge } from "@emdash-cms/plugin-test/worker";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../src/requests.js";
import { describeCalls, measure, SANDBOX_SUBREQUESTS, type Measured } from "./bridge-budget.js";

// Host calls a test can make fail, to reach the plugin's error paths (a failed email, a failed
// publish, a failed write). Patched before bridge-budget installs its counter, so the failing
// call still counts.
const failing = new Set<string>();
{
	const proto = PluginBridge.prototype as unknown as Record<
		string,
		(...args: unknown[]) => unknown
	>;
	for (const name of ["emailSend", "contentPublish", "storagePut"]) {
		const original = proto[name]!;
		proto[name] = function (this: unknown, ...args: unknown[]) {
			if (failing.has(name)) return Promise.reject(new Error(`${name} failed (test)`));
			return original.apply(this, args);
		};
	}
}

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	failing.clear();
	await drain();
	await host?.dispose();
	host = undefined;
});

type User = Awaited<ReturnType<PluginRuntimeTestHost["fixtures"]["user"]>>;

interface Site {
	host: PluginRuntimeTestHost;
	/** The approvers under "Others need my OK": the admins. */
	admins: User[];
	editor: User;
	contributor: User;
}

const HELD = { collections: ["pages"], preset: "others", ai: true, checks: "remind", remind: true };

const NAMES = ["Ellen Marsh", "Tom Achebe", "Rita Gomez", "Ade Bello", "Lin Wu"];

/**
 * A bakery site. `settings`: saved by this release (ctx.settings), left by the previous release
 * (the plain KV key only, before the copy forward), or never saved.
 */
async function site(
	options: { settings?: "saved" | "legacy" | "none"; config?: object; admins?: number } = {},
): Promise<Site> {
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
	const admins: User[] = [];
	for (let i = 0; i < (options.admins ?? 2); i++) {
		admins.push(
			await runtime.fixtures.user({
				email: `admin${i}@agency.test`,
				name: NAMES[i] ?? `Admin ${i}`,
				role: "admin",
			}),
		);
	}
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
	const config = options.config ?? HELD;
	const settings = options.settings ?? "saved";
	if (settings === "saved") await runtime.fixtures.plugin.setting("config", config);
	if (settings === "legacy") await runtime.fixtures.plugin.kv("config", config);
	return { host: runtime, admins, editor, contributor };
}

function admin(s: Site): User {
	return s.admins[0]!;
}

const actor = (user: User, source: "api" | "mcp" = "api") => ({
	actor: { id: user.id, role: user.role },
	origin: { source },
});

const DATA = { title: "Summer menu", content: "Iced coffee £3.20 and lemon tart" };

async function edit(s: Site, id: string, data: Record<string, unknown>, by: User = s.editor) {
	const updated = await s.host.actions.content.update("pages", id, {
		data,
		actor: { id: by.id, role: by.role },
	});
	if (!updated.success) throw new Error(updated.error.message);
}

async function page(s: Site, by: User = s.editor, title = DATA.title): Promise<string> {
	const created = await s.host.actions.content.create("pages", {
		data: { ...DATA, title },
		slug: title.toLowerCase().replace(/\s+/g, "-"),
		authorId: by.id,
		actor: { id: by.id, role: by.role },
	});
	if (!created.success) throw new Error(created.error.message);
	const id = created.data.item.id;
	// Saved once more, as a writer does: the page now has a draft revision.
	await edit(s, id, { ...DATA, title }, by);
	const item = await s.host.inspect.content.get("pages", id);
	if (!item?.draftRevisionId) throw new Error("expected a draft revision");
	return id;
}

/** A page the editor sent for approval by pressing Publish. */
async function waiting(s: Site, title = DATA.title, by: User = s.editor): Promise<string> {
	const id = await page(s, by, title);
	const held = await s.host.actions.content.publish("pages", id, actor(by));
	if (held.success) throw new Error("expected the publish to be held");
	return id;
}

async function request(s: Site, id: string): Promise<ApprovalRequest | null> {
	return s.host.inspect.storage.get<ApprovalRequest>("requests", `pages:${id}`);
}

/**
 * The event EmDash passes to content:beforePublish / beforeSchedule (checkContentPolicy): the
 * entry as stored. The pages here save the same data to their draft, so it is what goes live.
 */
async function policyEvent(
	s: Site,
	id: string,
	who: User | null,
	source: "api" | "mcp" | "scheduler" = "api",
	collection = "pages",
	extra: Record<string, unknown> = {},
) {
	const item = await s.host.inspect.content.get(collection, id);
	if (!item) throw new Error("no such entry");
	return {
		content: { id, slug: item.slug, status: item.status, data: { ...item.data } },
		collection,
		origin: { source },
		...(who && source !== "scheduler" ? { actor: { id: who.id, role: who.role, source } } : {}),
		...extra,
	};
}

/** The event EmDash passes to content:afterSave. */
async function saveEvent(s: Site, id: string, who: User) {
	const item = await s.host.inspect.content.get("pages", id);
	return {
		content: { ...item, id },
		collection: "pages",
		isNew: false,
		actor: { id: who.id, role: who.role, source: "api" },
	};
}

/** Wait for EmDash's deferred work (afterSave and afterPublish hooks) started while seeding. */
async function drain(): Promise<void> {
	const tasks = (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:deferred-tasks")] as
		| Set<Promise<unknown>>
		| undefined;
	for (;;) {
		// A copy: each task removes itself from the set when it settles.
		const pending = Array.from(tasks ?? []);
		if (pending.length === 0) return;
		await Promise.all(pending);
	}
}

/** A cold isolate on the same database, with nothing left running from the seeding. */
async function cold(s: Site): Promise<void> {
	await drain();
	await s.host.restart();
}

/** Turn saved settings back into what the previous release left: the plain KV key only. */
async function toLegacy(s: Site, config: object = HELD): Promise<void> {
	await drain();
	await s.host.fixtures.plugin.setting("config", null);
	await s.host.fixtures.plugin.kv("config", config);
	expect(await s.host.inspect.setting("config")).toBeNull();
}

/** Pin the count of one invocation and log its calls. */
function pin(label: string, m: Measured<unknown>, count: number): void {
	console.info(describeCalls(label, m));
	expect(m.calls.length, label).toBe(count);
}

/**
 * After a publish from a route, EmDash runs this plugin's content:afterPublish hook deferred
 * (after()), so its first call (storageGet, which then finds the request already published)
 * lands at the end of the route's window. It is a separate invocation with its own budget.
 */
function measureWithDeferred<T>(invoke: () => Promise<T>): Promise<Measured<T>> {
	// Wait for the deferred hook inside the window, so its first call always lands there.
	return measure(async () => {
		const result = await invoke();
		await drain();
		return result;
	});
}

function expectDeferredAfterPublish(m: Measured<unknown>): void {
	expect(m.calls.at(-1)).toBe("storageGet");
	// The content-policy hook during the publish: settingsGet storageGet, its own invocation.
	expect(m.nested).toEqual(["settingsGet", "storageGet"]);
}

function text(value: unknown): string {
	return JSON.stringify(value);
}

describe("content:beforePublish and content:beforeSchedule (the gate)", () => {
	it("lets everything through until the settings are saved", async () => {
		const s = await site({ settings: "none" });
		const id = await page(s);
		await cold(s);
		const event = await policyEvent(s, id, s.editor);
		const m = await measure(() => s.host.transport.invokeHook("content:beforePublish", event));
		pin("beforePublish, settings never saved", m, 2);
		expect(m.error).toBeUndefined();
		expect(m.result ?? undefined).toBeUndefined();
	});

	it("never touches a content type that is off", async () => {
		const s = await site();
		const created = await s.host.actions.content.create("products", {
			data: { title: "Sourdough" },
			actor: { id: s.editor.id, role: s.editor.role },
		});
		if (!created.success) throw new Error(created.error.message);
		await cold(s);
		const event = await policyEvent(s, created.data.item.id, s.editor, "api", "products");
		const m = await measure(() => s.host.transport.invokeHook("content:beforePublish", event));
		pin("beforePublish, type off", m, 1);
		expect(m.result ?? undefined).toBeUndefined();
	});

	it("lets an admin through under 'Others need my OK'", async () => {
		const s = await site();
		const id = await page(s, admin(s));
		await cold(s);
		const event = await policyEvent(s, id, admin(s));
		const m = await measure(() => s.host.transport.invokeHook("content:beforePublish", event));
		pin("beforePublish, admin not held", m, 1);
		expect(m.result ?? undefined).toBeUndefined();
	});

	it("holds an editor's publish and makes a request (measured through the publish action)", async () => {
		const s = await site();
		const id = await page(s);
		await cold(s);
		// A refused publish runs only this one hook of the plugin.
		const m = await measure(() => s.host.actions.content.publish("pages", id, actor(s.editor)));
		pin("beforePublish, held, new request (action)", m, 7);
		expect(m.result?.success).toBe(false);
		expect((await request(s, id))?.status).toBe("waiting");
	});

	it("costs the same measured through the hook directly", async () => {
		const s = await site();
		const id = await page(s);
		await cold(s);
		const event = await policyEvent(s, id, s.editor);
		const m = await measure(() => s.host.transport.invokeHook("content:beforePublish", event));
		pin("beforePublish, held, new request (hook)", m, 7);
		expect(text(m.result)).toContain("Sent for approval");
	});

	it("holds an editor's publish on a site migrated from 0.1.5 (settings in the old key)", async () => {
		const s = await site();
		const id = await page(s);
		await toLegacy(s);
		await cold(s);
		const m = await measure(() => s.host.actions.content.publish("pages", id, actor(s.editor)));
		pin("beforePublish, held, new request, migrated settings", m, 9);
		expect(m.result?.success).toBe(false);
		expect((await request(s, id))?.status).toBe("waiting");
		expect(await s.host.inspect.setting("config")).toMatchObject({ collections: ["pages"] });
	});

	it("holds an AI tool's publish on a type that is off", async () => {
		const s = await site({ config: { ...HELD, collections: [] } });
		const id = await page(s, admin(s));
		await cold(s);
		const m = await measure(() =>
			s.host.actions.content.publish("pages", id, actor(admin(s), "mcp")),
		);
		pin("beforePublish, held, AI tool", m, 7);
		expect(m.result?.success).toBe(false);
	});

	it("answers 'still waiting' when Publish is pressed again", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() => s.host.actions.content.publish("pages", id, actor(s.editor)));
		pin("beforePublish, held again, same version", m, 4);
		expect(m.result?.success).toBe(false);
		expect((await request(s, id))?.history).toHaveLength(1);
	});

	it("refuses a scheduled run that was never approved", async () => {
		const s = await site();
		const id = await page(s);
		await cold(s);
		const event = await policyEvent(s, id, null, "scheduler");
		const m = await measure(() => s.host.transport.invokeHook("content:beforePublish", event));
		pin("beforePublish, scheduled run held", m, 5);
		expect(text(m.result)).toContain("needs approval first");
		expect((await request(s, id))?.status).toBe("waiting");
	});

	it("refuses in plain words when the stored request is unreadable, and logs it", async () => {
		const s = await site();
		const id = await page(s);
		await s.host.fixtures.plugin.storage("requests", `pages:${id}`, {
			status: "approved",
			approval: null,
			history: 5,
		});
		await cold(s);
		const m = await measure(() => s.host.actions.content.publish("pages", id, actor(s.editor)));
		pin("beforePublish, broken request, logs", m, 4);
		expect(m.result?.success).toBe(false);
		expect(m.calls.at(-1)).toBe("log");
	});

	it("records an admin's own Schedule as needing no approval", async () => {
		const s = await site();
		const id = await page(s, admin(s));
		await cold(s);
		const at = new Date(Date.now() + 3_600_000).toISOString();
		const event = await policyEvent(s, id, admin(s), "api", "pages", { scheduledAt: at });
		const m = await measure(() => s.host.transport.invokeHook("content:beforeSchedule", event));
		pin("beforeSchedule, admin cleared", m, 4);
		expect(m.result ?? undefined).toBeUndefined();
		expect((await request(s, id))?.status).toBe("approved");
	});

	it("records an admin's own Schedule on a migrated site", async () => {
		const s = await site();
		const id = await page(s, admin(s));
		await toLegacy(s);
		await cold(s);
		const at = new Date(Date.now() + 3_600_000).toISOString();
		const event = await policyEvent(s, id, admin(s), "api", "pages", { scheduledAt: at });
		const m = await measure(() => s.host.transport.invokeHook("content:beforeSchedule", event));
		pin("beforeSchedule, admin cleared, migrated settings", m, 6);
		expect((await request(s, id))?.status).toBe("approved");
	});

	it("holds an editor's Schedule", async () => {
		const s = await site();
		const id = await page(s);
		await cold(s);
		const at = new Date(Date.now() + 3_600_000).toISOString();
		const event = await policyEvent(s, id, s.editor, "api", "pages", { scheduledAt: at });
		const m = await measure(() => s.host.transport.invokeHook("content:beforeSchedule", event));
		pin("beforeSchedule, editor held", m, 7);
		expect(text(m.result)).toContain("Sent for approval");
		expect((await request(s, id))?.wants).toBe("schedule");
	});
});

/** A waiting page an approver has just edited, before the after-save hook records it. */
async function editedWhileWaiting(s: Site): Promise<string> {
	const id = await waiting(s);
	const before = await request(s, id);
	await edit(s, id, { content: "Iced coffee £3.40 and lemon tart" }, admin(s));
	await drain();
	await s.host.fixtures.plugin.storage("requests", `pages:${id}`, before);
	return id;
}

describe("content:afterSave, afterPublish, afterDelete", () => {
	it("does nothing for a page without a request", async () => {
		const s = await site();
		const id = await page(s);
		await cold(s);
		const event = await saveEvent(s, id, s.editor);
		const m = await measure(() => s.host.transport.invokeHook("content:afterSave", event));
		pin("afterSave, no request", m, 1);
	});

	it("records an approver's edit to a waiting page", async () => {
		const s = await site();
		const id = await editedWhileWaiting(s);
		await cold(s);
		const event = await saveEvent(s, id, admin(s));
		const m = await measure(() => s.host.transport.invokeHook("content:afterSave", event));
		pin("afterSave, approver edits waiting page", m, 7);
		expect((await request(s, id))?.history[0]?.text).toBe(
			"Edited by Ellen Marsh before approving: Content",
		);
	});

	it("records an approver's edit on a migrated site", async () => {
		const s = await site();
		const id = await editedWhileWaiting(s);
		await toLegacy(s);
		await cold(s);
		const event = await saveEvent(s, id, admin(s));
		const m = await measure(() => s.host.transport.invokeHook("content:afterSave", event));
		pin("afterSave, approver edits waiting page, migrated settings", m, 9);
		expect((await request(s, id))?.history[0]?.text).toContain("Edited by Ellen Marsh");
	});

	it("logs when the edit cannot be recorded", async () => {
		const s = await site();
		const id = await editedWhileWaiting(s);
		await cold(s);
		const event = await saveEvent(s, id, admin(s));
		failing.add("storagePut");
		const m = await measure(() => s.host.transport.invokeHook("content:afterSave", event));
		pin("afterSave, write fails, logs", m, 8);
		expect(m.calls.at(-1)).toBe("log");
	});

	it("lets an approval follow an admin's own change to an approved page", async () => {
		const s = await site();
		const id = await waiting(s);
		await s.host.admin.actEditorPanel("approval", "pages", id, "approve", {
			user: admin(s),
			value: { key: `pages:${id}` },
		});
		const before = await request(s, id);
		await edit(s, id, { content: "Iced coffee £3.40 and lemon tart" }, s.admins[1]);
		await drain();
		await s.host.fixtures.plugin.storage("requests", `pages:${id}`, before);
		await cold(s);
		const event = await saveEvent(s, id, s.admins[1]!);
		const m = await measure(() => s.host.transport.invokeHook("content:afterSave", event));
		pin("afterSave, admin changes approved page", m, 6);
		expect((await request(s, id))?.history[0]?.text).toBe(
			"Changed by Tom Achebe; no approval needed",
		);
	});

	it("records a publish", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const event = { content: await s.host.inspect.content.get("pages", id), collection: "pages" };
		const m = await measure(() => s.host.transport.invokeHook("content:afterPublish", event));
		pin("afterPublish, request waiting", m, 2);
		expect((await request(s, id))?.status).toBe("published");
	});

	it("logs when a publish cannot be recorded", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const event = { content: await s.host.inspect.content.get("pages", id), collection: "pages" };
		failing.add("storagePut");
		const m = await measure(() => s.host.transport.invokeHook("content:afterPublish", event));
		pin("afterPublish, write fails, logs", m, 3);
		expect(m.calls.at(-1)).toBe("log");
	});

	it("closes the request of a deleted page", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const event = { id, collection: "pages", permanent: false };
		const m = await measure(() => s.host.transport.invokeHook("content:afterDelete", event));
		pin("afterDelete, request waiting", m, 2);
		expect((await request(s, id))?.status).toBe("closed");
	});
});

/** One run of the one-shot task that emails the approvers after a held publish. */
function mailTask(s: Site, id: string) {
	const key = `pages:${id}`;
	return s.host.transport.invokeHook("cron", {
		name: `mail-${key}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
		data: { key, kind: "asked" },
		scheduledAt: new Date().toISOString(),
	});
}

async function emails(s: Site): Promise<number> {
	return (await s.host.inspect.email()).length;
}

describe("cron", () => {
	// 3 + approvers (settingsGet storageGet userList, one emailSend each); +2 on a migrated site.
	// Over the limit from 8 approvers (6 on a migrated site).
	for (const [admins, count] of [
		[1, 4],
		[3, 6],
	] as const) {
		it(`emails ${admins} approver(s) after a held publish`, async () => {
			const s = await site({ admins });
			const id = await waiting(s);
			await cold(s);
			const before = await emails(s);
			const m = await measure(() => mailTask(s, id));
			pin(`cron mail, ${admins} approver(s)`, m, count);
			expect((await emails(s)) - before).toBe(admins);
		});
	}

	it("emails 3 approvers on a migrated site", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await toLegacy(s);
		await cold(s);
		const before = await emails(s);
		const m = await measure(() => mailTask(s, id));
		pin("cron mail, 3 approvers, migrated settings", m, 8);
		expect((await emails(s)) - before).toBe(3);
	});

	// When sending fails, 3 + 2 x approvers: each failure is logged.
	it("logs each failed email to 3 approvers", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await cold(s);
		failing.add("emailSend");
		const m = await measure(() => mailTask(s, id));
		pin("cron mail, 3 approvers, every email fails", m, 9);
		expect(m.calls.filter((c) => c === "log")).toHaveLength(3);
	});

	it("logs each failed email to 4 approvers", async () => {
		const s = await site({ admins: 4 });
		const id = await waiting(s);
		await cold(s);
		failing.add("emailSend");
		const m = await measure(() => mailTask(s, id));
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("cron mail, 4 approvers, every email fails", m, 11);
		expect(m.calls.filter((c) => c === "log")).toHaveLength(4);
	});

	it("reminds 3 approvers after two days (3 + approvers)", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		const stored = await request(s, id);
		await cold(s);
		const key = `pages:${id}`;
		const before = await emails(s);
		const m = await measure(() =>
			s.host.transport.invokeHook("cron", {
				name: `remind-${key}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
				data: { key, requestedAt: stored?.requestedAt },
				scheduledAt: new Date().toISOString(),
			}),
		);
		pin("cron remind, 3 approvers", m, 6);
		expect((await emails(s)) - before).toBe(3);
	});
});

describe("the Approvals page (route admin)", () => {
	it("opens on Settings for an admin before anything is saved", async () => {
		const s = await site({ settings: "none" });
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		pin("page load, admin, settings never saved", m, 6);
		expect(text(m.result)).toContain("Approval is off until you save these settings");
	});

	it("opens for an admin on a migrated site with nothing waiting", async () => {
		const s = await site({ settings: "legacy" });
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		pin("page load, admin, migrated settings, nothing waiting", m, 8);
		expect(text(m.result)).toContain("For you to approve");
	});

	// 6 + 3 per page waiting for this approver (contentGet contentGetRevision schemaGetCollection
	// for its "things to check" count, up to 20 pages), +1 when History has an approved copy, +2 on
	// a migrated site. Over the limit from 2 pages waiting.
	for (const [count, calls] of [
		[1, 9],
		// TODO(B39): 12 calls, over Cloudflare's sandbox limit of 10 -- see report
		[2, 12],
		// TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
		[5, 21],
	] as const) {
		it(`lists ${count} waiting page(s) for an admin`, async () => {
			const s = await site();
			for (let i = 0; i < count; i++) await waiting(s, `Page ${i + 1}`);
			await cold(s);
			const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
			pin(`page load, admin, ${count} waiting`, m, calls);
			expect(text(m.result)).toContain(`"label":"Waiting for you","value":${count}`);
		});
	}

	it("lists one waiting page with one decision in History", async () => {
		const s = await site();
		await waiting(s, "Page 1");
		const done = await waiting(s, "Page 2");
		await s.host.admin.act("/overview", "approve", {
			user: admin(s),
			value: { key: `pages:${done}` },
		});
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		pin("page load, admin, 1 waiting + 1 approved", m, 10);
		expect(text(m.result)).toContain("Show the approved text");
	});

	it("opens for a writer with their own page waiting", async () => {
		const s = await site();
		await waiting(s);
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: s.editor }));
		pin("page load, editor, own page waiting", m, 4);
		expect(text(m.result)).toContain("Yours waiting");
	});

	it("lists a Contributor's drafts (+2 per content type that needs approval)", async () => {
		const s = await site();
		await page(s, s.contributor);
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: s.contributor }));
		pin("page load, contributor with a draft", m, 6);
		expect(text(m.result)).toContain("Your drafts");
	});

	it("shows the dashboard widget", async () => {
		const s = await site();
		for (let i = 0; i < 3; i++) await waiting(s, `Page ${i + 1}`);
		await cold(s);
		const m = await measure(() => s.host.admin.loadWidget("approvals", { user: admin(s) }));
		pin("widget, admin, 3 waiting", m, 2);
		expect(text(m.result)).toContain('"value":3');
	});

	it("saves the settings the first time", async () => {
		const s = await site({ settings: "none" });
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit("/overview", "save_settings", HELD, { user: admin(s) }),
		);
		pin("save settings, first time", m, 9);
		expect(m.result?.toast?.type).toBe("success");
		expect(await s.host.inspect.setting("config")).toMatchObject({ collections: ["pages"] });
	});

	it("saves the settings with a page waiting", async () => {
		const s = await site();
		await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit("/overview", "save_settings", HELD, { user: admin(s) }),
		);
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("save settings, 1 waiting", m, 11);
		expect(m.result?.toast?.type).toBe("success");
	});

	it("refuses a settings change from an editor", async () => {
		const s = await site();
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit("/overview", "save_settings", { collections: [] }, { user: s.editor }),
		);
		pin("save settings, editor refused", m, 4);
		expect(m.result?.toast?.type).toBe("error");
	});

	it("opens a review", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.act("/overview", "review", { user: admin(s), value: { key: `pages:${id}` } }),
		);
		pin("review", m, 6);
		expect(text(m.result)).toContain("Approve and publish");
	});

	it("approves from the page", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.act("/overview", "approve", { user: admin(s), value: { key: `pages:${id}` } }),
		);
		// TODO(B39): 15 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("page approve", m, 15);
		expect(m.result?.toast).toEqual({ type: "success", message: "Approved. Sam has been told." });
	});

	it("approves and publishes from the page", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measureWithDeferred(() =>
			s.host.admin.act("/overview", "approve_publish", {
				user: admin(s),
				value: { key: `pages:${id}` },
			}),
		);
		// TODO(B39): 18 calls, over Cloudflare's sandbox limit of 10 -- see report
		// (19 measured: the last is the deferred afterPublish hook's own storageGet.)
		pin("page approve and publish", m, 19);
		expectDeferredAfterPublish(m);
		expect(m.result?.toast?.message).toBe(
			"Approved and published. It's live now. Sam has been told.",
		);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
	});

	it("approves but cannot publish from the page", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		failing.add("contentPublish");
		const m = await measure(() =>
			s.host.admin.act("/overview", "approve_publish", {
				user: admin(s),
				value: { key: `pages:${id}` },
			}),
		);
		// TODO(B39): 17 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("page approve and publish, publish fails", m, 17);
		expect(m.result?.toast?.message).toBe(
			"Approved, but it could not be published just now. Press Publish on the page.",
		);
	});

	it("sends back from the page", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit(
				"/overview",
				"send_back",
				{ note: "Iced coffee is £3.40" },
				{ user: admin(s), blockId: `sb:pages:${id}` },
			),
		);
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		pin("page send back", m, 10);
		expect(m.result?.toast?.message).toBe("Sent back to Sam with your note.");
	});

	it("publishes without review from the page, telling the other approvers", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await cold(s);
		const m = await measureWithDeferred(() =>
			s.host.admin.submit(
				"/overview",
				"override_publish",
				{ reason: "Price list must go out today" },
				{ user: admin(s), blockId: `ov:pages:${id}` },
			),
		);
		// TODO(B39): 21 calls, over Cloudflare's sandbox limit of 10 -- see report
		// (22 measured: the last is the deferred afterPublish hook's own storageGet.)
		// 19 + other approvers (one emailSend each).
		pin("page publish without review, 3 approvers", m, 22);
		expectDeferredAfterPublish(m);
		expect(m.result?.toast?.message).toContain("Published without review.");
	});

	it("sends back from the page with another page still waiting", async () => {
		const s = await site();
		await waiting(s, "Page 1");
		const id = await waiting(s, "Page 2");
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit(
				"/overview",
				"send_back",
				{ note: "Iced coffee is £3.40" },
				{ user: admin(s), blockId: `sb:pages:${id}` },
			),
		);
		// TODO(B39): 13 calls, over Cloudflare's sandbox limit of 10 -- see report
		// The list shown afterwards costs 3 more per page still waiting.
		pin("page send back, 1 other waiting", m, 13);
		expect(m.result?.toast?.message).toBe("Sent back to Sam with your note.");
	});

	it("approves without review from the page, telling the other approvers", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit(
				"/overview",
				"override",
				{ reason: "Price list must go out today" },
				{ user: admin(s), blockId: `ov:pages:${id}` },
			),
		);
		// TODO(B39): 18 calls, over Cloudflare's sandbox limit of 10 -- see report
		// 16 + other approvers (one emailSend each).
		pin("page approve without review, 3 approvers", m, 18);
		expect(m.result?.toast?.type).toBe("success");
		expect((await request(s, id))?.status).toBe("approved");
	});

	it("asks for approval from the page (a Contributor)", async () => {
		const s = await site();
		const id = await page(s, s.contributor);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.act("/overview", "ask", {
				user: s.contributor,
				value: { collection: "pages", id },
			}),
		);
		// TODO(B39): 16 calls, over Cloudflare's sandbox limit of 10 -- see report
		// 14 + approvers (one emailSend each).
		pin("page ask, contributor, 2 approvers", m, 16);
		expect(m.result?.toast?.type).toBe("success");
	});
});

describe("the Approval panel (route editor/panel)", () => {
	it("loads for an approver with the page waiting", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.loadEditorPanel("approval", "pages", id, { user: admin(s) }),
		);
		pin("panel load, approver, waiting", m, 5);
		expect(text(m.result)).toContain("Waiting for your approval");
	});

	it("loads for the writer of a waiting page", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.editor }),
		);
		pin("panel load, writer, own page waiting", m, 6);
		expect(text(m.result)).toContain("Waiting for approval");
	});

	it("loads on a page changed after approval, on a migrated site", async () => {
		const s = await site();
		const id = await waiting(s);
		await s.host.admin.actEditorPanel("approval", "pages", id, "approve", {
			user: admin(s),
			value: { key: `pages:${id}` },
		});
		await edit(s, id, { content: "Iced coffee £3.40 and lemon tart" });
		await toLegacy(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.editor }),
		);
		pin("panel load, changed since approval, migrated settings", m, 8);
		expect(text(m.result)).toContain("Changed since Ellen Marsh approved it");
	});

	it("approves", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.actEditorPanel("approval", "pages", id, "approve", {
				user: admin(s),
				value: { key: `pages:${id}` },
			}),
		);
		// TODO(B39): 13 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("panel approve", m, 13);
		expect(m.result?.toast).toEqual({ type: "success", message: "Approved. Sam has been told." });
	});

	it("approves and publishes", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measureWithDeferred(() =>
			s.host.admin.actEditorPanel("approval", "pages", id, "approve_publish", {
				user: admin(s),
				value: { key: `pages:${id}` },
			}),
		);
		// TODO(B39): 15 calls, over Cloudflare's sandbox limit of 10 -- see report
		// (16 measured: the last is the deferred afterPublish hook's own storageGet.)
		pin("panel approve and publish", m, 16);
		expectDeferredAfterPublish(m);
		expect(m.result?.toast?.message).toBe(
			"Approved and published. It's live now. Sam has been told.",
		);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
	});

	it("sends back with a note", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submitEditorPanel(
				"approval",
				"pages",
				id,
				"send_back",
				{ note: "Iced coffee is £3.40" },
				{ user: admin(s), blockId: `sb:pages:${id}` },
			),
		);
		pin("panel send back", m, 9);
		expect(m.result?.toast?.message).toBe("Sent back to Sam with your note.");
	});

	it("sends back with a note when the email fails", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		failing.add("emailSend");
		const m = await measure(() =>
			s.host.admin.submitEditorPanel(
				"approval",
				"pages",
				id,
				"send_back",
				{ note: "Iced coffee is £3.40" },
				{ user: admin(s), blockId: `sb:pages:${id}` },
			),
		);
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		pin("panel send back, email fails", m, 10);
		expect(m.result?.toast?.message).toBe("Sent back to Sam with your note.");
	});

	it("saves the writer's note", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submitEditorPanel(
				"approval",
				"pages",
				id,
				"save_note",
				{ note: "New prices from Monday" },
				{ user: s.editor, blockId: `note:pages:${id}` },
			),
		);
		pin("panel save note", m, 8);
		expect(m.result?.toast?.type).toBe("success");
	});

	it("publishes without review, telling the other approvers", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await cold(s);
		const m = await measureWithDeferred(() =>
			s.host.admin.submitEditorPanel(
				"approval",
				"pages",
				id,
				"override_publish",
				{ reason: "Price list must go out today" },
				{ user: admin(s), blockId: `ov:pages:${id}` },
			),
		);
		// TODO(B39): 18 calls, over Cloudflare's sandbox limit of 10 -- see report
		// (19 measured: the last is the deferred afterPublish hook's own storageGet.)
		// 16 + other approvers (one emailSend each).
		pin("panel publish without review, 3 approvers", m, 19);
		expectDeferredAfterPublish(m);
		expect(m.result?.toast?.message).toContain("Published without review.");
	});
});

describe("Ask for approval (route editor/ask)", () => {
	// 9 + approvers (one emailSend each), +2 on a migrated site. Over the limit from 2 approvers.
	for (const [admins, count] of [
		// TODO(B39): 10 calls, at Cloudflare's sandbox limit of 10 -- see report
		[1, 10],
		// TODO(B39): 11 calls, over Cloudflare's sandbox limit of 10 -- see report
		[2, 11],
		// TODO(B39): 12 calls, over Cloudflare's sandbox limit of 10 -- see report
		[3, 12],
	] as const) {
		it(`asks ${admins} approver(s)`, async () => {
			const s = await site({ admins });
			const id = await page(s);
			await cold(s);
			const m = await measure(() =>
				s.host.admin.invokeEditorAction("ask", "pages", id, { user: s.editor }),
			);
			pin(`editor ask, ${admins} approver(s)`, m, count);
			expect(m.result?.toast?.type).toBe("success");
			expect((await request(s, id))?.status).toBe("waiting");
		});
	}

	it("asks 1 approver on a migrated site", async () => {
		const s = await site({ admins: 1, settings: "legacy" });
		const id = await page(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.invokeEditorAction("ask", "pages", id, { user: s.editor }),
		);
		// TODO(B39): 12 calls, over Cloudflare's sandbox limit of 10 -- see report
		pin("editor ask, 1 approver, migrated settings", m, 12);
		expect(m.result?.toast?.type).toBe("success");
	});
});

/**
 * What each path over the limit does on Cloudflare today: every call after the 10th is
 * refused. Outcome: whether it threw (the person sees an error, not the plugin's message),
 * the toast shown, whether the page is live, the request's status, how many emails went out.
 */
describe(`enforced: paths over ${SANDBOX_SUBREQUESTS} calls`, () => {
	interface Outcome {
		threw: boolean;
		toast: string | null;
		live: string | null;
		request: string | null;
		emails: number;
		/** A two-day reminder is scheduled. */
		reminder: boolean;
		refused: string[];
	}

	const base = { threw: true, toast: null, emails: 0, reminder: true } as const;
	// After a publish the refused "storageGet log" at the end are the deferred afterPublish
	// hook's, which shares the test's window; outcome() runs it again as its own invocation.
	const OUTCOMES: Record<string, Outcome> = {
		// The fourth failure is not logged; nothing else changes.
		"cron mail, 4 approvers, every email fails: the last failure is not logged": {
			...base,
			threw: false,
			live: "draft",
			request: "waiting",
			refused: ["log"],
		},
		// The Approvals page does not open for an admin once 2 pages wait.
		"page load, admin, 2 waiting": {
			...base,
			live: "draft",
			request: "waiting",
			refused: ["schemaListCollections"],
		},
		"page load, admin, 5 waiting": {
			...base,
			live: "draft",
			request: "waiting",
			refused: ["contentGetRevision", "contentGet", "contentGet", "userList"],
		},
		// Saved, but the admin sees an error.
		"save settings, 1 waiting": {
			...base,
			live: "draft",
			request: "waiting",
			refused: ["userList"],
		},
		// Approved and the writer emailed, but the approver sees an error.
		"page approve": {
			...base,
			live: "draft",
			request: "approved",
			emails: 1,
			refused: ["schemaListCollections"],
		},
		// Live, but the writer is never told and the approver sees an error.
		"page approve_publish": {
			...base,
			live: "published",
			request: "published",
			refused: ["userGet", "storageGet", "log"],
		},
		"page approve_publish, publish fails": {
			...base,
			live: "draft",
			request: "approved",
			refused: ["storageGet"],
		},
		// Live, but neither the other approvers nor the writer are told.
		"page override_publish, 3 approvers": {
			...base,
			live: "published",
			request: "published",
			refused: ["userList", "storageGet", "log"],
		},
		// Asked and emailed, but the Contributor sees an error.
		// Sent back and the writer emailed, but the approver sees an error.
		"page send back, 1 other waiting": {
			...base,
			live: "draft",
			request: "sent_back",
			emails: 1,
			refused: ["userList"],
		},
		// Approved and the other approvers emailed, but the writer is never told and the approver
		// sees an error.
		"page override, 3 approvers": {
			...base,
			live: "draft",
			request: "approved",
			emails: 2,
			refused: ["userGet"],
		},
		"page ask, contributor, 2 approvers": {
			...base,
			live: "draft",
			request: "waiting",
			emails: 2,
			refused: ["userList"],
		},
		"panel approve": {
			...base,
			live: "draft",
			request: "approved",
			emails: 1,
			refused: ["storageGet"],
		},
		// Live; "Published by" is never recorded (afterPublish records "Published" instead), the
		// writer is never told and the approver sees an error.
		"panel approve_publish": {
			...base,
			live: "published",
			request: "published",
			refused: ["storagePut", "storageGet", "log"],
		},
		"panel override_publish, 3 approvers": {
			...base,
			live: "published",
			request: "published",
			refused: ["storagePut", "storageGet", "log"],
		},
		// Asked and emailed, but the writer sees an error.
		"editor ask, 2 approver(s), saved settings": {
			...base,
			live: "draft",
			request: "waiting",
			emails: 2,
			refused: ["userList"],
		},
		// Emailed, but no two-day reminder is scheduled, and the writer sees an error.
		"editor ask, 3 approver(s), saved settings": {
			...base,
			live: "draft",
			request: "waiting",
			emails: 3,
			reminder: false,
			refused: ["cronSchedule"],
		},
		"editor ask, 1 approver(s), legacy settings": {
			...base,
			live: "draft",
			request: "waiting",
			emails: 1,
			reminder: false,
			refused: ["cronSchedule"],
		},
	};

	async function outcome(
		s: Site,
		id: string,
		m: Measured<unknown>,
		emailsBefore: number,
	): Promise<Outcome> {
		await drain();
		const item = await s.host.inspect.content.get("pages", id);
		if (item?.status === "published") {
			// After a publish EmDash runs content:afterPublish deferred, as its own invocation with
			// its own budget. In the test it shares this window and is refused, so run it again as
			// Cloudflare would.
			await s.host.transport.invokeHook("content:afterPublish", {
				content: item,
				collection: "pages",
			});
		}
		const result = m.result as { toast?: { message?: string } } | undefined;
		const out: Outcome = {
			threw: m.error !== undefined,
			toast: result?.toast?.message ?? null,
			live: item?.status ?? null,
			request: (await request(s, id))?.status ?? null,
			emails: (await emails(s)) - emailsBefore,
			reminder: text(await s.host.inspect.scheduledTasks()).includes("remind-"),
			refused: m.refused,
		};
		console.info(describeCalls("enforced", m), text(out));
		return out;
	}

	/** The pinned outcome of the running test, by its name. */
	function expected(): Outcome {
		const name = expect.getState().currentTestName?.split(" > ").at(-1) ?? "";
		const found = OUTCOMES[name];
		if (!found) throw new Error(`no pinned outcome for "${name}"`);
		return found;
	}

	it("cron mail, 4 approvers, every email fails: the last failure is not logged", async () => {
		const s = await site({ admins: 4 });
		const id = await waiting(s);
		await cold(s);
		failing.add("emailSend");
		const before = await emails(s);
		const m = await measure(() => mailTask(s, id), { enforce: true });
		expect(await outcome(s, id, m, before)).toEqual(expected());
	});

	for (const count of [2, 5]) {
		it(`page load, admin, ${count} waiting`, async () => {
			const s = await site();
			let id = "";
			for (let i = 0; i < count; i++) id = await waiting(s, `Page ${i + 1}`);
			await cold(s);
			const before = await emails(s);
			const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }), {
				enforce: true,
			});
			expect(await outcome(s, id, m, before)).toEqual(expected());
		});
	}

	it("save settings, 1 waiting", async () => {
		const s = await site({ config: { ...HELD, checks: "off" } });
		const id = await waiting(s);
		await cold(s);
		const before = await emails(s);
		const m = await measure(
			() => s.host.admin.submit("/overview", "save_settings", HELD, { user: admin(s) }),
			{ enforce: true },
		);
		expect(await outcome(s, id, m, before)).toEqual(expected());
		expect(await s.host.inspect.setting("config")).toMatchObject({ checks: "remind" });
	});

	for (const action of ["approve", "approve_publish"]) {
		it(`page ${action}`, async () => {
			const s = await site();
			const id = await waiting(s);
			await cold(s);
			const before = await emails(s);
			const m = await measure(
				() =>
					s.host.admin.act("/overview", action, {
						user: admin(s),
						value: { key: `pages:${id}` },
					}),
				{ enforce: true },
			);
			expect(await outcome(s, id, m, before)).toEqual(expected());
		});
	}

	it("page approve_publish, publish fails", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		failing.add("contentPublish");
		const before = await emails(s);
		const m = await measure(
			() =>
				s.host.admin.act("/overview", "approve_publish", {
					user: admin(s),
					value: { key: `pages:${id}` },
				}),
			{ enforce: true },
		);
		expect(await outcome(s, id, m, before)).toEqual(expected());
	});

	it("page override_publish, 3 approvers", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await cold(s);
		const before = await emails(s);
		const m = await measure(
			() =>
				s.host.admin.submit(
					"/overview",
					"override_publish",
					{ reason: "Price list must go out today" },
					{ user: admin(s), blockId: `ov:pages:${id}` },
				),
			{ enforce: true },
		);
		expect(await outcome(s, id, m, before)).toEqual(expected());
	});

	it("page send back, 1 other waiting", async () => {
		const s = await site();
		await waiting(s, "Page 1");
		const id = await waiting(s, "Page 2");
		await cold(s);
		const before = await emails(s);
		const m = await measure(
			() =>
				s.host.admin.submit(
					"/overview",
					"send_back",
					{ note: "Iced coffee is £3.40" },
					{ user: admin(s), blockId: `sb:pages:${id}` },
				),
			{ enforce: true },
		);
		expect(await outcome(s, id, m, before)).toEqual(expected());
	});

	it("page override, 3 approvers", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await cold(s);
		const before = await emails(s);
		const m = await measure(
			() =>
				s.host.admin.submit(
					"/overview",
					"override",
					{ reason: "Price list must go out today" },
					{ user: admin(s), blockId: `ov:pages:${id}` },
				),
			{ enforce: true },
		);
		expect(await outcome(s, id, m, before)).toEqual(expected());
	});

	it("page ask, contributor, 2 approvers", async () => {
		const s = await site();
		const id = await page(s, s.contributor);
		await cold(s);
		const before = await emails(s);
		const m = await measure(
			() =>
				s.host.admin.act("/overview", "ask", {
					user: s.contributor,
					value: { collection: "pages", id },
				}),
			{ enforce: true },
		);
		expect(await outcome(s, id, m, before)).toEqual(expected());
	});

	for (const action of ["approve", "approve_publish"]) {
		it(`panel ${action}`, async () => {
			const s = await site();
			const id = await waiting(s);
			await cold(s);
			const before = await emails(s);
			const m = await measure(
				() =>
					s.host.admin.actEditorPanel("approval", "pages", id, action, {
						user: admin(s),
						value: { key: `pages:${id}` },
					}),
				{ enforce: true },
			);
			expect(await outcome(s, id, m, before)).toEqual(expected());
		});
	}

	it("panel override_publish, 3 approvers", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await cold(s);
		const before = await emails(s);
		const m = await measure(
			() =>
				s.host.admin.submitEditorPanel(
					"approval",
					"pages",
					id,
					"override_publish",
					{ reason: "Price list must go out today" },
					{ user: admin(s), blockId: `ov:pages:${id}` },
				),
			{ enforce: true },
		);
		expect(await outcome(s, id, m, before)).toEqual(expected());
	});

	for (const [admins, settings] of [
		[2, "saved"],
		[3, "saved"],
		[1, "legacy"],
	] as const) {
		it(`editor ask, ${admins} approver(s), ${settings} settings`, async () => {
			const s = await site({ admins, settings });
			const id = await page(s);
			await cold(s);
			const before = await emails(s);
			const m = await measure(
				() => s.host.admin.invokeEditorAction("ask", "pages", id, { user: s.editor }),
				{ enforce: true },
			);
			expect(await outcome(s, id, m, before)).toEqual(expected());
		});
	}
});
