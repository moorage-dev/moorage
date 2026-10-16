// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { BlockResponse } from "@emdash-cms/blocks";
import { afterEach, describe, expect, it } from "vitest";

import { handleAdmin } from "../src/admin.js";
import type { Connection, RestoreRecord } from "../src/state.js";
import {
	ago,
	buttons,
	dated,
	edited,
	enquiry,
	find,
	HOUR,
	sql,
	startSite,
	text,
	valid,
	type Site,
} from "./helpers.js";

let site: Site | undefined;

afterEach(async () => {
	await site?.host.dispose();
	site = undefined;
});

async function act(
	s: Site,
	input: Record<string, unknown>,
	now = Date.now(),
): Promise<BlockResponse> {
	return valid(await handleAdmin(input, s.admin, s.ctx, now));
}

/** Connect as if Restore had been set up six hours ago. */
async function connected(options: Parameters<typeof startSite>[0] = {}): Promise<Site> {
	site = await startSite(options);
	const response = await act(
		site,
		{ type: "form_submit", action_id: "connect", values: { key: "good-key" } },
		Date.now() - 6 * HOUR,
	);
	expect(text(response)).toContain("Connected");
	return site;
}

/** Rosie's morning: a good edit before the import, the import, then Maria's edits and an enquiry. */
async function morning(s: Site) {
	const maria = await s.host.fixtures.user({
		email: "maria@rosiesbakery.test",
		name: "Maria",
		role: "editor",
	});
	// Maria joined after the import, so going back before it takes her access away.
	await sql("UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?", [
		ago(3),
		ago(3),
		maria.id,
	]);
	const sourdough = await s.host.fixtures.content("products", {
		slug: "sourdough",
		data: { title: "Sourdough", price: "4.50" },
	});
	await dated("products", sourdough.id, ago(5), s.admin.id);
	const products = [];
	for (let i = 0; i < 6; i++) {
		const product = await s.host.fixtures.content("products", {
			slug: `p${i}`,
			data: { title: `Loaf ${i}`, price: "1" },
		});
		await dated("products", product.id, ago(7), s.admin.id);
		await edited(
			"products",
			product.id,
			new Date(Date.now() - 4 * HOUR + i * 1000).toISOString(),
			s.admin.id,
		);
		products.push(product);
	}
	const hours = await s.host.fixtures.content("pages", {
		slug: "opening-hours",
		data: {
			title: "Opening hours",
			content: [
				{ _type: "block", children: [{ _type: "span", text: "Monday to Friday 7:30 to 16:00." }] },
			],
		},
	});
	await dated("pages", hours.id, ago(7), s.admin.id);
	await edited("pages", hours.id, ago(1), maria.id);
	await enquiry("Jane Hollis", "jane@example.com", ago(2));
	return { maria, hours, products };
}

describe("before setup", () => {
	it("says plainly what it is and is not, and asks for a key from Cloudflare", async () => {
		site = await startSite();
		const response = await act(site, { type: "page_load", page: "/restore" });
		const all = text(response);
		expect(all).toContain("What this does, and what it is not");
		expect(all).toContain("Not an off-site backup");
		expect(all).toContain("Set it up on the day a site launches");
		expect(all).toContain("a key from Cloudflare, the company your site runs on");
		expect(find(response, "form")?.fields[0]).toMatchObject({
			type: "secret_input",
			label: "Key from Cloudflare",
		});
		// No jargon in the owner's path.
		for (const word of ["API token", "D1", "bookmark", "wrangler", "Moorage"])
			expect(all).not.toContain(word);
	});

	it("gives the web person instructions to copy", async () => {
		site = await startSite();
		const response = await act(site, { type: "block_action", action_id: "web_person" });
		expect(find(response, "code")?.code).toContain("Account > D1 > Edit");
	});

	it("shows the alternatives on a site that isn't on Cloudflare", async () => {
		site = await startSite();
		const response = await act(site, { type: "block_action", action_id: "not_cloudflare" });
		expect(text(response)).toContain("Going back in time isn't available on this site");
		expect(text(response)).toContain("Settings > Backups");
	});

	it("tells an Editor to ask an administrator and shows nothing else", async () => {
		site = await startSite();
		const response = valid(
			await handleAdmin({ type: "page_load" }, { id: "e", role: 40 }, site.ctx),
		);
		expect(response.blocks).toHaveLength(2);
		expect(text(response)).toContain("Only an administrator can put the site back");
	});
});

describe("connecting", () => {
	it.each([
		["refused-key", "Cloudflare did not accept that key", "error"],
		["no-d1-key", "That key can't put sites back", "error"],
		["elsewhere-key", "We couldn't find this site's data in that Cloudflare account", "alert"],
	])("explains a key that doesn't work (%s) and saves nothing", async (key, title, variant) => {
		site = await startSite({ otherDatabases: ["harbour-cafe"] });
		const response = await act(site, {
			type: "form_submit",
			action_id: "connect",
			values: { key },
		});
		expect(find(response, "banner", (b) => b.title === title)?.variant).toBe(variant);
		expect(await site.ctx.kv.get("connection")).toBeNull();
		expect(await site.ctx.settings.get("token")).toBeNull();
	});

	it("finds this site's database by itself and lists every site the key reaches, in red", async () => {
		site = await startSite({ otherDatabases: ["harbour-cafe", "smith-joinery"] });
		const response = await act(site, {
			type: "form_submit",
			action_id: "connect",
			values: { key: "good" },
		});
		const reach = find(response, "banner", (b) => b.variant === "error");
		expect(reach?.title).toBe("This key can change 3 sites, not only this one");
		expect(reach?.description).toContain("rosies-bakery (this site), harbour-cafe, smith-joinery");
		const connection = await site.ctx.kv.get<Connection>("connection");
		expect(connection).toMatchObject({
			databaseName: "rosies-bakery",
			windowDays: 30,
			zone: "UTC",
		});
		expect(await site.ctx.settings.get("token")).toBe("good");
		// Admins are emailed by default.
		expect(await site.ctx.kv.get("emails")).toEqual(["rosie@rosiesbakery.test"]);
	});

	it("says it in one plain line when the key reaches only this site", async () => {
		site = await startSite();
		const response = await act(site, {
			type: "form_submit",
			action_id: "connect",
			values: { key: "good" },
		});
		expect(find(response, "banner", (b) => b.variant === "error")).toBeUndefined();
		expect(text(response)).toContain("This key can change only this site's data.");
	});
});

describe("picking a moment", () => {
	it("lists recent changes with a go-back button on each row, a burst as one row", async () => {
		const s = await connected();
		await morning(s);
		const response = await act(s, { type: "page_load" });
		const table = find(response, "table", (t) => t.block_id === "changes");
		const rows = table?.rows.map((row) => String(row.what)) ?? [];
		expect(rows[0]).toMatch(/^Opening hours \(page\) edited · Maria, today/);
		expect(rows.some((row) => row.startsWith("6 products changed at once · You"))).toBe(true);
		expect(rows.some((row) => row.startsWith("Enquiry from the Contact form · A visitor"))).toBe(
			true,
		);
		// Two columns, so the button stays on screen on a phone.
		expect(table?.columns).toHaveLength(2);
		expect(buttons(response).find((b) => b.action_id === "pick")?.label).toMatch(
			/^Go back to \d\d:\d\d$/,
		);
	});

	it("refuses a moment before setup with an alert, not an error", async () => {
		const s = await connected();
		const response = await act(s, {
			type: "block_action",
			action_id: "pick",
			value: { at: ago(8), from: ago(8), to: ago(8), who: null, what: "x" },
		});
		const refused = find(response, "banner");
		expect(refused).toMatchObject({ variant: "alert", title: "This page can't go back that far" });
	});

	it("refuses a moment before the site was last upgraded", async () => {
		const s = await connected();
		await sql("INSERT INTO _emdash_migrations (name, timestamp) VALUES ('999_test', ?)", [ago(3)]);
		const response = await act(s, {
			type: "block_action",
			action_id: "pick",
			value: { at: ago(4), from: ago(4), to: ago(4), who: null, what: "x" },
		});
		expect(find(response, "banner")?.title).toBe("The site was upgraded after that moment");
	});

	it("refuses while another restore is running", async () => {
		const s = await connected();
		await s.ctx.kv.set("lock", { byId: "sam", byName: "Sam", at: new Date().toISOString() });
		const response = await act(s, {
			type: "block_action",
			action_id: "pick",
			value: { at: ago(4), from: ago(4), to: ago(4), who: null, what: "x" },
		});
		expect(find(response, "banner")?.title).toBe("A restore is already running");
	});

	it("turns a day, hour and minute in the site's time zone into the right moment", async () => {
		const s = await connected();
		await sql(
			"INSERT INTO options (name, value) VALUES ('site:timezone', '\"Europe/London\"') ON CONFLICT (name) DO UPDATE SET value = excluded.value",
		);
		const connection = (await s.ctx.kv.get<Connection>("connection"))!;
		await s.ctx.kv.set("connection", { ...connection, zone: "Europe/London" });
		const target = new Date(Date.now() - 2 * HOUR);
		const local = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Europe/London",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(target);
		const part = (type: string) => local.find((p) => p.type === type)?.value ?? "";
		const response = await act(s, {
			type: "form_submit",
			action_id: "pick_time",
			values: {
				day: `${part("year")}-${part("month")}-${part("day")}`,
				hour: part("hour"),
				minute: "0",
			},
		});
		expect(find(response, "header", (h) => h.text.startsWith("Go back to"))?.text).toContain(
			`${part("hour")}:00`,
		);
	});
});

describe("reviewing and restoring", () => {
	async function review(s: Site) {
		const day = await morning(s);
		const page = await act(s, { type: "page_load" });
		const pick = buttons(page).find(
			(b) => b.action_id === "pick" && JSON.stringify(b.value).includes("products"),
		);
		expect(pick).toBeDefined();
		const response = await act(s, { type: "block_action", action_id: "pick", value: pick!.value });
		return { ...day, response, pick: pick! };
	}

	it("deals with enquiries first: named, with a way to download them, before anything can be confirmed", async () => {
		const s = await connected();
		const { response } = await review(s);
		const first = find(response, "banner", (b) => b.variant === "alert");
		expect(first?.title).toMatch(/^1 enquiry came in since \d\d:\d\d and will be removed$/);
		expect(first?.description).toContain("Contact form: Jane Hollis (jane@example.com)");
		expect(text(response)).toContain(
			"https://rosies.test/_emdash/admin/plugins/emdash-forms/submissions",
		);
		expect(buttons(response).map((b) => b.action_id)).not.toContain("restore");
		expect(text(response)).not.toContain("understand");

		// Pressing the red button without dealing with them does nothing.
		const sneaky = await act(s, { type: "block_action", action_id: "restore", value: { at: "x" } });
		expect(sneaky.toast?.message).toBe("Review the moment again first");
		expect(s.sim.state.restores).toHaveLength(0);
	});

	it("shows the text of good edits that will be lost, names people, and asks for a tick before the red button", async () => {
		const s = await connected();
		const { pick } = await review(s);
		const at = (pick.value as { at: string }).at;
		const after = await act(s, { type: "block_action", action_id: "enquiries_ok" });
		const lost = find(after, "code")?.code ?? "";
		expect(lost).toContain("Opening hours (page), edited by Maria");
		expect(lost).toContain("Monday to Friday 7:30 to 16:00.");
		// The import itself is the change being undone, not a good edit.
		expect(lost).not.toContain("Loaf 3");
		const warning = find(after, "banner", (b) => b.title === "Before you go back");
		expect(warning?.description).toContain("Ask Maria to stop editing");
		expect(warning?.description).toContain("Maria (added since then) loses access");
		expect(buttons(after).map((b) => b.action_id)).not.toContain("restore");

		const ticked = await act(s, { type: "block_action", action_id: "understand", value: ["yes"] });
		const red = buttons(ticked).find((b) => b.action_id === "restore");
		expect(red).toMatchObject({ style: "danger", value: { at } });
		expect(red?.confirm).toMatchObject({ style: "danger", confirm: "Put the site back" });
	});

	it("puts the site back to the exact moment reviewed, keeps its history, and offers undo", async () => {
		const s = await connected();
		const { pick } = await review(s);
		const at = (pick.value as { at: string }).at;
		await sql(
			"INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES ('lead-delivery', 'deliveries', 'd1', '{}', ?, ?)",
			[ago(1), ago(1)],
		);
		await act(s, { type: "block_action", action_id: "enquiries_ok" });
		await act(s, { type: "block_action", action_id: "understand", value: ["yes"] });
		const done = await act(s, { type: "block_action", action_id: "restore", value: { at } });

		expect(s.sim.state.restores).toHaveLength(1);
		expect(s.sim.timeOf(s.sim.state.restores[0]!.bookmark)).toBe(Date.parse(at));
		expect(find(done, "banner")?.title).toMatch(/^Done\. Your site is back to /);
		const undo = buttons(done).find((b) => b.action_id === "undo");
		expect(undo).toMatchObject({ label: "Undo this restore", style: "danger" });
		expect(buttons(done).find((b) => b.action_id === "put_back")?.label).toBe("Put back 1 record");
		expect(find(done, "code")?.code).toContain(
			"npx wrangler d1 time-travel restore rosies-bakery --bookmark=",
		);

		const history = await s.ctx.storage.restores!.query({ orderBy: { at: "desc" } });
		expect((history.items[0]?.data as RestoreRecord).to).toBe(at);
		expect(await s.ctx.kv.get("lock")).toBeNull();
		expect(s.emails[0]?.subject).toMatch(/^Rosie's Bakery: the site was put back to /);

		// Undo is another restore, to the point just before this one.
		const undone = await act(
			s,
			{ type: "block_action", action_id: "undo", value: undo!.value },
			Date.now() + 2 * 60_000,
		);
		expect(s.sim.state.restores).toHaveLength(2);
		expect(s.sim.state.restores[1]!.bookmark).toBe((undo!.value as { point: string }).point);
		expect(find(undone, "banner")?.title).toMatch(/^Done\./);
	});

	it("puts Lead Delivery's records back when asked", async () => {
		const s = await connected();
		await s.ctx.kv.set("carry", {
			restoreId: "r1",
			rows: [
				{
					plugin_id: "lead-delivery",
					collection: "deliveries",
					id: "kept",
					data: "{}",
					created_at: ago(1),
					updated_at: ago(1),
				},
			],
		});
		const response = await act(s, { type: "block_action", action_id: "put_back" });
		expect(response.toast?.message).toBe("Put back 1 Lead Delivery record");
		expect(await sql("SELECT id FROM _plugin_storage WHERE plugin_id = 'lead-delivery'")).toEqual([
			{ id: "kept" },
		]);
	});

	it.each(["error", "timeout"] as const)(
		"says nothing was changed when Cloudflare fails (%s) and the site did not move",
		async (failure) => {
			const s = await connected();
			const { pick } = await review(s);
			await act(s, { type: "block_action", action_id: "enquiries_ok" });
			await act(s, { type: "block_action", action_id: "understand", value: ["yes"] });
			s.sim.state.failNextRestore = failure;
			const response = await act(s, {
				type: "block_action",
				action_id: "restore",
				value: pick.value,
			});
			const banner = find(response, "banner");
			expect(banner?.title).toBe("The site was not put back");
			expect(banner?.description).toContain("Nothing was changed.");
			expect(await s.ctx.kv.get("lock")).toBeNull();
		},
	);
});

describe("keeping it working", () => {
	it("saves several email addresses and refuses a wrong one", async () => {
		const s = await connected();
		const bad = await act(s, {
			type: "form_submit",
			action_id: "save_emails",
			values: { emails: "rosie@x.test, nope" },
		});
		expect(bad.toast?.type).toBe("error");
		await act(s, {
			type: "form_submit",
			action_id: "save_emails",
			values: { emails: "rosie@x.test, sam@webfolk.test" },
		});
		expect(await s.ctx.kv.get("emails")).toEqual(["rosie@x.test", "sam@webfolk.test"]);
	});

	it("emails once a day when the key stops working", async () => {
		const s = await connected();
		await s.ctx.settings.set("token", "refused-now");
		const first = await act(s, { type: "block_action", action_id: "check_now" });
		expect(find(first, "banner")?.title).toBe("Restore has stopped working");
		await act(s, { type: "block_action", action_id: "check_now" });
		expect(s.emails.filter((e) => e.subject.includes("stopped working"))).toHaveLength(1);
		expect(s.emails[0]?.subject.startsWith("Rosie's Bakery: ")).toBe(true);
	});

	it("saves a moment and offers it back", async () => {
		const s = await connected();
		const saved = await act(s, {
			type: "form_submit",
			action_id: "save_moment",
			values: { name: "Before the menu import" },
		});
		expect(find(saved, "table", (t) => t.block_id === "moments")?.rows[0]?.name).toBe(
			"Before the menu import",
		);
	});

	it("draws every screen without a site address", async () => {
		site = await startSite({ siteUrl: "" });
		await act(site, { type: "page_load" });
		await act(
			site,
			{ type: "form_submit", action_id: "connect", values: { key: "good" } },
			Date.now() - 6 * HOUR,
		);
		await morning(site);
		await act(site, { type: "page_load" });
		const page = await act(site, { type: "page_load" });
		const pick = buttons(page).find(
			(b) => b.action_id === "pick" && JSON.stringify(b.value).includes("products"),
		)!;
		const response = await act(site, {
			type: "block_action",
			action_id: "pick",
			value: pick.value,
		});
		expect(text(response)).toContain("Forms > Submissions, Export");
	});
});
