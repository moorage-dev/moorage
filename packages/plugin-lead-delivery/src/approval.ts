// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

/**
 * One-time admin access through EmDash's own approval page (the OAuth device flow that
 * `emdash login` uses). The plugin asks for a code, an admin approves it in EmDash, the plugin
 * exchanges it once, makes its calls, and revokes the access before returning.
 *
 * The tokens never leave this module: callers get a `call` function, not the token, and the
 * results carry no token and no device code. The device code waits in plugin storage between
 * "start" and "finish" (15 minutes at most) and is deleted on every outcome but "pending".
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** The only scope that reaches /_emdash/api/plugins/* (EmDash middleware/auth.ts). */
const SCOPE = "admin";
const CLIENT_ID = "lead-delivery";

interface Stored {
	deviceCode: string;
	expiresAt: number;
}

export type StartResult =
	| { kind: "started"; userCode: string; approveUrl: string; expiresAt: string }
	| { kind: "failed"; reason: string };

export type FinishResult<T> =
	/** Not approved yet (also when "Done" is pressed again within EmDash's 5-second poll interval). */
	| { kind: "pending" }
	| { kind: "denied" }
	| { kind: "expired" }
	/** Nothing was started, or it was already used. */
	| { kind: "missing" }
	/** `revoked` is there once access was given: whether it was thrown away again. */
	| { kind: "failed"; reason: string; revoked?: boolean }
	| { kind: "done"; value: T; revoked: boolean };

/** An authenticated call to this site; the path starts with "/_emdash/". */
export type AdminCall = (
	path: string,
	init?: { method?: string; body?: unknown },
) => Promise<Response>;

function storageKey(key: string): string {
	return `approval:${key}`;
}

async function post(
	ctx: PluginContext,
	url: string,
	body: unknown,
	headers?: Record<string, string>,
) {
	if (!ctx.http) throw new Error("Web requests are not available.");
	return ctx.http.fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", "X-EmDash-Request": "1", ...headers },
		body: JSON.stringify(body),
	});
}

/** Ask EmDash for an approval code. `key` names the flow (one per delivery, say). */
export async function startApproval(
	ctx: PluginContext,
	origin: string,
	key: string,
): Promise<StartResult> {
	let response: Response;
	try {
		response = await post(ctx, `${origin}/_emdash/api/oauth/device/code`, {
			client_id: CLIENT_ID,
			scope: SCOPE,
		});
	} catch {
		return { kind: "failed", reason: "This site could not reach its own address." };
	}
	if (response.status === 429) {
		return { kind: "failed", reason: "EmDash is busy. Wait a minute and try again." };
	}
	if (!response.ok) return { kind: "failed", reason: `EmDash answered ${response.status}.` };
	const body = (await response.json()) as {
		data?: {
			device_code?: unknown;
			user_code?: unknown;
			verification_uri?: unknown;
			expires_in?: unknown;
		};
	};
	const data = body.data;
	if (
		typeof data?.device_code !== "string" ||
		typeof data.user_code !== "string" ||
		typeof data.verification_uri !== "string"
	) {
		return { kind: "failed", reason: "EmDash gave no approval code." };
	}
	const seconds = typeof data.expires_in === "number" ? data.expires_in : 900;
	const expiresAt = Date.now() + seconds * 1000;
	await ctx.kv.set(storageKey(key), { deviceCode: data.device_code, expiresAt } satisfies Stored);
	const approve = new URL(data.verification_uri);
	approve.searchParams.set("code", data.user_code);
	return {
		kind: "started",
		userCode: data.user_code,
		approveUrl: approve.toString(),
		expiresAt: new Date(expiresAt).toISOString(),
	};
}

/** Throw a started approval away without using it. */
export async function cancelApproval(ctx: PluginContext, key: string): Promise<void> {
	await ctx.kv.delete(storageKey(key));
}

async function revoke(ctx: PluginContext, origin: string, refreshToken: string): Promise<boolean> {
	try {
		const response = await post(ctx, `${origin}/_emdash/api/oauth/token/revoke`, {
			token: refreshToken,
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Exchange the approved code once, run `use` with an authenticated `call`, then revoke.
 * Revoking the refresh token deletes it and every access token made from it.
 */
export async function withApproval<T>(
	ctx: PluginContext,
	origin: string,
	key: string,
	use: (call: AdminCall) => Promise<T>,
): Promise<FinishResult<T>> {
	const stored = await ctx.kv.get<Stored>(storageKey(key));
	if (!stored || typeof stored.deviceCode !== "string") return { kind: "missing" };
	if (stored.expiresAt < Date.now()) {
		await cancelApproval(ctx, key);
		return { kind: "expired" };
	}

	let response: Response;
	try {
		response = await post(ctx, `${origin}/_emdash/api/oauth/device/token`, {
			device_code: stored.deviceCode,
			grant_type: DEVICE_GRANT,
		});
	} catch {
		return { kind: "failed", reason: "This site could not reach its own address." };
	}
	const body = (await response.json().catch(() => ({}))) as {
		error?: unknown;
		data?: { access_token?: unknown; refresh_token?: unknown };
	};
	if (!response.ok) {
		const error = typeof body.error === "string" ? body.error : "";
		if (error === "authorization_pending" || error === "slow_down") return { kind: "pending" };
		// Busy or a passing fault: keep the code, it may already be approved.
		if (response.status === 429 || response.status >= 500) {
			return { kind: "failed", reason: "EmDash is busy. Wait a minute and try again." };
		}
		await cancelApproval(ctx, key);
		if (error === "access_denied") return { kind: "denied" };
		if (error === "expired_token") return { kind: "expired" };
		return { kind: "missing" };
	}
	await cancelApproval(ctx, key);
	const access = body.data?.access_token;
	const refresh = body.data?.refresh_token;
	if (typeof access !== "string" || typeof refresh !== "string") {
		return { kind: "failed", reason: "EmDash gave no access." };
	}

	const call: AdminCall = async (path, init) => {
		if (!ctx.http) throw new Error("Web requests are not available.");
		const method = init?.method ?? (init?.body === undefined ? "GET" : "POST");
		return ctx.http.fetch(`${origin}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${access}`,
				...(init?.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});
	};

	try {
		const value = await use(call);
		return { kind: "done", value, revoked: await revoke(ctx, origin, refresh) };
	} catch (error) {
		const reason = error instanceof Error ? scrub(error.message, [access, refresh]) : "Failed.";
		return { kind: "failed", reason, revoked: await revoke(ctx, origin, refresh) };
	}
}

/** Never let a token reach a message, even through an error text. */
function scrub(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join("[hidden]");
	return out;
}
