// Copyright 2026 GoSiTech. Licensed under FSL-1.1-MIT; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import type { ImportState } from "../src/redirects-admin.js";
import { exportList, planImport } from "../src/redirects.js";

const PAGE = "/overview";

describe("reading a pasted list", () => {
	it("reads a plain two-column list with or without a header", () => {
		const plain = planImport("/old,/new\n/gone-page,/home", []);
		expect(plain.format).toBe("plain");
		expect(plain.ready).toEqual([
			{ source: "/old", destination: "/new", type: 301 },
			{ source: "/gone-page", destination: "/home", type: 301 },
		]);

		const headed = planImport("Old URL,New URL\n/old,/new", []);
		expect(headed.ready).toEqual([{ source: "/old", destination: "/new", type: 301 }]);
	});

	it("reads two addresses separated by a space", () => {
		expect(planImport("/old-page /new-page", []).ready).toEqual([
			{ source: "/old-page", destination: "/new-page", type: 301 },
		]);
	});

	it("reads tab-separated rows pasted from a spreadsheet", () => {
		expect(planImport("/old\t/new\t302", []).ready).toEqual([
			{ source: "/old", destination: "/new", type: 302 },
		]);
	});

	it("reads a Redirection export, translating only safe patterns", () => {
		const plan = planImport(
			[
				"source,target,regex,code",
				"/about-us/,/about,0,301",
				"^/blog/(.*)$,/news/$1,1,301",
				"^/shop/(\\d+)/(.*)$,/store/$2,1,301",
				"/temp,/sale,0,302",
			].join("\n"),
			[],
		);
		expect(plan.format).toBe("redirection");
		expect(plan.ready).toEqual([
			{ source: "/about-us", destination: "/about", type: 301 },
			{ source: "/blog/[...rest]", destination: "/news/[...rest]", type: 301 },
			{ source: "/temp", destination: "/sale", type: 302 },
		]);
		expect(plan.skipped).toEqual([
			{
				line: 4,
				source: "^/shop/(\\d+)/(.*)$",
				reason: "Uses a pattern. Add it by hand under Manage > Redirects",
			},
		]);
	});

	it("recognises a headerless Redirection export by its 0/1 column", () => {
		const plan = planImport("/a,/b,0,301\n^/c/?$,/d,1,301", []);
		expect(plan.format).toBe("redirection");
		expect(plan.ready.map((row) => row.source)).toEqual(["/a", "/c"]);
	});

	it("reads a Yoast Premium export, including pages deleted on purpose", () => {
		const plan = planImport(
			["Origin,Target,Type,Format", "old-page,new-page,301,plain", "retired,,410,plain"].join("\n"),
			[],
		);
		expect(plan.format).toBe("yoast");
		expect(plan.ready).toEqual([
			{ source: "/old-page", destination: "/new-page", type: 301 },
			{ source: "/retired", destination: "", type: 410 },
		]);
	});

	it("reads a Rank Math export, skipping inactive rows and fuzzy matches", () => {
		const plan = planImport(
			[
				"id,source,matching,destination,type,category,status,ignore",
				"1,old,exact,/new,301,,active,",
				"2,shop/,start,/store,301,,active,",
				"3,sale,contains,/offers,301,,active,",
				"4,draft,exact,/x,301,,inactive,",
			].join("\n"),
			[],
		);
		expect(plan.format).toBe("rankmath");
		expect(plan.ready).toEqual([
			{ source: "/old", destination: "/new", type: 301 },
			{ source: "/shop/[...rest]", destination: "/store", type: 301 },
		]);
		expect(plan.skipped.map((row) => row.reason)).toEqual([
			"Uses a pattern. Add it by hand under Manage > Redirects",
			"Switched off in the export",
		]);
	});

	it("strips the old domain and refuses other websites, query strings and unknown types", () => {
		const plan = planImport(
			[
				"https://old.example/a/,https://old.example/b",
				"/c,https://elsewhere.example/d",
				"/e?id=1,/f",
				"/g,/h,999",
				"/i,",
				"/j,/j/",
			].join("\n"),
			[],
		);
		expect(plan.ready).toEqual([{ source: "/a", destination: "/b", type: 301 }]);
		expect(plan.skipped.map((row) => [row.line, row.reason])).toEqual([
			[2, "Points to another website"],
			[3, "Addresses with a ? are not supported"],
			[4, "Unknown redirect type"],
			[5, "No new address"],
			[6, "Old and new address are the same"],
		]);
	});

	it("never overwrites: existing, conflicting and repeated rows are skipped", () => {
		const plan = planImport("/a,/b\n/c,/d\n/e,/f\n/e,/g", [
			{ source: "/a", destination: "/b" },
			{ source: "/c", destination: "/other" },
		]);
		expect(plan.ready).toEqual([{ source: "/e", destination: "/f", type: 301 }]);
		expect(plan.skipped.map((row) => row.reason)).toEqual([
			"Already exists",
			"Conflicts with an existing redirect",
			"Listed twice",
		]);
	});

	it("refuses rows that would send visitors in a circle", () => {
		const within = planImport("/a,/b\n/b,/a", []);
		expect(within.ready).toEqual([]);
		expect(within.skipped.map((row) => [row.line, row.reason])).toEqual([
			[1, "Would send visitors in a circle"],
			[2, "Would send visitors in a circle"],
		]);

		const withExisting = planImport("/new,/old", [{ source: "/old", destination: "/new" }]);
		expect(withExisting.ready).toEqual([]);
	});

	it("exports a list that reads back in", () => {
		const text = exportList([
			{ source: "/a", destination: "/b", type: 301 },
			{ source: '/with,"comma"', destination: "", type: 410 },
		]);
		expect(text).toBe('source,target,code\n/a,/b,301\n"/with,""comma""",,410');
		expect(planImport(text, []).ready).toHaveLength(2);
	});
});

describe("Redirects tab", () => {
	let host: PluginRuntimeTestHost | undefined;

	afterEach(async () => {
		await host?.dispose();
		host = undefined;
	});

	async function start(): Promise<PluginRuntimeTestHost> {
		host = await createPluginRuntimeTestHost({
			site: { name: "Acme", url: "https://acme.test", locale: "en" },
		});
		return host;
	}

	const state = (runtime: PluginRuntimeTestHost) =>
		runtime.inspect.kv.get<ImportState>("redirects");
	const sources = async (runtime: PluginRuntimeTestHost) =>
		(await runtime.inspect.redirects()).map((rule) => rule.source).sort();

	it("checks a list without adding anything, then adds it, then removes only that batch", async () => {
		const runtime = await start();
		await runtime.fixtures.redirect({ source: "/kept", destination: "/home" });

		const checked = await runtime.admin.submit(PAGE, "check_redirects", {
			list: "/old-1,/new-1\n/old-2,/new-2\n/old-3,/new-3\n/old-4,/new-4\n/old-5,/new-5\n/kept,/home\n/bad,https://other.example/x",
		});
		expect(JSON.stringify(checked.blocks)).toContain("5 ready, 2 skipped");
		expect(JSON.stringify(checked.blocks)).toContain("Add 5 redirects");
		expect(await sources(runtime)).toEqual(["/kept"]);

		const added = await runtime.admin.act(PAGE, "add_redirects");
		expect(added.toast).toEqual({ type: "success", message: "5 redirects added." });
		expect(await sources(runtime)).toEqual([
			"/kept",
			"/old-1",
			"/old-2",
			"/old-3",
			"/old-4",
			"/old-5",
		]);
		expect(await state(runtime)).toMatchObject({ status: "done", added: 5, cursor: 5 });
		const created = (await runtime.inspect.redirects()).find((rule) => rule.source === "/old-1");
		expect(created).toMatchObject({ destination: "/new-1", type: 301, enabled: true });
		expect(created?.groupName).toMatch(/^Imported /);

		const removed = await runtime.admin.act(PAGE, "remove_redirects");
		expect(removed.toast?.message).toBe("Removed. Your other redirects are untouched.");
		expect(await sources(runtime)).toEqual(["/kept"]);
		expect(await state(runtime)).toBeNull();
	});

	it("continues an interrupted import and counts rows already created as added", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "check_redirects", { list: "/a,/x\n/b,/y\n/c,/z" });
		// As if an earlier request created /a but stopped before saving its progress.
		await runtime.fixtures.redirect({ source: "/a", destination: "/x" });

		await runtime.admin.act(PAGE, "add_redirects");
		expect(await state(runtime)).toMatchObject({ status: "done", added: 3 });
		expect(await sources(runtime)).toEqual(["/a", "/b", "/c"]);
	});

	it("lists what EmDash itself refuses instead of failing the import", async () => {
		const runtime = await start();
		await runtime.admin.submit(PAGE, "check_redirects", {
			list: "/ok,/fine\n/broken/[...a]/[...b],/x",
		});
		await runtime.admin.act(PAGE, "add_redirects");
		const finished = await state(runtime);
		expect(finished).toMatchObject({ status: "done", added: 1 });
		expect(finished?.skipped.at(-1)?.reason).toMatch(/^EmDash refused it: /);
	});

	it("lets an admin stop an import that is still running, keeping what was added", async () => {
		const runtime = await start();
		await runtime.fixtures.redirect({ source: "/a", destination: "/x" });
		await runtime.fixtures.plugin.kv("redirects", {
			status: "adding",
			format: "plain",
			rows: [
				{ source: "/a", destination: "/x", type: 301 },
				{ source: "/b", destination: "/y", type: 301 },
			],
			skipped: [],
			cursor: 1,
			added: 1,
			group: "Imported test",
		} satisfies ImportState);

		const page = await runtime.admin.loadPage(PAGE);
		expect(JSON.stringify(page.blocks)).toContain("1 of 2 added");

		const stopped = await runtime.admin.act(PAGE, "stop_redirects");
		expect(stopped.toast?.message).toBe("Stopped. 1 redirect added.");
		expect(await state(runtime)).toMatchObject({ status: "done", added: 1, cursor: 1 });
		expect(await sources(runtime)).toEqual(["/a"]);
	});

	it("carries on from the background task", async () => {
		const runtime = await start();
		await runtime.fixtures.plugin.kv("redirects", {
			status: "adding",
			format: "plain",
			rows: [
				{ source: "/a", destination: "/x", type: 301 },
				{ source: "/b", destination: "/y", type: 301 },
			],
			skipped: [],
			cursor: 0,
			added: 0,
			group: "Imported test",
		} satisfies ImportState);

		await runtime.transport.invokeHook("cron", {
			name: "redirects-import",
			scheduledAt: new Date().toISOString(),
		});
		expect(await state(runtime)).toMatchObject({ status: "done", added: 2 });
		expect(await sources(runtime)).toEqual(["/a", "/b"]);
	});

	it("adds one redirect from the form opened by its button", async () => {
		const runtime = await start();
		const opened = await runtime.admin.act(PAGE, "open_add");
		// Redirect from, Redirect to, and a Kind that starts as Permanent.
		expect(JSON.stringify(opened.blocks)).toContain(
			'"action_id":"code","label":"Kind","options":[{"value":"301","label":"Permanent"}',
		);
		expect(JSON.stringify(opened.blocks)).toContain('"initial_value":"301"');

		const added = await runtime.admin.submit(PAGE, "add_redirect", {
			source: "old-page/",
			destination: "/new-page",
			code: "301",
		});
		expect(added.toast).toEqual({
			type: "success",
			message: "Redirect added. old-page/ now goes to /new-page.",
		});
		expect(JSON.stringify(added.blocks)).toContain(
			'"source":"/old-page","destination":"/new-page","kind":"Permanent"',
		);
	});

	it("adds a page that was removed on purpose, with no new address", async () => {
		const runtime = await start();
		const added = await runtime.admin.submit(PAGE, "add_redirect", {
			source: "/retired",
			destination: "/ignored",
			code: "410",
		});
		expect(added.toast?.message).toBe("Done. /retired now tells visitors the page was removed.");
		expect((await runtime.inspect.redirects())[0]).toMatchObject({
			source: "/retired",
			destination: "",
			type: 410,
		});
	});

	it("changes and removes a redirect, keeping a kind the form does not offer", async () => {
		const runtime = await start();
		// A redirect imported as 308 must stay 308 when only its address is changed.
		const special = await runtime.fixtures.redirect({
			source: "/moved",
			destination: "/here",
			type: 308,
		});
		const form = await runtime.admin.act(PAGE, "edit_redirect", { value: special.id });
		expect(JSON.stringify(form.blocks)).toContain('"initial_value":"308"');
		await runtime.admin.submit(PAGE, `save_redirect:${special.id}`, { destination: "/there" });
		expect(
			(await runtime.inspect.redirects()).find((rule) => rule.id === special.id),
		).toMatchObject({
			source: "/moved",
			destination: "/there",
			type: 308,
		});

		const removed = await runtime.admin.act(PAGE, "remove_redirect", { value: special.id });
		expect(removed.toast?.message).toBe("Redirect removed.");
		expect(await sources(runtime)).toEqual([]);
	});

	it("explains a redirect it cannot add, beside the form", async () => {
		const runtime = await start();
		await runtime.fixtures.redirect({ source: "/a", destination: "/b" });
		const twice = await runtime.admin.submit(PAGE, "add_redirect", {
			source: "/a",
			destination: "/c",
		});
		expect(JSON.stringify(twice.blocks)).toContain(
			"There is already a redirect from that old address. Use Change in the list below.",
		);
		const elsewhere = await runtime.admin.submit(PAGE, "add_redirect", {
			source: "/x",
			destination: "https://other.example/y",
		});
		expect(JSON.stringify(elsewhere.blocks)).toContain("Points to another website.");
		expect(await sources(runtime)).toEqual(["/a"]);
	});

	it("shows the site's redirects as a copyable list", async () => {
		const runtime = await start();
		await runtime.fixtures.redirect({ source: "/a", destination: "/b" });
		const response = await runtime.admin.act(PAGE, "export_redirects");
		expect(JSON.stringify(response.blocks)).toContain("source,target,code\\n/a,/b,301");
	});

	it("does nothing for an editor", async () => {
		const runtime = await start();
		const editor = await runtime.fixtures.user({ email: "editor@acme.test", role: "editor" });
		await runtime.admin.submit(PAGE, "check_redirects", { list: "/a,/b" }, { user: editor });
		expect(await state(runtime)).toBeNull();
	});
});
