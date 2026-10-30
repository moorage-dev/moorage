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
	for (const name of ["emailSend", "contentPublish", "storagePut", "cronSchedule"]) {
		const original = proto[name]!;
		proto[name] = function (this: unknown, ...args: unknown[]) {
			const times = failTimes.get(name) ?? 0;
			if (times > 0) failTimes.set(name, times - 1);
			if (failing.has(name) || times > 0) return Promise.reject(new Error(`${name} failed (test)`));
			return original.apply(this, args);
		};
	}
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
		pin("beforePublish, held, new request (action)", m, 6);
		expect(m.result?.success).toBe(false);
		expect((await request(s, id))?.status).toBe("waiting");
	});

	it("costs the same measured through the hook directly", async () => {
		const s = await site();
		const id = await page(s);
		await cold(s);
		const event = await policyEvent(s, id, s.editor);
		const m = await measure(() => s.host.transport.invokeHook("content:beforePublish", event));
		pin("beforePublish, held, new request (hook)", m, 6);
		expect(text(m.result)).toContain("Sent for approval");
	});

	it("holds an editor's publish on a site migrated from 0.1.5 (settings in the old key)", async () => {
		const s = await site();
		const id = await page(s);
		await toLegacy(s);
		await cold(s);
		const m = await measure(() => s.host.actions.content.publish("pages", id, actor(s.editor)));
		pin("beforePublish, held, new request, migrated settings", m, 6);
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
		pin("beforePublish, held, AI tool", m, 6);
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
		pin("beforePublish, scheduled run held", m, 4);
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
		pin("beforeSchedule, admin cleared, migrated settings", m, 4);
		expect((await request(s, id))?.status).toBe("approved");
	});

	it("holds an editor's Schedule", async () => {
		const s = await site();
		const id = await page(s);
		await cold(s);
		const at = new Date(Date.now() + 3_600_000).toISOString();
		const event = await policyEvent(s, id, s.editor, "api", "pages", { scheduledAt: at });
		const m = await measure(() => s.host.transport.invokeHook("content:beforeSchedule", event));
		pin("beforeSchedule, editor held", m, 6);
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
});

describe("the Approvals page (route admin)", () => {
	it("opens on Settings for an admin before anything is saved", async () => {
		const s = await site({ settings: "none" });
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		pin("page load, admin, settings never saved", m, 4);
		expect(text(m.result)).toContain("Approval is off until you save these settings");
	});

	it("opens for an admin on a migrated site with nothing waiting, copying the settings forward", async () => {
		const s = await site({ settings: "legacy" });
		await cold(s);
		const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
		pin("page load, admin, migrated settings, nothing waiting", m, 5);
		expect(text(m.result)).toContain("For you to approve");
		expect(await s.host.inspect.setting("config")).toMatchObject({ collections: ["pages"] });
	});

	// kvList storageQuery schemaListCollections userList, however many pages wait: each row's
	// "things to check" is noted on the request when the page is held or saved.
	for (const count of [1, 2, 25]) {
		it(`lists ${count} waiting page(s) for an admin`, async () => {
			const s = await site();
			for (let i = 0; i < count; i++) await waiting(s, `Page ${i + 1}`);
			await cold(s);
			const m = await measure(() => s.host.admin.loadPage("/overview", { user: admin(s) }));
			pin(`page load, admin, ${count} waiting`, m, 4);
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
		// + storageGetMany for the approved text copies.
		pin("page load, admin, 1 waiting + 1 approved", m, 5);
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
		pin("save settings, first time", m, 6);
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
		pin("save settings, 3 waiting", m, 6);
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
		// kvList storageGet contentGet contentGetRevision schemaGetCollection storagePut (text
		// copy) storagePut cronSchedule (the writer's email).
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
		// kvList storageGet contentGetVersioned contentGetRevision schemaGetCollection
		// storagePut storagePut contentPublish; the emails and "Published by" follow in
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
		// kvList storageGet storagePut cronSchedule, then the list (4).
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
