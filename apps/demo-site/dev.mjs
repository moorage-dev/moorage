// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Runs `astro dev` and restarts it whenever a plugin is rebuilt.
//
// A sandboxed plugin is loaded once, when the dev server starts, so hot reload
// never picks up a plugin change. Each plugin's `dev` script rebuilds its
// `dist/` on save; this watches those folders and restarts the site, which
// takes a few seconds and keeps you signed in.

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";

// Add each plugin's build folder here as packages are added.
const PLUGIN_BUILDS = ["../../packages/plugin-seo/dist", "../../packages/plugin-analytics/dist",
	"../../packages/plugin-popups/dist",
];

let server;
let stopping = false;
let pending;

function start() {
	server = spawn("astro", ["dev", ...process.argv.slice(2)], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	server.on("exit", (code) => {
		if (stopping) process.exit(code ?? 0);
	});
}

function restart() {
	// A build writes several files; wait for it to finish before restarting once.
	clearTimeout(pending);
	pending = setTimeout(() => {
		console.log("\n[demo-site] a plugin was rebuilt, restarting the dev server\n");
		server.removeAllListeners("exit");
		server.once("exit", start);
		server.kill("SIGTERM");
	}, 500);
}

for (const folder of PLUGIN_BUILDS) {
	if (existsSync(folder)) watch(folder, restart);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		stopping = true;
		server.kill(signal);
	});
}

start();
