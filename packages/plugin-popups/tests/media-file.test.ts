// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown> = {};
let fail = false;
vi.mock("emdash/runtime", () => ({
	getDb: async () => {
		if (fail) throw new Error("no database here");
		return {};
	},
}));
vi.mock("emdash", async (original) => ({
	...(await original<typeof import("emdash")>()),
	MediaRepository: class {
		async findById(id: string) {
			return rows[id] ?? null;
		}
	},
}));

const { storedFileUrl } = await import("../src/media-file.js");

describe("the public address of a picture, read in-process", () => {
	beforeEach(() => {
		fail = false;
		for (const key of Object.keys(rows)) delete rows[key];
		rows.m1 = { id: "m1", status: "ready", mimeType: "image/png", storageKey: "01ABC.png" };
		rows.m2 = { id: "m2", status: "pending", mimeType: "image/png", storageKey: "01DEF.png" };
		rows.m3 = { id: "m3", status: "ready", mimeType: "application/pdf", storageKey: "menu.pdf" };
		rows.m4 = { id: "m4", status: "ready", mimeType: "image/png", storageKey: "../../x" };
	});

	it("gives a ready picture's file address", async () => {
		expect(await storedFileUrl("m1")).toBe("/_emdash/api/media/file/01ABC.png");
	});

	it("refuses an odd id, a file not ready, a file that is not a picture, and an unsafe key", async () => {
		expect(await storedFileUrl("../m1")).toBeNull();
		expect(await storedFileUrl("m2")).toBeNull();
		expect(await storedFileUrl("m3")).toBeNull();
		expect(await storedFileUrl("m4")).toBeNull();
		expect(await storedFileUrl("nope")).toBeNull();
	});

	it("says why when the site's database cannot be read, without failing", async () => {
		fail = true;
		const warn = vi.fn();
		expect(await storedFileUrl("m1", { warn })).toBeNull();
		expect(warn).toHaveBeenCalledWith("could not read a picture's file address", {
			error: "Error: no database here",
		});
	});
});
