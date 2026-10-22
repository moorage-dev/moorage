// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";

import { peekApproval, startApproval, sweepApprovals, withApproval } from "../src/approval.js";

const ORIGIN = "https://crumbandco.uk";
const DEVICE = "device-secret-1234567890";
const ACCESS = "ec_oat_access-secret";
const REFRESH = "ec_ort_refresh-secret";
const INTENT = { form: "contact" };

interface Call {
	url: string;
	init?: RequestInit;
}

const codeAnswer = (extra: Record<string, unknown> = {}) =>
	Response.json({
		data: {
			device_code: DEVICE,
			user_code: "ABCD-EFGH",
			verification_uri: `${ORIGIN}/_emdash/admin/device`,
			expires_in: 900,
			interval: 5,
			...extra,
		},
	});

/** A fake site: its device-flow answers come from `code`, `token` and `revoke`; everything else is 200 {}. */
function fakeSite(
	token: () => Response,
	opts: { code?: () => Response; revoke?: () => Response } = {},
) {
	const kv = new Map<string, unknown>();
	const calls: Call[] = [];
	const logs: unknown[] = [];
	const record = (...args: unknown[]) => void logs.push(args);
	const ctx = {
		log: { debug: record, info: record, warn: record, error: record },
		kv: {
			get: async (key: string) => kv.get(key) ?? null,
			set: async (key: string, value: unknown) => void kv.set(key, value),
			delete: async (key: string) => kv.delete(key),
			list: async (prefix = "") =>
				[...kv.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.map(([key, value]) => ({ key, value })),
		},
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				if (url.endsWith("/oauth/device/code")) return (opts.code ?? codeAnswer)();
				if (url.endsWith("/oauth/device/token")) return token();
				if (url.endsWith("/oauth/token/revoke"))
					return opts.revoke ? opts.revoke() : Response.json({ data: { revoked: true } });
				return Response.json({ data: {} });
			},
		},
	} as unknown as PluginContext;
	return { ctx, kv, calls, logs };
}

const approved = () =>
	Response.json({ data: { access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer" } });
const error = (code: string) => Response.json({ error: code }, { status: 400 });

function leaks(value: unknown): boolean {
	const text = JSON.stringify(value);
	return [
		DEVICE,
		ACCESS,
		REFRESH,
		"ec_oat_",
		"ec_ort_",
		"device_code",
		"access_token",
		"refresh_token",
	].some((secret) => text.includes(secret));
}

describe("one-time approval: start", () => {
	it("shows the code and a plain link to the approval page, with nothing filled in", async () => {
		const { ctx, kv, calls } = fakeSite(approved);
		const started = await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		expect(started).toEqual({
			kind: "started",
			userCode: "ABCD-EFGH",
			approveUrl: `${ORIGIN}/_emdash/admin/device`,
			expiresAt: expect.any(String),
			intent: INTENT,
		});
		expect(leaks(started)).toBe(false);
		expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ scope: "admin" });
		expect([...kv.keys()]).toEqual(["approval:d1:u1"]);
		// The code the screen shows again is the same, with no device code.
		const peeked = await peekApproval(ctx, "d1:u1");
		expect(peeked).toMatchObject({ userCode: "ABCD-EFGH", intent: INTENT });
		expect(leaks(peeked)).toBe(false);
	});

	it("drops a query EmDash adds to the approval page, so the code is never filled in", async () => {
		const { ctx } = fakeSite(approved, {
			code: () => codeAnswer({ verification_uri: `${ORIGIN}/_emdash/admin/device?code=ABCD-EFGH` }),
		});
		const started = await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		expect(started).toMatchObject({ approveUrl: `${ORIGIN}/_emdash/admin/device` });
	});

	it("never keeps a code longer than 15 minutes", async () => {
		const { ctx } = fakeSite(approved, { code: () => codeAnswer({ expires_in: 86_400 }) });
		const started = await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		if (started.kind !== "started") throw new Error(started.kind);
		expect(Date.parse(started.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
	});

	it.each([
		["EmDash removed the flow (404)", () => new Response("Not found", { status: 404 })],
		[
			"the client name is refused",
			() => Response.json({ error: "invalid_client" }, { status: 400 }),
		],
		["an unknown error object", () => Response.json({ error: { code: "NOPE" } }, { status: 403 })],
		["an answer that is not JSON", () => new Response("<html>hello</html>", { status: 200 })],
		["no data", () => Response.json({ ok: true })],
		[
			"a changed shape",
			() => Response.json({ data: { deviceCode: DEVICE, userCode: "ABCD-EFGH" } }),
		],
		["no device code", () => codeAnswer({ device_code: "" })],
		["an odd user code", () => codeAnswer({ user_code: "<b>hi</b>" })],
		[
			"an approval page on another site",
			() => codeAnswer({ verification_uri: "https://evil.example/_emdash/admin/device" }),
		],
		["an approval page somewhere else", () => codeAnswer({ verification_uri: `${ORIGIN}/device` })],
		["no approval page", () => codeAnswer({ verification_uri: 5 })],
	])("is unavailable when %s, and keeps nothing", async (_name, code) => {
		const { ctx, kv } = fakeSite(approved, { code });
		expect(await startApproval(ctx, ORIGIN, "d1:u1", INTENT)).toEqual({ kind: "unavailable" });
		expect(kv.size).toBe(0);
	});

	it("is unavailable when the site cannot reach itself", async () => {
		const { ctx, kv } = fakeSite(approved, {
			code: () => {
				throw new Error("blocked");
			},
		});
		expect(await startApproval(ctx, ORIGIN, "d1:u1", INTENT)).toEqual({ kind: "unavailable" });
		expect(kv.size).toBe(0);
	});

	it.each([429, 500, 503])("is busy when EmDash answers %i", async (status) => {
		const { ctx, kv } = fakeSite(approved, {
			code: () => Response.json({ error: { code: "BUSY" } }, { status }),
		});
		expect(await startApproval(ctx, ORIGIN, "d1:u1", INTENT)).toEqual({ kind: "busy" });
		expect(kv.size).toBe(0);
	});
});

describe("one-time approval: finish", () => {
	it("uses the access once, revokes the refresh token and keeps nothing", async () => {
		const { ctx, kv, calls } = fakeSite(approved);
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		const result = await withApproval(ctx, ORIGIN, "d1:u1", async (call, intent) => {
			const response = await call("/_emdash/api/plugins/emdash-forms/forms/list");
			return `${intent.form}:${response.status}`;
		});
		expect(result).toEqual({ kind: "done", value: "contact:200", revoked: true });
		expect(leaks(result)).toBe(false);
		expect(kv.size).toBe(0);
		const list = calls.find((c) => c.url.endsWith("/forms/list"))!;
		expect((list.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`);
		const revoke = calls.at(-1)!;
		expect(revoke.url).toBe(`${ORIGIN}/_emdash/api/oauth/token/revoke`);
		expect(JSON.parse(String(revoke.init!.body))).toEqual({ token: REFRESH });
	});

	it("revokes even when the work fails, and hides the token in the reason", async () => {
		const { ctx, calls } = fakeSite(approved);
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		const result = await withApproval(ctx, ORIGIN, "d1:u1", async () => {
			throw new Error(`refused for ${ACCESS} and ec_oat_other`);
		});
		expect(result).toMatchObject({ kind: "failed", revoked: true });
		expect(leaks(result)).toBe(false);
		expect(calls.at(-1)!.url).toMatch(/token\/revoke$/);
	});

	it("tries the revoke once more, then says it could not", async () => {
		let tries = 0;
		const { ctx, calls } = fakeSite(approved, {
			revoke: () => {
				tries += 1;
				return new Response("", { status: 500 });
			},
		});
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		const result = await withApproval(ctx, ORIGIN, "d1:u1", async () => 1);
		expect(result).toEqual({ kind: "done", value: 1, revoked: false });
		expect(tries).toBe(2);
		expect(calls.filter((c) => c.url.endsWith("/revoke"))).toHaveLength(2);
	});

	it("needs no second try when the retry works", async () => {
		let tries = 0;
		const { ctx } = fakeSite(approved, {
			revoke: () => {
				tries += 1;
				if (tries === 1) throw new Error("network");
				return Response.json({ data: {} });
			},
		});
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		expect(await withApproval(ctx, ORIGIN, "d1:u1", async () => 1)).toEqual({
			kind: "done",
			value: 1,
			revoked: true,
		});
	});

	it.each([
		["authorization_pending", "pending", 1],
		["slow_down", "pending", 1],
		["access_denied", "denied", 0],
		["expired_token", "expired", 0],
		["invalid_client", "unavailable", 0],
		["invalid_grant", "unavailable", 0],
		["something_new", "unavailable", 0],
	])("%s → %s", async (code, kind, kept) => {
		const { ctx, kv } = fakeSite(() => error(code));
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		let used = false;
		const result = await withApproval(ctx, ORIGIN, "d1:u1", async () => {
			used = true;
		});
		expect(result).toEqual({ kind });
		expect(used).toBe(false);
		expect(kv.size).toBe(kept);
	});

	it.each([429, 500, 503])("keeps the code when EmDash answers %i", async (status) => {
		const { ctx, kv } = fakeSite(() => Response.json({ error: { code: "BUSY" } }, { status }));
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		const result = await withApproval(ctx, ORIGIN, "d1:u1", async () => 1);
		expect(result).toEqual({ kind: "busy" });
		expect(kv.size).toBe(1);
	});

	it.each([
		["an error object", () => Response.json({ error: { code: "INVALID_GRANT" } }, { status: 400 })],
		["404, the flow is gone", () => new Response("Not found", { status: 404 })],
		["401", () => Response.json({ error: "unauthorized" }, { status: 401 })],
		["a 200 that is not JSON", () => new Response("<html></html>", { status: 200 })],
		["a 200 with a changed shape", () => Response.json({ accessToken: ACCESS })],
		["a 200 with no refresh token", () => Response.json({ data: { access_token: ACCESS } })],
		["a 400 that is not JSON", () => new Response("Bad", { status: 400 })],
	])("is unavailable on %s, and forgets the code", async (_name, token) => {
		const { ctx, kv } = fakeSite(token);
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		let used = false;
		const result = await withApproval(ctx, ORIGIN, "d1:u1", async () => {
			used = true;
		});
		expect(result).toMatchObject({ kind: "unavailable" });
		expect(used).toBe(false);
		expect(kv.size).toBe(0);
		expect(leaks(result)).toBe(false);
	});

	it("throws away an access token that came without its refresh token", async () => {
		const { ctx, calls } = fakeSite(() => Response.json({ data: { access_token: ACCESS } }));
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		await withApproval(ctx, ORIGIN, "d1:u1", async () => 1);
		const revoke = calls.find((c) => c.url.endsWith("/revoke"));
		expect(JSON.parse(String(revoke!.init!.body))).toEqual({ token: ACCESS });
	});

	it("treats an answer that was redirected anyway as unavailable, and asks without following", async () => {
		const followed = () => {
			const response = approved();
			Object.defineProperty(response, "redirected", { value: true });
			return response;
		};
		const { ctx, kv, calls } = fakeSite(followed);
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		let used = false;
		const result = await withApproval(ctx, ORIGIN, "d1:u1", async () => {
			used = true;
		});
		expect(result).toEqual({ kind: "unavailable" });
		expect(used).toBe(false);
		expect(kv.size).toBe(0);
		for (const call of calls) expect(call.init?.redirect).toBe("manual");
	});

	it("says when a token that came in a changed shape could not be thrown away", async () => {
		const { ctx } = fakeSite(() => Response.json({ data: { access_token: ACCESS } }), {
			revoke: () => new Response("", { status: 500 }),
		});
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		expect(await withApproval(ctx, ORIGIN, "d1:u1", async () => 1)).toEqual({
			kind: "unavailable",
			revoked: false,
		});
	});

	it("is unavailable when the site cannot reach itself, and forgets the code", async () => {
		const { ctx, kv } = fakeSite(() => {
			throw new Error("blocked");
		});
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		expect(await withApproval(ctx, ORIGIN, "d1:u1", async () => 1)).toEqual({
			kind: "unavailable",
		});
		expect(kv.size).toBe(0);
	});

	it("is missing when nothing was started, and expired after 15 minutes", async () => {
		const { ctx, kv } = fakeSite(approved);
		expect(await withApproval(ctx, ORIGIN, "d1:u1", async () => 1)).toEqual({ kind: "missing" });
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		const stored = kv.get("approval:d1:u1") as { expiresAt: number };
		kv.set("approval:d1:u1", { ...stored, expiresAt: Date.now() - 1 });
		expect(await withApproval(ctx, ORIGIN, "d1:u1", async () => 1)).toEqual({ kind: "expired" });
		expect(kv.size).toBe(0);
	});

	it("keeps each admin's code apart", async () => {
		const { ctx, kv } = fakeSite(approved);
		await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
		await startApproval(ctx, ORIGIN, "d1:u2", INTENT);
		expect(await withApproval(ctx, ORIGIN, "d1:u1", async () => 1)).toMatchObject({ kind: "done" });
		expect([...kv.keys()]).toEqual(["approval:d1:u2"]);
	});
});

describe("one-time approval: logs", () => {
	it("never writes a token or the device code to the log, whatever happens", async () => {
		const answers = [
			approved,
			() => error("authorization_pending"),
			() => error("something_new"),
			() => new Response("<html></html>"),
			() => Response.json({ error: { code: "BUSY" } }, { status: 503 }),
		];
		for (const token of answers) {
			const { ctx, logs } = fakeSite(token, { revoke: () => new Response("", { status: 500 }) });
			await startApproval(ctx, ORIGIN, "d1:u1", INTENT);
			await withApproval(ctx, ORIGIN, "d1:u1", async () => {
				throw new Error(`boom ${ACCESS}`);
			});
			expect(leaks(logs)).toBe(false);
		}
	});
});

describe("one-time approval: the every-minute sweep", () => {
	it("deletes expired and damaged codes and keeps live ones and other entries", async () => {
		const { ctx, kv } = fakeSite(approved);
		await startApproval(ctx, ORIGIN, "live:u1", INTENT);
		await startApproval(ctx, ORIGIN, "old:u1", INTENT);
		const old = kv.get("approval:old:u1") as { expiresAt: number };
		kv.set("approval:old:u1", { ...old, expiresAt: Date.now() - 1 });
		kv.set("approval:broken", { deviceCode: 5 });
		kv.set("config", { keep: true });
		expect(await sweepApprovals(ctx)).toBe(2);
		expect([...kv.keys()].sort()).toEqual(["approval:live:u1", "config"]);
		expect(await peekApproval(ctx, "old:u1")).toBeUndefined();
	});
});
