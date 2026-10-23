// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The plugin as the host runs it: built, sandboxed in Worker Loader, through the host bridge.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { justBefore } from "../src/operations.js";
import { groupChanges, iso, type Change } from "../src/site-data.js";
import { fromLocal, moment, since } from "../src/time.js";

const PAGE = "/restore";
let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function start() {
	host = await createPluginRuntimeTestHost({
		site: { name: "Rosie's Bakery", url: "https://rosies.test", locale: "en" },
	});
	return host;
}

describe("sandboxed", () => {
	it("declares only Cloudflare as a host and asks for no content, user or media access", async () => {
		const runtime = await start();
		expect(runtime.manifest.allowedHosts).toEqual(["api.cloudflare.com"]);
		expect([...runtime.manifest.capabilities].sort()).toEqual(["email:send", "network:request"]);
	});

	it("shows an administrator the setup page", async () => {
		const runtime = await start();
		const response = await runtime.admin.loadPage(PAGE);
		expect(JSON.stringify(response.blocks)).toContain("What this does, and what it is not");
		expect(runtime.http.requests()).toHaveLength(0);
	});

	it("tells an Editor to ask an administrator", async () => {
		const runtime = await start();
		const editor = await runtime.fixtures.user({
			email: "maria@rosies.test",
			name: "Maria",
			role: "editor",
		});
		const response = await runtime.admin.loadPage(PAGE, { user: editor });
		expect(JSON.stringify(response.blocks)).toContain(
			"Only an administrator can put the site back",
		);
	});

	it("explains a key Cloudflare refuses, through the sandbox, and keeps nothing", async () => {
		const runtime = await start();
		await runtime.http.respond(
			"https://api.cloudflare.com/client/v4/accounts?per_page=50",
			Response.json(
				{ success: false, errors: [{ code: 10000, message: "Authentication error" }] },
				{ status: 401 },
			),
		);
		const response = await runtime.admin.submit(PAGE, "connect", { key: "wrong-key" });
		expect(JSON.stringify(response.blocks)).toContain("Cloudflare did not accept that key");
		const [request] = runtime.http.requests();
		expect(request?.headers.authorization).toBe("Bearer wrong-key");
		expect(await runtime.inspect.setting("connection")).toBeNull();
		expect(await runtime.inspect.settings.raw("token")).toBeNull();
	});
});

describe("times", () => {
	it("reads a wall-clock time in the site's zone, across a clock change", () => {
		expect(fromLocal("2026-10-16", 11, 4, "Europe/London")).toBe("2026-10-16T10:04:00.000Z");
		expect(fromLocal("2026-12-16", 11, 4, "Europe/London")).toBe("2026-12-16T11:04:00.000Z");
		expect(fromLocal("2026-10-16", 11, 4, "UTC")).toBe("2026-10-16T11:04:00.000Z");
		expect(fromLocal("16/10/2026", 11, 4, "UTC")).toBeNull();
	});

	it("shows moments in plain words", () => {
		expect(moment("2026-10-16T10:04:00.000Z", "Europe/London")).toBe("Fri 16 Oct, 11:04");
		expect(since("2026-10-16T11:04:00.000Z", Date.parse("2026-10-16T14:34:00.000Z"))).toBe(
			"3 h 30 min",
		);
	});

	it("goes back to the end of the minute before a change", () => {
		expect(justBefore("2026-10-16T11:05:12.000Z")).toBe("2026-10-16T11:04:59.999Z");
	});

	it("reads both time formats EmDash writes", () => {
		expect(iso("2026-10-16 11:04:00")).toBe("2026-10-16T11:04:00.000Z");
		expect(iso("2026-10-16T11:04:00.000Z")).toBe("2026-10-16T11:04:00.000Z");
	});
});

describe("grouping changes", () => {
	const change = (at: string, who = "rosie", collection = "products"): Change => ({
		kind: "edited",
		what: `Loaf (product) edited`,
		who,
		at,
		collection,
	});

	it("turns a burst by one person into one row", () => {
		const burst = Array.from({ length: 31 }, (_, i) =>
			change(`2026-10-16T11:05:${String(59 - i).padStart(2, "0")}.000Z`),
		);
		const groups = groupChanges([change("2026-10-16T14:32:00.000Z", "maria", "pages"), ...burst]);
		expect(groups).toHaveLength(2);
		expect(groups[1]).toMatchObject({
			count: 31,
			from: "2026-10-16T11:05:29.000Z",
			to: "2026-10-16T11:05:59.000Z",
		});
	});

	it("keeps a few separate changes separate", () => {
		const groups = groupChanges([
			change("2026-10-16T11:05:00.000Z"),
			change("2026-10-16T11:04:00.000Z"),
		]);
		expect(groups.map((g) => g.count)).toEqual([1, 1]);
	});
});
