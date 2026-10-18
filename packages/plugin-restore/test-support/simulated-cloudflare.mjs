// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// A stand-in for the few Cloudflare API calls Restore makes, for tests and the demo site.
// Nothing here ever reaches Cloudflare. It is not part of the plugin bundle.
//
// - Keys: a key starting with "refused" is not accepted; "no-d1" may not see databases;
//   "elsewhere" reaches an account without this site; anything else works.
// - The site's database runs its queries through `exec(sql, params)`, which tests point at
//   the test site's real database (D1 in workerd, SQLite in the demo site).
// - A restore is recorded but does not change data: neither D1 in tests nor SQLite has
//   Time Travel. The scratch-database check (scripts/time-travel-check.mjs) covers that part.

const API = "https://api.cloudflare.com/client/v4";
const DAY = 86_400_000;

/**
 * @param {{
 *   exec: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>,
 *   accountName?: string,
 *   siteDatabase?: string,
 *   otherDatabases?: string[],
 *   now?: () => number,
 * }} options
 */
export function createSimulatedCloudflare(options) {
	const now = options.now ?? (() => Date.now());
	const account = {
		id: "0123456789abcdef0123456789abcdef",
		name: options.accountName ?? "Test account",
	};
	const elsewhere = { id: "fedcba9876543210fedcba9876543210", name: "Another account" };
	const site = {
		uuid: "5173e5c6-0000-4000-8000-000000000001",
		name: options.siteDatabase ?? "site",
	};
	const others = (options.otherDatabases ?? []).map((name, i) => ({
		uuid: `5173e5c6-0000-4000-8000-00000000010${i}`,
		name,
	}));
	const state = {
		/** Every call, for assertions. */
		calls: /** @type {Array<{ method: string, path: string, body?: unknown }>} */ ([]),
		/** Restores made, newest last. */
		restores: /** @type {Array<{ bookmark: string, at: number }>} */ ([]),
		/** Set to "error" or "timeout" to make the next restore fail that way. */
		failNextRestore: /** @type {null | "error" | "timeout"} */ (null),
		expiresOn: /** @type {string | null} */ (null),
	};

	const ok = (result) => Response.json({ success: true, errors: [], messages: [], result });
	const bad = (status, code, message) =>
		Response.json(
			{ success: false, errors: [{ code, message }], messages: [], result: null },
			{ status },
		);
	const bookmarkFor = (ms) =>
		`00000085-${Math.floor(ms).toString(16).padStart(12, "0")}-00004e2f-sim`;
	const timeOf = (bookmark) => Number.parseInt(String(bookmark).split("-")[1] ?? "", 16);

	/** @param {string | URL | Request} input @param {RequestInit} [init] */
	async function fetch(input, init = {}) {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (!url.href.startsWith(API)) throw new Error(`Simulated Cloudflare only answers ${API}`);
		const path = url.pathname.replace("/client/v4", "");
		const method = request.method;
		const text = method === "GET" ? "" : await request.text();
		const body = text ? JSON.parse(text) : undefined;
		state.calls.push({ method, path: `${path}${url.search}`, body });

		const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
		if (!key || key.startsWith("refused")) return bad(401, 10000, "Authentication error");
		const accounts = key.startsWith("elsewhere") ? [elsewhere] : [account];

		if (path === "/accounts") return ok(accounts);
		const match = /^\/accounts\/([^/]+)(\/.*)$/.exec(path);
		if (!match || !accounts.some((a) => a.id === match[1]))
			return bad(403, 9109, "Unauthorized to access requested resource");
		const rest = match[2];
		if (rest === "/tokens/verify")
			return ok({ id: "simulated", status: "active", expires_on: state.expiresOn });
		if (key.startsWith("no-d1")) return bad(403, 10000, "Authentication error");
		const databases = key.startsWith("elsewhere") ? others.slice(0, 1) : [site, ...others];
		if (rest === "/d1/database" && method === "GET") {
			return ok(databases.map((db) => ({ uuid: db.uuid, name: db.name, version: "production" })));
		}
		const dbMatch = /^\/d1\/database\/([^/]+)(\/.*)?$/.exec(rest);
		const db = dbMatch && databases.find((candidate) => candidate.uuid === dbMatch[1]);
		if (!db) return bad(404, 7404, "The database could not be found");
		const action = dbMatch[2] ?? "";
		if (action === "/query" && method === "POST") {
			if (db !== site) return ok([{ results: [], success: true, meta: {} }]);
			try {
				const results = await options.exec(String(body?.sql ?? ""), body?.params ?? []);
				return ok([{ results, success: true, meta: {} }]);
			} catch (error) {
				return bad(400, 7500, String(error?.message ?? error));
			}
		}
		if (action === "/time_travel/bookmark" && method === "GET") {
			const at = url.searchParams.get("timestamp");
			const ms = at ? Date.parse(at) : now();
			if (Number.isNaN(ms) || ms < now() - 30 * DAY)
				return bad(400, 7400, "timestamp is outside the allowed window");
			return ok({ bookmark: bookmarkFor(Math.min(ms, now())) });
		}
		if (action === "/time_travel/restore" && method === "POST") {
			const bookmark = url.searchParams.get("bookmark");
			if (!bookmark || Number.isNaN(timeOf(bookmark))) return bad(400, 7400, "Invalid bookmark");
			const failure = state.failNextRestore;
			state.failNextRestore = null;
			if (failure === "error") return bad(500, 7500, "Internal error");
			if (failure === "timeout") throw new Error("network connection lost");
			const previous = bookmarkFor(now());
			state.restores.push({ bookmark, at: now() });
			return ok({
				bookmark,
				previous_bookmark: previous,
				message: "Database restored (simulated)",
			});
		}
		return bad(404, 7000, `Not simulated: ${method} ${path}`);
	}

	return { fetch, state, account, site, others, bookmarkFor, timeOf };
}

/**
 * Put the simulator in front of `globalThis.fetch` for api.cloudflare.com only. Used by the
 * demo site so the plugin, sandboxed or in-process, never reaches Cloudflare.
 * @param {Parameters<typeof createSimulatedCloudflare>[0]} options
 */
export function interceptCloudflare(options) {
	const simulator = createSimulatedCloudflare(options);
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.startsWith("https://api.cloudflare.com/")) return simulator.fetch(input, init);
		// EmDash checks where a plugin's request goes by asking Cloudflare's public DNS first; answer
		// for api.cloudflare.com here too, so a slow or failed lookup never fails the demo's tests.
		const lookup = new URL(url);
		if (
			lookup.origin === "https://cloudflare-dns.com" &&
			lookup.searchParams.get("name") === "api.cloudflare.com"
		) {
			const type = lookup.searchParams.get("type") === "AAAA" ? 28 : 1;
			const data = type === 28 ? "2606:4700::6810:84e5" : "104.16.132.229";
			return Response.json({
				Status: 0,
				Answer: [{ name: "api.cloudflare.com", type, TTL: 300, data }],
			});
		}
		return original(input, init);
	};
	return simulator;
}
