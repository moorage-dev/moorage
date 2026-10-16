// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The only module that talks to Cloudflare. Everything goes through the owner's own key to
// api.cloudflare.com (the one allowed host). Tests and the demo site answer these calls with a
// simulated Cloudflare (test-support/simulated-cloudflare.mjs); nothing in a test reaches Cloudflare.

const API = "https://api.cloudflare.com/client/v4";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What went wrong, in the terms the page explains. */
export type CloudflareProblem =
	/** The key was not accepted (wrong, expired, or revoked). */
	| "refused"
	/** The key works but may not do this. */
	| "forbidden"
	| "not-found"
	/** No answer at all: the request may or may not have reached Cloudflare. */
	| "network"
	| "other";

export class CloudflareError extends Error {
	constructor(
		readonly problem: CloudflareProblem,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "CloudflareError";
	}
}

export interface Account {
	id: string;
	name: string;
}

export interface Database {
	uuid: string;
	name: string;
}

export interface RestoreResult {
	/** The point the database is now at. */
	bookmark: string;
	/** The point just before this restore: restoring it undoes this restore. */
	previousBookmark: string | null;
}

export type Row = Record<string, unknown>;

export interface CloudflareClient {
	accounts(): Promise<Account[]>;
	/** When the key stops working (ISO), or null for never. */
	expiresOn(accountId: string): Promise<string | null>;
	databases(accountId: string): Promise<Database[]>;
	query(accountId: string, databaseId: string, sql: string, params?: unknown[]): Promise<Row[]>;
	/** The restore point at or just before a moment (ISO). */
	pointAt(accountId: string, databaseId: string, moment: string): Promise<string>;
	restore(accountId: string, databaseId: string, point: string): Promise<RestoreResult>;
}

interface Envelope<T> {
	success?: boolean;
	result?: T;
	errors?: Array<{ code?: number; message?: string }>;
}

export function createCloudflareClient(fetch: Fetch, key: string): CloudflareClient {
	async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
		let response: Response;
		try {
			response = await fetch(`${API}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${key}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			throw new CloudflareError("network", String((error as Error)?.message ?? error));
		}
		let json: Envelope<T> = {};
		try {
			json = (await response.json()) as Envelope<T>;
		} catch {
			// A non-JSON answer is treated by its status below.
		}
		if (response.ok && json.success !== false) return json.result as T;
		const message =
			(json.errors ?? []).map((e) => e.message ?? "").join("; ") || `HTTP ${response.status}`;
		const problem: CloudflareProblem =
			response.status === 401
				? "refused"
				: response.status === 403
					? "forbidden"
					: response.status === 404
						? "not-found"
						: response.status >= 500 || response.status === 408
							? "network"
							: "other";
		throw new CloudflareError(problem, message, response.status);
	}

	const db = (accountId: string, databaseId: string) =>
		`/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`;

	return {
		async accounts() {
			return (await call<Account[]>("GET", "/accounts?per_page=50")) ?? [];
		},
		async expiresOn(accountId) {
			try {
				const result = await call<{ expires_on?: string | null }>(
					"GET",
					`/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
				);
				return result?.expires_on ?? null;
			} catch {
				// A key made under a person rather than the account is verified elsewhere.
				const result = await call<{ expires_on?: string | null }>("GET", "/user/tokens/verify");
				return result?.expires_on ?? null;
			}
		},
		async databases(accountId) {
			const list = await call<Database[]>(
				"GET",
				`/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=100`,
			);
			return (list ?? []).map(({ uuid, name }) => ({ uuid, name }));
		},
		async query(accountId, databaseId, sql, params = []) {
			const result = await call<Array<{ results?: Row[] }>>(
				"POST",
				`${db(accountId, databaseId)}/query`,
				{
					sql,
					params,
				},
			);
			return result?.[0]?.results ?? [];
		},
		async pointAt(accountId, databaseId, moment) {
			const result = await call<{ bookmark?: string }>(
				"GET",
				`${db(accountId, databaseId)}/time_travel/bookmark?timestamp=${encodeURIComponent(moment)}`,
			);
			if (!result?.bookmark) throw new CloudflareError("other", "No restore point for that moment");
			return result.bookmark;
		},
		async restore(accountId, databaseId, point) {
			const result = await call<{ bookmark?: string; previous_bookmark?: string }>(
				"POST",
				`${db(accountId, databaseId)}/time_travel/restore?bookmark=${encodeURIComponent(point)}`,
			);
			return {
				bookmark: result?.bookmark ?? point,
				previousBookmark: result?.previous_bookmark ?? null,
			};
		},
	};
}
