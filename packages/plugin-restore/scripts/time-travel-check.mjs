#!/usr/bin/env node
// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The scratch-database check for Restore, run before the plugin is released.
//
// It creates a new, empty D1 database in a TEST Cloudflare account, writes rows, takes a
// restore point, restores, and reports timings and what survives. It touches only the
// database it created in this run (fixed name prefix, id checked before every destructive
// call) and deletes it at the end. It never reads or changes any other database.
//
// Usage (the key is read from the environment, never from the command line):
//   CLOUDFLARE_API_TOKEN=... node scripts/time-travel-check.mjs --test-account=<account id>
//
// Options:
//   --test-account=<id>   Required. Must equal the account the key belongs to. This is your
//                         statement that the account is a test account with nothing real in it.
//   --sizes=1,50          Database sizes to try, in MB (default 1,50). Free plan: 500 MB per
//                         database; each MB is one write of about 1 MB.
//   --account-has-other-databases
//                         Run even though the account already holds other D1 databases. Without
//                         it the script stops, because a real account usually has some.
//   --worker              Also check point 1 from inside a Worker: upload a tiny Worker bound to
//                         the scratch database that restores its own database and keeps writing.
//                         Needs a key that can also edit Workers scripts; the Worker is deleted after.
//   --keep                Keep the scratch database (and Worker) afterwards, to look at by hand.
//   --simulate            Run against a simulated Cloudflare in this process. No network, no key.
//   --json                Print the report as JSON.

import { setTimeout as sleep } from "node:timers/promises";

const API = "https://api.cloudflare.com/client/v4";
const PREFIX = "restore-check-";

const args = parseArgs(process.argv.slice(2));
const simulate = args.simulate === true;
const token = simulate ? "simulated" : process.env.CLOUDFLARE_API_TOKEN;
const testAccount = typeof args["test-account"] === "string" ? args["test-account"] : "";
const sizes = String(args.sizes ?? "1,50")
	.split(",")
	.map((size) => Number(size.trim()))
	.filter((size) => Number.isFinite(size) && size > 0);

function parseArgs(list) {
	const out = {};
	for (const arg of list) {
		const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
		if (!match) fail(`Unknown argument: ${arg}`);
		out[match[1]] = match[2] ?? true;
	}
	return out;
}

function fail(message) {
	console.error(`\n${message}\n`);
	process.exit(1);
}

if (!simulate) {
	if (!testAccount) {
		fail(
			"Refusing to run: say which account is the test account with --test-account=<account id>.\n" +
				"Use a Cloudflare account with nothing real in it. Never point this at a site's account.",
		);
	}
	if (!token) fail("Set CLOUDFLARE_API_TOKEN to a key with D1 Edit on the test account.");
}
if (sizes.length === 0) fail("--sizes needs at least one size in MB, for example --sizes=1,50");

// ---------------------------------------------------------------- Cloudflare calls

const fetchImpl = simulate ? await createSimulatedCloudflare() : globalThis.fetch;
const calls = [];

async function cf(method, path, body) {
	const started = performance.now();
	const response = await fetchImpl(`${API}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const ms = Math.round(performance.now() - started);
	let json;
	try {
		json = await response.json();
	} catch {
		json = { success: false, errors: [{ message: `not JSON (HTTP ${response.status})` }] };
	}
	const entry = {
		method,
		path: path.replace(/[0-9a-f-]{36}/g, "<db>"),
		status: response.status,
		ms,
	};
	calls.push(entry);
	if (!response.ok || json.success === false) {
		const error = new Error(
			(json.errors ?? []).map((e) => `${e.code ?? ""} ${e.message}`.trim()).join("; ") ||
				`HTTP ${response.status}`,
		);
		error.status = response.status;
		throw error;
	}
	return json.result;
}

async function tryCf(method, path, body) {
	try {
		return { ok: true, result: await cf(method, path, body) };
	} catch (error) {
		return { ok: false, status: error.status, error: error.message };
	}
}

// ---------------------------------------------------------------- the run

const report = { startedAt: new Date().toISOString(), simulated: simulate, sizes: [], points: {} };
const created = new Set();
let accountId = "";

try {
	// Which account does the key belong to? It must be the one named as the test account.
	const accounts = await cf("GET", "/accounts?per_page=50");
	if (simulate && !testAccount) accountId = accounts[0].id;
	else {
		const match = accounts.find((account) => account.id === testAccount);
		if (!match) {
			fail(
				`Refusing to run: the key does not belong to account ${testAccount}.\n` +
					`It reaches: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ") || "no accounts"}.`,
			);
		}
		if (accounts.length > 1) {
			fail(
				`Refusing to run: the key reaches ${accounts.length} accounts. Make a key for the test account only.`,
			);
		}
		accountId = match.id;
	}

	const existing = await cf("GET", `/accounts/${accountId}/d1/database?per_page=100`);
	const others = existing.filter((db) => !db.name.startsWith(PREFIX));
	if (others.length > 0 && args["account-has-other-databases"] !== true) {
		fail(
			`Refusing to run: this account already holds ${others.length} other D1 database(s) ` +
				`(${others.map((db) => db.name).join(", ")}). That does not look like a test account.\n` +
				"If it really is one, run again with --account-has-other-databases. They are never touched.",
		);
	}

	report.points.permissions = await checkPermissions();

	for (const size of sizes) report.sizes.push(await runSize(size));

	report.points.windowProbe = await probeWindow(report.sizes[0]?.databaseId);

	if (args.worker === true) report.points.worker = await runWorkerCheck();
} catch (error) {
	report.error = String(error?.message ?? error);
} finally {
	if (args.keep !== true) {
		for (const id of created) {
			const listed = await tryCf("GET", `/accounts/${accountId}/d1/database/${id}`);
			if (listed.ok && String(listed.result?.name ?? "").startsWith(PREFIX)) {
				await tryCf("DELETE", `/accounts/${accountId}/d1/database/${id}`);
			}
		}
	}
	report.finishedAt = new Date().toISOString();
	report.calls = calls;
	printReport(report);
}

async function createScratch(label) {
	const name = `${PREFIX}${label}-${Date.now().toString(36)}`;
	const db = await cf("POST", `/accounts/${accountId}/d1/database`, { name });
	created.add(db.uuid);
	return { id: db.uuid, name };
}

/** Every destructive call goes through this: the id must be one this run created. */
function guard(id) {
	if (!created.has(id))
		throw new Error(`Refusing to touch a database this run did not create (${id})`);
	return id;
}

function query(id, sql, params = []) {
	return cf("POST", `/accounts/${accountId}/d1/database/${guard(id)}/query`, { sql, params });
}

async function rows(id, sql, params) {
	const result = await query(id, sql, params);
	return result?.[0]?.results ?? [];
}

async function bookmarkAt(id, when) {
	const qs = when ? `?timestamp=${encodeURIComponent(when.toISOString())}` : "";
	const result = await cf(
		"GET",
		`/accounts/${accountId}/d1/database/${guard(id)}/time_travel/bookmark${qs}`,
	);
	return result.bookmark;
}

/** Restores go only through here, so the id check always runs first. */
function tryRestore(id, bookmark) {
	return tryCf(
		"POST",
		`/accounts/${accountId}/d1/database/${guard(id)}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`,
	);
}

async function runSize(sizeMb) {
	const out = { sizeMb };
	const db = await createScratch(`${sizeMb}mb`);
	out.databaseId = db.id;
	await query(db.id, "CREATE TABLE marks (name TEXT PRIMARY KEY, at TEXT NOT NULL)");
	await query(db.id, "CREATE TABLE filler (b BLOB)");

	const fillStart = performance.now();
	for (let mb = 0; mb < sizeMb; mb++) {
		await query(
			db.id,
			"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) " +
				"INSERT INTO filler (b) SELECT randomblob(1000) FROM n",
		);
	}
	out.fillSeconds = seconds(fillStart);

	await query(db.id, "INSERT INTO marks VALUES ('before', ?)", [new Date().toISOString()]);
	// Restore points are taken on a clock; leave a gap on both sides of the moment.
	await sleep(simulate ? 5 : 3000);
	const moment = new Date();
	await sleep(simulate ? 5 : 3000);
	await query(db.id, "INSERT INTO marks VALUES ('after-moment', ?)", [new Date().toISOString()]);

	const bookmark = await bookmarkAt(db.id, moment);
	out.bookmarkResolved = Boolean(bookmark);

	// What a visitor's queries see while the restore runs (point 2).
	let restoring = true;
	const during = [];
	const prober = (async () => {
		while (restoring) {
			const started = performance.now();
			const probe = await tryCf("POST", `/accounts/${accountId}/d1/database/${db.id}/query`, {
				sql: "SELECT count(*) AS n FROM marks",
				params: [],
			});
			during.push({
				ms: Math.round(performance.now() - started),
				ok: probe.ok,
				...(probe.ok ? { marks: probe.result?.[0]?.results?.[0]?.n } : { error: probe.error }),
			});
			await sleep(simulate ? 1 : 250);
		}
	})();
	const restoreStart = performance.now();
	const restored = await tryRestore(db.id, bookmark);
	out.restoreSeconds = seconds(restoreStart);
	restoring = false;
	await prober;
	out.restoreOk = restored.ok;
	if (!restored.ok) {
		out.restoreError = restored.error;
		return out;
	}
	out.restoreMessage = restored.result?.message ?? null;
	out.queriesDuringRestore = summariseDuring(during);

	// Writes straight after the restore land in the restored database (point 1, from outside).
	const afterRestoreStart = performance.now();
	await query(db.id, "INSERT INTO marks VALUES ('after-restore', ?)", [new Date().toISOString()]);
	out.firstWriteAfterRestoreMs = Math.round(performance.now() - afterRestoreStart);
	const names = (await rows(db.id, "SELECT name FROM marks ORDER BY name")).map((row) => row.name);
	out.survivesRestore = {
		before: names.includes("before"),
		afterMomentGone: !names.includes("after-moment"),
		writeAfterRestore: names.includes("after-restore"),
	};
	out.fillerRows = (await rows(db.id, "SELECT count(*) AS n FROM filler"))[0]?.n ?? null;

	// Undo: restore to the point the restore returned (what the plugin's Undo button does).
	const previous = restored.result?.previous_bookmark;
	out.previousBookmarkReturned = Boolean(previous);
	if (previous) {
		const undoStart = performance.now();
		const undone = await tryRestore(db.id, previous);
		out.undoSeconds = seconds(undoStart);
		out.undoOk = undone.ok;
		if (undone.ok) {
			const back = (await rows(db.id, "SELECT name FROM marks ORDER BY name")).map((r) => r.name);
			out.afterUndo = {
				afterMomentBack: back.includes("after-moment"),
				writeAfterRestoreKept: back.includes("after-restore"),
			};
		} else out.undoError = undone.error;
	}

	// Older restore points still resolve after two restores.
	const older = await tryCf(
		"GET",
		`/accounts/${accountId}/d1/database/${db.id}/time_travel/bookmark?timestamp=${encodeURIComponent(moment.toISOString())}`,
	);
	out.olderPointStillResolves = older.ok && Boolean(older.result?.bookmark);
	return out;
}

function summariseDuring(list) {
	const failed = list.filter((probe) => !probe.ok);
	return {
		probes: list.length,
		failed: failed.length,
		slowestMs: Math.max(0, ...list.map((probe) => probe.ms)),
		errors: [...new Set(failed.map((probe) => probe.error))].slice(0, 5),
		marksSeen: [...new Set(list.filter((p) => p.ok).map((p) => p.marks))],
	};
}

/** Point 6: which calls this key may make. */
async function checkPermissions() {
	const verify = await tryCf("GET", `/accounts/${accountId}/tokens/verify`);
	const userVerify = verify.ok ? null : await tryCf("GET", "/user/tokens/verify");
	const db = await createScratch("perm");
	const q = await tryCf("POST", `/accounts/${accountId}/d1/database/${db.id}/query`, {
		sql: "SELECT 1 AS one",
		params: [],
	});
	const b = await tryCf("GET", `/accounts/${accountId}/d1/database/${db.id}/time_travel/bookmark`);
	const r = b.ok
		? await tryRestore(db.id, b.result.bookmark)
		: { ok: false, error: "no restore point to try" };
	const scripts = await tryCf("GET", `/accounts/${accountId}/workers/scripts`);
	return {
		accountTokenVerify: verify.ok ? (verify.result?.status ?? "ok") : verify.error,
		expiresOn: verify.result?.expires_on ?? null,
		userTokenVerify: userVerify ? (userVerify.ok ? "ok" : userVerify.error) : "not needed",
		listDatabases: "ok",
		createDatabase: "ok",
		query: q.ok ? "ok" : q.error,
		getRestorePoint: b.ok ? "ok" : b.error,
		restore: r.ok ? "ok" : r.error,
		listWorkerScripts: scripts.ok
			? "ok (key can also see Workers)"
			: "refused (expected for D1 Edit only)",
	};
}

/** Point 7 (part): is a moment 8 or 29 days ago accepted for a database made today? */
async function probeWindow(id) {
	if (!id) return null;
	const out = {};
	for (const days of [8, 29]) {
		const when = new Date(Date.now() - days * 86_400_000);
		const probe = await tryCf(
			"GET",
			`/accounts/${accountId}/d1/database/${id}/time_travel/bookmark?timestamp=${encodeURIComponent(when.toISOString())}`,
		);
		out[`${days}DaysAgo`] = probe.ok
			? `accepted (${probe.result?.bookmark ?? "no point"})`
			: probe.error;
	}
	out.note =
		"A database made today has no history that far back, so this shows what the API says about such a moment, " +
		"not the plan's window. Repeat on a database older than 8 days to tell 7 from 30 days.";
	return out;
}

// ---------------------------------------------------------------- point 1 from inside a Worker

const WORKER_SOURCE = `
export default {
  async fetch(request, env) {
    const out = {};
    const api = (path, init) => fetch("https://api.cloudflare.com/client/v4/accounts/" + env.ACCOUNT_ID + "/d1/database/" + env.DATABASE_ID + path, { ...init, headers: { authorization: "Bearer " + env.TOKEN } }).then((r) => r.json());
    await env.DB.exec("CREATE TABLE IF NOT EXISTS marks (name TEXT PRIMARY KEY, at TEXT NOT NULL)");
    await env.DB.prepare("INSERT OR REPLACE INTO marks VALUES ('before', ?)").bind(new Date().toISOString()).run();
    await new Promise((r) => setTimeout(r, 3000));
    const moment = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 3000));
    await env.DB.prepare("INSERT OR REPLACE INTO marks VALUES ('doomed', ?)").bind(new Date().toISOString()).run();
    const point = await api("/time_travel/bookmark?timestamp=" + encodeURIComponent(moment));
    const started = Date.now();
    const restored = await api("/time_travel/restore?bookmark=" + encodeURIComponent(point.result.bookmark), { method: "POST" });
    out.restoreMs = Date.now() - started;
    out.restoreOk = restored.success;
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO marks VALUES ('written-by-worker-after', ?)").bind(new Date().toISOString()).run();
      out.writeAfterRestore = "ok";
    } catch (error) { out.writeAfterRestore = String(error); }
    try {
      const { results } = await env.DB.prepare("SELECT name FROM marks ORDER BY name").all();
      out.marksSeenByWorker = results.map((r) => r.name);
    } catch (error) { out.readAfterRestore = String(error); }
    out.workerStillRunning = true;
    return Response.json(out);
  },
};`;

async function runWorkerCheck() {
	const db = await createScratch("worker");
	const name = `${PREFIX}worker-${Date.now().toString(36)}`;
	const form = new FormData();
	form.append(
		"metadata",
		JSON.stringify({
			main_module: "worker.mjs",
			compatibility_date: "2026-08-20",
			bindings: [
				{ type: "d1", name: "DB", id: db.id },
				{ type: "plain_text", name: "ACCOUNT_ID", text: accountId },
				{ type: "plain_text", name: "DATABASE_ID", text: db.id },
				{ type: "secret_text", name: "TOKEN", text: token },
			],
		}),
	);
	form.append(
		"worker.mjs",
		new Blob([WORKER_SOURCE], { type: "application/javascript+module" }),
		"worker.mjs",
	);
	const out = {};
	try {
		const upload = await fetchImpl(`${API}/accounts/${accountId}/workers/scripts/${name}`, {
			method: "PUT",
			headers: { authorization: `Bearer ${token}` },
			body: form,
		});
		if (!upload.ok)
			return {
				skipped: `could not upload the Worker (HTTP ${upload.status}); the key needs Workers Scripts Edit`,
			};
		const sub = await cf("GET", `/accounts/${accountId}/workers/subdomain`);
		await cf("POST", `/accounts/${accountId}/workers/scripts/${name}/subdomain`, { enabled: true });
		const url = `https://${name}.${sub.subdomain}.workers.dev/`;
		// A new workers.dev address can take a little while to answer.
		for (let attempt = 0; attempt < 20; attempt++) {
			const response = await fetchImpl(url).catch(() => null);
			if (response?.ok) {
				Object.assign(out, await response.json());
				break;
			}
			await sleep(3000);
		}
		if (!("restoreOk" in out)) out.error = "the Worker never answered";
	} finally {
		if (args.keep !== true) await tryCf("DELETE", `/accounts/${accountId}/workers/scripts/${name}`);
	}
	return out;
}

// ---------------------------------------------------------------- report

function seconds(started) {
	return Math.round((performance.now() - started) / 100) / 10;
}

function printReport(r) {
	if (args.json === true) {
		console.log(JSON.stringify(r, null, 2));
		return;
	}
	const yes = (value) => (value ? "yes" : "NO");
	console.log(
		`\nRestore: scratch-database check${r.simulated ? " (SIMULATED, no Cloudflare)" : ""}`,
	);
	console.log(`Started ${r.startedAt}, finished ${r.finishedAt}`);
	if (r.error) console.log(`\nStopped early: ${r.error}`);
	if (r.points.permissions) {
		console.log("\nPoint 6, what this key may do:");
		for (const [key, value] of Object.entries(r.points.permissions))
			console.log(`  ${key}: ${value}`);
	}
	for (const s of r.sizes) {
		console.log(`\nPoints 1 and 2 at ${s.sizeMb} MB (filled in ${s.fillSeconds} s):`);
		if (!s.restoreOk) {
			console.log(`  restore FAILED: ${s.restoreError ?? "no restore point"}`);
			continue;
		}
		console.log(`  restore took ${s.restoreSeconds} s; undo took ${s.undoSeconds ?? "-"} s`);
		const d = s.queriesDuringRestore;
		console.log(
			`  queries during the restore: ${d.probes}, failed ${d.failed}, slowest ${d.slowestMs} ms` +
				(d.errors.length ? `; errors: ${d.errors.join(" | ")}` : ""),
		);
		console.log(`  row written before the moment survives: ${yes(s.survivesRestore.before)}`);
		console.log(
			`  row written after the moment is gone: ${yes(s.survivesRestore.afterMomentGone)}`,
		);
		console.log(
			`  write straight after the restore lands: ${yes(s.survivesRestore.writeAfterRestore)} (${s.firstWriteAfterRestoreMs} ms)`,
		);
		console.log(`  filler rows after restore: ${s.fillerRows}`);
		console.log(`  restore returned an undo point: ${yes(s.previousBookmarkReturned)}`);
		if (s.afterUndo) {
			console.log(
				`  undo brings back the row after the moment: ${yes(s.afterUndo.afterMomentBack)}`,
			);
			console.log(
				`  undo keeps the write made after the restore: ${s.afterUndo.writeAfterRestoreKept ? "yes" : "no (expected: undo goes back to just before the restore)"}`,
			);
		}
		console.log(
			`  older restore point still resolves after two restores: ${yes(s.olderPointStillResolves)}`,
		);
	}
	if (r.points.windowProbe) {
		console.log("\nPoint 7 (part), moments far back:");
		for (const [key, value] of Object.entries(r.points.windowProbe))
			console.log(`  ${key}: ${value}`);
	}
	if (r.points.worker) {
		console.log(
			"\nPoint 1 from inside a Worker (a site restoring its own database while running):",
		);
		for (const [key, value] of Object.entries(r.points.worker))
			console.log(`  ${key}: ${JSON.stringify(value)}`);
	} else {
		console.log(
			"\nPoint 1 from inside a Worker: not run (add --worker with a key that may also edit Workers).",
		);
	}
	console.log(
		"\nNot answered by this script (they need a deployed copy of the demo site on a test account):\n" +
			"  3. Go back past an EmDash upgrade: deploy an older EmDash, save a moment, upgrade, restore, then open the admin.\n" +
			"  4. EmDash's in-memory caches: change the site title, restore, check the title on the next page loads.\n" +
			"  5. Read replicas and session cookies: with read replication on, restore and load pages signed in and out.\n" +
			"  8. Telling D1 apart before a key is pasted: open Restore on the deployed site and on the Node demo site.",
	);
	console.log(
		`\nCloudflare calls made: ${r.calls.length}. Scratch databases ${args.keep === true ? "kept" : "deleted"}.\n`,
	);
}

// ---------------------------------------------------------------- simulated Cloudflare

/**
 * An in-process stand-in for the parts of the Cloudflare API this script calls. Each
 * database is SQLite in memory; every write is logged with its time, and a restore rebuilds
 * the database from the log up to the restore point, the way Time Travel replays its log.
 */
async function createSimulatedCloudflare() {
	const { DatabaseSync } = await import("node:sqlite");
	const account = { id: "simulated-account", name: "Simulated test account" };
	const databases = new Map();
	const ok = (result) => Response.json({ success: true, errors: [], messages: [], result });
	const bad = (status, message) =>
		Response.json(
			{ success: false, errors: [{ code: status, message }], result: null },
			{ status },
		);

	function rebuild(db, upTo) {
		db.sqlite.close();
		db.sqlite = new DatabaseSync(":memory:");
		db.log = db.log.slice(0, upTo);
		for (const entry of db.log) db.sqlite.prepare(entry.sql).run(...entry.params);
	}

	return async (url, init = {}) => {
		const { pathname, searchParams } = new URL(url);
		const path = pathname.replace("/client/v4", "");
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		await sleep(2);
		if (path === "/accounts") return ok([account]);
		if (path === `/accounts/${account.id}/tokens/verify`) return ok({ id: "t", status: "active" });
		if (path === `/accounts/${account.id}/workers/scripts`) return bad(403, "Authentication error");
		const list = `/accounts/${account.id}/d1/database`;
		if (path === list && method === "GET")
			return ok([...databases.values()].map(({ uuid, name }) => ({ uuid, name })));
		if (path === list && method === "POST") {
			const uuid = crypto.randomUUID();
			databases.set(uuid, { uuid, name: body.name, sqlite: new DatabaseSync(":memory:"), log: [] });
			return ok({ uuid, name: body.name });
		}
		const match = /^\/accounts\/[^/]+\/d1\/database\/([^/]+)(\/.*)?$/.exec(path);
		const db = match && databases.get(match[1]);
		if (!db) return bad(404, "database not found");
		const rest = match[2] ?? "";
		if (rest === "" && method === "GET") return ok({ uuid: db.uuid, name: db.name });
		if (rest === "" && method === "DELETE") {
			databases.delete(db.uuid);
			return ok(null);
		}
		if (rest === "/query") {
			const statement = db.sqlite.prepare(body.sql);
			const params = body.params ?? [];
			if (/^\s*select/i.test(body.sql)) {
				return ok([{ results: statement.all(...params), success: true, meta: {} }]);
			}
			statement.run(...params);
			db.log.push({ sql: body.sql, params, at: Date.now() });
			return ok([{ results: [], success: true, meta: {} }]);
		}
		if (rest === "/time_travel/bookmark") {
			const at = searchParams.get("timestamp")
				? Date.parse(searchParams.get("timestamp"))
				: Date.now();
			if (at < Date.now() - 30 * 86_400_000)
				return bad(400, "timestamp is outside the 30 day window");
			const index = db.log.filter((entry) => entry.at <= at).length;
			return ok({ bookmark: `sim-${String(index).padStart(8, "0")}` });
		}
		if (rest === "/time_travel/restore" && method === "POST") {
			const target = Number((searchParams.get("bookmark") ?? "").replace("sim-", ""));
			if (!Number.isInteger(target)) return bad(400, "bad bookmark");
			const previous = `sim-${String(db.log.length).padStart(8, "0")}`;
			// Keep the full log so a later restore can move forward again, as Time Travel can.
			db.full ??= [];
			if (db.log.length > db.full.length) db.full = [...db.log];
			db.log = [...db.full];
			await sleep(20);
			rebuild(db, target);
			return ok({
				bookmark: `sim-${String(target).padStart(8, "0")}`,
				previous_bookmark: previous,
				message: "Restored (simulated)",
			});
		}
		return bad(404, `not simulated: ${method} ${path}`);
	};
}
