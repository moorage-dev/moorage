// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { checkExport, EXPORT_LINK_MS, signExport } from "../src/export-link.js";
import { fakeContext } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 19, 12);

async function signed(range = { from: "2026-10-01", to: "2026-10-07" }) {
	const fake = fakeContext();
	const query = new URLSearchParams(await signExport(fake.ctx.kv, range, NOW));
	return { kv: fake.ctx.kv, store: fake.kv, query };
}

describe("signed download link", () => {
	it("opens for the dates it was signed for, until it expires", async () => {
		const { kv, query } = await signed();
		expect(Number(query.get("expires"))).toBe(NOW + EXPORT_LINK_MS);
		expect(EXPORT_LINK_MS).toBeLessThanOrEqual(10 * 60 * 1000);
		expect(await checkExport(kv, query, NOW)).toEqual({ from: "2026-10-01", to: "2026-10-07" });
		expect(await checkExport(kv, query, NOW + EXPORT_LINK_MS)).not.toBeNull();
		expect(await checkExport(kv, query, NOW + EXPORT_LINK_MS + 1)).toBeNull();
	});

	it("works with no dates, and leaves them out of the link", async () => {
		const { kv, query } = await signed({ from: "", to: "" });
		expect(query.has("from")).toBe(false);
		expect(query.has("to")).toBe(false);
		expect(await checkExport(kv, query, NOW)).toEqual({ from: "", to: "" });
	});

	it("refuses changed dates, a changed expiry, a changed or missing signature", async () => {
		const { kv, query } = await signed();
		const tries: Array<(q: URLSearchParams) => void> = [
			(q) => q.set("from", "2020-01-01"),
			(q) => q.delete("from"),
			(q) => q.set("to", "2026-10-08"),
			(q) => q.set("to", "today"),
			(q) => q.set("expires", String(Number(q.get("expires")) - 1000)),
			(q) => q.set("expires", "1e15"),
			// The first character: every one of its bits is part of the signature.
			(q) => q.set("sig", `${q.get("sig")!.startsWith("A") ? "B" : "A"}${q.get("sig")!.slice(1)}`),
			(q) => q.set("sig", "AAAA"),
			(q) => q.set("sig", "not base64!"),
			(q) => q.delete("sig"),
			(q) => q.delete("expires"),
		];
		for (const change of tries) {
			const copy = new URLSearchParams(query);
			change(copy);
			expect(await checkExport(kv, copy, NOW), copy.toString()).toBeNull();
		}
	});

	it("refuses a link that claims to last longer than ten minutes", async () => {
		const { kv, query } = await signed();
		// Signed at NOW, checked a minute before it was made: expires is now 11 minutes away.
		expect(await checkExport(kv, query, NOW - 60_000)).toBeNull();
	});

	it("keeps one secret, and refuses everything when there is none", async () => {
		const { kv, store, query } = await signed();
		const secret = store.get("export-secret");
		expect(typeof secret).toBe("string");
		await signExport(kv, { from: "", to: "" }, NOW);
		expect(store.get("export-secret")).toBe(secret);
		// A link signed by another site (another secret) is refused.
		const other = fakeContext();
		expect(await checkExport(other.ctx.kv, query, NOW)).toBeNull();
		expect(other.kv.has("export-secret")).toBe(false);
	});
});
