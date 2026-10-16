// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import {
	cleanReason,
	describeChanges,
	describeTextChange,
	fingerprint,
	nameList,
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
