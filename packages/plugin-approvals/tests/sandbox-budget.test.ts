// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Pins how many host calls (subrequests) each sandboxed invocation of Content Approval makes,
// per hook, route, admin interaction and cron run, in the states that cost the most (B39). On
// Cloudflare one invocation may make at most 10; the 11th call and every one after it throw.
// The plugin keeps every path to 9 or fewer, whatever the number of pages waiting or people
// who approve: emails go out from cron runs that each send what fits and queue the rest.
// Each count is measured on a cold isolate (host.restart() first) and pinned exactly, so any
// change in cost shows up here; pin() also checks the limit. The enforced tests at the end run
// the paths that once went over with Cloudflare's limit, and follow their emails to the inbox.
//
// Pages are saved twice before they are measured, so they have a draft revision: reading what
// would go live then costs contentGet + contentGetRevision, the worst case.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { PluginBridge } from "@emdash-cms/plugin-test/worker";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../src/requests.js";
import {
	describeCalls,
	measure,
	SANDBOX_SUBREQUESTS,
	type Measured,
	setRuntimeFault,
} from "./bridge-budget.js";

/** The plugin's own ceiling per invocation: one call below Cloudflare's limit. */
const BUDGET = SANDBOX_SUBREQUESTS - 1;
/**
 * Paths added from 0.5.0, with this plugin's floor at EmDash 1.5.0 (30 calls per invocation,
 * emdash-cms/emdash#4712), keep to 25.
 */
const NEW_BUDGET = 25;

// Host calls a test can make fail, to reach the plugin's error paths (a failed email, a failed
// publish, a failed write). Patched before bridge-budget installs its counter, so the failing
// call still counts.
const failing = new Set<string>();
/** Host calls that fail this many more times, then work again. */
const failTimes = new Map<string, number>();
{
	const proto = PluginBridge.prototype as unknown as Record<
		string,
		(...args: unknown[]) => unknown
	>;
	for (const name of [
		"emailSend",
		"contentPublish",
		"storagePut",
		"cronSchedule",
		"kvSet",
		"storageUpdateIf",
		"userGet",
	]) {
		const original = proto[name]!;
		proto[name] = function (this: unknown, ...args: unknown[]) {
			const times = failTimes.get(name) ?? 0;
			if (times > 0) failTimes.set(name, times - 1);
			if (failing.has(name) || times > 0) return Promise.reject(new Error(`${name} failed (test)`));
			return original.apply(this, args);
		};
	}
}
// A compare-and-set that loses to a write landing between the read and the write (another
// person's withdraw or decision), this many more times. Counted as the call it replaces.
let conflicts = 0;
{
	const proto = PluginBridge.prototype as unknown as Record<
		string,
		(...args: unknown[]) => unknown
	>;
	const original = proto.storageCompareAndSet!;
	proto.storageCompareAndSet = function (this: unknown, ...args: unknown[]) {
		if (conflicts > 0) {
			conflicts--;
			return Promise.resolve({ applied: false });
		}
		return original.apply(this, args);
	};
}
// EmDash 1.4.0 sends content actions (publish) through PluginRuntimeBridge instead: the same
// failures for those calls, applied by bridge-budget after it counts the call.
setRuntimeFault((name) => {
	const times = failTimes.get(name) ?? 0;
	if (times > 0) failTimes.set(name, times - 1);
	return failing.has(name) || times > 0 ? new Error(`${name} failed (test)`) : undefined;
});

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	failing.clear();
	failTimes.clear();
	conflicts = 0;
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

/** Pin the count of one invocation, check it is within the plugin's budget, log its calls. */
function pin(label: string, m: Measured<unknown>, count: number): void {
	console.info(describeCalls(label, m));
	expect(m.calls.length, label).toBe(count);
	expect(m.calls.length, `${label}: within ${BUDGET} calls`).toBeLessThanOrEqual(BUDGET);
}

/**
 * After a publish from a route, EmDash runs this plugin's content:afterPublish hook deferred
 * (after()), as a separate invocation with its own budget, once the route has returned. Its
 * calls land in the route's window after the route's last call, the publish. This waits for
 * it inside the window and splits the two.
 */
async function measureWithDeferred<T>(
	invoke: () => Promise<T>,
): Promise<{ route: Measured<T>; deferred: string[] }> {
	const m = await measure(async () => {
		const result = await invoke();
		await drain();
		return result;
	});
	const end = m.calls.indexOf("contentPublish") + 1;
	expect(end, "the route publishes").toBeGreaterThan(0);
	return { route: { ...m, calls: m.calls.slice(0, end) }, deferred: m.calls.slice(end) };
}

/** The afterPublish hook after "Approve and publish": queue the emails, record "Published by". */
function expectDeferredAfterPublish(
	{ route, deferred }: { route: Measured<unknown>; deferred: string[] },
	queued = true,
): void {
	expect(deferred).toEqual(
		queued ? ["storageGet", "cronSchedule", "storagePut"] : ["storageGet", "storagePut"],
	);
	// The content-policy hook during the publish: kvList storageGet, its own invocation.
	expect(route.nested).toEqual(["kvList", "storageGet"]);
}

function text(value: unknown): string {
	return JSON.stringify(value);
}

// A new request reads its content type once (schemaGetCollection) to name the entry by its
// declared title field (0.5.0): one call more than before on each path that makes a request.
describe("content:beforePublish and content:beforeSchedule (the gate)", () => {
	it("lets everything through until the settings are saved", async () => {
		const s = await site({ settings: "none" });
		const id = await page(s);
		await cold(s);
		const event = await policyEvent(s, id, s.editor);
		const m = await measure(() => s.host.transport.invokeHook("content:beforePublish", event));
		pin("beforePublish, settings never saved", m, 1);
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
		pin("beforePublish, held, new request, migrated settings", m, 7);
		expect(m.result?.success).toBe(false);
		expect((await request(s, id))?.status).toBe("waiting");
		// One kv.list() reads both places; the copy forward is left to the Approvals page.
		expect(await s.host.inspect.setting("config")).toBeNull();
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

	// + contentGet: the live page's text, to note which fields the change touches (0.5.0).
	it("holds a change to a live page, noting which fields it changes", async () => {
		const s = await site();
		const id = await waiting(s);
		await s.host.admin.act("/overview", "approve_publish", {
			user: admin(s),
			value: { key: `pages:${id}` },
		});
		await drain();
		await edit(s, id, { ...DATA, content: "Iced coffee £3.40 and lemon tart" });
		await cold(s);
		const m = await measure(() => s.host.actions.content.publish("pages", id, actor(s.editor)));
		pin("beforePublish, held, change to a live page", m, 8);
		expect((await request(s, id))?.changed).toEqual({ live: true, fields: ["content"] });
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
		pin("beforePublish, broken request, logs", m, 5);
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
		pin("beforeSchedule, admin cleared", m, 5);
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
		pin("beforeSchedule, admin cleared, migrated settings", m, 5);
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
		pin("afterSave, approver edits waiting page, migrated settings", m, 7);
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

	// EmDash 1.5 co-editing: one save can hold several people's edits, saved as one actor.
	it("keeps an approval where it was when an admin's save also holds a writer's edits", async () => {
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
		const event = {
			...(await saveEvent(s, id, s.admins[1]!)),
			editedBy: [s.admins[1]!.id, s.editor.id],
		};
		const m = await measure(() => s.host.transport.invokeHook("content:afterSave", event));
		pin("afterSave, co-edited save on approved page", m, 1);
		const after = await request(s, id);
		expect(after?.approval?.fingerprint).toBe(before?.approval?.fingerprint);
		expect(after?.history[0]?.text).toBe(before?.history[0]?.text);
	});

	it("gets the editors of a co-edited save from EmDash's own save, sandboxed", async () => {
		const s = await site();
		const id = await waiting(s);
		await s.host.admin.actEditorPanel("approval", "pages", id, "approve", {
			user: admin(s),
			value: { key: `pages:${id}` },
		});
		const before = await request(s, id);
		const writer = s.admins[1]!;
		const updated = await s.host.actions.content.update("pages", id, {
			data: { content: "Iced coffee £3.40 and lemon tart" },
			actor: { id: writer.id, role: writer.role },
			editedBy: [writer.id, s.editor.id],
		});
		if (!updated.success) throw new Error(updated.error.message);
		await drain();
		const after = await request(s, id);
		expect(after?.approval?.fingerprint).toBe(before?.approval?.fingerprint);
		expect(after?.history[0]?.text).toBe(before?.history[0]?.text);
	});

	it("does not credit an approver with a co-edited save that holds others' edits", async () => {
		const s = await site();
		const id = await editedWhileWaiting(s);
		await cold(s);
		const event = { ...(await saveEvent(s, id, admin(s))), editedBy: [admin(s).id, s.editor.id] };
		const m = await measure(() => s.host.transport.invokeHook("content:afterSave", event));
		pin("afterSave, co-edited save on waiting page", m, 6);
		expect((await request(s, id))?.history[0]?.text).toBe("Changed while waiting: Content");
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
function mailTask(s: Site, id: string, extra: Record<string, unknown> = {}) {
	const key = `pages:${id}`;
	return s.host.transport.invokeHook("cron", {
		name: `mail-${key}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
		data: { key, kind: "asked", ...extra },
		scheduledAt: new Date().toISOString(),
	});
}

async function emails(s: Site): Promise<number> {
	return (await s.host.inspect.email()).length;
}

async function inbox(s: Site): Promise<Array<{ to: string; subject: string }>> {
	return (await s.host.inspect.email()).map((sent) => {
		const message = (sent.message ?? sent) as { to: string; subject: string };
		return { to: message.to, subject: message.subject };
	});
}

interface Task {
	name: string;
	nextRunAt: string;
}

/** Email tasks (mail-, send-) due by `at`. Reminders (two days on) are left alone. */
async function dueMail(s: Site, at: Date): Promise<Task[]> {
	const tasks = (await s.host.inspect.scheduledTasks()) as unknown as Task[];
	return tasks.filter(
		(t) =>
			(t.name.startsWith("mail-") || t.name.startsWith("send-")) &&
			Date.parse(t.nextRunAt) <= at.getTime(),
	);
}

async function mailTasks(s: Site): Promise<Task[]> {
	const tasks = (await s.host.inspect.scheduledTasks()) as unknown as Task[];
	return tasks.filter((t) => t.name.startsWith("mail-") || t.name.startsWith("send-"));
}

/**
 * Run the email tasks as EmDash's scheduler does (CronExecutor.tick), one run per tick, each
 * with Cloudflare's limit enforced, until none is due. `later` moves the clock on that far
 * first (failed emails are tried again after 5 minutes). Returns each run's call count.
 */
async function runMail(s: Site, { later = 0, max = 40 } = {}): Promise<number[]> {
	const counts: number[] = [];
	for (let run = 0; run < max; run++) {
		await drain();
		const at = new Date(Date.now() + later);
		const due = await dueMail(s, at);
		if (due.length === 0) return counts;
		// One task per tick, so each window is one invocation.
		expect(due, "one email task due at a time").toHaveLength(1);
		s.host.scheduled.setTime(at);
		const m = await measure(() => s.host.scheduled.run(), { enforce: true });
		console.info(describeCalls(`cron ${due[0]!.name.split("-")[0]} run ${run + 1}`, m));
		expect(m.error).toBeUndefined();
		expect(m.refused).toEqual([]);
		expect(m.calls.length).toBeLessThanOrEqual(BUDGET);
		counts.push(m.calls.length);
	}
	throw new Error(`still sending after ${max} runs`);
}

/** Run whatever email tasks seeding left (the request emails), outside any measurement. */
async function flushMail(s: Site): Promise<void> {
	for (let run = 0; run < 40; run++) {
		await drain();
		const at = new Date();
		if ((await dueMail(s, at)).length === 0) return;
		s.host.scheduled.setTime(at);
		await s.host.scheduled.run();
	}
}

describe("cron", () => {
	// kvList storageGet userList, then one emailSend each, up to 4; more go to a new task.
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

	it("sets the two-day reminder from the email task", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await cold(s);
		const stored = await request(s, id);
		const m = await measure(() => mailTask(s, id, { remind: stored?.requestedAt }));
		pin("cron mail, 3 approvers, sets the reminder", m, 7);
		expect(text(await s.host.inspect.scheduledTasks())).toContain("remind-");
	});

	it("emails 3 approvers on a migrated site", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		await toLegacy(s);
		await cold(s);
		const before = await emails(s);
		const m = await measure(() => mailTask(s, id));
		pin("cron mail, 3 approvers, migrated settings", m, 6);
		expect((await emails(s)) - before).toBe(3);
	});

	it("emails 12 approvers over three runs, at most 9 calls each", async () => {
		const s = await site({ admins: 12 });
		const id = await waiting(s);
		// The request email the publish queued goes first; this run sends it again.
		await flushMail(s);
		await cold(s);
		const before = await emails(s);
		const m = await measure(() => mailTask(s, id));
		// kvList storageGet userList, the rest queued (cronSchedule), then 3 emails.
		pin("cron mail, 12 approvers, first run", m, 7);
		expect((await emails(s)) - before).toBe(3);
		expect(await runMail(s)).toEqual([7, 3]);
		const sent = (await inbox(s)).slice(before);
		expect(new Set(sent.map((e) => e.to)).size).toBe(12);
		expect(sent).toHaveLength(12);
	});

	it("tries failed emails again later, and logs once", async () => {
		const s = await site({ admins: 4 });
		const id = await waiting(s);
		await flushMail(s);
		await cold(s);
		failing.add("emailSend");
		const m = await measure(() => mailTask(s, id));
		// kvList storageGet userList, 4 emailSend that fail, cronSchedule (again later), log.
		pin("cron mail, 4 approvers, every email fails", m, 9);
		expect(m.calls.filter((c) => c === "log")).toHaveLength(1);
		failing.clear();
		const before = await emails(s);
		expect(await runMail(s, { later: 6 * 60_000 })).toEqual([4]);
		expect((await emails(s)) - before).toBe(4);
	});

	it("reminds 3 approvers after two days", async () => {
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

	// + contentGet schemaGetCollection: a request an earlier release stored as "Untitled" is named
	// from its entry for the email; the reminder still reaches all 3 within the limit.
	it("reminds 3 approvers about a request stored as Untitled, by its name", async () => {
		const s = await site({ admins: 3 });
		const id = await waiting(s);
		const key = `pages:${id}`;
		const stored = await request(s, id);
		await s.host.fixtures.plugin.storage("requests", key, { ...stored, title: "Untitled" });
		await cold(s);
		const before = (await inbox(s)).length;
		const m = await measure(() =>
			s.host.transport.invokeHook("cron", {
				name: `remind-${key}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
				data: { key, requestedAt: stored?.requestedAt },
				scheduledAt: new Date().toISOString(),
			}),
		);
		console.info(describeCalls("cron remind, Untitled", m));
		pin("cron remind, 3 approvers, stored as Untitled", m, 7);
		// Two reads more leave room for one email in this run; the rest go out in the next.
		for (let run = 0; run < 5; run++) {
			await drain();
			s.host.scheduled.setTime(new Date(Date.now() + 60_000));
			await s.host.scheduled.run();
		}
		const sent = (await newMail(s, before)).filter((mail) =>
			mail.subject.includes("Still waiting"),
		);
		expect(sent).toHaveLength(3);
		for (const mail of sent) expect(mail.subject).toContain('Still waiting: "Summer menu"');
	});
});

describe("the Approvals page (route admin)", () => {
	it("opens on Settings for an admin before anything is saved", async () => {
		const s = await site({ settings: "none" });
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		pin("page load, admin, settings never saved", m, 5);
		expect(text(m.result)).toContain("Approval is off until you save these settings");
		expect(text(m.result)).toContain(
			"Taking a page off the site (Unpublish) is not held, by choice",
		);
	});

	it("opens for an admin on a migrated site with nothing waiting, copying the settings forward", async () => {
		const s = await site({ settings: "legacy" });
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		pin("page load, admin, migrated settings, nothing waiting", m, 6);
		expect(text(m.result)).toContain("For you to approve");
		expect(await s.host.inspect.setting("config")).toMatchObject({ collections: ["pages"] });
	});

	// kvList storageQuery schemaListCollections userList, however many pages wait: each row's
	// "things to check" is noted on the request when the page is held or saved. + contentList: the
	// pages already scheduled in Pages, for the Settings tab.
	for (const count of [1, 2, 25]) {
		it(`lists ${count} waiting page(s) for an admin`, async () => {
			const s = await site();
			for (let i = 0; i < count; i++) await waiting(s, `Page ${i + 1}`);
			await cold(s);
			const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
			pin(`page load, admin, ${count} waiting`, m, 5);
			expect(text(m.result)).toContain(`"label":"Waiting for you","value":${count}`);
		});
	}

	// Requests an earlier release stored as "Untitled" are named on opening: contentGet and
	// storageUpdateIf each, 5 at most per load, within EmDash 1.5's limit (a new path: <= 25).
	it("names 6 requests stored as Untitled, 5 per load", async () => {
		const s = await site();
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) ids.push(await waiting(s, `Page ${i + 1}`));
		for (const id of ids) {
			const stored = await request(s, id);
			await s.host.fixtures.plugin.storage("requests", `pages:${id}`, {
				...stored,
				title: "Untitled",
			});
		}
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		console.info(describeCalls("page load, admin, 6 stored as Untitled", m));
		// The Settings tab's pages already scheduled are read first (contentList), then the names.
		expect(m.calls.length).toBe(15);
		expect(m.calls.length).toBeLessThanOrEqual(NEW_BUDGET);
		const named = await Promise.all(ids.map(async (id) => (await request(s, id))?.title));
		expect(named.filter((t) => t === "Untitled")).toHaveLength(1);
		await s.host.admin.loadPage("/overview", { user: admin(s) });
		expect(
			(await Promise.all(ids.map(async (id) => (await request(s, id))?.title))).sort(),
		).toEqual(["Page 1", "Page 2", "Page 3", "Page 4", "Page 5", "Page 6"]);
	});

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
		// + storageGetMany for the approved text copies.
		pin("page load, admin, 1 waiting + 1 approved", m, 6);
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

	it("lists a Contributor's drafts (+1 per content type that needs approval)", async () => {
		const s = await site();
		await page(s, s.contributor);
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: s.contributor }));
		pin("page load, contributor with a draft", m, 4);
		expect(text(m.result)).toContain("Your drafts");
	});

	it("reads a Contributor's drafts from 3 content types at most", async () => {
		const types = ["posts", "news", "events", "recipes"];
		const s = await site({ config: { ...HELD, collections: ["pages", ...types] } });
		for (const slug of types) {
			await s.host.fixtures.collection({
				slug,
				label: slug.charAt(0).toUpperCase() + slug.slice(1),
				supports: ["drafts", "revisions"],
				fields: [{ slug: "title", label: "Title", type: "string" }],
			});
		}
		const mine = await waiting(s, "Mine", s.contributor);
		await s.host.admin.act("/overview", "approve", {
			user: admin(s),
			value: { key: `pages:${mine}` },
		});
		await waiting(s, "Mine too", s.contributor);
		await page(s, s.contributor, "Draft");
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: s.contributor }));
		// kvList storageQuery schemaListCollections userList storageGetMany + 3 contentList.
		pin("page load, contributor, 5 types, waiting and approved", m, 8);
		expect(text(m.result)).toContain("aren't listed here");
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
		pin("save settings, first time", m, 7);
		expect(m.result?.toast?.type).toBe("success");
		expect(await s.host.inspect.setting("config")).toMatchObject({ collections: ["pages"] });
	});

	it("saves the settings with pages waiting", async () => {
		const s = await site();
		for (let i = 0; i < 3; i++) await waiting(s, `Page ${i + 1}`);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit("/overview", "save_settings", HELD, { user: admin(s) }),
		);
		pin("save settings, 3 waiting", m, 7);
		expect(m.result?.toast?.type).toBe("success");
	});

	it("refuses a settings change from an editor", async () => {
		const s = await site();
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit("/overview", "save_settings", { collections: [] }, { user: s.editor }),
		);
		pin("save settings, editor refused", m, 3);
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

	it("approves from the page, and offers the way back to the list", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.act("/overview", "approve", { user: admin(s), value: { key: `pages:${id}` } }),
		);
		// kvList storageGetVersioned contentGet contentGetRevision schemaGetCollection
		// storageCompareAndSet storagePut (text copy) cronSchedule (the writer's email).
		pin("page approve", m, 8);
		expect(m.result?.toast).toEqual({ type: "success", message: "Approved. Sam has been told." });
		expect(text(m.result)).toContain("Back to the list");
	});

	it("shows the review again when the page changed while the approver looked", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.act("/overview", "approve", {
				user: admin(s),
				value: { key: `pages:${id}`, seen: "an older version" },
			}),
		);
		pin("page approve, page changed meanwhile", m, 6);
		expect(m.result?.toast?.message).toContain("This page changed while you were looking");
		expect(text(m.result)).toContain("Approve and publish");
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
		// kvList storageGetVersioned contentGetVersioned contentGetRevision schemaGetCollection
		// storageCompareAndSet storagePut contentPublish; the emails and "Published by" follow in
		// content:afterPublish.
		pin("page approve and publish", m.route, 8);
		expectDeferredAfterPublish(m);
		expect(m.route.result?.toast?.message).toBe(
			"Approved and published. It's live now. Sam has been told.",
		);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
		const stored = await request(s, id);
		expect(stored?.status).toBe("published");
		expect(stored?.history[0]?.text).toBe("Published by Ellen Marsh");
		expect(stored?.publishing).toBeUndefined();
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
		// The 8 above, then the failure logged.
		pin("page approve and publish, publish fails", m, 9);
		expect(m.result?.toast?.message).toBe(
			"Approved, but it could not be published just now. Press Publish on the page.",
		);
		expect((await request(s, id))?.status).toBe("approved");
	});

	it("sends back from the page, and lists what still waits", async () => {
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
		// kvList storageGetVersioned storageCompareAndSet cronSchedule, then the list (4).
		pin("page send back, 1 other waiting", m, 7);
		expect(m.result?.toast?.message).toBe("Sent back to Sam with your note.");
		expect(text(m.result)).toContain(`"label":"Waiting for you","value":1`);
	});

	it("publishes without review from the page", async () => {
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
		pin("page publish without review, 3 approvers", m.route, 8);
		expectDeferredAfterPublish(m);
		expect(m.route.result?.toast?.message).toContain("Published without review.");
	});

	it("approves without review from the page", async () => {
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
		// One task carries both emails: to the other approvers and to the writer.
		pin("page approve without review, 3 approvers", m, 8);
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
		// kvList schemaGetCollection storageGet contentGet contentGetRevision storagePut
		// cronSchedule userList.
		pin("page ask, contributor, 2 approvers", m, 8);
		expect(m.result?.toast?.type).toBe("success");
		expect(text(m.result)).toContain("Back to the list");
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
		pin("panel load, changed since approval, migrated settings", m, 6);
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
		pin("panel approve", m, 8);
		expect(m.result?.toast).toEqual({ type: "success", message: "Approved. Sam has been told." });
		expect(text(m.result)).toContain("Approved by Ellen Marsh");
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
		pin("panel approve and publish", m.route, 8);
		expectDeferredAfterPublish(m);
		expect(m.route.result?.toast?.message).toBe(
			"Approved and published. It's live now. Sam has been told.",
		);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
	});

	it("approves and publishes under the 'require' checks", async () => {
		const s = await site({ config: { ...HELD, checks: "require" } });
		const id = await waiting(s);
		await cold(s);
		const m = await measureWithDeferred(() =>
			s.host.admin.actEditorPanel("approval", "pages", id, "approve_publish", {
				user: admin(s),
				value: { key: `pages:${id}` },
			}),
		);
		// + contentGet: the page read for publishing comes without its SEO panel.
		pin("panel approve and publish, require checks", m.route, 9);
		expectDeferredAfterPublish(m);
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
		pin("panel send back", m, 5);
		expect(m.result?.toast?.message).toBe("Sent back to Sam with your note.");
	});

	it("sends back with a note when the email cannot be queued, and logs it", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		failing.add("cronSchedule");
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
		pin("panel send back, email not queued", m, 6);
		expect(m.calls.at(-1)).toBe("log");
		expect(m.result?.toast?.message).toBe("Sent back to Sam with your note.");
		expect((await request(s, id))?.status).toBe("sent_back");
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
		pin("panel save note", m, 7);
		expect(m.result?.toast?.type).toBe("success");
	});

	it("publishes without review", async () => {
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
		pin("panel publish without review, 3 approvers", m.route, 8);
		expectDeferredAfterPublish(m);
		expect(m.route.result?.toast?.message).toContain("Published without review.");
	});
});

describe("Ask for approval (route editor/ask)", () => {
	// kvList schemaGetCollection storageGet contentGet contentGetRevision storagePut
	// cronSchedule userList, however many approvers: the emails go from a cron task.
	for (const admins of [1, 3, 12]) {
		it(`asks ${admins} approver(s)`, async () => {
			const s = await site({ admins });
			const id = await page(s);
			await cold(s);
			const m = await measure(() =>
				s.host.admin.invokeEditorAction("ask", "pages", id, { user: s.editor }),
			);
			pin(`editor ask, ${admins} approver(s)`, m, 8);
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
		pin("editor ask, 1 approver, migrated settings", m, 8);
		expect(m.result?.toast?.type).toBe("success");
	});
});

/** Jo, a Contributor, asks from the Approvals page: her draft waits. */
async function contributorWaiting(s: Site, title = "Picnic ideas"): Promise<string> {
	const id = await page(s, s.contributor, title);
	const asked = await s.host.admin.act("/overview", "ask", {
		user: s.contributor,
		value: { collection: "pages", id },
	});
	expect(asked.toast?.type).toBe("success");
	return id;
}

/** Schedule a page, an hour from now. */
async function schedule(s: Site, id: string, by: User = admin(s)): Promise<string> {
	const at = new Date(Date.now() + 3_600_000).toISOString();
	const result = await s.host.actions.content.schedule("pages", id, at, actor(by));
	if (!result.success) throw new Error(result.error.message);
	return at;
}

describe("Withdraw (the person who asked)", () => {
	it("shows Withdraw under 'Yours, waiting' for a Contributor", async () => {
		const s = await site();
		await contributorWaiting(s);
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: s.contributor }));
		// kvList storageQuery schemaListCollections userList, + contentList for the drafts.
		pin("page load, contributor, own page waiting", m, 5);
		expect(text(m.result)).toContain('"action_id":"withdraw"');
		expect(text(m.result)).toContain("Withdraw this request?");
	});

	it("withdraws from the page: closed, and the approvers' email is never sent", async () => {
		const s = await site();
		const id = await contributorWaiting(s);
		await cold(s);
		const before = await emails(s);
		const m = await measure(() =>
			s.host.admin.act("/overview", "withdraw", {
				user: s.contributor,
				value: { key: `pages:${id}` },
			}),
		);
		// kvList storageGetVersioned storageCompareAndSet.
		pin("page withdraw, contributor", m, 3);
		expect(m.result?.toast).toEqual({
			type: "success",
			message: "Withdrawn. The approvers no longer see it; ask again when it is ready.",
		});
		expect(text(m.result)).toContain("Back to the list");
		const stored = await request(s, id);
		expect(stored?.status).toBe("closed");
		expect(stored?.history[0]?.text).toBe("Jo Park withdrew the request");
		// The email task queued by the ask finds nothing waiting.
		await runMail(s);
		expect(await newMail(s, before)).toEqual([]);
	});

	it("refuses a withdraw from anyone but the person who asked", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.act("/overview", "withdraw", { user: admin(s), value: { key: `pages:${id}` } }),
		);
		pin("page withdraw, someone else refused", m, 2);
		expect(m.result?.toast).toEqual({
			type: "error",
			message: "Only the person who asked can withdraw it.",
		});
		expect((await request(s, id))?.status).toBe("waiting");
	});

	it("shows Withdraw in the writer's panel, not in an approver's", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.loadEditorPanel("approval", "pages", id, { user: s.editor }),
		);
		pin("panel load, writer, own page waiting", m, 6);
		expect(text(m.result)).toContain('"action_id":"withdraw"');
		const approver = await s.host.admin.loadEditorPanel("approval", "pages", id, {
			user: admin(s),
		});
		expect(text(approver)).not.toContain('"action_id":"withdraw"');
	});

	it("withdraws from the panel", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.actEditorPanel("approval", "pages", id, "withdraw", {
				user: s.editor,
				value: { key: `pages:${id}` },
			}),
		);
		// kvList schemaGetCollection storageGetVersioned storageCompareAndSet.
		pin("panel withdraw, writer", m, 4);
		expect(m.result?.toast?.type).toBe("success");
		expect(text(m.result)).toContain("You withdrew the request");
		expect((await request(s, id))?.status).toBe("closed");
	});

	it("does not email the approvers twice in a day when the writer withdraws and asks again", async () => {
		const s = await site();
		const id = await waiting(s);
		await flushMail(s);
		await s.host.admin.actEditorPanel("approval", "pages", id, "withdraw", {
			user: s.editor,
			value: { key: `pages:${id}` },
		});
		const emailedAt = (await request(s, id))?.emailedAt;
		expect(emailedAt).toBeTruthy();
		const held = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(held.success).toBe(false);
		const again = await request(s, id);
		expect(again?.status).toBe("waiting");
		expect(again?.emailedAt).toBe(emailedAt);
		await drain();
		expect(await mailTasks(s)).toEqual([]);
		// The two-day reminder is still set, for the new request.
		const tasks = (await s.host.inspect.scheduledTasks()) as unknown as Task[];
		const remind = tasks.filter((t) => t.name.startsWith("remind-"));
		const safe = again!.requestedAt.replace(/[^a-zA-Z0-9_-]/g, "_");
		expect(remind.map((t) => t.name).some((name) => name.endsWith(safe))).toBe(true);
	});
});

describe("Withdraw before the approvers' email went out", () => {
	const asked = (mail: Array<{ to: string; subject: string }>) =>
		mail.filter((e) => e.subject.includes("asked you to approve")).map((e) => e.to);

	it("emails the approvers when the writer withdraws before the email went out and asks again", async () => {
		const s = await site();
		const id = await waiting(s);
		const before = await emails(s);
		await s.host.admin.actEditorPanel("approval", "pages", id, "withdraw", {
			user: s.editor,
			value: { key: `pages:${id}` },
		});
		// The email task finds the request withdrawn: nothing is sent, and no email is counted
		// for the day. kvList storageGetVersioned storageCompareAndSet.
		expect(await runMail(s)).toEqual([3]);
		expect(await newMail(s, before)).toEqual([]);
		expect((await request(s, id))?.emailedAt).toBeUndefined();
		const held = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(held.success).toBe(false);
		await runMail(s);
		expect(asked(await newMail(s, before)).sort()).toEqual(s.admins.map((a) => a.email).sort());
	});

	it("emails the approvers once when the writer withdraws and asks again before the email went out", async () => {
		const s = await site();
		const id = await waiting(s);
		const before = await emails(s);
		await s.host.admin.actEditorPanel("approval", "pages", id, "withdraw", {
			user: s.editor,
			value: { key: `pages:${id}` },
		});
		const held = await s.host.actions.content.publish("pages", id, actor(s.editor));
		expect(held.success).toBe(false);
		await runMail(s);
		expect(asked(await newMail(s, before)).sort()).toEqual(s.admins.map((a) => a.email).sort());
	});
});

describe("Two people at once (compare-and-set)", () => {
	it("does not withdraw a request decided between reading and writing it", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		conflicts = 1;
		const m = await measure(() =>
			s.host.admin.actEditorPanel("approval", "pages", id, "withdraw", {
				user: s.editor,
				value: { key: `pages:${id}` },
			}),
		);
		// kvList schemaGetCollection storageGetVersioned storageCompareAndSet (lost), then the
		// panel as it is now: storageGet contentGet contentGetRevision userList.
		pin("panel withdraw, lost to a decision", m, 8);
		expect(m.result?.toast?.type).toBe("error");
		expect(m.calls).toContain("storageCompareAndSet");
		expect((await request(s, id))?.status).toBe("waiting");
	});

	it("does not approve or publish a request withdrawn between reading and writing it", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		for (const action of ["approve", "approve_publish"]) {
			conflicts = 1;
			const m = await measure(() =>
				s.host.admin.act("/overview", action, { user: admin(s), value: { key: `pages:${id}` } }),
			);
			expect(m.result?.toast?.type, action).toBe("error");
			expect(m.calls, action).toContain("storageCompareAndSet");
			expect(m.calls, action).not.toContain("contentPublish");
			// No text copy is left for an approval that did not happen.
			expect(m.calls, action).not.toContain("storagePut");
			expect(m.calls.length, action).toBeLessThanOrEqual(BUDGET);
			expect((await request(s, id))?.status, action).toBe("waiting");
		}
		expect((await s.host.inspect.content.get("pages", id))?.status).not.toBe("published");
	});

	it("does not send back a request withdrawn between reading and writing it", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const send = (surface: "page" | "panel") =>
			surface === "page"
				? s.host.admin.submit(
						"/overview",
						"send_back",
						{ note: "Iced coffee is £3.40" },
						{ user: admin(s), blockId: `sb:pages:${id}` },
					)
				: s.host.admin.submitEditorPanel(
						"approval",
						"pages",
						id,
						"send_back",
						{ note: "Iced coffee is £3.40" },
						{ user: admin(s), blockId: `sb:pages:${id}` },
					);
		// kvList storageGetVersioned storageCompareAndSet (lost), then the list (3).
		conflicts = 1;
		const page = await measure(() => send("page"));
		pin("page send back, lost to a withdraw", page, 6);
		// kvList schemaGetCollection storageGetVersioned storageCompareAndSet (lost), then the
		// panel as it is now: storageGet contentGet contentGetRevision.
		conflicts = 1;
		const panel = await measure(() => send("panel"));
		pin("panel send back, lost to a withdraw", panel, 7);
		for (const m of [page, panel]) {
			expect(m.result?.toast).toEqual({
				type: "error",
				message: "This request changed just now, so nothing was changed. Look again.",
			});
			expect(m.calls).not.toContain("cronSchedule");
		}
		expect((await request(s, id))?.status).toBe("waiting");
	});

	it("does not save a note on a request decided between reading and writing it", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		conflicts = 1;
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
		// kvList schemaGetCollection storageGetVersioned storageCompareAndSet (lost), then the
		// panel as it is now: storageGet contentGet contentGetRevision userList.
		pin("panel save note, lost to a decision", m, 8);
		expect(m.result?.toast).toEqual({
			type: "error",
			message: "This request changed just now, so nothing was changed. Look again.",
		});
		expect((await request(s, id))?.note).toBeUndefined();
	});

	// kvList schemaGetCollection storageGetVersioned, the page (2, + contentGet for the
	// "require" checks), storageCompareAndSet (lost), then the panel shows the request as it
	// is now (storageGet), reusing the page it already read.
	for (const [label, config, act, count] of [
		["approve", HELD, "approve", 7],
		["approve and publish", HELD, "approve_publish", 7],
		["approve and publish, require checks", { ...HELD, checks: "require" }, "approve_publish", 8],
		["publish without review", HELD, "override_publish", 7],
	] as const) {
		it(`panel ${label}: lost to a withdraw, nothing published, within the limit`, async () => {
			const s = await site({ config, admins: 3 });
			const id = await waiting(s);
			await cold(s);
			conflicts = 1;
			const m = await measure(() =>
				act === "override_publish"
					? s.host.admin.submitEditorPanel(
							"approval",
							"pages",
							id,
							act,
							{ reason: "Price list must go out today" },
							{ user: admin(s), blockId: `ov:pages:${id}` },
						)
					: s.host.admin.actEditorPanel("approval", "pages", id, act, {
							user: admin(s),
							value: { key: `pages:${id}` },
						}),
			);
			pin(`panel ${label}, lost to a withdraw`, m, count);
			expect(m.result?.toast?.type).toBe("error");
			expect(m.calls).toContain("storageCompareAndSet");
			expect(m.calls).not.toContain("contentPublish");
			expect(m.calls).not.toContain("storagePut");
			expect((await request(s, id))?.status).toBe("waiting");
		});
	}
});

describe("Settings: pages already scheduled", () => {
	it("names the pages already scheduled that approval will hold", async () => {
		const s = await site({ settings: "none" });
		const sale = await page(s, s.editor, "Summer sale");
		await schedule(s, sale);
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		// kvList storageQuery schemaListCollections userList, + contentList for Pages.
		pin("page load, admin, settings never saved, 1 scheduled", m, 5);
		expect(text(m.result)).toMatch(/Summer sale \(Pages, \d+ \w+, \d\d:\d\d UTC\)/);

		const saved = await measure(() =>
			s.host.admin.submit("/overview", "save_settings", HELD, { user: admin(s) }),
		);
		pin("save settings, first time, 1 scheduled", saved, 7);
		expect(text(saved.result)).toContain(
			"Already scheduled, and will need approval before they go live: Summer sale (Pages,",
		);
	});

	it("leaves out what an admin scheduled with approval on, and says when nothing is scheduled", async () => {
		const s = await site();
		const own = await page(s, admin(s), "Opening hours");
		await schedule(s, own);
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		pin("page load, admin, own schedule cleared", m, 6);
		expect(text(m.result)).not.toContain("Opening hours (Pages,");
		expect(text(m.result)).toContain("Nothing already scheduled needs approval.");
	});

	it("reads scheduled pages only with calls to spare: save settings, worst case", async () => {
		const types = ["posts", "news", "events"];
		const s = await site({ config: { ...HELD, collections: ["pages", ...types] } });
		for (const slug of types) {
			await s.host.fixtures.collection({
				slug,
				label: slug.charAt(0).toUpperCase() + slug.slice(1),
				supports: ["drafts", "revisions"],
				fields: [{ slug: "title", label: "Title", type: "string" }],
			});
		}
		const done = await waiting(s, "Page 1");
		await s.host.admin.act("/overview", "approve", {
			user: admin(s),
			value: { key: `pages:${done}` },
		});
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit(
				"/overview",
				"save_settings",
				{ ...HELD, collections: ["pages", ...types] },
				{ user: admin(s) },
			),
		);
		pin("save settings, 1 approved, 4 types", m, 9);
		expect(text(m.result)).toContain("weren't checked here");
	});

	it("does not read scheduled pages after a decision", async () => {
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
		expect(m.calls).not.toContain("contentList");
		expect(text(m.result)).toContain("Pages already scheduled will need approval");
	});
});

async function enforced<T>(label: string, invoke: () => Promise<T>): Promise<Measured<T>> {
	const m = await measure(invoke, { enforce: true });
	console.info(describeCalls(`enforced ${label}`, m));
	expect(m.error).toBeUndefined();
	expect(m.refused).toEqual([]);
	expect(m.calls.length).toBeLessThanOrEqual(BUDGET);
	return m;
}

/** A site with pages waiting, their request emails already sent. */
async function seeded(options: Parameters<typeof site>[0] = {}, count = 1) {
	const s = await site(options);
	let id = "";
	for (let i = 0; i < count; i++) id = await waiting(s, count > 1 ? `Page ${i + 1}` : DATA.title);
	await flushMail(s);
	await cold(s);
	return { s, id, before: await emails(s) };
}

async function newMail(s: Site, before: number) {
	return (await inbox(s)).slice(before);
}

/**
 * The paths that went over the limit up to 0.1.6, run with Cloudflare's limit: nothing is
 * refused, the decision is stored, and every email it queued reaches its inbox in later cron
 * runs, each within the limit too.
 */
describe(`enforced: Cloudflare's limit of ${SANDBOX_SUBREQUESTS} calls`, () => {
	for (const count of [2, 25]) {
		it(`page load, admin, ${count} waiting`, async () => {
			const { s } = await seeded({}, count);
			const m = await enforced("page load", () =>
				s.host.admin.loadPage("/overview", { user: admin(s) }),
			);
			expect(text(m.result)).toContain(`"label":"Waiting for you","value":${count}`);
		});
	}

	it("save settings, 1 waiting", async () => {
		const { s } = await seeded({ config: { ...HELD, checks: "off" } });
		const m = await enforced("save settings", () =>
			s.host.admin.submit("/overview", "save_settings", HELD, { user: admin(s) }),
		);
		expect(m.result?.toast?.type).toBe("success");
		expect(await s.host.inspect.setting("config")).toMatchObject({ checks: "remind" });
	});

	it("page approve: approved, and the writer's email follows", async () => {
		const { s, id, before } = await seeded();
		await enforced("page approve", () =>
			s.host.admin.act("/overview", "approve", { user: admin(s), value: { key: `pages:${id}` } }),
		);
		expect((await request(s, id))?.status).toBe("approved");
		expect(await emails(s)).toBe(before);
		expect(await mailTasks(s)).toHaveLength(1);
		await runMail(s);
		expect(await newMail(s, before)).toEqual([
			{ to: "sam@bakery.test", subject: 'Harbour Street Bakery: Approved: "Summer menu"' },
		]);
	});

	it("page approve and publish: live, recorded, and the writer's email follows", async () => {
		const { s, id, before } = await seeded();
		// The publish runs content:afterPublish as its own invocation once the route returns;
		// in the test it shares the window, so the two are counted apart rather than enforced.
		const m = await measureWithDeferred(() =>
			s.host.admin.act("/overview", "approve_publish", {
				user: admin(s),
				value: { key: `pages:${id}` },
			}),
		);
		expect(m.route.calls.length).toBeLessThanOrEqual(BUDGET);
		expect(m.deferred.length).toBeLessThanOrEqual(BUDGET);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
		expect((await request(s, id))?.history[0]?.text).toBe("Published by Ellen Marsh");
		await runMail(s);
		expect(await newMail(s, before)).toEqual([
			{
				to: "sam@bakery.test",
				subject: 'Harbour Street Bakery: Approved and published: "Summer menu"',
			},
		]);
	});

	it("page approve and publish, publish fails: approved, the approver told", async () => {
		const { s, id, before } = await seeded();
		failing.add("contentPublish");
		const m = await enforced("page approve and publish, publish fails", () =>
			s.host.admin.act("/overview", "approve_publish", {
				user: admin(s),
				value: { key: `pages:${id}` },
			}),
		);
		failing.clear();
		expect(m.result?.toast?.message).toBe(
			"Approved, but it could not be published just now. Press Publish on the page.",
		);
		expect((await s.host.inspect.content.get("pages", id))?.status).toBe("draft");
		expect((await request(s, id))?.status).toBe("approved");
		expect(await runMail(s)).toEqual([]);
		expect(await emails(s)).toBe(before);
	});

	it("page publish without review, 3 approvers: the other two and the writer are told", async () => {
		const { s, id, before } = await seeded({ admins: 3 });
		const m = await measureWithDeferred(() =>
			s.host.admin.submit(
				"/overview",
				"override_publish",
				{ reason: "Price list must go out today" },
				{ user: admin(s), blockId: `ov:pages:${id}` },
			),
		);
		expect(m.route.calls.length).toBeLessThanOrEqual(BUDGET);
		expect((await request(s, id))?.status).toBe("published");
		await runMail(s);
		const sent = await newMail(s, before);
		expect(sent.map((e) => e.to).sort()).toEqual([
			"admin1@agency.test",
			"admin2@agency.test",
			"sam@bakery.test",
		]);
		expect(
			sent.filter((e) => e.subject.includes('published "Summer menu" without review')),
		).toHaveLength(2);
	});

	it("page send back, 1 other waiting: sent back, and the writer's email follows", async () => {
		const { s, before } = await seeded({}, 2);
		const pages = await s.host.inspect.content.list("pages");
		const id = pages.find((p) => (p.data as { title?: string }).title === "Page 2")!.id;
		await enforced("page send back", () =>
			s.host.admin.submit(
				"/overview",
				"send_back",
				{ note: "Iced coffee is £3.40" },
				{ user: admin(s), blockId: `sb:pages:${id}` },
			),
		);
		expect((await request(s, id))?.status).toBe("sent_back");
		await runMail(s);
		expect(await newMail(s, before)).toEqual([
			{ to: "sam@bakery.test", subject: 'Harbour Street Bakery: Ellen Marsh sent back "Page 2"' },
		]);
	});

	it("page approve without review, 3 approvers: the other two and the writer are told", async () => {
		const { s, id, before } = await seeded({ admins: 3 });
		await enforced("page approve without review", () =>
			s.host.admin.submit(
				"/overview",
				"override",
				{ reason: "Price list must go out today" },
				{ user: admin(s), blockId: `ov:pages:${id}` },
			),
		);
		expect((await request(s, id))?.status).toBe("approved");
		await runMail(s);
		expect((await newMail(s, before)).map((e) => e.to).sort()).toEqual([
			"admin1@agency.test",
			"admin2@agency.test",
			"sam@bakery.test",
		]);
	});

	it("page ask, a Contributor: waiting, both approvers emailed, a reminder set", async () => {
		const s = await site();
		const id = await page(s, s.contributor);
		await cold(s);
		const before = await emails(s);
		await enforced("page ask", () =>
			s.host.admin.act("/overview", "ask", {
				user: s.contributor,
				value: { collection: "pages", id },
			}),
		);
		expect((await request(s, id))?.status).toBe("waiting");
		await runMail(s);
		expect((await newMail(s, before)).map((e) => e.to).sort()).toEqual([
			"admin0@agency.test",
			"admin1@agency.test",
		]);
		expect(text(await s.host.inspect.scheduledTasks())).toContain("remind-");
	});

	it("panel approve: approved, and the writer's email follows", async () => {
		const { s, id, before } = await seeded();
		await enforced("panel approve", () =>
			s.host.admin.actEditorPanel("approval", "pages", id, "approve", {
				user: admin(s),
				value: { key: `pages:${id}` },
			}),
		);
		expect((await request(s, id))?.status).toBe("approved");
		await runMail(s);
		expect((await newMail(s, before)).map((e) => e.to)).toEqual(["sam@bakery.test"]);
	});

	for (const action of ["approve_publish", "override_publish"]) {
		it(`panel ${action}, 3 approvers: live, and the emails follow`, async () => {
			const { s, id, before } = await seeded({ admins: 3 });
			const m = await measureWithDeferred(() =>
				action === "approve_publish"
					? s.host.admin.actEditorPanel("approval", "pages", id, action, {
							user: admin(s),
							value: { key: `pages:${id}` },
						})
					: s.host.admin.submitEditorPanel(
							"approval",
							"pages",
							id,
							action,
							{ reason: "Price list must go out today" },
							{ user: admin(s), blockId: `ov:pages:${id}` },
						),
			);
			expect(m.route.calls.length).toBeLessThanOrEqual(BUDGET);
			expect(m.deferred.length).toBeLessThanOrEqual(BUDGET);
			expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
			expect((await request(s, id))?.status).toBe("published");
			await runMail(s);
			const to = (await newMail(s, before)).map((e) => e.to).sort();
			expect(to).toEqual(
				action === "approve_publish"
					? ["sam@bakery.test"]
					: ["admin1@agency.test", "admin2@agency.test", "sam@bakery.test"],
			);
		});
	}

	it("editor ask, 25 approvers: one email each, every run within the limit", async () => {
		const s = await site({ admins: 25 });
		const id = await page(s);
		await cold(s);
		const before = await emails(s);
		await enforced("editor ask, 25 approvers", () =>
			s.host.admin.invokeEditorAction("ask", "pages", id, { user: s.editor }),
		);
		expect((await request(s, id))?.status).toBe("waiting");
		const runs = await runMail(s);
		expect(runs.length).toBeGreaterThan(1);
		const sent = await newMail(s, before);
		expect(sent).toHaveLength(25);
		expect(new Set(sent.map((e) => e.to)).size).toBe(25);
		expect(text(await s.host.inspect.scheduledTasks())).toContain("remind-");
	});

	it("an email that fails mid-run is sent later, once", async () => {
		const s = await site({ admins: 6 });
		const id = await waiting(s);
		await cold(s);
		// The first two sends fail, the rest go through.
		failTimes.set("emailSend", 2);
		const before = await emails(s);
		await runMail(s);
		expect(await emails(s)).toBe(before + 4);
		await runMail(s, { later: 6 * 60_000 });
		const sent = await newMail(s, before);
		expect(sent).toHaveLength(6);
		expect(new Set(sent.map((e) => e.to)).size).toBe(6);
		expect(id).not.toBe("");
	});
});

// The MCP tools need EmDash 1.5.0, whose sandbox allows 30 calls per invocation (#4712): each new
// path is pinned and kept to 25, though both fit the old 9.
const MCP_BUDGET = 25;

function pinMcp(label: string, m: Measured<Response>, count: number): void {
	console.info(describeCalls(label, m));
	expect(m.error).toBeUndefined();
	expect(m.result?.status, label).toBe(200);
	expect(m.calls.length, label).toBe(count);
	expect(m.calls.length, `${label}: within ${MCP_BUDGET} calls`).toBeLessThanOrEqual(MCP_BUDGET);
}

function tool(s: Site, route: string, user: User, body: unknown = {}): Promise<Response> {
	return s.host.actions.routes.request(route, {
		user,
		body,
		headers: { "X-EmDash-Request": "1" },
		// As EmDash's MCP server calls it: with the request it received.
		url: "https://bakery.test/_emdash/api/mcp",
	});
}

describe("MCP tools", () => {
	// kvList storageQuery schemaListCollections, however many pages wait.
	it("queue: 25 waiting, for an admin", async () => {
		const s = await site();
		for (let i = 0; i < 25; i++) await waiting(s, `Page ${i + 1}`);
		await cold(s);
		const m = await measure(() => tool(s, "mcp/queue", admin(s)));
		pinMcp("mcp queue, admin, 25 waiting", m, 3);
	});

	// kvList storageGet contentGet contentGetRevision schemaGetCollection.
	it("status: an approved page changed since, for its writer", async () => {
		const s = await site();
		const id = await waiting(s);
		await s.host.admin.act("/overview", "approve", {
			user: admin(s),
			value: { key: `pages:${id}` },
		});
		await edit(s, id, { ...DATA, content: "Iced coffee £3.40" });
		await cold(s);
		const m = await measure(() => tool(s, "mcp/status", s.editor, { collection: "pages", id }));
		pinMcp("mcp status, approved then changed", m, 5);
		expect(text(await m.result?.json())).toContain('"changedSinceApproval":true');
	});

	// kvList storageGet contentGet contentGetRevision: refused before the content type is read.
	it("status: refuses a Contributor someone else's page", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			tool(s, "mcp/status", s.contributor, { collection: "pages", id }),
		);
		pinMcp("mcp status, not yours", m, 4);
	});
});

/** A button's value in a Block Kit response. */
function valueOf(response: unknown, actionId: string): unknown {
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

/** The values of the Waiting tab's tick boxes. */
function pickValues(response: unknown): string[] {
	let found: string[] = [];
	const walk = (node: unknown) => {
		if (typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (record.type === "checkbox" && record.action_id === "pick") {
			found = (record.options as Array<{ value: string }>).map((o) => o.value);
			return;
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(response);
	return found;
}

/** The value "Approve and publish all N" carries. */
function allButtonValue(response: unknown): unknown {
	return findButton(response, "bulk_all")?.value;
}

/** The first row's "Approve and publish" value. */
function rowButtonValue(response: unknown): unknown {
	return findButton(response, "row_approve")?.value;
}

function findButton(response: unknown, action: string): Record<string, unknown> | null {
	let found: Record<string, unknown> | null = null;
	const walk = (node: unknown) => {
		if (found || typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (record.type === "button" && record.action_id === action) {
			found = record;
			return;
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(response);
	return found;
}

/**
 * The calls of content:afterPublish, deferred after each publish into its own invocation, land
 * at the end of the window (storageGet, cronSchedule when it queues an email, storagePut): up to
 * three per publish, split off the end.
 */
function splitDeferred(calls: string[]): { own: string[]; deferred: string[] } {
	const publishes = calls.filter((c) => c === "contentPublish").length;
	let end = calls.length;
	while (
		end > 0 &&
		calls.length - end < publishes * 3 &&
		["storageGet", "cronSchedule", "storagePut"].includes(calls[end - 1]!)
	)
		end--;
	return { own: calls.slice(0, end), deferred: calls.slice(end) };
}

/**
 * Measure a route that publishes several pages: each publish runs content:afterPublish deferred,
 * in its own invocation with its own budget (storageGet, cronSchedule when it queues an email,
 * storagePut), and those calls land in the route's window. They are split off by their shape.
 */
async function measureWithDeferredAll<T>(
	invoke: () => Promise<T>,
): Promise<{ route: Measured<T>; deferred: string[] }> {
	const m = await measure(async () => {
		const result = await invoke();
		await drain();
		return result;
	});
	const { own, deferred } = splitDeferred(m.calls);
	const route = own;
	return { route: { ...m, calls: route }, deferred };
}

describe(`deciding several at once (new paths: <= ${NEW_BUDGET} calls)`, () => {
	/** The confirm step's button value: which stored selection it decides, and how. */
	async function goValue(s: Site, what: "publish" | "send_back" = "publish"): Promise<unknown> {
		const pick = await s.host.inspect.kv.get<{ at: string }>(`state:bulk-pick:${admin(s).id}`);
		return { pick: pick?.at, do: what };
	}

	/** The confirm step's button, as the Admin. */
	async function press(s: Site, what: "publish" | "send_back" = "publish") {
		return s.host.admin.act("/overview", "bulk_go", {
			user: admin(s),
			value: await goValue(s, what),
		});
	}

	/** Tick every waiting page and press Continue, as an Admin. */
	async function chooseAll(s: Site, what: "publish" | "send_back" = "publish") {
		const pick = pickValues(await s.host.admin.loadPage("/overview", { user: admin(s) }));
		return s.host.admin.submit(
			"/overview",
			"bulk_review",
			{ pick, ...(what === "send_back" ? { reason: "Prices" } : {}) },
			{ user: admin(s) },
		);
	}

	/** The confirm step for every waiting page, then its button: the Admin's press. */
	async function decideAll(s: Site, what: "publish" | "send_back" = "publish") {
		await chooseAll(s, what);
		return press(s, what);
	}

	interface LaneState {
		run: string;
		seq: number;
		rows: unknown[];
		results: Array<{ state: string; text: string }>;
	}

	/**
	 * Run every lane of the Admin's bulk run, one cron invocation at a time, as EmDash would, and
	 * measure each. content:afterPublish runs after each publish in its own invocation; its calls
	 * land after the run's own last write (kvSet, then the next task's cronSchedule), so they are
	 * split off.
	 */
	async function runLanes(s: Site): Promise<number[]> {
		const user = admin(s);
		const run = await s.host.inspect.kv.get<{ id: string; lanes: number }>(`state:bulk:${user.id}`);
		const counts: number[] = [];
		if (!run) return counts;
		for (let round = 0; round < 80; round++) {
			let ran = false;
			for (let lane = 0; lane < run!.lanes; lane++) {
				const state = await s.host.inspect.kv.get<LaneState>(
					`state:bulk:${user.id}:${run!.id}:${lane}`,
				);
				if (!state || state.rows.length === 0) continue;
				ran = true;
				await cold(s);
				const m = await measure(async () => {
					const out = await s.host.transport.invokeHook("cron", {
						name: `bulk-${user.id}-${run!.id}-${lane}-${state.seq}`,
						data: { user: user.id, run: run!.id, lane, seq: state.seq },
						scheduledAt: new Date().toISOString(),
					});
					await drain();
					return out;
				});
				expect(m.error).toBeUndefined();
				const { own } = splitDeferred(m.calls);
				console.info(`bulk lane ${lane} run ${state.seq}: ${own.length} ${own.join(" ")}`);
				expect(own.length).toBeLessThanOrEqual(NEW_BUDGET);
				counts.push(own.length);
			}
			if (!ran) return counts;
		}
		throw new Error("still running after 80 rounds");
	}

	// kvList storageQuery schemaListCollections, + kvSet: the selection stored for the press.
	it("confirm step for 25 selected: reads the list once and stores the selection", async () => {
		const s = await site();
		for (let i = 0; i < 25; i++) await waiting(s, `Page ${i + 1}`);
		const pick = pickValues(await s.host.admin.loadPage("/overview", { user: admin(s) }));
		expect(pick).toHaveLength(25);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit("/overview", "bulk_review", { pick, do: "publish" }, { user: admin(s) }),
		);
		console.info(describeCalls("bulk confirm, 25 selected", m));
		expect(m.calls.length).toBe(4);
		expect(text(m.result)).toContain("Decide these 25?");
	});

	// kvList, the requests and the content types (storageGetMany schemaListCollections), 3 pages
	// (contentGetVersioned storageUpdateIf contentPublish each, no draft revision read here as the
	// pages were saved twice: contentGetRevision too), the text copies (storagePutMany), the run,
	// its lane and its first task (kvSet kvSet cronSchedule), then the list: kvList storageQuery
	// userList storageGetMany. content:afterPublish runs per publish in its own invocation.
	it("the press: decides what fits at once, sends the rest to the background, shows the banner", async () => {
		const s = await site();
		for (let i = 0; i < 50; i++) await waiting(s, `Page ${i + 1}`);
		await chooseAll(s);
		await cold(s);
		const value = await goValue(s);
		const m = await measure(() =>
			s.host.admin.act("/overview", "bulk_go", { user: admin(s), value }),
		);
		const { own } = splitDeferred(m.calls);
		console.info(describeCalls("bulk press, 50 selected", m));
		expect(own.length).toBeLessThanOrEqual(NEW_BUDGET);
		expect(text(m.result)).toMatch(/Approving 50 pages: [1-9] done\. You can leave this page\./);
		await drain();
		const decided = (await s.host.inspect.storage.list<ApprovalRequest>("requests")).filter(
			(r) => r.data.status !== "waiting",
		);
		console.info(`bulk press, 50 selected: ${decided.length} decided during the press`);
		expect(decided.length).toBeGreaterThanOrEqual(3);
	});

	for (const n of [1, 2, 3, 4]) {
		it(`the press with ${n} chosen: all decided at once, within the limit, nothing left for later`, async () => {
			const s = await site();
			const ids: string[] = [];
			for (let i = 0; i < Math.max(n, 2); i++) ids.push(await waiting(s, `Page ${i + 1}`));
			const pick = pickValues(await s.host.admin.loadPage("/overview", { user: admin(s) })).slice(
				0,
				n,
			);
			await s.host.admin.submit("/overview", "bulk_review", { pick }, { user: admin(s) });
			await cold(s);
			const value = await goValue(s);
			const { route, deferred } = await measureWithDeferredAll(() =>
				s.host.admin.act("/overview", "bulk_go", { user: admin(s), value }),
			);
			console.info(describeCalls(`bulk press, ${n} chosen`, route));
			console.info(`  deferred afterPublish: ${deferred.join(" ")}`);
			expect(route.calls.length).toBeLessThanOrEqual(NEW_BUDGET);
			expect(text(route.result)).toContain(`Approved ${n} of ${n} ${n === 1 ? "page" : "pages"}.`);
			for (const id of ids.slice(0, n)) expect((await request(s, id))?.status).toBe("published");
			expect(
				(await s.host.inspect.scheduledTasks()).some((t) => String(t.name).startsWith("bulk-")),
			).toBe(false);
		});
	}

	// The audit's worst cases for the press that stores what is left: checks off, the first rows
	// refused as changed (cheaper than a decision, so more rows are reached), the rest decided.
	for (const changedFirst of [1, 3]) {
		it(`the press, ${changedFirst} changed first, checks off, 12 chosen: within the limit with the list`, async () => {
			const s = await site({ config: { ...HELD, checks: "off" } });
			const ids: string[] = [];
			for (let i = 0; i < 12; i++) ids.push(await waiting(s, `Page ${i + 1}`));
			const list = await s.host.admin.loadPage("/overview", { user: admin(s) });
			const value = allButtonValue(list);
			for (const id of ids.slice(0, changedFirst))
				await edit(s, id, { ...DATA, title: `Page ${ids.indexOf(id) + 1}`, content: "Changed" });
			await drain();
			await cold(s);
			const m = await measure(() =>
				s.host.admin.act("/overview", "bulk_all", { user: admin(s), value }),
			);
			const { own } = splitDeferred(m.calls);
			console.info(`bulk all 12, ${changedFirst} changed first: ${own.length} ${own.join(" ")}`);
			expect(m.error).toBeUndefined();
			expect(own.length).toBeLessThanOrEqual(NEW_BUDGET);
			expect(text(m.result)).toContain("You can leave this page.");
		});
	}

	// Two tabs pressed at once: both read the KV before either stored its run.
	it("two presses at once: the second keeps the first's run and says what it left", async () => {
		const s = await site();
		const ids: string[] = [];
		for (let i = 0; i < 16; i++) ids.push(await waiting(s, `Page ${i + 1}`));
		const list = await s.host.admin.loadPage("/overview", { user: admin(s) });
		const value = allButtonValue(list) as { rows: string[] };
		const first = { rows: value.rows.slice(0, 8) };
		const second = { rows: value.rows.slice(8) };
		const [a, b] = await Promise.all([
			s.host.admin.act("/overview", "bulk_all", { user: admin(s), value: first }),
			s.host.admin.act("/overview", "bulk_all", { user: admin(s), value: second }),
		]);
		const toasts = [a.toast?.message, b.toast?.message].join(" | ");
		console.info(`two presses: ${toasts}`);
		const run = await s.host.inspect.kv.get<{ id: string; total: number }>(
			`state:bulk:${admin(s).id}`,
		);
		const lanes = (await s.host.inspect.kv.list()).filter((e) =>
			e.id.startsWith(`state:bulk:${admin(s).id}:`),
		);
		// Exactly one run stored, and its lane is the one the run record names.
		expect(lanes.map((l) => l.id)).toEqual([`state:bulk:${admin(s).id}:${run!.id}:0`]);
		expect(toasts).toContain("Another decision of yours started at the same time");
	});

	// kvList storageGetMany (the button carries the list: no query), schemaListCollections, the
	// pages, storagePutMany, then the list.
	it("Approve and publish all 4: decided at once, within the limit", async () => {
		const s = await site();
		for (let i = 0; i < 4; i++) await waiting(s, `Page ${i + 1}`);
		const list = await s.host.admin.loadPage("/overview", { user: admin(s) });
		const value = allButtonValue(list);
		await cold(s);
		const { route } = await measureWithDeferredAll(() =>
			s.host.admin.act("/overview", "bulk_all", { user: admin(s), value }),
		);
		console.info(describeCalls("bulk all 4", route));
		expect(route.calls.length).toBeLessThanOrEqual(NEW_BUDGET);
		expect(text(route.result)).toContain("Approved 4 of 4 pages.");
	});

	// kvList, then approve(): storageGetVersioned contentGetVersioned contentGetRevision
	// schemaGetCollection storageCompareAndSet storagePut contentPublish, then the list.
	it("Approve and publish from a row: within the limit", async () => {
		const s = await site();
		for (let i = 0; i < 3; i++) await waiting(s, `Page ${i + 1}`);
		const list = await s.host.admin.loadPage("/overview", { user: admin(s) });
		const value = rowButtonValue(list);
		await cold(s);
		const { route } = await measureWithDeferredAll(() =>
			s.host.admin.act("/overview", "row_approve", { user: admin(s), value }),
		);
		console.info(describeCalls("row approve and publish", route));
		expect(route.calls.length).toBeLessThanOrEqual(NEW_BUDGET);
		expect(route.result).toMatchObject({ toast: { type: "success" } });
	});

	it(
		"approves and publishes 50 selected in background runs, each within the limit, each approved once",
		{ timeout: 600_000 },
		async () => {
			const s = await site();
			const ids: string[] = [];
			for (let i = 0; i < 50; i++) ids.push(await waiting(s, `Page ${i + 1}`));
			await decideAll(s);
			const counts = await runLanes(s);
			console.info(
				`bulk approve and publish, 50 selected: ${counts.length} runs: ${counts.join(" ")}`,
			);
			await drain();
			for (const id of ids) {
				const stored = await request(s, id);
				expect(stored?.status, id).toBe("published");
				expect(stored?.history.filter((h) => h.text === "Ellen Marsh approved")).toHaveLength(1);
				expect(stored?.history[0]?.text).toBe("Published by Ellen Marsh");
				expect((await s.host.inspect.content.get("pages", id))?.status).toBe("published");
			}
			const list = text(await s.host.admin.loadPage("/overview", { user: admin(s) }));
			expect(list).toContain("Approved 50 of 50 pages.");
		},
	);

	it(
		"the same 50 through EmDash's own scheduler: all done, each approved once",
		{ timeout: 600_000 },
		async () => {
			const s = await site();
			const ids: string[] = [];
			for (let i = 0; i < 50; i++) ids.push(await waiting(s, `Page ${i + 1}`));
			await decideAll(s);
			for (let tick = 0; tick < 60; tick++) {
				await drain();
				s.host.scheduled.setTime(new Date(Date.now() + 60_000));
				const { processed } = await s.host.scheduled.run();
				if (processed === 0) break;
			}
			await drain();
			for (const id of ids) {
				const stored = await request(s, id);
				expect(stored?.status, id).toBe("published");
				expect(stored?.history.filter((h) => h.text === "Ellen Marsh approved")).toHaveLength(1);
			}
		},
	);

	it(
		"sends back 50 selected in background runs, each within the limit",
		{ timeout: 600_000 },
		async () => {
			const s = await site();
			const ids: string[] = [];
			for (let i = 0; i < 50; i++) ids.push(await waiting(s, `Page ${i + 1}`));
			await decideAll(s, "send_back");
			const counts = await runLanes(s);
			console.info(`bulk send back, 50 selected: ${counts.length} runs: ${counts.join(" ")}`);
			for (const id of ids) expect((await request(s, id))?.status).toBe("sent_back");
		},
	);

	// The list drawn again: kvList storageQuery schemaListCollections userList.
	it("Back to the list, Continue with nothing ticked, and Send back without a note", async () => {
		const s = await site();
		for (let i = 0; i < 25; i++) await waiting(s, `Page ${i + 1}`);
		await chooseAll(s);
		const counts: Record<string, number> = {};
		const run = async (label: string, invoke: () => Promise<unknown>) => {
			await cold(s);
			const m = await measure(invoke);
			console.info(describeCalls(label, m));
			expect(m.error).toBeUndefined();
			counts[label] = m.calls.length;
		};
		await run("bulk back to the list", () =>
			s.host.admin.act("/overview", "bulk_back", { user: admin(s) }),
		);
		await run("bulk continue, nothing ticked", () =>
			s.host.admin.submit("/overview", "bulk_review", { pick: [] }, { user: admin(s) }),
		);
		const value = await goValue(s, "send_back");
		await run("bulk send back without a note", () =>
			s.host.admin.act("/overview", "bulk_go", { user: admin(s), value }),
		);
		expect(counts).toEqual({
			"bulk back to the list": 4,
			"bulk continue, nothing ticked": 4,
			"bulk send back without a note": 4,
		});
	});

	// kvList kvSet (the run marked stopped), then the list with the KV read again: kvList storageQuery
	// schemaListCollections userList. A lane's next turn: kvList kvSet. Dismiss: kvList, kvDelete
	// per lane and the run, then the list.
	it("Stop, a lane's turn after it, and Dismiss", async () => {
		const s = await site();
		for (let i = 0; i < 10; i++) await waiting(s, `Page ${i + 1}`);
		await decideAll(s);
		await drain();
		await cold(s);
		const stop = await measure(() =>
			s.host.admin.act("/overview", "bulk_stop", { user: admin(s) }),
		);
		console.info(describeCalls("bulk stop", stop));
		// The list after it reads the text copies of the pages decided during the press.
		expect(stop.calls.length).toBe(7);
		const lanes = await runLanes(s);
		expect(lanes.every((n) => n === 2)).toBe(true);
		await cold(s);
		const dismiss = await measure(() =>
			s.host.admin.act("/overview", "bulk_dismiss", { user: admin(s) }),
		);
		console.info(describeCalls("bulk dismiss", dismiss));
		expect(dismiss.calls.length).toBeLessThanOrEqual(NEW_BUDGET);
		for (const id of ["Page 1"]) expect(id).toBeTruthy();
	});

	// The run's write of its lane fails after it decided its rows: EmDash runs the task again,
	// which counts those rows as done (decided by this person at that version) and goes on.
	it("a run that fails part-way is run again: nothing decided twice, nothing lost", async () => {
		const s = await site();
		const ids: string[] = [];
		for (let i = 0; i < 12; i++) ids.push(await waiting(s, `Page ${i + 1}`));
		await decideAll(s);
		await drain();
		const user = admin(s);
		const run = await s.host.inspect.kv.get<{ id: string }>(`state:bulk:${user.id}`);
		const event = {
			name: `bulk-${user.id}-${run!.id}-0-0`,
			data: { user: user.id, run: run!.id, lane: 0, seq: 0 },
			scheduledAt: new Date().toISOString(),
		};
		failTimes.set("kvSet", 1);
		await s.host.transport.invokeHook("cron", event).catch(() => undefined);
		await drain();
		await cold(s);
		const again = await measure(async () => {
			const out = await s.host.transport.invokeHook("cron", event);
			await drain();
			return out;
		});
		console.info(describeCalls("bulk run again after a failed write", again));
		expect(again.error).toBeUndefined();
		const counts = await runLanes(s);
		expect(counts.every((n) => n <= NEW_BUDGET)).toBe(true);
		for (const id of ids) {
			const stored = await request(s, id);
			expect(stored?.status).toBe("published");
			expect(stored?.history.filter((h) => h.text === "Ellen Marsh approved")).toHaveLength(1);
		}
		const list = text(await s.host.admin.loadPage("/overview", { user: admin(s) }));
		expect(list).toContain("Approved 12 of 12 pages.");
	});

	// A task run again after its lane was written: kvList, then the next task set (cronSchedule).
	it("a task run again after its lane was written only sets the next task", async () => {
		const s = await site();
		for (let i = 0; i < 12; i++) await waiting(s, `Page ${i + 1}`);
		await decideAll(s);
		await drain();
		const user = admin(s);
		const run = await s.host.inspect.kv.get<{ id: string }>(`state:bulk:${user.id}`);
		const event = {
			name: `bulk-${user.id}-${run!.id}-0-0`,
			data: { user: user.id, run: run!.id, lane: 0, seq: 0 },
			scheduledAt: new Date().toISOString(),
		};
		await s.host.transport.invokeHook("cron", event);
		await drain();
		await cold(s);
		const m = await measure(() => s.host.transport.invokeHook("cron", event));
		console.info(describeCalls("bulk task run again", m));
		expect(m.calls).toEqual(["kvList", "cronSchedule"]);
	});

	/** The Admin's run and its lane 0, as stored. */
	async function laneOf(s: Site) {
		const user = admin(s);
		const run = await s.host.inspect.kv.get<{ id: string }>(`state:bulk:${user.id}`);
		const lane = await s.host.inspect.kv.get<LaneState>(`state:bulk:${user.id}:${run!.id}:0`);
		return { run: run!, lane: lane! };
	}

	async function turn(s: Site, runId: string, seq: number) {
		const user = admin(s);
		return s.host.transport.invokeHook("cron", {
			name: `bulk-${user.id}-${runId}-0-${seq}`,
			data: { user: user.id, run: runId, lane: 0, seq },
			scheduledAt: new Date().toISOString(),
		});
	}

	// Audit 2: a stopped run's turn still in flight writes only its own lane.
	it("a stopped run's late turn does not touch the next run", async () => {
		const s = await site();
		const ids: string[] = [];
		for (let i = 0; i < 12; i++) ids.push(await waiting(s, `Page ${i + 1}`));
		await decideAll(s);
		await drain();
		const first = await laneOf(s);
		await s.host.admin.act("/overview", "bulk_stop", { user: admin(s) });
		await decideAll(s);
		await drain();
		const second = await laneOf(s);
		expect(second.run.id).not.toBe(first.run.id);
		// Run A's turn, in flight when it was stopped, ends now.
		await turn(s, first.run.id, 0);
		await drain();
		await runLanes(s);
		await drain();
		for (const id of ids) expect((await request(s, id))?.status).toBe("published");
		const list = text(await s.host.admin.loadPage("/overview", { user: admin(s) }));
		expect(list).toMatch(/Approved (\d+) of \1 pages\./);
	});

	// Audit 3: a row that throws is recorded and the press goes on.
	for (const call of ["storageUpdateIf", "contentGetVersioned"]) {
		it(`a row whose ${call} fails is recorded, and the rest are decided, copied and emailed`, async () => {
			const s = await site();
			for (let i = 0; i < 4; i++) await waiting(s, `Page ${i + 1}`);
			await chooseAll(s);
			failTimes.set(call, 1);
			await cold(s);
			const m = await measure(() => press(s));
			expect(m.error).toBeUndefined();
			await drain();
			expect(text(m.result)).toContain(
				"Could not be decided just now. Try it again from the list.",
			);
			expect(text(m.result)).toContain("Approved 3 of 4 pages. 1 need a look");
			const copies = await s.host.inspect.storage.list("versions");
			expect(copies).toHaveLength(3);
		});
	}

	// Audit 4: a failed read of the person is retried, not taken as "can't approve".
	it("a failed read of the person fails the turn so EmDash runs it again", async () => {
		const s = await site();
		for (let i = 0; i < 12; i++) await waiting(s, `Page ${i + 1}`);
		await decideAll(s);
		await drain();
		const before = (await laneOf(s)).lane;
		failTimes.set("userGet", 1);
		await turn(s, before.run, 0).catch(() => undefined);
		const { lane } = await laneOf(s);
		expect(lane.seq).toBe(0);
		expect(lane.results).toEqual(before.results);
		expect(lane.rows).toEqual(before.rows);
	});

	// Audit 5: an approval carried over from earlier is not this run's.
	it("does not count an earlier approval at the same version as this run's", async () => {
		const s = await site();
		const id = await waiting(s);
		await waiting(s, "Bake sale");
		await chooseAll(s);
		const stored = await request(s, id);
		await s.host.fixtures.plugin.storage("requests", `pages:${id}`, {
			...stored,
			status: "closed",
			withdrawn: { by: { id: s.editor.id, name: "Sam Reyes" }, at: new Date().toISOString() },
			approval: {
				by: { id: admin(s).id, name: "Ellen Marsh" },
				at: "2026-01-01T00:00:00.000Z",
				fingerprint: stored!.fingerprint,
				versionId: "",
			},
		});
		const pressed = await press(s);
		expect(text(pressed)).toContain("This request has already been decided.");
	});

	// Audit 6: expired runs and stale selections are deleted when the page opens.
	it("deletes a run kept past its time and a stale selection when the page opens", async () => {
		const s = await site();
		const user = admin(s);
		const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
		await s.host.fixtures.plugin.kv(`state:bulk:${user.id}`, {
			id: "old",
			do: "publish",
			reason: "",
			total: 1,
			lanes: 1,
			at: old,
		});
		await s.host.fixtures.plugin.kv(`state:bulk:${user.id}:old:0`, {
			run: "old",
			seq: 1,
			rows: [],
			results: [{ key: "pages:x", title: "X", state: "done", text: "Approved." }],
			endedAt: old,
		});
		await s.host.fixtures.plugin.kv(`state:bulk-pick:${user.id}`, {
			do: "publish",
			reason: "",
			rows: [],
			at: old,
		});
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user }));
		console.info(describeCalls("page load, expired run and stale selection", m));
		expect(m.calls.length).toBeLessThanOrEqual(NEW_BUDGET);
		const keys = (await s.host.inspect.kv.list()).map((e) => e.id);
		expect(keys.filter((k) => k.startsWith("state:"))).toEqual([]);
	});

	// Audit 7: task names carry the person, so two approvers' runs never share one.
	it("names each run's tasks with the person", async () => {
		const s = await site();
		for (let i = 0; i < 12; i++) await waiting(s, `Page ${i + 1}`);
		await decideAll(s);
		const names = (await s.host.inspect.scheduledTasks()).map((t) => String(t.name));
		expect(names.some((n) => n.startsWith(`bulk-${admin(s).id}-`))).toBe(true);
		expect(names.every((n) => n.length <= 128)).toBe(true);
	});

	// Audit 8: the worst cases.
	it("require checks: each turn within the limit", async () => {
		const s = await site({ config: { ...HELD, checks: "require" } });
		for (let i = 0; i < 10; i++) await waiting(s, `Page ${i + 1}`);
		await decideAll(s);
		const counts = await runLanes(s);
		console.info(`bulk require checks, 10 selected: ${counts.join(" ")}`);
	});

	it("send back of 20 stored as Untitled: each turn within the limit, each named", async () => {
		const s = await site();
		const ids: string[] = [];
		for (let i = 0; i < 20; i++) ids.push(await waiting(s, `Page ${i + 1}`));
		for (const id of ids)
			await s.host.fixtures.plugin.storage("requests", `pages:${id}`, {
				...(await request(s, id)),
				title: "Untitled",
			});
		await decideAll(s, "send_back");
		const counts = await runLanes(s);
		console.info(`bulk send back, 20 Untitled: ${counts.join(" ")}`);
		for (const id of ids) {
			const stored = await request(s, id);
			expect(stored?.status).toBe("sent_back");
			expect(stored?.title).not.toBe("Untitled");
		}
	});

	it(
		"200 waiting, all chosen: the confirm step, the press and every turn within the limit",
		{ timeout: 900_000 },
		async () => {
			const s = await site();
			for (let i = 0; i < 200; i++) await waiting(s, `Page ${i + 1}`);
			await cold(s);
			const confirm = await measure(() => chooseAll(s));
			console.info(describeCalls("bulk confirm, 200 selected", confirm));
			expect(confirm.calls.length).toBeLessThanOrEqual(NEW_BUDGET);
			await cold(s);
			const value = await goValue(s);
			const go = await measure(() =>
				s.host.admin.act("/overview", "bulk_go", { user: admin(s), value }),
			);
			console.info(describeCalls("bulk press, 200 selected", go));
			expect(splitDeferred(go.calls).own.length).toBeLessThanOrEqual(NEW_BUDGET);
			const counts = await runLanes(s);
			console.info(
				`bulk approve and publish, 200 selected: ${counts.length} turns, max ${Math.max(...counts)}`,
			);
			expect(Math.max(...counts)).toBeLessThanOrEqual(NEW_BUDGET);
			await drain();
			const run = await s.host.inspect.kv.get<{ total: number }>(`state:bulk:${admin(s).id}`);
			// The list reads one page of requests: EmDash caps a storage query at 100 (the plugin
			// asks for 200), so "All waiting for you" holds the 100 most recently changed.
			console.info(`bulk 200: run total ${run?.total}`);
			expect(run?.total).toBe(100);
			const published = (await s.host.inspect.storage.list<ApprovalRequest>("requests")).filter(
				(r) => r.data.status === "published",
			);
			expect(published).toHaveLength(run!.total);
		},
	);

	it("approve and publish fails for one page: approved, not live, and said so", async () => {
		const s = await site();
		for (let i = 0; i < 2; i++) await waiting(s, `Page ${i + 1}`);
		await chooseAll(s);
		failTimes.set("contentPublish", 1);
		const list = text(await press(s));
		expect(list).toContain("Approved, not live yet: press Publish on the page.");
		expect(list).not.toContain("Not done: Approved");
	});
});

describe("MCP tools for a reviewer that is an AI tool", () => {
	const AI_ON = { ...HELD, aiApprove: true };

	// kvList storageGet contentGet contentGetRevision schemaGetCollection.
	it("changes: a waiting page", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() => tool(s, "mcp/changes", admin(s), { collection: "pages", id }));
		pinMcp("mcp changes", m, 5);
	});

	// kvList, then approve(): storageGetVersioned contentGetVersioned contentGetRevision
	// schemaGetCollection storageCompareAndSet storagePut contentPublish; "Published by" and the
	// writer's email follow in content:afterPublish.
	it("approve: approves and publishes", async () => {
		const s = await site({ config: AI_ON });
		const id = await waiting(s);
		const version = (await request(s, id))!.fingerprint;
		await cold(s);
		const m = await measureWithDeferred(() =>
			tool(s, "mcp/approve", admin(s), { collection: "pages", id, version }),
		);
		pinMcp("mcp approve and publish", m.route as Measured<Response>, 8);
		expectDeferredAfterPublish(m);
		expect((await request(s, id))?.status).toBe("published");
	});

	// kvList: refused before anything else is read.
	it("approve: refused while AI approval is off", async () => {
		const s = await site();
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() => tool(s, "mcp/approve", admin(s), { collection: "pages", id }));
		pinMcp("mcp approve, AI approval off", m, 1);
	});

	// kvList storageGetVersioned storageCompareAndSet cronSchedule (the writer's email).
	it("send_back", async () => {
		const s = await site({ config: AI_ON });
		const id = await waiting(s);
		await cold(s);
		const m = await measure(() =>
			tool(s, "mcp/send-back", admin(s), { collection: "pages", id, reason: "Prices" }),
		);
		pinMcp("mcp send back", m, 4);
	});

	// As editor/ask: kvList schemaGetCollection storageGet contentGet contentGetRevision storagePut
	// cronSchedule userList.
	it("ask_approval", async () => {
		const s = await site();
		const id = await page(s);
		await cold(s);
		const m = await measure(() => tool(s, "mcp/ask", s.editor, { collection: "pages", id }));
		pinMcp("mcp ask", m, 8);
	});
});

describe("requests stored as Untitled by an earlier release, named where they are read", () => {
	async function untitled(s: Site, count: number): Promise<string[]> {
		const ids: string[] = [];
		for (let i = 0; i < count; i++) ids.push(await waiting(s, `Page ${i + 1}`));
		for (const id of ids)
			await s.host.fixtures.plugin.storage("requests", `pages:${id}`, {
				...(await request(s, id)),
				title: "Untitled",
			});
		return ids;
	}

	// kvList storageQuery, + schemaListCollections and one contentGet per row shown (5 at most).
	it("dashboard widget, 6 stored as Untitled", async () => {
		const s = await site();
		await untitled(s, 6);
		await cold(s);
		const m = await measure(() => s.host.admin.loadWidget("approvals", { user: admin(s) }));
		pin("widget, 6 stored as Untitled", m, 8);
		expect(text(m.result)).not.toContain("Untitled");
	});

	// kvList storageQuery schemaListCollections, + one contentGet per row (10 at most).
	it("MCP queue, 12 stored as Untitled", async () => {
		const s = await site();
		await untitled(s, 12);
		await cold(s);
		const m = await measure(() => tool(s, "mcp/queue", admin(s)));
		pinMcp("mcp queue, 12 stored as Untitled", m, 13);
	});

	// The held-again path (4), + schemaGetCollection and the request written with its name.
	it("Publish pressed again on a request stored as Untitled", async () => {
		const s = await site();
		const [id] = await untitled(s, 1);
		await cold(s);
		const m = await measure(() => s.host.actions.content.publish("pages", id!, actor(s.editor)));
		pin("beforePublish, held again, stored as Untitled", m, 6);
		expect((await request(s, id!))?.title).toBe("Page 1");
	});

	// Send back (page): + contentGet schemaGetCollection for the writer's email.
	it("send back from the page, stored as Untitled", async () => {
		const s = await site();
		const [id] = await untitled(s, 1);
		await cold(s);
		const m = await measure(() =>
			s.host.admin.submit(
				"/overview",
				"send_back",
				{ note: "Prices" },
				{ user: admin(s), blockId: `sb:pages:${id}` },
			),
		);
		console.info(describeCalls("page send back, stored as Untitled", m));
		expect(m.calls.length).toBeLessThanOrEqual(NEW_BUDGET);
		expect((await request(s, id!))?.title).toBe("Page 1");
	});
});
