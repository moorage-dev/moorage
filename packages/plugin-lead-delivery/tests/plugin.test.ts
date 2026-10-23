// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { HELP_LINE, HIDE_ACTION } from "../src/help-line.js";
import type { Config, Delivery, KnownForm, Send } from "../src/types.js";
import { runQueued } from "./queue.js";

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

type User = Awaited<ReturnType<PluginRuntimeTestHost["fixtures"]["user"]>>;

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
	return (await runtime.inspect.setting<Config>("config"))!;
}

let counter = 0;
function delivery(overrides: Partial<Delivery> = {}): Delivery {
	counter += 1;
	return {
		id: `d${counter}xxxxxx`.slice(0, 10),
		kind: "app",
		name: "Contact us → Zapier",
		forms: ["contact"],
		on: true,
		repeat: "off",
		holdSpam: false,
		createdAt: "2026-10-20T00:00:00.000Z",
		app: "zapier",
		url: HOOK,
		secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0",
		...overrides,
	};
}

/** Put deliveries straight into the setup, as if the owner had made them. */
async function setDeliveries(runtime: PluginRuntimeTestHost, list: Delivery[]) {
	await runtime.fixtures.plugin.setting("config", { ...(await config(runtime)), deliveries: list });
}

async function setForms(runtime: PluginRuntimeTestHost, forms: KnownForm[]) {
	await runtime.fixtures.plugin.setting("forms", Object.fromEntries(forms.map((f) => [f.slug, f])));
}

function known(slug: string, name: string, extra: Partial<KnownForm> = {}): KnownForm {
	return {
		slug,
		name,
		fields: [],
		source: "enquiry",
		addedAt: "2026-10-01T00:00:00.000Z",
		days: [],
		...extra,
	};
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

/**
 * An enquiry posted straight from a form, then delivered by the runs that follow (it is stored
 * on arrival and sent by the scheduler), unless `queued` asks to stop at arrival.
 */
async function inbound(
	runtime: PluginRuntimeTestHost,
	body: unknown,
	key?: string,
	{ queued = false } = {},
) {
	const k = key ?? (await config(runtime)).key;
	const response = await runtime.actions.routes.request("inbound", {
		method: "POST",
		url: `${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${k}`,
		body,
	});
	if (!queued) await runQueued(runtime);
	return response;
}

/** Real (not test) log rows. */
async function rows(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.storage.list<Send>("deliveries"))
		.map((r) => r.data)
		.filter((r) => !r.test);
}

function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) => {
		if (block.type === "tab") return [block, ...block.panels.flatMap((p) => flatten(p.blocks))];
		if (block.type === "accordion") return [block, ...flatten(block.blocks)];
		return [block];
	});
}

const text = (response: BlockResponse) => JSON.stringify(response.blocks);

function buttons(response: BlockResponse): Array<{
	action_id: string;
	label: string;
	value?: unknown;
	confirm?: { title: string; text: string };
}> {
	const out: Array<{ action_id: string; label: string; value?: unknown }> = [];
	for (const block of flatten(response.blocks)) {
		if (block.type === "actions")
			for (const e of block.elements) if (e.type === "button") out.push(e);
		if (block.type === "empty")
			for (const e of block.actions ?? []) if (e.type === "button") out.push(e);
		if (block.type === "section" && block.accessory?.type === "button") out.push(block.accessory);
		if (block.type === "table")
			for (const row of block.rows)
				for (const cell of Object.values(row))
					if (cell && typeof cell === "object" && (cell as { type?: string }).type === "button")
						out.push(cell as { action_id: string; label: string });
	}
	return out;
}

const headers = (response: BlockResponse) =>
	response.blocks
		.filter((b) => b.type === "header")
		.map((b) => (b.type === "header" ? b.text : ""));

/** New delivery, step 2, saved: the form block's id carries step 1's choices. */
async function saveNew(
	runtime: PluginRuntimeTestHost,
	user: User,
	kind: "email" | "hubspot" | "app",
	form: string,
	values: Record<string, unknown>,
) {
	return runtime.admin.submit(PAGE, "new_save", values, { user, blockId: `new2:${kind}:${form}` });
}

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
		const { runtime } = await start();
		await setDeliveries(runtime, [delivery()]);
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
			marks: [],
		});
		expect((await rows(runtime)).map((r) => r.status)).toEqual(["delivered"]);
		// Once all its deliveries are done, the contents go.
		const [stored] = await runtime.inspect.storage.list<{ fields: unknown[]; cleared: boolean }>(
			"enquiries",
		);
		expect(stored?.data).toMatchObject({ fields: [], cleared: true });
		expect(JSON.stringify(stored)).not.toContain("tom@example.com");
		// The form is now known as connected, the straight way.
		const forms = await runtime.inspect.setting<Record<string, KnownForm>>("forms");
		expect(forms?.contact).toMatchObject({ connectedWay: "straight" });
		expect(forms?.contact?.connectedAt).toBeTruthy();
	});

	it("stops after a reset of the private address", async () => {
		const { runtime, admin } = await start();
		const old = (await config(runtime)).key;
		await runtime.admin.act(PAGE, "reset_address", { user: admin });
		expect((await config(runtime)).key).not.toBe(old);
		expect((await inbound(runtime, payload("01B"), old)).status).toBe(401);
	});

	it("logs an enquiry no delivery takes, and one for a delivery that is turned off, as Not sent", async () => {
		const { runtime, admin } = await start();
		await inbound(runtime, payload("01N"));
		expect((await rows(runtime)).map((r) => [r.status, r.destination, r.notes.at(-1)])).toEqual([
			["skipped", "none", "No delivery for this form; not sent"],
		]);

		const off = delivery({ on: false });
		await setDeliveries(runtime, [off]);
		await inbound(runtime, payload("01O", { email: "priya@example.com" }));
		const row = (await rows(runtime)).find((r) => r.destination === off.id)!;
		expect(row).toMatchObject({ status: "skipped", held: true, notes: ["Turned off; not sent"] });
		// Held, so its contents stay and Send again sends it.
		await runtime.http.respond(HOOK, new Response("ok"));
		const sent = await runtime.admin.act(PAGE, "send_again", {
			user: admin,
			value: { row: `01O~${off.id}`, from: { screen: "home" } },
		});
		expect(sent.toast?.type).toBe("success");
		expect((await rows(runtime)).find((r) => r.destination === off.id)).toMatchObject({
			status: "delivered",
			notes: [],
		});
	});
});

describe("delivery problems", () => {
	it("shows a refused HubSpot enquiry in red, says what to fix, and alerts once a day", async () => {
		const { runtime, admin } = await start();
		const hub = delivery({
			kind: "hubspot",
			name: "Contact us → HubSpot",
			portalId: "4410287",
			formGuid: "9f1c2b3a-1111-2222-3333-444455556666",
		});
		await setDeliveries(runtime, [hub]);
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
		expect(banner).toMatchObject({ variant: "error", title: "Contact us → HubSpot needs fixing" });
		expect(text(page)).toContain("does not have the field message");
		expect(text(page)).toContain("Lead delivery → Contact us → HubSpot → Edit");
		expect(buttons(page).map((b) => b.label)).toEqual(
			expect.arrayContaining(["Open Contact us → HubSpot", "Send all failed again", "Send again"]),
		);

		const sent = (await runtime.inspect.email()) as unknown as Array<{
			to: string;
			cc?: string[];
			subject: string;
			text: string;
		}>;
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: "anna@crumb.test", cc: ["sam@pixel.dev"] });
		expect(sent[0]!.subject).toBe("Crumb & Co.: an enquiry could not be delivered");
		expect(sent[0]!.text).toContain('could not be delivered by "Contact us → HubSpot"');
		expect(sent[0]!.text).toContain("it is kept in Lead delivery");
	});

	it("tries again when an app does not answer, a few per run", async () => {
		const { runtime } = await start();
		await setDeliveries(
			runtime,
			[0, 1, 2, 3].map((i) => delivery({ app: "make", url: `${HOOK}${i}`, name: `App ${i}` })),
		);
		for (let i = 0; i < 4; i++)
			await runtime.http.respond(`${HOOK}${i}`, new Response("", { status: 503 }));
		await inbound(runtime, payload("01E"), undefined, { queued: true });
		// Stored, every delivery due: nothing is sent while the enquiry arrives.
		expect((await rows(runtime)).map((r) => [r.status, r.attempts])).toEqual(
			Array(4).fill(["retrying", 0]),
		);
		await runQueued(runtime);
		const waiting = await rows(runtime);
		expect(waiting.map((r) => [r.status, r.attempts])).toEqual(Array(4).fill(["retrying", 1]));
		const tried = waiting[0]!;
		const wait = Date.parse(tried.nextAt) - Date.parse(tried.createdAt);
		expect(wait).toBeGreaterThan(55_000);
		expect(wait).toBeLessThan(120_000);

		const past = new Date(Date.now() - 1000).toISOString();
		for (const item of await runtime.inspect.storage.list<Send>("deliveries")) {
			await runtime.fixtures.plugin.storage("deliveries", item.id, { ...item.data, nextAt: past });
		}
		for (let i = 0; i < 4; i++) await runtime.http.respond(`${HOOK}${i}`, new Response("ok"));
		const before = runtime.http.requests().length;
		await runQueued(runtime);
		expect(runtime.http.requests().length - before).toBe(4);
		expect((await rows(runtime)).map((r) => r.status)).toEqual(Array(4).fill("delivered"));
	});

	it("sends again from the log", async () => {
		const { runtime, admin } = await start();
		const d = delivery({ app: "n8n", name: "Contact us → n8n" });
		await setDeliveries(runtime, [d]);
		await runtime.http.respond(HOOK, new Response("gone", { status: 404 }));
		await inbound(runtime, payload("01F"));
		const [row] = await runtime.inspect.storage.list<Send>("deliveries");
		expect(row?.data.status).toBe("fixing");
		await runtime.http.respond(HOOK, new Response("ok"));
		const response = await runtime.admin.act(PAGE, "send_again", {
			user: admin,
			value: { row: row!.id, from: { screen: "delivery", id: d.id } },
		});
		expect(response.toast).toEqual({
			type: "success",
			message: 'Sent again. "Contact us → n8n" delivered Tom Reyes\'s enquiry.',
		});
		// A short screen says so, with the way back to the delivery's page.
		expect(headers(response)).toEqual(["Sent again"]);
		expect(buttons(response).map((b) => b.label)).toEqual(["← Back to Contact us → n8n"]);
	});
});

describe("repeats and possibly spam", () => {
	it("marks a repeat and still sends it when repeats are allowed", async () => {
		const { runtime } = await start();
		await setDeliveries(runtime, [delivery()]);
		await runtime.http.respond(HOOK, new Response("ok"));
		await runtime.http.respond(HOOK, new Response("ok"));
		await inbound(runtime, payload("01G"));
		await inbound(runtime, payload("01H"));
		const list = (await rows(runtime)).sort((a, b) => a.enquiryId.localeCompare(b.enquiryId));
		expect(list.map((r) => r.status)).toEqual(["delivered", "delivered"]);
		expect(list[1]!.notes).toEqual(["Same address less than a minute earlier"]);
		const second = runtime.http.requests().filter((r) => r.url === HOOK)[1]!;
		expect(JSON.parse(new TextDecoder().decode(second.body))).toMatchObject({
			marks: ["repeat"],
			repeatAfterMinutes: 0,
		});
	});

	it("holds the same address within 24 hours, with Send again", async () => {
		const { runtime, admin } = await start();
		const d = delivery({ repeat: "24h" });
		await setDeliveries(runtime, [d]);
		await runtime.http.respond(HOOK, new Response("ok"));
		await inbound(runtime, payload("01G"));
		await inbound(runtime, payload("01H"));
		const list = (await rows(runtime)).sort((a, b) => a.enquiryId.localeCompare(b.enquiryId));
		expect(list.map((r) => r.status)).toEqual(["delivered", "skipped"]);
		expect(list[1]!.notes).toEqual([
			"Same address less than a minute earlier; not sent: repeats are off for 24 hours",
		]);
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(text(page)).toContain("Not sent");
		expect(buttons(page).filter((b) => b.label === "Send again")).toHaveLength(1);

		await runtime.http.respond(HOOK, new Response("ok"));
		await runtime.admin.act(PAGE, "send_again", {
			user: admin,
			value: { row: `01H~${d.id}`, from: { screen: "home" } },
		});
		const sent = (await rows(runtime)).find((r) => r.enquiryId === "01H")!;
		expect(sent).toMatchObject({
			status: "delivered",
			notes: ["Same address less than a minute earlier"],
		});
	});

	it("holds the same address within 7 days only when asked for 7 days", async () => {
		const { runtime } = await start();
		const day = delivery({ repeat: "24h", url: `${HOOK}day` });
		const week = delivery({ repeat: "7d", url: `${HOOK}week` });
		await setDeliveries(runtime, [day, week]);
		await runtime.http.respond(`${HOOK}day`, new Response("ok"));
		await runtime.http.respond(`${HOOK}week`, new Response("ok"));
		await inbound(runtime, payload("01G"));
		// Move the first enquiry three days back.
		const threeDays = new Date(Date.now() - 3 * 86_400_000).toISOString();
		for (const item of await runtime.inspect.storage.list<Send>("deliveries")) {
			await runtime.fixtures.plugin.storage("deliveries", item.id, {
				...item.data,
				createdAt: threeDays,
			});
		}
		await runtime.http.respond(`${HOOK}day`, new Response("ok"));
		await inbound(runtime, payload("01H"));
		const second = (await rows(runtime)).filter((r) => r.enquiryId === "01H");
		expect(second.find((r) => r.destination === day.id)).toMatchObject({
			status: "delivered",
			notes: ["Same address 3 days earlier"],
		});
		expect(second.find((r) => r.destination === week.id)).toMatchObject({
			status: "skipped",
			notes: ["Same address 3 days earlier; not sent: repeats are off for 7 days"],
		});
	});

	it("says a repeat five minutes later came five minutes earlier, not yesterday", async () => {
		const { runtime } = await start();
		await setDeliveries(runtime, [delivery()]);
		await runtime.http.respond(HOOK, new Response("ok"));
		await runtime.http.respond(HOOK, new Response("ok"));
		await inbound(runtime, payload("01G"));
		const [first] = await runtime.inspect.storage.list<Send>("deliveries");
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000 - 1000).toISOString();
		await runtime.fixtures.plugin.storage("deliveries", first!.id, {
			...first!.data,
			createdAt: fiveMinutesAgo,
		});
		await inbound(runtime, payload("01H"));
		const list = (await rows(runtime)).sort((a, b) => a.enquiryId.localeCompare(b.enquiryId));
		expect(list[1]!.notes).toEqual(["Same address 5 minutes earlier"]);
	});

	it("marks possibly spam and sends it, unless the delivery holds it", async () => {
		const { runtime } = await start();
		const mail = delivery({
			kind: "email",
			name: "Contact us → Shop inbox",
			to: ["shop@crumb.test"],
		});
		const held = delivery({ holdSpam: true });
		await setDeliveries(runtime, [mail, held]);
		await inbound(
			runtime,
			payload("01S", {
				email: "ben@mailinator.com",
				message: "Grow your traffic fast! See example.com, example.net and example.org",
			}),
		);
		const list = await rows(runtime);
		expect(list.find((r) => r.destination === held.id)).toMatchObject({
			status: "skipped",
			held: true,
			notes: ["Possibly fake address", "Possibly spam; not sent"],
		});
		expect(list.find((r) => r.destination === mail.id)).toMatchObject({
			notes: ["Possibly fake address", "Possibly spam"],
		});
		await runQueued(runtime);
		const emails = (await runtime.inspect.email()) as unknown as Array<{
			subject: string;
			text: string;
		}>;
		const enquiry = emails.find((e) => e.subject.includes("new enquiry"))!;
		expect(enquiry.subject).toBe("Crumb & Co.: new enquiry from Tom Reyes (Contact us)");
		expect(enquiry.text.split("\n").slice(0, 2)).toEqual([
			"Marked: possibly fake address · possibly spam",
			"These marks are a guess. Lead delivery still sends marked enquiries.",
		]);
	});
});

describe("the email way", () => {
	it("takes the enquiry from the form's email to the private address and cancels that email", async () => {
		const { runtime } = await start();
		await setDeliveries(runtime, [
			delivery({
				kind: "email",
				name: "Contact us → Orders inbox",
				forms: ["contact-us"],
				to: ["orders@crumb.test"],
			}),
		]);
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

		await runQueued(runtime);
		expect((await rows(runtime)).map((r) => r.status)).toEqual(["delivered"]);
		const emails = JSON.stringify(await runtime.inspect.email());
		expect(emails).toContain("orders@crumb.test");
		expect(emails).toContain("Crumb & Co.: new enquiry from Tom Reyes (Contact us)");
		expect(emails).toContain("Your name: Tom Reyes");
		const forms = await runtime.inspect.setting<Record<string, KnownForm>>("forms");
		expect(forms?.["contact-us"]?.connectedWay).toBe("email");
	});

	it("known limit: a short name typed on a site that cannot look it up may not match the form's email", async () => {
		const { runtime } = await start();
		// "Another form" with short name "contact", saved unchecked, so its name is only "contact".
		await setForms(runtime, [known("contact", "contact")]);
		await setDeliveries(runtime, [
			delivery({
				kind: "email",
				name: "contact → Shop inbox",
				forms: ["contact"],
				to: ["shop@crumb.test"],
			}),
		]);
		const key = (await config(runtime)).key;
		await runtime.transport.invokeHook("email:beforeSend", {
			source: "emdash-forms",
			message: {
				to: `enquiries-${key}@lead-delivery.invalid`,
				subject: "New submission: Contact us",
				text: "Your name: Tom Reyes\nEmail: tom@example.com\n\nSubmitted at: 2026-10-16T09:00:00.000Z",
			},
		});
		// The email names the form "Contact us", so it arrives as contact-us: listed, not lost.
		expect((await rows(runtime)).map((r) => [r.formId, r.destination, r.notes.at(-1)])).toEqual([
			["contact-us", "none", "No delivery for this form; not sent"],
		]);
		// The way out: the form is now known by that name, so Edit can tick it.
		const forms = await runtime.inspect.setting<Record<string, KnownForm>>("forms");
		expect(forms?.["contact-us"]?.name).toBe("Contact us");
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

describe("enquiries from a form no delivery takes", () => {
	/** Two enquiries through the email way from a form called "Contact us" (arrives as contact-us). */
	async function arriveFromContactUs(runtime: PluginRuntimeTestHost) {
		const key = (await config(runtime)).key;
		for (const who of ["Tom Reyes", "Priya Shah"]) {
			await runtime.transport.invokeHook("email:beforeSend", {
				source: "emdash-forms",
				message: {
					to: `enquiries-${key}@lead-delivery.invalid`,
					subject: "New submission: Contact us",
					text: `Your name: ${who}\nEmail: ${who.split(" ")[0]!.toLowerCase()}@example.com\n\nSubmitted at: 2026-10-16T09:00:00.000Z`,
				},
			});
		}
	}
	// A delivery for the typed short name "contact", which never receives anything.
	const typed = () =>
		delivery({
			kind: "email",
			name: "contact → Shop inbox",
			forms: ["contact"],
			to: ["shop@crumb.test"],
		});

	it("says so on home, and with one delivery adds the form to it and sends what was held", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [known("contact", "contact")]);
		const d = typed();
		await setDeliveries(runtime, [d]);
		await arriveFromContactUs(runtime);
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(
			flatten(page.blocks).find((b) => b.type === "banner" && b.title?.includes("were not sent")),
		).toMatchObject({
			variant: "alert",
			title: "2 enquiries from Contact us were not sent: no delivery takes this form",
		});
		// The held enquiries have no Send again of their own: there is nowhere to send them yet.
		const add = buttons(page).find((b) => b.action_id === "adopt");
		expect(add?.label).toBe("Add Contact us to contact → Shop inbox and send them");
		expect(buttons(page).filter((b) => b.label === "Send again")).toHaveLength(0);

		const done = await runtime.admin.act(PAGE, "adopt", { user: admin, value: add!.value });
		expect(done.toast?.message).toBe(
			'"contact → Shop inbox" now takes Contact us. Sending its 2 enquiries.',
		);
		expect((await config(runtime)).deliveries[0]!.forms).toEqual(["contact", "contact-us"]);
		await runQueued(runtime);
		const list = await rows(runtime);
		expect(list.map((r) => [r.destination, r.status])).toEqual([
			[d.id, "delivered"],
			[d.id, "delivered"],
		]);
		const emails = JSON.stringify(await runtime.inspect.email());
		expect(emails).toContain("new enquiry from Tom Reyes (Contact us)");
		expect(emails).toContain("new enquiry from Priya Shah (Contact us)");
		const after = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(text(after)).not.toContain("were not sent");
	});

	it("with several deliveries asks which, the one that never received anything first", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [
			known("contact", "contact"),
			known("quote", "Quote", { lastAt: new Date().toISOString() }),
		]);
		const quote = delivery({
			kind: "email",
			name: "Quote → Shop inbox",
			forms: ["quote"],
			to: ["shop@crumb.test"],
		});
		const d = typed();
		await setDeliveries(runtime, [quote, d]);
		await arriveFromContactUs(runtime);
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		const choose = buttons(page).find((b) => b.action_id === "adopt_choose");
		expect(choose?.label).toBe("Add Contact us to a delivery");
		const view = await runtime.admin.act(PAGE, "adopt_choose", {
			user: admin,
			value: choose!.value,
		});
		const form = flatten(view.blocks).find((b) => b.type === "form");
		const radio = form?.type === "form" ? form.fields[0] : undefined;
		expect(radio?.type === "radio" && radio.options.map((o) => o.label)).toEqual([
			"contact → Shop inbox (nothing has arrived from contact yet)",
			"Quote → Shop inbox",
		]);
		expect(radio?.type === "radio" && radio.initial_value).toBe(d.id);
		const done = await runtime.admin.submit(
			PAGE,
			"adopt",
			{ delivery: d.id },
			{ user: admin, blockId: form?.type === "form" ? form.block_id : "" },
		);
		expect(done.toast?.message).toMatch(/now takes Contact us/);
		expect((await config(runtime)).deliveries.find((x) => x.id === d.id)!.forms).toEqual([
			"contact",
			"contact-us",
		]);
	});

	it("asks on the delivery's page whether the form that did arrive is the one", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [known("contact", "contact")]);
		const d = typed();
		await setDeliveries(runtime, [d]);
		await arriveFromContactUs(runtime);
		const page = await runtime.admin.act(PAGE, "open", { user: admin, value: d.id });
		expect(text(page)).toContain(
			"Nothing has arrived from contact. Enquiries arrived from Contact us instead: is that the one?",
		);
		expect(buttons(page).find((b) => b.action_id === "adopt")?.label).toBe("Yes, use Contact us");
	});

	it("shows Editors the banner without a button", async () => {
		const { runtime } = await start();
		await setForms(runtime, [known("contact", "contact")]);
		await setDeliveries(runtime, [typed()]);
		await arriveFromContactUs(runtime);
		const editor = await runtime.fixtures.user({ email: "client@crumb.test", role: "editor" });
		const page = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(text(page)).toContain(
			"2 enquiries from Contact us were not sent: no delivery takes this form",
		);
		expect(buttons(page).some((b) => b.action_id.startsWith("adopt"))).toBe(false);
		const refused = await runtime.admin.act(PAGE, "adopt", {
			user: editor,
			value: { form: "contact-us", delivery: "x" },
		});
		expect(refused.toast?.message).toBe("Only an admin can change this.");
	});
});

describe("updating from 0.1", () => {
	const OLD_KEY = "K".repeat(32);
	const places = [
		{
			id: "mailplace1",
			kind: "email",
			name: "Email to shop@crumb.test",
			forms: "all",
			on: true,
			noDuplicates: false,
			createdAt: "2026-10-02T00:00:00.000Z",
			to: ["shop@crumb.test"],
		},
		{
			id: "appplace01",
			kind: "app",
			name: "My Zap",
			forms: ["contact"],
			on: true,
			noDuplicates: true,
			createdAt: "2026-10-03T00:00:00.000Z",
			app: "zapier",
			url: HOOK,
			secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0",
		},
	];

	async function oldSite() {
		const runtime = (host = await createPluginRuntimeTestHost({
			site: { name: "Crumb & Co.", url: ORIGIN, locale: "en" },
		}));
		await runtime.fixtures.plugin.kv("config", {
			places,
			alertTo: ["anna@crumb.test"],
			key: OLD_KEY,
			reach: { result: "email", at: "2026-10-05T00:00:00.000Z" },
			testedAt: "2026-10-06T00:00:00.000Z",
		});
		await runtime.fixtures.plugin.kv("forms", {
			contact: known("contact", "Contact us", { lastAt: "2026-10-19T09:00:00.000Z" }),
		});
		// A log row from 0.1, sent to the Zap.
		await runtime.fixtures.plugin.storage("deliveries", "01OLD~appplace01", {
			enquiryId: "01OLD",
			destination: "appplace01",
			formId: "contact",
			formName: "Contact us",
			who: "Old Enquirer",
			status: "fixing",
			attempts: 1,
			nextAt: "",
			createdAt: new Date(Date.now() - 3_600_000).toISOString(),
			notes: [],
			plain: "Zapier refused the enquiry.",
		});
		return runtime;
	}

	it("keeps an old connected form delivering, with the same address and ids", async () => {
		const runtime = await oldSite();
		// The form still posts to the address it was given under 0.1.
		await runtime.http.respond(HOOK, new Response("ok"));
		const response = await inbound(
			runtime,
			payload("01NEW", { email: "new@example.com" }),
			OLD_KEY,
		);
		expect(await response.text()).toBe("Received.");
		const sent = (await rows(runtime)).filter((r) => r.enquiryId === "01NEW");
		expect(sent.map((r) => [r.destination, r.status]).sort()).toEqual([
			["appplace01", "delivered"],
			["mailplace1", "delivered"],
		]);

		// The setup moves to deliveries in the settings when an admin opens the page.
		const admin = await runtime.fixtures.user({ email: "anna@crumb.test", role: "admin" });
		await runtime.admin.loadPage(PAGE, { user: admin });
		const after = await config(runtime);
		expect(after.version).toBe(2);
		expect(after.key).toBe(OLD_KEY);
		expect(after.deliveries.map((d) => [d.id, d.name, d.oldName, d.repeat])).toEqual([
			["mailplace1", "All forms → Shop inbox", "Email to shop@crumb.test", "off"],
			["appplace01", "Contact us → Zapier", "My Zap", "24h"],
		]);
		expect(after.deliveries[1]!.secret).toBe(places[1]!.secret);
		expect(after.places).toEqual(places); // kept for a rollback to 0.1.2
	});

	it("keeps the email way working with the old private address", async () => {
		const runtime = await oldSite();
		const result = await runtime.transport.invokeHook("email:beforeSend", {
			source: "emdash-forms",
			message: {
				to: `enquiries-${OLD_KEY}@lead-delivery.invalid`,
				subject: "New submission: Contact us",
				text: "Your name: Tom Reyes\nEmail: tom@example.com\n\nSubmitted at: 2026-10-16T09:00:00.000Z",
			},
		});
		expect(result).toBe(false);
		expect(
			(await rows(runtime))
				.filter((r) => r.enquiryId !== "01OLD")
				.map((r) => r.destination)
				.sort(),
		).toEqual(["appplace01", "mailplace1"]);
	});

	it("shows the old log under the new names, says what changed once, and does it only once", async () => {
		const runtime = await oldSite();
		const admin = await runtime.fixtures.user({
			email: "anna@crumb.test",
			name: "Anna",
			role: "admin",
		});
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(text(page)).toContain("Old Enquirer · Contact us → Zapier");
		expect(text(page)).toContain("Lead delivery's setup is now a list of deliveries");
		const once = await config(runtime);
		await runtime.admin.loadPage(PAGE, { user: admin });
		expect(await config(runtime)).toEqual(once);
		const ok = await runtime.admin.act(PAGE, "dismiss_notice", { user: admin });
		expect(text(ok)).not.toContain("is now a list of deliveries");
	});
});

describe("New delivery", () => {
	it("lists the forms it knows, and only Another form when it knows none", async () => {
		const { runtime, admin } = await start();
		const empty = await runtime.admin.act(PAGE, "new", { user: admin });
		expect(headers(empty)).toEqual(["New delivery"]);
		expect(text(empty)).toContain(
			"Lead delivery learns your forms' names once one is connected or sends an enquiry.",
		);
		const form = flatten(empty.blocks).find((b) => b.type === "form");
		expect(form?.type === "form" && form.fields.map((f) => f.label)).toEqual([
			"Which form?",
			"Its short name (Forms lists it under each form's name)",
			"Send to?",
		]);
		const which = form?.type === "form" ? form.fields[0] : undefined;
		expect(which?.type === "select" && which.options.map((o) => o.label)).toEqual(["Another form"]);
		const to = form?.type === "form" ? form.fields[2] : undefined;
		expect(to?.type === "radio" && to.options.map((o) => o.label)).toEqual([
			"Email: an inbox, or several",
			"HubSpot: each enquiry becomes a HubSpot form submission",
			"Another app: Zapier, Make, n8n or your own. Zapier needs a paid plan for this; Make and n8n do not",
		]);

		await setForms(runtime, [known("contact", "Contact form"), known("newsletter", "Newsletter")]);
		const listed = await runtime.admin.act(PAGE, "new", { user: admin });
		const select = flatten(listed.blocks).find((b) => b.type === "form");
		const first = select?.type === "form" ? select.fields[0] : undefined;
		expect(first?.type === "select" && first.options.map((o) => o.label)).toEqual([
			"Contact form",
			"Newsletter",
			"Another form",
		]);
	});

	it("refuses no form and a short name Forms does not know", async () => {
		const { runtime, admin } = await start();
		const none = await runtime.admin.submit(
			PAGE,
			"new_continue",
			{ form: "", kind: "email" },
			{ user: admin },
		);
		expect(none.toast).toEqual({ type: "error", message: "Choose a form." });
		await runtime.http.respond(DEFINITION, Response.json({ success: false }, { status: 404 }));
		const missing = await runtime.admin.submit(
			PAGE,
			"new_continue",
			{ form: "__other", short_name: "contactt", kind: "email" },
			{ user: admin },
		);
		expect(missing.toast).toEqual({
			type: "error",
			message: 'There is no form called "contactt". Copy its short name from Forms.',
		});
	});

	it("goes on to step 2 with the name prefilled, then saves, tests and connects", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(
			DEFINITION,
			Response.json({ data: { name: "Contact form", slug: "contact", pages: [] } }),
		);
		const step2 = await runtime.admin.submit(
			PAGE,
			"new_continue",
			{ form: "__other", short_name: "contact", kind: "email" },
			{ user: admin },
		);
		expect(headers(step2)).toEqual(["Contact form → Email"]);
		const form = flatten(step2.blocks).find((b) => b.type === "form");
		expect(form?.type === "form" && form.block_id).toBe("new2:email:contact");
		expect(form?.type === "form" && form.submit.label).toBe("Save and send a test");
		expect(
			form?.type === "form" &&
				form.fields.map((f) => [f.label, "initial_value" in f ? f.initial_value : ""]),
		).toEqual([
			["Send each enquiry to (separate several addresses with commas)", "anna@crumb.test"],
			["Name (only admins see it)", "Contact form → Email"],
		]);

		await runtime.http.respond(
			DEFINITION,
			Response.json({ data: { name: "Contact form", slug: "contact", pages: [] } }),
		);
		const saved = await saveNew(runtime, admin, "email", "contact", {
			to: "shop@crumb.test",
			name: "Contact form → Email",
		});
		expect(saved.toast).toEqual({
			type: "success",
			message:
				'Saved as "Contact form → Shop inbox". A test went to shop@crumb.test: check the inbox, and the spam folder.',
		});
		// The form was never connected, so Connect this form comes next, with the site checked first.
		expect(headers(saved)).toEqual(["Connect Contact form"]);
		const code = flatten(saved.blocks).find((b) => b.type === "code");
		expect(code?.type === "code" && code.code).toContain("@lead-delivery.invalid");
		expect(buttons(saved).map((b) => b.label)).toEqual(
			expect.arrayContaining(["I have done this", "Skip for now"]),
		);
		const after = await config(runtime);
		expect(after.reach?.result).toBe("email");
		expect(after.deliveries).toEqual([
			expect.objectContaining({
				kind: "email",
				name: "Contact form → Shop inbox",
				forms: ["contact"],
				on: true,
				repeat: "off",
				holdSpam: false,
				to: ["shop@crumb.test"],
				testResult: { ok: true },
			}),
		]);
		const emails = JSON.stringify(await runtime.inspect.email());
		expect(emails).toContain("test enquiry from Anna Baker (Contact form)");
		// The form is remembered for next time.
		const forms = await runtime.inspect.setting<Record<string, KnownForm>>("forms");
		expect(forms?.contact?.name).toBe("Contact form");
	});

	it("keeps a typed name, refuses the same form and address twice, and skips Connect for a connected form", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [
			known("contact", "Contact form", { lastAt: new Date().toISOString() }),
		]);
		const saved = await saveNew(runtime, admin, "email", "contact", {
			to: "anna@crumb.test",
			name: "Anna's inbox",
		});
		expect(saved.toast?.message).toMatch(/^Saved as "Anna's inbox"\./);
		expect(headers(saved)).toEqual([
			"Anna's inbox",
			"Checks",
			"Repeats and spam",
			"Enquiries through this delivery",
		]);
		const twice = await saveNew(runtime, admin, "email", "contact", {
			to: "anna@crumb.test",
			name: "",
		});
		expect(twice.toast).toEqual({
			type: "error",
			message: "Contact form already goes to anna@crumb.test (Anna's inbox).",
		});
		expect(buttons(twice).map((b) => b.label)).toContain("Open Anna's inbox");
		expect((await config(runtime)).deliveries).toHaveLength(1);
	});

	it("matches HubSpot fields for the chosen form and tests only when asked", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [
			known("contact", "Contact form", {
				lastAt: new Date().toISOString(),
				fields: [
					{ key: "name", label: "Your name", type: "text" },
					{ key: "email", label: "Email address", type: "email" },
					{ key: "cake_date", label: "When do you need it?", type: "date" },
				],
			}),
		]);
		const step2 = await runtime.admin.submit(
			PAGE,
			"new_continue",
			{ form: "contact", kind: "hubspot" },
			{ user: admin },
		);
		const form = flatten(step2.blocks).find((b) => b.type === "form");
		expect(form?.type === "form" && form.fields.map((f) => f.label)).toEqual([
			"Your HubSpot form's share link or embed code (HubSpot → Marketing → Forms → Share)",
			"Your name",
			"HubSpot field name for Your name",
			"Email address",
			"HubSpot field name for Email address",
			"When do you need it?",
			"HubSpot field name for When do you need it?",
			"My HubSpot account has its privacy (GDPR) settings on",
			"Mark possibly fake email addresses in HubSpot",
			"HubSpot field to mark (a checkbox field on your HubSpot form)",
			"Name (only admins see it)",
			"Send a test to HubSpot now. It adds a contact called Anna Baker with your email (anna@crumb.test) to HubSpot; you can delete it there afterwards.",
		]);

		const bad = await saveNew(runtime, admin, "hubspot", "contact", {
			hubspot: "https://example.com",
		});
		expect(bad.toast?.message).toContain(
			"That does not look like a HubSpot form's share link or embed code.",
		);

		const saved = await saveNew(runtime, admin, "hubspot", "contact", {
			hubspot: EMBED,
			"f:name": "fullname",
			"f:email": "email",
			"f:cake_date": "skip",
			name: "Contact form → HubSpot",
			test_now: false,
		});
		expect(saved.toast?.message).toMatch(
			/^Saved as "Contact form → HubSpot"\. Found HubSpot account 4410287\./,
		);
		expect(runtime.http.requests().filter((r) => r.url === HUBSPOT)).toHaveLength(0);
		const d = (await config(runtime)).deliveries[0]!;
		expect(d.mapping).toEqual({ contact: { name: "fullname", email: "email", cake_date: "skip" } });

		// The delivery page's test asks first, because it adds a contact.
		const test = buttons(saved).find((b) => b.action_id === "test");
		expect(test?.confirm?.title).toBe("Send a test to HubSpot?");
		await runtime.http.respond(HUBSPOT, new Response(null, { status: 204 }));
		const tested = await runtime.admin.act(PAGE, "test", { user: admin, value: d.id });
		expect(tested.toast).toEqual({
			type: "success",
			message: "HubSpot accepted the test. Look for Anna Baker in HubSpot → Contacts.",
		});
		expect(text(tested)).toContain("HubSpot accepted it.");
		const [row] = (await runtime.inspect.storage.list<Send>("deliveries")).map((r) => r.data);
		expect(row).toMatchObject({ status: "delivered", test: true, notes: ["Test"] });
	});

	it("shows an app's secret once, at the top of the next screen", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [known("contact", "Contact form")]);
		await runtime.http.respond(HOOK, new Response("ok"));
		const saved = await saveNew(runtime, admin, "app", "contact", {
			app: "zapier",
			url: HOOK,
			name: "Contact form → App",
		});
		expect(saved.toast?.message).toBe(
			'Saved as "Contact form → Zapier". Zapier accepted the test.',
		);
		const first = saved.blocks[1];
		expect(first).toMatchObject({
			type: "accordion",
			label: "For your web person: how to check an enquiry came from this site",
			default_open: true,
		});
		expect(JSON.stringify(first)).toMatch(/whsec_/);
		const d = (await config(runtime)).deliveries[0]!;
		const later = await runtime.admin.act(PAGE, "open", { user: admin, value: d.id });
		expect(text(later)).not.toContain("whsec_");
		expect(text(later)).toContain("The secret was shown when you saved this delivery.");
		const renewed = await runtime.admin.act(PAGE, "new_secret", { user: admin, value: d.id });
		expect((await config(runtime)).deliveries[0]!.secret).not.toBe(d.secret);
		expect(text(renewed)).toContain((await config(runtime)).deliveries[0]!.secret!);
	});
});

describe("Connect this form", () => {
	it("marks a form connected by hand, or skips to a page that says it is not connected", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [known("contact", "Contact form")]);
		const d = delivery({ name: "Contact form → Zapier" });
		await setDeliveries(runtime, [d]);

		const skipped = await runtime.admin.act(PAGE, "open", { user: admin, value: d.id });
		expect(text(skipped)).toContain("Not sending yet: Contact form is not connected");
		expect(buttons(skipped).find((b) => b.label === "Connect this form")?.value).toEqual({
			id: d.id,
			form: "contact",
		});

		const connect = await runtime.admin.act(PAGE, "connect", {
			user: admin,
			value: { id: d.id, form: "contact" },
		});
		expect(headers(connect)).toEqual(["Connect Contact form"]);
		const emailed = await runtime.admin.submit(
			PAGE,
			"email_instructions",
			{ to: "sam@pixel.dev" },
			{ user: admin, blockId: `instructions:${d.id}:contact` },
		);
		expect(emailed.toast).toEqual({
			type: "success",
			message: "Instructions sent to sam@pixel.dev.",
		});
		expect(JSON.stringify(await runtime.inspect.email())).toContain(
			"how to connect the Contact form to Lead Delivery",
		);

		const done = await runtime.admin.act(PAGE, "connected", {
			user: admin,
			value: { id: d.id, form: "contact" },
		});
		expect(text(done)).toContain(
			"Not sending yet: Contact form is connected. Send yourself an enquiry through it on your site",
		);
		const forms = await runtime.inspect.setting<Record<string, KnownForm>>("forms");
		expect(forms?.contact?.connectedWay).toBe("by hand");
	});

	it("asks to connect again after the private address is reset", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [
			known("contact", "Contact form", { lastAt: "2026-10-19T09:00:00.000Z" }),
		]);
		const d = delivery({ name: "Contact form → Zapier" });
		await setDeliveries(runtime, [d]);
		expect(text(await runtime.admin.act(PAGE, "open", { user: admin, value: d.id }))).not.toContain(
			"is not connected",
		);
		await runtime.admin.act(PAGE, "reset_address", { user: admin });
		expect(text(await runtime.admin.act(PAGE, "open", { user: admin, value: d.id }))).toContain(
			"Not sending yet: Contact form is not connected",
		);
	});
});

describe("a delivery's page", () => {
	it("shows the two checks separately, and saves repeats and spam", async () => {
		const { runtime, admin } = await start();
		const d = delivery({ name: "Contact us → Zapier" });
		await setDeliveries(runtime, [d]);
		await runtime.http.respond(HOOK, new Response("ok"));
		await inbound(runtime, payload("01P"));
		const page = await runtime.admin.act(PAGE, "open", { user: admin, value: d.id });
		const fields = flatten(page.blocks).find((b) => b.type === "fields");
		expect(fields).toEqual({
			type: "fields",
			fields: [
				{ label: "Test", value: "Not sent yet" },
				{ label: "Real enquiries", value: "Arriving: last one just now (Tom Reyes)" },
			],
		});
		expect(buttons(page).map((b) => b.label)).toEqual(
			expect.arrayContaining([
				"Send a test",
				"Edit",
				"Turn off",
				"Delete this delivery",
				"← Back to Lead delivery",
			]),
		);
		const saved = await runtime.admin.submit(
			PAGE,
			"save_repeats",
			{ repeat: "7d", hold_spam: true },
			{ user: admin, blockId: `repeats:${d.id}` },
		);
		expect(saved.toast?.message).toBe("Saved.");
		expect((await config(runtime)).deliveries[0]).toMatchObject({ repeat: "7d", holdSpam: true });

		const off = await runtime.admin.act(PAGE, "toggle", { user: admin, value: d.id });
		expect(text(off)).toContain("Turned off: nothing is sent until you turn it on");
	});

	it("does not keep trying a test that got no answer", async () => {
		const { runtime, admin } = await start();
		const d = delivery({ name: "Contact us → Zapier" });
		await setDeliveries(runtime, [d]);
		await runtime.http.respond(HOOK, new Response("", { status: 503 }));
		const page = await runtime.admin.act(PAGE, "test", { user: admin, value: d.id });
		expect(page.toast?.type).toBe("error");
		const [test] = (await runtime.inspect.storage.list<Send>("deliveries")).map((r) => r.data);
		expect(test).toMatchObject({ test: true, status: "gaveup", nextAt: "" });
		expect(text(page)).toContain("Did not arrive: Zapier did not answer.");
		const home = await runtime.admin.loadPage(PAGE, { user: admin });
		const stats = home.blocks.find((b) => b.type === "stats");
		expect(stats?.type === "stats" && stats.items[2]?.value).toBe(0);
	});

	it("deletes after a warning, and keeps what was on its way in the log as Not sent", async () => {
		const { runtime, admin } = await start();
		const d = delivery({ name: "Contact us → Zapier" });
		await setDeliveries(runtime, [d]);
		await runtime.http.respond(HOOK, new Response("", { status: 503 }));
		await inbound(runtime, payload("01Q"));
		const page = await runtime.admin.act(PAGE, "open", { user: admin, value: d.id });
		const del = buttons(page).find((b) => b.action_id === "delete");
		expect(del?.confirm?.title).toBe("Delete Contact us → Zapier?");
		expect(del?.confirm?.text).toContain(
			"Contact us will have nowhere to send. Its enquiries still arrive here and are listed as Not sent.",
		);
		await runtime.admin.act(PAGE, "delete", { user: admin, value: d.id });
		expect((await config(runtime)).deliveries).toEqual([]);
		expect(await rows(runtime)).toEqual([
			expect.objectContaining({ status: "skipped", notes: ["Its delivery was deleted; not sent"] }),
		]);
	});
});

describe("Edit", () => {
	it("lets one delivery take several forms or all forms, and connects a new form", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [
			known("contact", "Contact form", { lastAt: new Date().toISOString() }),
			known("quote", "Quote"),
		]);
		const d = delivery({
			kind: "email",
			name: "Contact form → Shop inbox",
			to: ["shop@crumb.test"],
			forms: ["contact"],
		});
		await setDeliveries(runtime, [d]);
		const edit = await runtime.admin.act(PAGE, "edit", { user: admin, value: d.id });
		const form = flatten(edit.blocks).find((b) => b.type === "form");
		const which =
			form?.type === "form" ? form.fields.find((f) => f.action_id === "forms") : undefined;
		expect(which?.type === "checkbox" && which.options.map((o) => o.label)).toEqual([
			"All forms, including new ones",
			"Contact form",
			"Quote",
		]);
		const values = { name: d.name, to: "shop@crumb.test", on: true };
		const none = await runtime.admin.submit(
			PAGE,
			"save_edit",
			{ ...values, forms: [] },
			{ user: admin, blockId: `edit:${d.id}` },
		);
		expect(none.toast).toEqual({ type: "error", message: "Choose a form." });
		const two = await runtime.admin.submit(
			PAGE,
			"save_edit",
			{ ...values, forms: ["contact", "quote"] },
			{ user: admin, blockId: `edit:${d.id}` },
		);
		// Quote was never connected, so its connect step opens.
		expect(headers(two)).toEqual(["Connect Quote"]);
		const all = await runtime.admin.submit(
			PAGE,
			"save_edit",
			{ ...values, forms: ["all", "contact"] },
			{ user: admin, blockId: `edit:${d.id}` },
		);
		expect(all.toast?.message).toBe(
			"Saved. It takes all forms, including new ones, so the other ticks were not needed.",
		);
		expect((await config(runtime)).deliveries[0]!.forms).toBe("all");
	});
});

describe("alerts", () => {
	it("emails once when a form that usually gets enquiries goes quiet", async () => {
		const { runtime } = await start();
		const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
		await runtime.fixtures.plugin.setting("forms", {
			newsletter: known("newsletter", "Newsletter", {
				addedAt: day(30),
				lastAt: day(4),
				days: [day(12), day(8), day(4)].map((d) => d.slice(0, 10)),
			}),
		});
		// The every-minute run asks for the day's run, which checks the forms.
		await runtime.transport.invokeHook("cron", { name: "maintenance", data: null });
		const tasks = (await runtime.inspect.scheduledTasks()) as Array<{ name: string }>;
		expect(tasks.map((t) => t.name)).toContain("daily");
		await runtime.transport.invokeHook("cron", { name: "daily", data: null });
		const emails = JSON.stringify(await runtime.inspect.email());
		expect(emails).toContain("Crumb & Co.: no enquiries from Newsletter since");
		const forms = await runtime.inspect.setting<Record<string, KnownForm>>("forms");
		expect(forms?.newsletter?.quietAlertedFor).toBe(forms?.newsletter?.lastAt);
	});

	it("prefills the alert list with the admin's email", async () => {
		const { runtime } = await start();
		expect((await config(runtime)).alertTo).toEqual(["anna@crumb.test"]);
	});
});

describe("home and who sees what", () => {
	it("shows an admin the first-run empty state with New delivery", async () => {
		const { runtime, admin } = await start();
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(page.blocks[0]).toEqual({ type: "header", text: "Lead delivery" });
		expect(page.blocks.find((b) => b.type === "empty")).toMatchObject({
			title: "Send every enquiry where you work",
			actions: [{ action_id: "new", label: "+ New delivery" }],
		});
		expect(page.blocks.some((b) => b.type === "tab")).toBe(false);
	});

	it("lists deliveries in the approved order, with one Open button on each row", async () => {
		const { runtime, admin } = await start();
		await setForms(runtime, [known("contact", "Contact us", { lastAt: new Date().toISOString() })]);
		const working = delivery({
			kind: "email",
			name: "Contact us → Shop inbox",
			to: ["shop@crumb.test"],
		});
		const broken = delivery({ name: "Contact us → Zapier" });
		const off = delivery({ name: "Contact us → n8n", app: "n8n", url: `${HOOK}n8n`, on: false });
		await setDeliveries(runtime, [working, broken, off]);
		await runtime.http.respond(HOOK, new Response("gone", { status: 404 }));
		await inbound(runtime, payload("01R"));
		await runQueued(runtime);
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		// Header, New delivery, stats, banners, Deliveries, Latest enquiries, site settings, rule, help line.
		const types = page.blocks.map((b) => b.type);
		expect(types.slice(0, 3)).toEqual(["header", "actions", "stats"]);
		expect(headers(page)).toEqual(["Lead delivery", "Deliveries", "Latest enquiries"]);
		expect(page.blocks.at(-4)).toMatchObject({
			type: "accordion",
			label: "Settings for the whole site",
			default_open: false,
		});
		const stats = page.blocks.find((b) => b.type === "stats");
		expect(stats?.type === "stats" && stats.items.map((i) => i.label)).toEqual([
			"Received",
			"Delivered",
			"Trying again",
			"Needs fixing",
		]);
		const table = page.blocks.find((b) => b.type === "table" && b.block_id === "deliveries");
		expect(table?.type === "table" && table.columns.map((c) => c.label)).toEqual([
			"Delivery",
			"Status",
			"",
		]);
		expect(table?.type === "table" && table.rows.map((r) => [r.delivery, r.status])).toEqual([
			["Contact us → Zapier", "Needs fixing"],
			["Contact us → n8n", "Turned off"],
			["Contact us → Shop inbox · Email", "Working, last just now"],
		]);
		expect(
			table?.type === "table" && table.rows.map((r) => (r.go as { label: string }).label)[0],
		).toEqual("Open");
	});

	it("shows an Editor the same page without the admin's buttons, and refuses their changes", async () => {
		const { runtime } = await start();
		const editor = await runtime.fixtures.user({ email: "client@crumb.test", role: "editor" });
		const empty = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(empty.blocks.find((b) => b.type === "empty")).toMatchObject({
			title: "Nothing is set up yet",
			description: "An admin of this site decides where enquiries are sent.",
		});
		const d = delivery({ name: "Contact us → Zapier" });
		await setDeliveries(runtime, [d]);
		await runtime.http.respond(HOOK, new Response("gone", { status: 404 }));
		await inbound(runtime, payload("01T"));
		const page = await runtime.admin.loadPage(PAGE, { user: editor });
		const labels = buttons(page).map((b) => b.label);
		expect(labels).not.toContain("+ New delivery");
		expect(labels).not.toContain("Open");
		expect(labels).toEqual(
			expect.arrayContaining([
				"Enquiries",
				"Send again",
				"Send all failed again",
				"See all enquiries",
			]),
		);
		expect(page.blocks.some((b) => b.type === "accordion")).toBe(false);
		expect(text(page)).toContain("Ask the person who set up this site to fix it.");
		const table = page.blocks.find((b) => b.type === "table" && b.block_id === "deliveries");
		expect(table?.type === "table" && table.columns.map((c) => c.label)).toEqual([
			"Delivery",
			"Status",
			"",
		]);

		// The Enquiries button shows one delivery's log.
		const log = await runtime.admin.act(PAGE, "open_log", { user: editor, value: d.id });
		expect(headers(log)).toEqual(["Enquiries"]);
		expect(text(log)).toContain("Tom Reyes · Contact us → Zapier");
		const refused = await runtime.admin.act(PAGE, "delete", { user: editor, value: d.id });
		expect(refused.toast).toEqual({ type: "error", message: "Only an admin can change this." });
		expect((await config(runtime)).deliveries).toHaveLength(1);
	});
});

describe("the help line", () => {
	const line = (response: BlockResponse) =>
		response.blocks.find((block) => block.type === "actions" && block.block_id === HELP_LINE);
	const lines = (response: BlockResponse) =>
		response.blocks.filter((block) => block.block_id === HELP_LINE).length;

	it("ends every screen an admin sees with the guide, the plugins and the maker", async () => {
		const { runtime, admin } = await start();
		const home = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(home.blocks.at(-1)).toEqual({
			type: "actions",
			block_id: HELP_LINE,
			elements: [
				{
					type: "link",
					label: "Help",
					target: {
						kind: "external",
						url: "https://moorage.dev/guides/send-emdash-form-enquiries-to-email-or-hubspot",
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
		});
		const d = delivery();
		await setDeliveries(runtime, [d]);
		for (const screen of [
			await runtime.admin.act(PAGE, "new", { user: admin }),
			await runtime.admin.act(PAGE, "open", { user: admin, value: d.id }),
			await runtime.admin.act(PAGE, "see_all", { user: admin }),
		]) {
			expect(lines(screen)).toBe(1);
			expect(screen.blocks.at(-1)?.block_id).toBe(HELP_LINE);
			expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] }).valid).toBe(true);
		}
	});

	it("never shows to an editor, nor on the widget", async () => {
		const { runtime, admin } = await start();
		const editor = await runtime.fixtures.user({ email: "client@crumb.test", role: "editor" });
		expect(text(await runtime.admin.loadPage(PAGE, { user: editor }))).not.toMatch(/moorage/i);
		expect(text(await runtime.admin.act(PAGE, "see_all", { user: editor }))).not.toMatch(
			/moorage/i,
		);
		const widget = await runtime.admin.loadWidget("enquiries", { user: admin });
		expect(text(widget)).not.toMatch(/moorage/i);
		for (const role of ["author", "contributor"] as const) {
			const user = await runtime.fixtures.user({ email: `${role}@crumb.test`, role });
			await expect(runtime.admin.loadPage(PAGE, { user })).rejects.toThrow(/403/);
		}
	});

	it("hides with the switch in the site settings, keeps it through other saves, and shows again", async () => {
		const { runtime, admin } = await start();
		const hidden = await runtime.admin.submit(
			PAGE,
			HIDE_ACTION,
			{ hide_help_line: true },
			{ user: admin },
		);
		expect(line(hidden)).toBeUndefined();
		expect(hidden.toast).toEqual({ type: "success", message: "Saved. The help line is hidden." });
		expect((await config(runtime)).hideHelpLine).toBe(true);
		expect(line(await runtime.admin.loadPage(PAGE, { user: admin }))).toBeUndefined();

		await runtime.admin.submit(PAGE, "save_alerts", { alert_to: "b@crumb.test" }, { user: admin });
		await runtime.admin.submit(PAGE, HIDE_ACTION, {}, { user: admin });
		expect((await config(runtime)).hideHelpLine).toBe(true);

		const shown = await runtime.admin.submit(
			PAGE,
			HIDE_ACTION,
			{ hide_help_line: false },
			{ user: admin },
		);
		expect(line(shown)).toBeDefined();
		expect((await config(runtime)).hideHelpLine).toBeUndefined();
	});

	it("an editor cannot use the switch", async () => {
		const { runtime, admin } = await start();
		const editor = await runtime.fixtures.user({ email: "client@crumb.test", role: "editor" });
		await runtime.admin.submit(PAGE, HIDE_ACTION, { hide_help_line: true }, { user: editor });
		expect(line(await runtime.admin.loadPage(PAGE, { user: admin }))).toBeDefined();
	});
});

describe("what EmDash will accept", () => {
	it("returns screens that pass EmDash's validator even when the site address is unknown", async () => {
		const { runtime, admin } = await start("");
		await setForms(runtime, [
			known("contact", "Contact us", {
				fields: [
					{ key: "name", label: "Your name", type: "text" },
					{ key: "email", label: "Email", type: "email" },
				],
			}),
		]);
		const hub = delivery({
			kind: "hubspot",
			name: "Contact us → HubSpot",
			portalId: "4410287",
			formGuid: "9f1c2b3a-1111-2222-3333-444455556666",
		});
		const app = delivery();
		const mail = delivery({
			kind: "email",
			name: "Contact us → Shop inbox",
			to: ["shop@crumb.test"],
		});
		await setDeliveries(runtime, [hub, app, mail]);
		await runtime.http.respond(HUBSPOT, new Response("{}", { status: 400 }));
		await runtime.http.respond(HOOK, new Response("", { status: 500 }));
		await inbound(runtime, payload("01Z"));
		const editor = await runtime.fixtures.user({ email: "client@crumb.test", role: "editor" });
		const screens = [
			await runtime.admin.loadPage(PAGE, { user: admin }),
			await runtime.admin.loadPage(PAGE, { user: editor }),
			await runtime.admin.loadWidget("enquiries", { user: admin }),
			await runtime.admin.act(PAGE, "new", { user: admin }),
			await runtime.admin.submit(
				PAGE,
				"new_continue",
				{ form: "contact", kind: "email" },
				{ user: admin },
			),
			await runtime.admin.submit(
				PAGE,
				"new_continue",
				{ form: "contact", kind: "hubspot" },
				{ user: admin },
			),
			await runtime.admin.submit(
				PAGE,
				"new_continue",
				{ form: "contact", kind: "app" },
				{ user: admin },
			),
			...(await Promise.all(
				[hub, app, mail].flatMap((d) => [
					runtime.admin.act(PAGE, "open", { user: admin, value: d.id }),
					runtime.admin.act(PAGE, "edit", { user: admin, value: d.id }),
				]),
			)),
			await runtime.admin.act(PAGE, "connect", {
				user: admin,
				value: { id: app.id, form: "contact" },
			}),
			await runtime.admin.act(PAGE, "see_all", { user: admin }),
			await runtime.admin.act(PAGE, "open_log", { user: editor, value: hub.id }),
			await runtime.admin.act(PAGE, "check_reach", { user: admin }),
			await runtime.admin.act(PAGE, "adopt_choose", { user: admin, value: "contact" }),
		];
		for (const screen of screens) {
			expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] })).toEqual({
				valid: true,
				errors: [],
			});
		}
	});
});
