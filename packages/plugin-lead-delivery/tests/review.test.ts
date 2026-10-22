// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { Config, Delivery, Send } from "../src/types.js";

// What the coordinator review asked for: a site with no name, and proof that the email way never sends anything to the private address.

const PAGE = "/enquiries";
const ORIGIN = "https://crumb.test";
const HOOK = "https://hooks.zapier.com/hooks/catch/123/abc/";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function start(name = "Crumb & Co.") {
	host = await createPluginRuntimeTestHost({ site: { name, url: ORIGIN, locale: "en" } });
	const admin = await host.fixtures.user({ email: "anna@crumb.test", name: "Anna", role: "admin" });
	await host.admin.loadPage(PAGE, { user: admin });
	return { runtime: host, admin };
}

type Admin = Awaited<ReturnType<PluginRuntimeTestHost["fixtures"]["user"]>>;

async function key(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.kv.get<Config>("config"))!.key;
}

async function addApp(runtime: PluginRuntimeTestHost, _admin: Admin, url: string, name: string) {
	const config = (await runtime.inspect.kv.get<Config>("config"))!;
	const app: Delivery = {
		id: "app0000001",
		kind: "app",
		name,
		forms: "all",
		on: true,
		repeat: "off",
		holdSpam: false,
		createdAt: new Date().toISOString(),
		app: "zapier",
		url,
		secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0",
	};
	await runtime.fixtures.plugin.kv("config", { ...config, deliveries: [app] });
}

async function inbound(runtime: PluginRuntimeTestHost, id: string) {
	return runtime.actions.routes.request("inbound", {
		method: "POST",
		url: `${ORIGIN}/_emdash/api/plugins/lead-delivery/inbound?key=${await key(runtime)}`,
		body: {
			event: "form.submission",
			formId: "contact",
			formName: "Contact us",
			submissionId: id,
			data: { name: "Tom Reyes", email: "tom@example.com" },
			submittedAt: new Date().toISOString(),
		},
	});
}

function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) => {
		if (block.type === "tab") return [block, ...block.panels.flatMap((p) => flatten(p.blocks))];
		if (block.type === "accordion") return [block, ...flatten(block.blocks)];
		return [block];
	});
}

const text = (response: BlockResponse) => JSON.stringify(response.blocks);

describe("a site with no name", () => {
	it("starts alert subjects with the site's address", async () => {
		const { runtime, admin } = await start("");
		await addApp(runtime, admin, HOOK, "Zapier");
		await runtime.http.respond(HOOK, new Response("", { status: 404 }));
		await inbound(runtime, "01N");
		const emails = JSON.stringify(await runtime.inspect.email());
		expect(emails).toContain("crumb.test: an enquiry could not be delivered");
		expect(emails).not.toContain("Your website");
	});
});

describe("the email way never sends to the private address", () => {
	it("cancels an email to the private domain from any sender, even an old address", async () => {
		const { runtime } = await start();
		for (const source of ["emdash-forms", "someone-else", "system"]) {
			expect(
				await runtime.transport.invokeHook("email:beforeSend", {
					source,
					message: { to: " Enquiries-OLD@Lead-Delivery.invalid ", subject: "x", text: "y" },
				}),
			).toBe(false);
		}
		expect(await runtime.inspect.storage.list("deliveries")).toEqual([]);
	});

	it("leaves the owner's own notification alone and takes the private domain out of copies", async () => {
		const { runtime } = await start();
		const own = {
			to: "anna@crumb.test",
			subject: "New submission: Contact us",
			text: "Your name: Tom",
		};
		expect(
			await runtime.transport.invokeHook("email:beforeSend", {
				source: "emdash-forms",
				message: own,
			}),
		).toEqual(own);
		const copied = await runtime.transport.invokeHook("email:beforeSend", {
			source: "emdash-forms",
			message: {
				...own,
				cc: [`enquiries-${await key(runtime)}@lead-delivery.invalid`, "sam@pixel.dev"],
			},
		});
		expect(copied).toEqual({ ...own, cc: ["sam@pixel.dev"] });
	});

	it("keeps an email in a changed format as text, flags it, and says so on the page", async () => {
		const { runtime, admin } = await start();
		await addApp(runtime, admin, HOOK, "Zapier");
		const result = await runtime.transport.invokeHook("email:beforeSend", {
			source: "emdash-forms",
			message: {
				to: `enquiries-${await key(runtime)}@lead-delivery.invalid`,
				subject: "Contact us got a new entry",
				text: "<table><tr><td>Tom Reyes</td><td>tom@example.com</td></tr></table>",
			},
		});
		expect(result).toBe(false);
		const [row] = (await runtime.inspect.storage.list<Send>("deliveries")).map((r) => r.data);
		expect(row).toMatchObject({ email: "tom@example.com", status: "retrying" });
		expect(row?.notes).toContain("Sent as text: its fields could not be read");
		const page = await runtime.admin.loadPage(PAGE, { user: admin });
		expect(text(page)).toContain(
			"An enquiry from Contact us got a new entry was read as plain text",
		);

		await runtime.http.respond(HOOK, new Response("ok"));
		await runtime.transport.invokeHook("cron", { name: "deliver", data: null });
		const sent = runtime.http.requests().find((r) => r.url === HOOK);
		expect(new TextDecoder().decode(sent!.body)).toContain("<td>Tom Reyes</td>");
	});
});
