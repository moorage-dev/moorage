// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

/**
 * One-time admin access through EmDash's own approval page (the OAuth device flow that
 * `emdash login` uses). The plugin asks for a code, an admin types it on EmDash's approval page
 * and approves, the plugin exchanges it once, makes its calls, and revokes the access before
 * returning.
 *
 * The tokens never leave this module: callers get a `call` function, not the token, and the
 * results carry no token and no device code. The device code waits in plugin storage between
 * "start" and "finish" (15 minutes at most); it is kept only while the answer may still come
 * (not approved yet, EmDash busy) and deleted on every other outcome.
 *
 * Fail safe: this rides on EmDash's device flow, which a later EmDash may change. Any answer
 * that is not exactly what the flow gives today comes back as "unavailable", so the caller can
 * fall back to the written instructions instead of showing a broken screen.
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** The only scope that reaches /_emdash/api/plugins/* (EmDash middleware/auth.ts). */
const SCOPE = "admin";
const CLIENT_ID = "lead-delivery";
const PREFIX = "approval:";
/** EmDash's codes last 15 minutes; never keep one longer, whatever it says. */
const MAX_SECONDS = 15 * 60;
/** The approval page inside EmDash's admin. */
const APPROVAL_PATH = "/_emdash/admin/device";
const USER_CODE = /^[A-Z0-9]{2,12}(-[A-Z0-9]{2,12})?$/;

/** What the caller wants done once access is given, kept with the code (nothing secret). */
export interface Intent {
	/** The form's short name. */
	form: string;
	/** The form's other address the admin agreed to replace: its host, and a hash of the whole address. */
	replace?: { host: string; hash: string };
}

/** A started approval as the screen shows it. */
export interface Shown {
	userCode: string;
	approveUrl: string;
	expiresAt: string;
	intent: Intent;
}

interface Stored {
	deviceCode: string;
	userCode: string;
	approveUrl: string;
	expiresAt: number;
	intent: Intent;
}

export type StartResult =
	| ({ kind: "started" } & Shown)
	/** EmDash is busy (429 or 5xx): try again in a minute. */
	| { kind: "busy" }
	/** Anything unexpected: use the written instructions. */
	| { kind: "unavailable" };

export type FinishResult<T> =
	/** Not approved yet (also when "Done" is pressed again within EmDash's 5-second poll interval). */
	| { kind: "pending" }
	/** EmDash is busy (429 or 5xx); the code is kept, it may already be approved. */
	| { kind: "busy" }
	| { kind: "denied" }
	| { kind: "expired" }
	/** Nothing was started, or it was already used. */
	| { kind: "missing" }
	/**
	 * An answer this module does not know: use the written instructions. `revoked` is there when
	 * a token came anyway (in a changed shape) and was thrown away again, or could not be.
	 */
	| { kind: "unavailable"; revoked?: boolean }
	/** Access was given but the work failed; `revoked` says whether it was thrown away again. */
	| { kind: "failed"; reason: string; revoked: boolean }
	| { kind: "done"; value: T; revoked: boolean };

/** An authenticated call to this site; the path starts with "/_emdash/". */
export type AdminCall = (
	path: string,
	init?: { method?: string; body?: unknown },
) => Promise<Response>;

function storageKey(key: string): string {
	return `${PREFIX}${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every call here carries a device code or a token, so none may follow a redirect: a 307 would
 * resend the body (and the token in it) to wherever it points. A redirect is answered like any
 * other unexpected answer.
 */
async function post(ctx: PluginContext, url: string, body: unknown) {
	if (!ctx.http) throw new Error("Web requests are not available.");
	return ctx.http.fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(body),
		redirect: "manual",
	});
}

/** A redirect answer, or one that was followed anyway. */
function isRedirect(response: Response): boolean {
	return (response.status >= 300 && response.status < 400) || response.redirected;
}

/** The JSON body, or undefined when it is not JSON. */
async function jsonOf(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

const busy = (status: number) => status === 429 || status >= 500;

/** The approval page, on this site, with nothing filled in: the admin types the code. */
function approvalPage(origin: string, verificationUri: unknown): string | undefined {
	if (typeof verificationUri !== "string") return undefined;
	try {
		const url = new URL(verificationUri);
		const site = new URL(origin);
		if (url.origin !== site.origin || url.pathname !== APPROVAL_PATH) return undefined;
		return `${url.origin}${url.pathname}`;
	} catch {
		return undefined;
	}
}

/** Ask EmDash for an approval code. `key` names the flow (a delivery and the admin). */
export async function startApproval(
	ctx: PluginContext,
	origin: string,
	key: string,
	intent: Intent,
): Promise<StartResult> {
	let response: Response;
	try {
		response = await post(ctx, `${origin}/_emdash/api/oauth/device/code`, {
			client_id: CLIENT_ID,
			scope: SCOPE,
		});
	} catch {
		return { kind: "unavailable" };
	}
	if (isRedirect(response)) return { kind: "unavailable" };
	if (busy(response.status)) return { kind: "busy" };
	if (!response.ok) return { kind: "unavailable" };
	const body = await jsonOf(response);
	const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
	const approveUrl = approvalPage(origin, data?.verification_uri);
	if (
		!data ||
		typeof data.device_code !== "string" ||
		data.device_code.length === 0 ||
		typeof data.user_code !== "string" ||
		!USER_CODE.test(data.user_code) ||
		!approveUrl
	) {
		return { kind: "unavailable" };
	}
	const seconds =
		typeof data.expires_in === "number" && data.expires_in > 0
			? Math.min(data.expires_in, MAX_SECONDS)
			: MAX_SECONDS;
	const expiresAt = Date.now() + seconds * 1000;
	const stored: Stored = {
		deviceCode: data.device_code,
		userCode: data.user_code,
		approveUrl,
		expiresAt,
		intent,
	};
	await ctx.kv.set(storageKey(key), stored);
	return { kind: "started", ...shown(stored) };
}

function shown(stored: Stored): Shown {
	return {
		userCode: stored.userCode,
		approveUrl: stored.approveUrl,
		expiresAt: new Date(stored.expiresAt).toISOString(),
		intent: stored.intent,
	};
}

function isStored(value: unknown): value is Stored {
	return (
		isRecord(value) &&
		typeof value.deviceCode === "string" &&
		typeof value.userCode === "string" &&
		typeof value.approveUrl === "string" &&
		typeof value.expiresAt === "number" &&
		isRecord(value.intent) &&
		typeof value.intent.form === "string"
	);
}

/** The live approval for `key`, without its device code; an expired one is deleted. */
export async function peekApproval(ctx: PluginContext, key: string): Promise<Shown | undefined> {
	const stored = await ctx.kv.get<unknown>(storageKey(key));
	if (stored === null) return undefined;
	if (!isStored(stored) || stored.expiresAt <= Date.now()) {
		await cancelApproval(ctx, key);
		return undefined;
	}
	return shown(stored);
}

/** Throw a started approval away without using it. */
export async function cancelApproval(ctx: PluginContext, key: string): Promise<void> {
	await ctx.kv.delete(storageKey(key));
}

/** Delete every expired (or damaged) approval. Run by the every-minute task. */
export async function sweepApprovals(ctx: PluginContext, now = Date.now()): Promise<number> {
	let deleted = 0;
	for (const entry of await ctx.kv.list(PREFIX)) {
		if (isStored(entry.value) && entry.value.expiresAt > now) continue;
		await ctx.kv.delete(entry.key);
		deleted += 1;
	}
	return deleted;
}

async function revokeOnce(ctx: PluginContext, origin: string, token: string): Promise<boolean> {
	try {
		const response = await post(ctx, `${origin}/_emdash/api/oauth/token/revoke`, { token });
		return response.ok && !isRedirect(response);
	} catch {
		return false;
	}
}

/** Revoke the refresh token (EmDash then deletes every access token made from it); one retry. */
async function revoke(ctx: PluginContext, origin: string, token: string): Promise<boolean> {
	return (await revokeOnce(ctx, origin, token)) || revokeOnce(ctx, origin, token);
}

/**
 * Exchange the approved code once, run `use` with an authenticated `call`, then revoke.
 * Revoking the refresh token deletes it and every access token made from it.
 */
export async function withApproval<T>(
	ctx: PluginContext,
	origin: string,
	key: string,
	use: (call: AdminCall, intent: Intent) => Promise<T>,
): Promise<FinishResult<T>> {
	const stored = await ctx.kv.get<unknown>(storageKey(key));
	if (stored === null) return { kind: "missing" };
	if (!isStored(stored)) {
		await cancelApproval(ctx, key);
		return { kind: "missing" };
	}
	if (stored.expiresAt <= Date.now()) {
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
		await cancelApproval(ctx, key);
		return { kind: "unavailable" };
	}
	if (isRedirect(response)) {
		await cancelApproval(ctx, key);
		return { kind: "unavailable" };
	}
	const body = await jsonOf(response);
	const answer = isRecord(body) && typeof body.error === "string" ? body.error : "";
	if (!response.ok) {
		if (answer === "authorization_pending" || answer === "slow_down") return { kind: "pending" };
		// Busy or a passing fault: keep the code, it may already be approved.
		if (busy(response.status)) return { kind: "busy" };
		await cancelApproval(ctx, key);
		if (answer === "access_denied") return { kind: "denied" };
		if (answer === "expired_token") return { kind: "expired" };
		return { kind: "unavailable" };
	}
	await cancelApproval(ctx, key);
	const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
	const access = data?.access_token;
	const refresh = data?.refresh_token;
	if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
		// A token may have been made: throw away whichever one came.
		const token =
			typeof refresh === "string" && refresh
				? refresh
				: typeof access === "string" && access
					? access
					: "";
		if (!token) return { kind: "unavailable" };
		return { kind: "unavailable", revoked: await revoke(ctx, origin, token) };
	}

	const call: AdminCall = async (path, init) => {
		if (!ctx.http) throw new Error("Web requests are not available.");
		const method = init?.method ?? (init?.body === undefined ? "GET" : "POST");
		const response = await ctx.http.fetch(`${origin}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${access}`,
				...(init?.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			redirect: "manual",
		});
		// Never follow the admin token anywhere: stop, and the access is revoked.
		if (isRedirect(response)) throw new Error("This site answered with a redirect.");
		return response;
	};

	try {
		const value = await use(call, stored.intent);
		return { kind: "done", value, revoked: await revoke(ctx, origin, refresh) };
	} catch (error) {
		const reason =
			error instanceof Error ? scrub(error.message, [access, refresh]) : "It did not work.";
		return { kind: "failed", reason, revoked: await revoke(ctx, origin, refresh) };
	}
}

/** Never let a token reach a message, even through an error text. */
function scrub(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join("[hidden]");
	return out.replace(/ec_o[ar]t_[A-Za-z0-9_-]*/g, "[hidden]");
}
