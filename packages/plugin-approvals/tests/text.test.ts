// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { publishFailedMessage } from "../src/actions.js";
import { emailFailureHint } from "../src/notify.js";
import {
	cleanReason,
	describeChanges,
	describeTextChange,
	fingerprint,
	nameList,
	readableDates,
	textCopy,
	textOf,
} from "../src/text.js";

describe("what changed, in words", () => {
	it("names a replaced word", () => {
		expect(describeTextChange("Iced coffee £3.20 today", "Iced coffee £3.40 today", "future")).toBe(
			'"£3.20" becomes "£3.40"',
		);
	});

	it("names added and removed words, in the past after an approval", () => {
		expect(describeTextChange("open until 9pm", "open until 9pm on Fridays", "past")).toBe(
			'added "on Fridays"',
		);
		expect(describeTextChange("tart and pavlova", "tart", "past")).toBe('removed "and pavlova"');
	});

	it("shows five changes and counts the rest", () => {
		const before = "a b c d e f g h i j k l m n";
		const after = "A b C d E f G h I j K l M n";
		expect(describeTextChange(before, after, "future")).toMatch(/; and 2 more changes$/);
	});

	it("describes pictures as changed and skips equal fields", () => {
		const changes = describeChanges(
			[
				{ slug: "title", label: "Title", text: "Menu" },
				{ slug: "hero", label: "Picture", text: "(picture)", picture: true, value: '"a"' },
			],
			[
				{ slug: "title", label: "Title", text: "Menu" },
				{ slug: "hero", label: "Picture", text: "(picture)", picture: true, value: '"b"' },
			],
			"past",
		);
		expect(changes).toEqual([{ label: "Picture", text: "changed" }]);
	});
});

describe("plain text of rich content", () => {
	it("reads Portable Text blocks as paragraphs", () => {
		const blocks = [
			{
				_type: "block",
				style: "normal",
				children: [
					{ _type: "span", text: "Hello " },
					{ _type: "span", text: "there" },
				],
			},
			{ _type: "block", children: [{ _type: "span", text: "Second" }] },
		];
		expect(textOf(blocks)).toBe("Hello there\nSecond");
	});
});

describe("the publish refusal text", () => {
	it("stays within what EmDash accepts", () => {
		const long = `Sent for approval.\u0007 ${"x".repeat(600)}`;
		const clean = cleanReason(long);
		expect([...clean].length).toBeLessThanOrEqual(500);
		expect(clean).not.toContain("\u0007");
	});

	it("lists names in plain English", () => {
		expect(nameList(["Ellen Marsh"])).toBe("Ellen Marsh");
		expect(nameList(["A", "B", "C"])).toBe("A, B and C");
	});
});

describe("version fingerprint", () => {
	it("ignores key order and internal keys, and changes with the address", async () => {
		const a = await fingerprint({ title: "x", body: "y" }, "menu");
		expect(await fingerprint({ body: "y", title: "x", _rev: "1" }, "menu")).toBe(a);
		expect(await fingerprint({ title: "x", body: "y" }, "menu-2")).not.toBe(a);
	});
});

describe("dates in the text copy and the review", () => {
	const fields = [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "starts", label: "Starts", type: "datetime" },
	];

	it("shows a date picked without a time as a date", () => {
		expect(textOf("2026-10-19T00:00:00.000Z")).toBe("19 Oct 2026");
		expect(textOf("2026-10-19")).toBe("19 Oct 2026");
	});

	it("shows a date and time in UTC, saying so", () => {
		const copy = textCopy(fields, { title: "Bake sale", starts: "2026-10-19T14:05:00.000Z" }, null);
		expect(copy.find((f) => f.slug === "starts")?.text).toBe("19 Oct 2026, 14:05 UTC");
	});

	it("reads dates inside repeaters too", () => {
		expect(textOf([{ day: "2026-01-02T09:30:00Z", what: "Doors open" }])).toBe(
			"2 Jan 2026, 09:30 UTC\nDoors open",
		);
	});

	it("leaves other text alone", () => {
		expect(textOf("Open 2026-10-19 to 2026-10-20")).toBe("Open 2026-10-19 to 2026-10-20");
		expect(textOf("2026-13-45")).toBe("2026-13-45");
	});

	it("names a changed date in full", () => {
		const changes = describeChanges(
			textCopy(fields, { title: "Bake sale", starts: "2026-10-19T00:00:00.000Z" }, null),
			textCopy(fields, { title: "Bake sale", starts: "2026-10-20T00:00:00.000Z" }, null),
			"future",
		);
		expect(changes).toEqual([{ label: "Starts", text: '"19 Oct 2026" becomes "20 Oct 2026".' }]);
	});

	it("sees no change against a copy saved before dates were readable", () => {
		const saved = [
			{ slug: "title", label: "Title", text: "Bake sale" },
			{ slug: "starts", label: "Starts", text: "2026-10-19T14:05:00.000Z" },
		];
		const now = textCopy(fields, { title: "Bake sale", starts: "2026-10-19T14:05:00.000Z" }, null);
		expect(describeChanges(saved, now, "past")).toEqual([]);
		expect(readableDates(saved[1]!.text)).toBe("19 Oct 2026, 14:05 UTC");
	});
});

describe("why a publish or an email did not go through", () => {
	it("asks to wait when EmDash was still finishing the page's last publish", () => {
		// EmDash 1.4.0 refuses a second action on an entry while its after-publish hooks run.
		const busy = Object.assign(new Error("busy"), { name: "CONTENT_ACTION_REENTRANT" });
		expect(publishFailedMessage(busy)).toBe(
			"Approved. The page was still finishing its last publish: press Publish on the page in a moment.",
		);
	});

	it("keeps the general message for any other failure", () => {
		expect(publishFailedMessage(new Error("CONFLICT"))).toBe(
			"Approved, but it could not be published just now. Press Publish on the page.",
		);
	});

	it("names the EmDash update when the sandbox could not use the site's email service", () => {
		expect(emailFailureHint(["Email is not configured"])).toContain("EmDash 1.4.0");
		expect(emailFailureHint(["Rate limit exceeded"])).toBeUndefined();
		expect(emailFailureHint([])).toBeUndefined();
	});
});
