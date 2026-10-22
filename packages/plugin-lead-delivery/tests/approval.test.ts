// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";

import { startApproval, withApproval } from "../src/approval.js";

const ORIGIN = "https://crumbandco.uk";
const DEVICE = "device-secret-1234567890";
const ACCESS = "ec_oat_access-secret";
const REFRESH = "ec_ort_refresh-secret";

interface Call {
	url: string;
	init?: RequestInit;
}

/** A fake site: its device-flow answers come from `token`, everything else is 200 {}. */
function fakeSite(token: () => Response) {
	const kv = new Map<string, unknown>();
	const calls: Call[] = [];
	const ctx = {
		kv: {
			get: async (key: string) => kv.get(key) ?? null,
			set: async (key: string, value: unknown) => void kv.set(key, value),
			delete: async (key: string) => kv.delete(key),
		},
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				if (url.endsWith("/oauth/device/code")) {
					return Response.json({
						data: {
							device_code: DEVICE,
							user_code: "ABCD-EFGH",
							verification_uri: `${ORIGIN}/_emdash/admin/device`,
							expires_in: 900,
							interval: 5,
						},
					});
				}
				if (url.endsWith("/oauth/device/token")) return token();
				return Response.json({ data: {} });
			},
		},
	} as unknown as PluginContext;
	return { ctx, kv, calls };
}

const approved = () =>
	Response.json({ data: { access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer" } });
const error = (code: string) => Response.json({ error: code }, { status: 400 });

function leaks(value: unknown): boolean {
	const text = JSON.stringify(value);
	return [DEVICE, ACCESS, REFRESH].some((secret) => text.includes(secret));
}

describe("one-time approval", () => {
	it("starts with a prefilled link and keeps the device code out of the answer", async () => {
		const { ctx, kv, calls } = fakeSite(approved);
		const started = await startApproval(ctx, ORIGIN, "d1");
		expect(started).toMatchObject({
			kind: "started",
			userCode: "ABCD-EFGH",
			approveUrl: `${ORIGIN}/_emdash/admin/device?code=ABCD-EFGH`,
		});
		expect(leaks(started)).toBe(false);
		expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ scope: "admin" });
		expect(kv.size).toBe(1);
	});

	it("uses the access once, revokes the refresh token and keeps nothing", async () => {
		const { ctx, kv, calls } = fakeSite(approved);
		await startApproval(ctx, ORIGIN, "d1");
		const result = await withApproval(ctx, ORIGIN, "d1", async (call) => {
			const response = await call("/_emdash/api/plugins/emdash-forms/forms/list");
			return response.status;
		});
		expect(result).toEqual({ kind: "done", value: 200, revoked: true });
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
		await startApproval(ctx, ORIGIN, "d1");
		const result = await withApproval(ctx, ORIGIN, "d1", async () => {
			throw new Error(`refused for ${ACCESS}`);
		});
		expect(result).toMatchObject({ kind: "failed", revoked: true });
		expect(leaks(result)).toBe(false);
		expect(calls.at(-1)!.url).toMatch(/token\/revoke$/);
	});

	it.each([
		["authorization_pending", "pending", 1],
		["slow_down", "pending", 1],
		["access_denied", "denied", 0],
		["expired_token", "expired", 0],
	])("%s → %s", async (code, kind, kept) => {
		const { ctx, kv } = fakeSite(() => error(code));
		await startApproval(ctx, ORIGIN, "d1");
		let used = false;
		const result = await withApproval(ctx, ORIGIN, "d1", async () => {
			used = true;
		});
		expect(result).toEqual({ kind });
		expect(used).toBe(false);
		expect(kv.size).toBe(kept);
	});

	it.each([429, 503])("keeps the code when EmDash answers %i", async (status) => {
		const { ctx, kv } = fakeSite(() => Response.json({ error: { code: "BUSY" } }, { status }));
		await startApproval(ctx, ORIGIN, "d1");
		const result = await withApproval(ctx, ORIGIN, "d1", async () => 1);
		expect(result).toMatchObject({ kind: "failed" });
		expect(kv.size).toBe(1);
	});

	it("forgets a code EmDash no longer knows", async () => {
		const { ctx, kv } = fakeSite(() =>
			Response.json({ error: { code: "INVALID_GRANT" } }, { status: 400 }),
		);
		await startApproval(ctx, ORIGIN, "d1");
		expect(await withApproval(ctx, ORIGIN, "d1", async () => 1)).toEqual({ kind: "missing" });
		expect(kv.size).toBe(0);
	});

	it("is missing when nothing was started", async () => {
		const { ctx } = fakeSite(approved);
		expect(await withApproval(ctx, ORIGIN, "d1", async () => 1)).toEqual({ kind: "missing" });
	});
});
