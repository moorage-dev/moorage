// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { Config, Delivery, KnownForm } from "../src/types.js";

const PAGE = "/enquiries";
const ORIGIN = "https://crumb.test";
const DEFINITION = `${ORIGIN}/_emdash/api/plugins/emdash-forms/definition`;
const HOOK = "https://hooks.zapier.com/hooks/catch/123/abc/";
const HUBSPOT =
	"https://api.hsforms.com/submissions/v3/integration/submit/4410287/9f1c2b3a-1111-2222-3333-444455556666";
const EMBED = 'portalId: "4410287", formId: "9f1c2b3a-1111-2222-3333-444455556666"';

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Admin = Awaited<ReturnType<PluginRuntimeTestHost["fixtures"]["user"]>>;

async function start(url = ORIGIN) {
	host = await createPluginRuntimeTestHost({ site: { name: "Crumb & Co.", url, locale: "en" } });
	const admin = await host.fixtures.user({
		email: "anna@crumb.test",
		name: "Anna Baker",
		role: "admin",
	});
	await host.admin.loadPage(PAGE, { user: admin });
	return { runtime: host, admin };
}

async function config(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.kv.get<Config>("config"))!;
}

function payload(id: string, data: Record<string, unknown> = {}) {
	return {
		event: "form.submission",
		formId: "contact",
		formName: "Contact us",
		submissionId: id,
		data: { name: "Tom Reyes", email: "tom@example.com", message: "Hello", ...data },
		files: [],
		submittedAt: new Date().toISOString(),
	};
}

async function inbound(runtime: PluginRuntimeTestHost, body: unknown, key?: string) {
	const k = key ?? (await config(runtime)).key;
	return runtime.actions.routes.request("inbound", {
		method: "POST",
		url: `${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${k}`,
		body,
	});
}

async function addPlace(
	runtime: PluginRuntimeTestHost,
	admin: Admin,
	values: Record<string, unknown>,
) {
	return runtime.admin.submit(
		PAGE,
		"save_place",
		{ forms: ["all"], on: true, no_duplicates: false, name: "", ...values },
		{ user: admin, blockId: "place:new" },
	);
}

async function rows(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.storage.list<Delivery>("deliveries")).map((r) => r.data);
}

function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) => {
		if (block.type === "tab") return [block, ...block.panels.flatMap((p) => flatten(p.blocks))];
		if (block.type === "accordion") return [block, ...flatten(block.blocks)];
		return [block];
	});
}

const text = (response: BlockResponse) => JSON.stringify(response.blocks);

describe("receiving an enquiry straight from a form", () => {
	it("refuses a wrong key and anything that is not an enquiry", async () => {
		const { runtime } = await start();
		const wrong = await inbound(runtime, payload("01A"), "x".repeat(32));
		expect(wrong.status).toBe(401);
		expect(await wrong.text()).toContain("Copy the address again");
		const junk = await inbound(runtime, { hello: "world" });
		expect(junk.status).toBe(400);
	});

	it("delivers to another app, signed, and only once however often it is sent", async () => {
		const { runtime, admin } = await start();
		await addPlace(runtime, admin, { kind: "app", app: "zapier", url: HOOK });
		await runtime.http.respond(HOOK, new Response("ok", { status: 200 }));

		const first = await inbound(runtime, payload("01A"));
		expect(first.status).toBe(200);
		expect(await first.text()).toBe("Received.");
		const again = await inbound(runtime, payload("01A"));
		expect(await again.text()).toBe("Already received.");

		const sent = runtime.http.requests().filter((r) => r.url === HOOK);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.headers["webhook-id"]).toBe("01A");
		expect(sent[0]!.headers["webhook-signature"]).toMatch(/^v1,/);
		expect(JSON.parse(new TextDecoder().decode(sent[0]!.body))).toMatchObject({
			form: "contact",
			email: "tom@example.com",
			fields: { message: "Hello" },
		});
		expect((await rows(runtime)).map((r) => r.status)).toEqual(["delivered"]);
		// Once every place has it, the contents go.
		const [stored] = await runtime.inspect.storage.list<{ fields: unknown[]; cleared: boolean }>(
			"enquiries",
		);
		expect(stored?.data).toMatchObject({ fields: [], cleared: true });
		expect(JSON.stringify(stored)).not.toContain("tom@example.com");
		// The form is now known as connected.
		const forms = await runtime.inspect.kv.get<Record<string, KnownForm>>("forms");
		expect(forms?.contact?.lastAt).toBeTruthy();
	});

	it("stops after a reset of the private address", async () => {
		const { runtime, admin } = await start();
		const old = (await config(runtime)).key;
		await runtime.admin.act(PAGE, "reset_address", { user: admin });
		expect((await config(runtime)).key).not.toBe(old);
		expect((await inbound(runtime, payload("01B"), old)).status).toBe(401);
	});
});

describe("delivery problems", () => {
	it("shows a refused HubSpot enquiry in red, says what to fix, and alerts once a day", async () => {
		const { runtime, admin } = await start();
		await addPlace(runtime, admin, { kind: "hubspot", hubspot: EMBED });
		await runtime.admin.submit(
			PAGE,
			"save_alerts",
			{ alert_to: "anna@crumb.test, sam@pixel.dev" },
			{ user: admin },
		);
		const refusal = () =>
			new Response(
				JSON.stringify({
					errors: [
						{
							errorType: "FIELD_NOT_IN_FORM_DEFINITION",
							message: 'Property "message" does not exist',
						},
					],
				}),
				{ status: 400 },
			);
		await runtime.http.respond(HUBSPOT, refusal());
		await runtime.http.respond(HUBSPOT, refusal());
		await inbound(runtime, payload("01C"));
		await inbound(runtime, payload("01D", { email: "priya@example.com" }));

		expect((await rows(runtime)).map((r) => r.status)).toEqual(["fixing", "fixing"]);
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		const banner = flatten(page.blocks).find((b) => b.type === "banner");
		expect(banner).toMatchObject({
			variant: "error",
			title: "2 enquiries could not reach HubSpot",
		});
		expect(text(page)).toContain("does not have the field message");
		expect(text(page)).toContain("Send again");

		const alerts = (await runtime.inspect.email()) as Array<{
			message?: { to: string; cc?: string[]; subject: string };
		}>;
		const sent = alerts.map(
			(a) => a.message ?? (a as unknown as { to: string; cc?: string[]; subject: string }),
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: "anna@crumb.test", cc: ["sam@pixel.dev"] });
		expect(sent[0]!.subject).toBe("Crumb & Co.: an enquiry could not be delivered");
	});

	it("tries again when an app does not answer, three at a time", async () => {
		const { runtime, admin } = await start();
		for (let i = 0; i < 4; i++) {
			await addPlace(runtime, admin, {
				kind: "app",
				app: "make",
				url: `${HOOK}${i}`,
				name: `App ${i}`,
			});
		}
		// The first three are tried at once.
		for (let i = 0; i < 3; i++)
			await runtime.http.respond(`${HOOK}${i}`, new Response("", { status: 503 }));
		await inbound(runtime, payload("01E"));
		const waiting = await rows(runtime);
		// Three tried at once, the fourth waits for the scheduled run.
		expect(waiting.map((r) => [r.status, r.attempts]).sort()).toEqual([
			["retrying", 0],
			["retrying", 1],
			["retrying", 1],
			["retrying", 1],
		]);
		const tried = waiting.find((r) => r.attempts === 1)!;
		const wait = Date.parse(tried.nextAt) - Date.parse(tried.createdAt);
		expect(wait).toBeGreaterThan(55_000);
		expect(wait).toBeLessThan(120_000);

		// Make every try due now, then one scheduled run delivers three.
		const past = new Date(Date.now() - 1000).toISOString();
		for (const item of await runtime.inspect.storage.list<Delivery>("deliveries")) {
			await runtime.fixtures.plugin.storage("deliveries", item.id, { ...item.data, nextAt: past });
		}
		for (let i = 0; i < 4; i++) await runtime.http.respond(`${HOOK}${i}`, new Response("ok"));
		const before = runtime.http.requests().length;
		await runtime.transport.invokeHook("cron", { name: "deliver", data: null });
		// One run sends three; the fourth goes in the next run.
		expect(runtime.http.requests().length - before).toBe(3);
		const after = (await rows(runtime)).map((r) => r.status).sort();
		expect(after).toEqual(["delivered", "delivered", "delivered", "retrying"]);
	});

	it("sends again from the log", async () => {
		const { runtime, admin } = await start();
		await addPlace(runtime, admin, { kind: "app", app: "n8n", url: HOOK });
		await runtime.http.respond(HOOK, new Response("gone", { status: 404 }));
		await inbound(runtime, payload("01F"));
		const [row] = await runtime.inspect.storage.list<Delivery>("deliveries");
		expect(row?.data.status).toBe("fixing");
		await runtime.http.respond(HOOK, new Response("ok"));
		const response = await runtime.admin.act(PAGE, "send_again", { user: admin, value: row!.id });
		expect(response.toast).toEqual({
			type: "success",
			message: "Sent again. n8n accepted Tom Reyes's enquiry.",
		});
	});

	it("does not send the same person twice within 24 hours when asked, and flags repeats", async () => {
		const { runtime, admin } = await start();
		await addPlace(runtime, admin, { kind: "app", app: "zapier", url: HOOK, no_duplicates: true });
		await runtime.http.respond(HOOK, new Response("ok"));
		await inbound(runtime, payload("01G"));
		await inbound(runtime, payload("01H"));
		const list = (await rows(runtime)).sort((a, b) => a.enquiryId.localeCompare(b.enquiryId));
		expect(list.map((r) => r.status)).toEqual(["delivered", "skipped"]);
		expect(list[1]!.notes).toEqual(["Same address yesterday", "Same person within 24 hours"]);
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(text(page)).toContain("Not sent");
	});
});

describe("the email way", () => {
	it("takes the enquiry from the form's email to the private address and cancels that email", async () => {
		const { runtime, admin } = await start();
		await addPlace(runtime, admin, { kind: "email", to: "orders@crumb.test" });
		const key = (await config(runtime)).key;
		const result = await runtime.transport.invokeHook("email:beforeSend", {
			source: "emdash-forms",
			message: {
				to: `enquiries-${key}@lead-delivery.invalid`,
				subject: "New submission: Contact us",
				text: 'New submission for "Contact us"\n\nYour name: Tom Reyes\nEmail: tom@example.com\nMessage: Hello\n\nSubmitted at: 2026-10-16T09:00:00.000Z',
			},
		});
		expect(result).toBe(false);
		expect((await rows(runtime)).map((r) => [r.status, r.formId])).toEqual([
			["retrying", "contact-us"],
		]);

		await runtime.transport.invokeHook("cron", { name: "deliver", data: null });
		expect((await rows(runtime)).map((r) => r.status)).toEqual(["delivered"]);
		const emails = JSON.stringify(await runtime.inspect.email());
		expect(emails).toContain("orders@crumb.test");
		expect(emails).toContain("Crumb & Co.: new enquiry from Tom Reyes (Contact us)");
		expect(emails).toContain("Your name: Tom Reyes");
	});

	it("leaves every other email alone and never delivers to the private domain", async () => {
		const { runtime } = await start();
		const message = { to: "anna@crumb.test", subject: "Hi", text: "Hello" };
		expect(
			await runtime.transport.invokeHook("email:beforeSend", { source: "emdash-forms", message }),
		).toEqual(message);
		const stray = await runtime.transport.invokeHook("email:beforeSend", {
			source: "someone-else",
			message: {
				...message,
				to: "enquiries-old@lead-delivery.invalid",
				subject: "New submission: X",
			},
		});
		expect(stray).toBe(false);
		expect(await rows(runtime)).toEqual([]);
	});
});

describe("connecting forms", () => {
	it("adds a form by its short name, with its fields from the form's own definition", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(
			DEFINITION,
			Response.json({
				data: {
					name: "Wedding cakes",
					slug: "wedding-cakes",
					status: "active",
					pages: [
						{
							fields: [
								{
									id: "a",
									name: "name",
									label: "Your name",
									type: "text",
									required: true,
									width: "full",
								},
								{
									id: "b",
									name: "email",
									label: "Email address",
									type: "email",
									required: true,
									width: "full",
								},
							],
						},
					],
				},
			}),
		);
		const added = await runtime.admin.submit(
			PAGE,
			"add_form",
			{ short_name: "wedding-cakes" },
			{ user: admin },
		);
		expect(added.toast).toEqual({
			type: "success",
			message: "Added Wedding cakes. Found 2 fields.",
		});
		expect(text(added)).toContain("Wedding cakes (wedding-cakes) · 2 fields · no enquiry yet");
		expect(text(added)).toContain("Waiting");

		// Matching works before the first enquiry.
		const saved = await addPlace(runtime, admin, { kind: "hubspot", hubspot: EMBED });
		expect(text(saved)).toContain("Wedding cakes: 2 of 2 fields matched");
	});

	it("refuses a short name the forms plugin does not know, and calmly keeps one it cannot check", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(DEFINITION, Response.json({ success: false }, { status: 404 }));
		const missing = await runtime.admin.submit(
			PAGE,
			"add_form",
			{ short_name: "contactt" },
			{ user: admin },
		);
		expect(missing.toast).toEqual({
			type: "error",
			message:
				'There is no form with the short name "contactt". Check the Slug column under Forms.',
		});
		await runtime.http.respond(DEFINITION, new Response("", { status: 502 }));
		const unknown = await runtime.admin.submit(
			PAGE,
			"add_form",
			{ short_name: "contact" },
			{ user: admin },
		);
		expect(unknown.toast).toEqual({
			type: "info",
			message:
				"Saved. This site could not look the form up, so its fields will be learned from its first enquiry.",
		});
	});

	it("recommends the email way when the site cannot call itself", async () => {
		const { runtime, admin } = await start();
		const checked = await runtime.admin.act(PAGE, "check_reach", { user: admin });
		expect(text(checked)).toContain(
			"Cannot send to its own address, so your forms will hand enquiries over",
		);
		const code = flatten(checked.blocks).find((b) => b.type === "code");
		expect(code?.type === "code" && code.code).toContain("@lead-delivery.invalid");
	});

	it("answers the site check only with the code it was given", async () => {
		const { runtime } = await start();
		await runtime.fixtures.plugin.kv("ping", "abc123");
		const right = await runtime.actions.routes.request("ping", {
			method: "GET",
			url: `${ORIGIN}/_emdash/api/plugins/lead-delivery/ping?code=abc123`,
		});
		expect(await right.text()).toBe("lead-delivery:abc123");
		const wrong = await runtime.actions.routes.request("ping", {
			method: "GET",
			url: `${ORIGIN}/_emdash/api/plugins/lead-delivery/ping?code=nope`,
		});
		expect(wrong.status).toBe(404);
	});

	it("emails the instructions to the web person", async () => {
		const { runtime, admin } = await start();
		const response = await runtime.admin.submit(
			PAGE,
			"email_instructions",
			{ to: "sam@pixel.dev" },
			{ user: admin },
		);
		expect(response.toast).toEqual({
			type: "success",
			message: "Instructions sent to sam@pixel.dev.",
		});
		expect(JSON.stringify(await runtime.inspect.email())).toContain(
			"how to connect the forms to Lead Delivery",
		);
	});
});

describe("where enquiries go", () => {
	it("refuses a HubSpot paste that is not a form, and a place with no form", async () => {
		const { runtime, admin } = await start();
		const bad = await addPlace(runtime, admin, { kind: "hubspot", hubspot: "https://example.com" });
		expect(bad.toast?.type).toBe("error");
		expect(bad.toast?.message).toContain("does not look like a HubSpot form");
		const none = await addPlace(runtime, admin, { kind: "email", to: "a@crumb.test", forms: [] });
		expect(none.toast).toEqual({
			type: "error",
			message: "Choose at least one form that sends here.",
		});
		expect((await config(runtime)).places).toEqual([]);
	});

	it("sends a HubSpot test after a confirmation and marks it Test", async () => {
		const { runtime, admin } = await start();
		const saved = await addPlace(runtime, admin, { kind: "hubspot", hubspot: EMBED });
		expect(saved.toast?.message).toBe(
			"Saved. Found HubSpot account 4410287. The HubSpot form must have the fields you send, at least Email.",
		);
		const test = flatten(saved.blocks).find(
			(b) =>
				b.type === "actions" &&
				b.elements.some((e) => e.type === "button" && e.action_id === "test_place"),
		);
		const button = test?.type === "actions" ? test.elements[0] : undefined;
		expect(button?.type === "button" && button.confirm?.title).toBe("Send a test to HubSpot?");

		await runtime.http.respond(HUBSPOT, new Response(null, { status: 204 }));
		const id = (await config(runtime)).places[0]!.id;
		const response = await runtime.admin.act(PAGE, "test_place", { user: admin, value: id });
		expect(response.toast).toEqual({
			type: "success",
			message: "HubSpot accepted the test. Look for Anna Baker in HubSpot → Contacts.",
		});
		const [row] = await rows(runtime);
		expect(row).toMatchObject({ status: "delivered", test: true, notes: ["Test"] });
		expect((await config(runtime)).testedAt).toBeTruthy();
	});

	it("prefills the alert list with the admin's email", async () => {
		const { runtime } = await start();
		expect((await config(runtime)).alertTo).toEqual(["anna@crumb.test"]);
	});
});

describe("alerts", () => {
	it("emails once when a form that usually gets enquiries goes quiet", async () => {
		const { runtime } = await start();
		const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
		await runtime.fixtures.plugin.kv("forms", {
			newsletter: {
				slug: "newsletter",
				name: "Newsletter",
				fields: [],
				source: "enquiry",
				addedAt: day(30),
				lastAt: day(4),
				days: [day(12), day(8), day(4)].map((d) => d.slice(0, 10)),
			},
		});
		await runtime.transport.invokeHook("cron", { name: "maintenance", data: null });
		const emails = JSON.stringify(await runtime.inspect.email());
		expect(emails).toContain("Crumb & Co.: no enquiries from Newsletter since");
		const forms = await runtime.inspect.kv.get<Record<string, KnownForm>>("forms");
		expect(forms?.newsletter?.quietAlertedFor).toBe(forms?.newsletter?.lastAt);
	});
});

describe("who sees what", () => {
	it("shows an editor the log without tabs and refuses their changes", async () => {
		const { runtime } = await start();
		const editor = await runtime.fixtures.user({ email: "client@crumb.test", role: "editor" });
		const page = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(page.blocks.some((b) => b.type === "tab")).toBe(false);
		expect(text(page)).toContain("Send every enquiry where you work");
		const refused = await addPlace(runtime, editor, { kind: "email", to: "x@crumb.test" });
		expect(refused.toast).toEqual({ type: "error", message: "Only an admin can change this." });
		expect((await config(runtime)).places).toEqual([]);
	});

	it("shows an admin three tabs and the setup steps first", async () => {
		const { runtime, admin } = await start();
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(page.blocks[0]).toEqual({ type: "header", text: "Lead delivery" });
		const tabs = page.blocks.find((b) => b.type === "tab");
		expect(tabs?.type === "tab" && tabs.panels.map((p) => p.label)).toEqual([
			"Enquiries",
			"Where enquiries go",
			"Connect forms",
		]);
		expect(text(page)).toContain("Step 1: connect your forms.");
	});
});

describe("what EmDash will accept", () => {
	it("returns screens that pass EmDash's validator even when the site address is unknown", async () => {
		const { runtime, admin } = await start("");
		await addPlace(runtime, admin, { kind: "hubspot", hubspot: EMBED });
		await addPlace(runtime, admin, { kind: "app", app: "zapier", url: HOOK });
		await runtime.http.respond(HUBSPOT, new Response("{}", { status: 400 }));
		await runtime.http.respond(HOOK, new Response("", { status: 500 }));
		await inbound(runtime, payload("01Z"));
		const places = (await config(runtime)).places;
		const screens = [
			await runtime.admin.loadPage(PAGE, { user: admin }),
			await runtime.admin.loadWidget("enquiries", { user: admin }),
			await runtime.admin.act(PAGE, "add_place", { user: admin }),
			await runtime.admin.act(PAGE, "open_place", { user: admin, value: places[0]!.id }),
			await runtime.admin.act(PAGE, "list_places", { user: admin }),
			await runtime.admin.act(PAGE, "check_reach", { user: admin }),
		];
		for (const screen of screens) {
			expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] })).toEqual({
				valid: true,
				errors: [],
			});
		}
	});
});
