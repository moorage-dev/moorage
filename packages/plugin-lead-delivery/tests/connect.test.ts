// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { Config, Delivery, KnownForm } from "../src/types.js";

// One-click connect (Connect this form, release 2 of the redesign): the admin types a code on
// EmDash's approval page; Lead delivery uses the access once, then throws it away.

const PAGE = "/enquiries";
const ORIGIN = "https://crumb.test";
const CODE = `${ORIGIN}/_emdash/api/oauth/device/code`;
const TOKEN = `${ORIGIN}/_emdash/api/oauth/device/token`;
const REVOKE = `${ORIGIN}/_emdash/api/oauth/token/revoke`;
const LIST = `${ORIGIN}/_emdash/api/plugins/emdash-forms/forms/list`;
const UPDATE = `${ORIGIN}/_emdash/api/plugins/emdash-forms/forms/update`;
const APPROVAL_PAGE = `${ORIGIN}/_emdash/admin/device`;
const DEVICE = "dev1ce-c0de-very-secret-value";
const ACCESS = "ec_oat_access-secret-value";
const REFRESH = "ec_ort_refresh-secret-value";
const ZAPIER = "https://hooks.zapier.com/hooks/catch/987/secretpath/";
const SECRETS = [
	DEVICE,
	ACCESS,
	REFRESH,
	"ec_oat_",
	"ec_ort_",
	"device_code",
	"access_token",
	"refresh_token",
];
const OFF_NOTE = "EmDash did not offer its one-step approval just now";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type User = Awaited<ReturnType<PluginRuntimeTestHost["fixtures"]["user"]>>;

const D: Delivery = {
	id: "d1aaaaaaaa",
	kind: "email",
	name: "Contact form → Shop inbox",
	forms: ["contact"],
	on: true,
	repeat: "off",
	holdSpam: false,
	createdAt: "2026-10-20T00:00:00.000Z",
	to: ["shop@crumb.test"],
};

const CONTACT: KnownForm = {
	slug: "contact",
	name: "Contact form",
	fields: [],
	source: "enquiry",
	addedAt: "2026-10-01T00:00:00.000Z",
	days: [],
};

/** A site with one delivery whose form was never connected; "Check this site" said `reach`. */
async function start(reach: "self" | "email" = "self") {
	host = await createPluginRuntimeTestHost({
		site: { name: "Crumb & Co.", url: ORIGIN, locale: "en" },
	});
	const runtime = host;
	const admin = await runtime.fixtures.user({
		email: "anna@crumb.test",
		name: "Anna Baker",
		role: "admin",
	});
	await runtime.admin.loadPage(PAGE, { user: admin });
	const config = (await runtime.inspect.kv.get<Config>("config"))!;
	await runtime.fixtures.plugin.kv("config", {
		...config,
		deliveries: [D],
		reach: { result: reach, at: new Date().toISOString() },
	});
	await runtime.fixtures.plugin.kv("forms", { contact: CONTACT });
	return { runtime, admin, key: config.key };
}

const codeAnswer = (extra: Record<string, unknown> = {}) =>
	Response.json({
		data: {
			device_code: DEVICE,
			user_code: "ABCD-EFGH",
			verification_uri: APPROVAL_PAGE,
			expires_in: 900,
			interval: 5,
			...extra,
		},
	});
const approved = () =>
	Response.json({ data: { access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer" } });
const listAnswer = (webhookUrl?: string) =>
	Response.json({
		data: {
			items: [
				{
					id: "form-1",
					slug: "contact",
					name: "Contact form",
					pages: [
						{
							fields: [
								{ name: "name", label: "Your name", type: "text" },
								{ name: "email", label: "Email", type: "email" },
							],
						},
					],
					settings: { notifyEmails: [], ...(webhookUrl ? { webhookUrl } : {}) },
				},
				{ id: "form-2", slug: "wedding-cakes", name: "Wedding cakes", pages: [], settings: {} },
			],
			hasMore: false,
		},
	});

const connect = (runtime: PluginRuntimeTestHost, user: User) =>
	runtime.admin.act(PAGE, "connect", { user, value: { id: D.id, form: "contact" } });
const finish = (runtime: PluginRuntimeTestHost, user: User) =>
	runtime.admin.act(PAGE, "connect_finish", { user, value: { id: D.id, form: "contact" } });

function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) =>
		block.type === "accordion" ? [block, ...flatten(block.blocks)] : [block],
	);
}

const text = (response: BlockResponse) => JSON.stringify(response.blocks);
const requests = (runtime: PluginRuntimeTestHost, url: string) =>
	runtime.http.requests().filter((r) => r.url === url);
const bodyOf = (request: { body: Uint8Array }) =>
	JSON.parse(new TextDecoder().decode(request.body));

function link(response: BlockResponse) {
	for (const block of flatten(response.blocks)) {
		if (block.type !== "actions") continue;
		for (const element of block.elements) if (element.type === "link") return element;
	}
	return undefined;
}

function button(response: BlockResponse, label: string) {
	for (const block of flatten(response.blocks)) {
		if (block.type !== "actions") continue;
		for (const element of block.elements)
			if (element.type === "button" && element.label === label) return element;
	}
	return undefined;
}

function instructionsOpen(response: BlockResponse): boolean | undefined {
	const accordion = response.blocks.find(
		(b) => b.type === "accordion" && b.label.startsWith("Instructions for your web person"),
	);
	return accordion?.type === "accordion" ? accordion.default_open : undefined;
}

async function approvalEntries(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.kv.list()).filter((e) => e.id.startsWith("approval:"));
}

/**
 * Nothing secret anywhere: screens, toasts, storage, emails. The device code may wait in its own
 * `approval:` entry while an approval is open, and nowhere else.
 */
async function expectNoSecrets(runtime: PluginRuntimeTestHost, responses: BlockResponse[]) {
	const seen = [
		JSON.stringify(responses),
		JSON.stringify((await runtime.inspect.kv.list()).filter((e) => !e.id.startsWith("approval:"))),
		JSON.stringify(await runtime.inspect.storage.list("deliveries")),
		JSON.stringify(await runtime.inspect.storage.list("enquiries")),
		JSON.stringify(await runtime.inspect.email()),
	].join("\n");
	for (const secret of SECRETS) expect(seen).not.toContain(secret);
	const open = JSON.stringify(await approvalEntries(runtime));
	for (const secret of [ACCESS, REFRESH, "ec_oat_", "ec_ort_", "access_token", "refresh_token"])
		expect(open).not.toContain(secret);
}

describe("one-click connect: when it is offered", () => {
	it("is not offered when the site cannot call its own address: written instructions only", async () => {
		const { runtime, admin } = await start("email");
		const screen = await connect(runtime, admin);
		expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});
		expect(text(screen)).not.toContain("Your code");
		expect(text(screen)).not.toContain("Connect in one step");
		expect(instructionsOpen(screen)).toBe(true);
		expect(requests(runtime, CODE)).toHaveLength(0);
	});

	it("shows the code and a plain link to EmDash's approval page, with no code filled in", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		const screen = await connect(runtime, admin);
		expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});
		expect(screen.blocks).toContainEqual({
			type: "fields",
			fields: [{ label: "Your code", value: "ABCD-EFGH" }],
		});
		expect(link(screen)).toEqual({
			type: "link",
			label: "Open the approval page",
			target: { kind: "external", url: APPROVAL_PAGE },
			appearance: "secondary",
		});
		expect(text(screen)).not.toContain("?code=");
		expect(text(screen)).toContain("2. Type ABCD-EFGH in its Device code box.");
		expect(text(screen)).toContain(
			"3. Press Authorize only if you opened that page from Lead delivery just now. If someone sent you a link or a code, press Deny.",
		);
		expect(text(screen)).toContain(
			"Lead delivery uses it once to connect this form, then throws it away.",
		);
		expect(button(screen, "Done, connect")).toMatchObject({ style: "primary" });
		// The written way is still there, folded.
		expect(instructionsOpen(screen)).toBe(false);
		// It asks for EmDash's admin scope.
		expect(bodyOf(requests(runtime, CODE)[0]!)).toEqual({
			client_id: "lead-delivery",
			scope: "admin",
		});
		await expectNoSecrets(runtime, [screen]);
	});

	it("keeps the same code when the screen is drawn again", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		const again = await connect(runtime, admin);
		expect(text(again)).toContain("ABCD-EFGH");
		const emailed = await runtime.admin.submit(
			PAGE,
			"email_instructions",
			{ to: "sam@pixel.dev" },
			{ user: admin, blockId: `instructions:${D.id}:contact` },
		);
		expect(text(emailed)).toContain("ABCD-EFGH");
		expect(requests(runtime, CODE)).toHaveLength(1);
	});

	it("is never offered to an Editor, and an Editor cannot press Done, connect", async () => {
		const { runtime } = await start();
		const editor = await runtime.fixtures.user({ email: "client@crumb.test", role: "editor" });
		const opened = await connect(runtime, editor);
		expect(opened.toast).toEqual({ type: "error", message: "Only an admin can change this." });
		expect(text(opened)).not.toContain("Your code");
		const finished = await finish(runtime, editor);
		expect(finished.toast).toEqual({ type: "error", message: "Only an admin can change this." });
		expect(requests(runtime, CODE)).toHaveLength(0);
		expect(requests(runtime, TOKEN)).toHaveLength(0);
	});
});

describe("one-click connect: Done, connect", () => {
	it("connects the form, remembers every form, throws the access away and keeps nothing", async () => {
		const { runtime, admin, key } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		const opened = await connect(runtime, admin);
		await runtime.http.respond(TOKEN, approved());
		await runtime.http.respond(LIST, listAnswer());
		await runtime.http.respond(UPDATE, Response.json({ data: { id: "form-1" } }));
		await runtime.http.respond(REVOKE, Response.json({ data: { revoked: true } }));
		const done = await finish(runtime, admin);
		expect(validateBlockResponse(done, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});
		expect(done.toast).toEqual({
			type: "success",
			message:
				"Contact form is connected. Send yourself an enquiry through it on your site to check.",
		});
		expect(text(done)).toContain("Not sending yet: Contact form is connected.");

		const inbound = `${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${key}`;
		const [update] = requests(runtime, UPDATE);
		expect(bodyOf(update!)).toEqual({ id: "form-1", settings: { webhookUrl: inbound } });
		expect(update!.headers.authorization).toBe(`Bearer ${ACCESS}`);
		expect(requests(runtime, LIST)[0]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
		const revokes = requests(runtime, REVOKE);
		expect(revokes).toHaveLength(1);
		expect(bodyOf(revokes[0]!)).toEqual({ token: REFRESH });

		const forms = (await runtime.inspect.kv.get<Record<string, KnownForm>>("forms"))!;
		expect(forms.contact).toMatchObject({ connectedWay: "straight", source: "definition" });
		expect(forms.contact!.fields.map((f) => f.key)).toEqual(["name", "email"]);
		expect(forms["wedding-cakes"]).toMatchObject({ name: "Wedding cakes" });
		expect(await approvalEntries(runtime)).toEqual([]);
		expect((await runtime.inspect.kv.get<Config>("config"))!.accessLeft).toBeUndefined();
		await expectNoSecrets(runtime, [opened, done]);

		// Used once: pressed again, it starts over with a new code.
		await runtime.http.respond(CODE, codeAnswer({ user_code: "WXYZ-2345" }));
		const again = await finish(runtime, admin);
		expect(again.toast).toEqual({
			type: "info",
			message: "That code was already used or ran out. Here is a new one.",
		});
		expect(text(again)).toContain("WXYZ-2345");
	});

	it("says when it is not approved yet or EmDash is busy, and keeps the code", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		await runtime.http.respond(
			TOKEN,
			Response.json({ error: "authorization_pending" }, { status: 400 }),
		);
		const pending = await finish(runtime, admin);
		expect(pending.toast?.type).toBe("info");
		expect(pending.toast?.message).toContain("EmDash has not been approved yet.");
		expect(text(pending)).toContain("ABCD-EFGH");
		await runtime.http.respond(TOKEN, Response.json({ error: { code: "BUSY" } }, { status: 503 }));
		const busy = await finish(runtime, admin);
		expect(busy.toast?.message).toBe(
			"EmDash is busy. Wait a minute, then press Done, connect again.",
		);
		expect(text(busy)).toContain("ABCD-EFGH");
		expect(await approvalEntries(runtime)).toHaveLength(1);
		expect(requests(runtime, CODE)).toHaveLength(1);
		await expectNoSecrets(runtime, [pending, busy]);
	});

	it("starts again with a new code after a denial or an expired code", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		await runtime.http.respond(TOKEN, Response.json({ error: "access_denied" }, { status: 400 }));
		await runtime.http.respond(CODE, codeAnswer({ user_code: "JKLM-NPQR" }));
		const denied = await finish(runtime, admin);
		expect(denied.toast?.message).toContain("The approval was turned down");
		expect(text(denied)).toContain("JKLM-NPQR");
		await runtime.http.respond(TOKEN, Response.json({ error: "expired_token" }, { status: 400 }));
		await runtime.http.respond(CODE, codeAnswer({ user_code: "STUV-WXYZ" }));
		const expired = await finish(runtime, admin);
		expect(expired.toast?.message).toBe("That code ran out after 15 minutes. Here is a new one.");
		expect(text(expired)).toContain("STUV-WXYZ");
		expect(await approvalEntries(runtime)).toHaveLength(1);
	});

	it("never replaces another address on the form without asking, and asks once more to replace it", async () => {
		const { runtime, admin, key } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		await runtime.http.respond(TOKEN, approved());
		await runtime.http.respond(LIST, listAnswer(ZAPIER));
		await runtime.http.respond(REVOKE, Response.json({ data: {} }));
		const asked = await finish(runtime, admin);
		expect(validateBlockResponse(asked, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});
		expect(requests(runtime, UPDATE)).toHaveLength(0);
		expect(requests(runtime, REVOKE)).toHaveLength(1);
		expect(text(asked)).toContain(
			"This form already sends each enquiry to hooks.zapier.com. Lead delivery would replace it, and that address would stop getting enquiries.",
		);
		const replace = button(asked, "Replace it")!;
		expect(replace.confirm).toMatchObject({
			title: "Replace the form's other address?",
			confirm: "Replace it",
			deny: "Keep it",
		});
		// The other address itself is never kept or shown: only its host.
		const kept = JSON.stringify(await runtime.inspect.kv.list());
		expect(kept).not.toContain("secretpath");
		expect(text(asked)).not.toContain("secretpath");

		// Keep it: written instructions for the email way, which keeps the other address.
		const keep = await runtime.admin.act(PAGE, "connect_keep", {
			user: admin,
			value: button(asked, "Keep it")!.value,
		});
		expect(text(keep)).toContain("The form keeps sending to hooks.zapier.com.");
		expect(text(keep)).toContain("stays as it is");
		expect(text(keep)).toContain("notifyEmails");
		expect(text(keep)).not.toContain("set the form's webhookUrl");
		expect(instructionsOpen(keep)).toBe(true);

		// Replace it: one more approval, then the address is replaced.
		await runtime.http.respond(CODE, codeAnswer({ user_code: "REPL-ACE2" }));
		const again = await runtime.admin.act(PAGE, "connect_replace", {
			user: admin,
			value: replace.value,
		});
		expect(text(again)).toContain("REPL-ACE2");
		expect(text(again)).toContain("Approve once more and Lead delivery replaces hooks.zapier.com");
		await runtime.http.respond(TOKEN, approved());
		await runtime.http.respond(LIST, listAnswer(ZAPIER));
		await runtime.http.respond(UPDATE, Response.json({ data: {} }));
		await runtime.http.respond(REVOKE, Response.json({ data: {} }));
		const done = await finish(runtime, admin);
		expect(done.toast?.type).toBe("success");
		expect(bodyOf(requests(runtime, UPDATE)[0]!)).toEqual({
			id: "form-1",
			settings: { webhookUrl: `${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${key}` },
		});
		await expectNoSecrets(runtime, [asked, keep, again, done]);
	});

	it("does not replace a different address than the one agreed", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		await runtime.http.respond(TOKEN, approved());
		await runtime.http.respond(LIST, listAnswer(ZAPIER));
		await runtime.http.respond(REVOKE, Response.json({ data: {} }));
		const asked = await finish(runtime, admin);
		await runtime.http.respond(CODE, codeAnswer());
		await runtime.admin.act(PAGE, "connect_replace", {
			user: admin,
			value: button(asked, "Replace it")!.value,
		});
		await runtime.http.respond(TOKEN, approved());
		await runtime.http.respond(LIST, listAnswer("https://hook.eu1.make.com/other"));
		await runtime.http.respond(REVOKE, Response.json({ data: {} }));
		const second = await finish(runtime, admin);
		expect(requests(runtime, UPDATE)).toHaveLength(0);
		expect(text(second)).toContain("This form already sends each enquiry to hook.eu1.make.com.");
	});

	it("replaces an old Lead delivery address of this site without asking", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		await runtime.http.respond(TOKEN, approved());
		await runtime.http.respond(
			LIST,
			listAnswer(`${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${"o".repeat(32)}`),
		);
		await runtime.http.respond(UPDATE, Response.json({ data: {} }));
		await runtime.http.respond(REVOKE, Response.json({ data: {} }));
		expect((await finish(runtime, admin)).toast?.type).toBe("success");
		expect(requests(runtime, UPDATE)).toHaveLength(1);
	});

	it("says why when the change is refused, still throws the access away, and opens the instructions", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		await runtime.http.respond(TOKEN, approved());
		await runtime.http.respond(LIST, listAnswer());
		await runtime.http.respond(
			UPDATE,
			Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }),
		);
		await runtime.http.respond(REVOKE, Response.json({ data: {} }));
		const failed = await finish(runtime, admin);
		expect(validateBlockResponse(failed, { pluginPagePaths: [PAGE] })).toEqual({
			valid: true,
			errors: [],
		});
		expect(failed.toast).toEqual({
			type: "error",
			message: "Not connected: EmDash's forms did not accept the change (403).",
		});
		expect(requests(runtime, REVOKE)).toHaveLength(1);
		expect(instructionsOpen(failed)).toBe(true);
		const forms = (await runtime.inspect.kv.get<Record<string, KnownForm>>("forms"))!;
		expect(forms.contact!.connectedAt).toBeUndefined();
		await expectNoSecrets(runtime, [failed]);
	});

	it("retries a failed revoke once, then tells the admin on the page and by email", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		await runtime.http.respond(TOKEN, approved());
		await runtime.http.respond(LIST, listAnswer());
		await runtime.http.respond(UPDATE, Response.json({ data: {} }));
		await runtime.http.respond(REVOKE, new Response("", { status: 500 }));
		await runtime.http.respond(REVOKE, new Response("", { status: 502 }));
		const done = await finish(runtime, admin);
		expect(requests(runtime, REVOKE)).toHaveLength(2);
		expect(done.toast?.type).toBe("success");
		expect(text(done)).toContain("A one-time access could not be thrown away");
		expect(text(done)).toContain("EmDash ends it by itself within 90 days");
		const emails = (await runtime.inspect.email()) as Array<{
			to: string;
			subject: string;
			text: string;
		}>;
		const alert = emails.find((e) => e.subject.includes("could not be thrown away"))!;
		expect(alert.to).toBe("anna@crumb.test");
		expect(alert.text).toContain(
			"ask another admin to open Users, disable your account and enable it again",
		);
		const home = await runtime.admin.act(PAGE, "home", { user: admin });
		expect(text(home)).toContain("A one-time access could not be thrown away");
		await expectNoSecrets(runtime, [done, home]);
		const dismissed = await runtime.admin.act(PAGE, "dismiss_access", { user: admin });
		expect(text(dismissed)).not.toContain("could not be thrown away");
	});

	it.each([
		[
			"the change was refused",
			async (runtime: PluginRuntimeTestHost) => {
				await runtime.http.respond(TOKEN, approved());
				await runtime.http.respond(LIST, listAnswer());
				await runtime.http.respond(UPDATE, Response.json({}, { status: 403 }));
			},
		],
		[
			"a token came in a changed shape",
			async (runtime: PluginRuntimeTestHost) => {
				await runtime.http.respond(TOKEN, Response.json({ data: { access_token: ACCESS } }));
			},
		],
	])(
		"tells the admin when a failed revoke follows %s, without saying it connected",
		async (_name, answers) => {
			const { runtime, admin } = await start();
			await runtime.http.respond(CODE, codeAnswer());
			await connect(runtime, admin);
			await answers(runtime);
			await runtime.http.respond(REVOKE, new Response("", { status: 500 }));
			await runtime.http.respond(REVOKE, new Response("", { status: 500 }));
			const screen = await finish(runtime, admin);
			expect(requests(runtime, REVOKE)).toHaveLength(2);
			const home = await runtime.admin.act(PAGE, "home", { user: admin });
			expect(text(home)).toContain("A one-time access could not be thrown away");
			expect(text(home)).toContain(
				"Lead delivery used the access you approved in EmDash for Contact form",
			);
			const emails = (await runtime.inspect.email()) as Array<{ subject: string; text: string }>;
			const alert = emails.find((e) => e.subject.includes("could not be thrown away"))!;
			expect(alert.text).toContain("while connecting the Contact form");
			expect(alert.text).not.toContain("Lead delivery connected");
			expect(
				(await runtime.inspect.kv.get<Record<string, KnownForm>>("forms"))!.contact!.connectedAt,
			).toBeUndefined();
			await expectNoSecrets(runtime, [screen, home]);
		},
	);

	it("tells a screen left open with an old code which code is current, and exchanges nothing", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		const old = await connect(runtime, admin);
		await runtime.admin.act(PAGE, "open", { user: admin, value: D.id });
		await runtime.http.respond(CODE, codeAnswer({ user_code: "NEWC-ODE2" }));
		await connect(runtime, admin);
		const stale = await runtime.admin.act(PAGE, "connect_finish", {
			user: admin,
			value: button(old, "Done, connect")!.value,
		});
		expect(button(old, "Done, connect")!.value).toEqual({
			id: D.id,
			form: "contact",
			code: "ABCD-EFGH",
		});
		expect(stale.toast?.type).toBe("info");
		expect(stale.toast?.message).toContain("replaced by a newer one: NEWC-ODE2");
		expect(text(stale)).toContain("NEWC-ODE2");
		expect(requests(runtime, TOKEN)).toHaveLength(0);
	});

	it("throws the code away on Skip for now and on I have done this", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		expect(await approvalEntries(runtime)).toHaveLength(1);
		await runtime.admin.act(PAGE, "open", { user: admin, value: D.id });
		expect(await approvalEntries(runtime)).toHaveLength(0);
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		await runtime.admin.act(PAGE, "connected", {
			user: admin,
			value: { id: D.id, form: "contact" },
		});
		expect(await approvalEntries(runtime)).toHaveLength(0);
	});
});

describe("one-click connect: fail safe", () => {
	const UNEXPECTED: Array<[string, () => Response]> = [
		["EmDash removed the flow (404)", () => new Response("Not found", { status: 404 })],
		[
			"the client name is refused",
			() => Response.json({ error: "invalid_client" }, { status: 400 }),
		],
		[
			"an unknown error",
			() => Response.json({ error: { code: "SOMETHING_NEW" } }, { status: 400 }),
		],
		["an answer that is not JSON", () => new Response("<html>oops</html>", { status: 200 })],
		["a changed shape", () => Response.json({ deviceCode: DEVICE, userCode: "ABCD-EFGH" })],
	];

	it.each(UNEXPECTED)(
		"falls back to the written instructions when asking for a code meets %s",
		async (_name, answer) => {
			const { runtime, admin } = await start();
			await runtime.http.respond(CODE, answer());
			const screen = await connect(runtime, admin);
			expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] })).toEqual({
				valid: true,
				errors: [],
			});
			expect(screen.toast).toBeUndefined();
			expect(text(screen)).toContain(OFF_NOTE);
			expect(text(screen)).not.toContain("Your code");
			expect(text(screen)).not.toContain("Connect in one step");
			expect(instructionsOpen(screen)).toBe(true);
			expect(await approvalEntries(runtime)).toEqual([]);
			await expectNoSecrets(runtime, [screen]);
		},
	);

	it("falls back when the site cannot reach its own address after all", async () => {
		const { runtime, admin } = await start();
		// No answer queued: the request fails as a network error does.
		const screen = await connect(runtime, admin);
		expect(text(screen)).toContain(OFF_NOTE);
		expect(instructionsOpen(screen)).toBe(true);
	});

	it.each([
		...UNEXPECTED,
		["no refresh token", () => Response.json({ data: { access_token: ACCESS } })],
	])(
		"falls back to the written instructions when Done, connect meets %s",
		async (_name, answer) => {
			const { runtime, admin } = await start();
			await runtime.http.respond(CODE, codeAnswer());
			await connect(runtime, admin);
			await runtime.http.respond(TOKEN, answer());
			await runtime.http.respond(REVOKE, Response.json({ data: {} }));
			const screen = await finish(runtime, admin);
			expect(validateBlockResponse(screen, { pluginPagePaths: [PAGE] })).toEqual({
				valid: true,
				errors: [],
			});
			expect(screen.toast).toBeUndefined();
			expect(text(screen)).toContain(OFF_NOTE);
			expect(text(screen)).not.toContain("Your code");
			expect(instructionsOpen(screen)).toBe(true);
			expect(requests(runtime, LIST)).toHaveLength(0);
			expect(await approvalEntries(runtime)).toEqual([]);
			await expectNoSecrets(runtime, [screen]);
		},
	);

	it("says EmDash is busy when asking for a code gets 429, and offers to try again", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, Response.json({ error: "rate" }, { status: 429 }));
		const screen = await connect(runtime, admin);
		expect(text(screen)).toContain("EmDash is busy just now.");
		expect(button(screen, "Connect in one step")).toBeDefined();
		expect(instructionsOpen(screen)).toBe(true);
	});
});

describe("one-click connect: the every-minute task", () => {
	it("deletes codes that ran out and keeps live ones", async () => {
		const { runtime, admin } = await start();
		await runtime.http.respond(CODE, codeAnswer());
		await connect(runtime, admin);
		const [live] = await approvalEntries(runtime);
		await runtime.fixtures.plugin.kv("approval:old:user", {
			...(live!.data as object),
			expiresAt: Date.now() - 1000,
		});
		expect(await approvalEntries(runtime)).toHaveLength(2);
		await runtime.transport.invokeHook("cron", { name: "maintenance", data: null });
		expect((await approvalEntries(runtime)).map((e) => e.id)).toEqual([live!.id]);
	});
});
