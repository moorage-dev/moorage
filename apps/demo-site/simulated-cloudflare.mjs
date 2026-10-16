// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The demo site never reaches Cloudflare. Restore talks to api.cloudflare.com through the
// owner's key; here every such call is answered by a simulated Cloudflare whose "site
// database" is this demo site's own SQLite file, so the review shows the demo's real changes.
// A restore is recorded but changes nothing (SQLite has no Time Travel). Sandboxed or
// in-process, the plugin's requests leave through this process's fetch, which is where the
// simulator sits.

import { DatabaseSync } from "node:sqlite";

import { interceptCloudflare } from "../../packages/plugin-restore/test-support/simulated-cloudflare.mjs";

/** @param {string} url the demo site's database URL ("file:./data.db") */
export function simulateCloudflare(url) {
	const path = url.replace(/^file:/, "");
	// Opened on the first query: the file may not exist yet when the config loads.
	let db;
	const open = () => (db ??= new DatabaseSync(path));
	const value = (v) => (typeof v === "boolean" ? Number(v) : v);
	return interceptCloudflare({
		accountName: "Demo account",
		siteDatabase: "demo-site",
		otherDatabases: ["another-site"],
		exec: async (sql, params) => {
			const statement = open().prepare(sql);
			const values = params.map(value);
			if (/^\s*(select|with|pragma)\b/i.test(sql)) return statement.all(...values);
			statement.run(...values);
			return [];
		},
	});
}
