// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

/**
 * Makes the browser script available to server code as a string.
 *
 * `import code from "virtual:client-script"` gives the contents of
 * `src/client/main.ts`, bundled into one minified function. Plugin routes
 * cannot serve JavaScript files, so the script has to travel inside the page;
 * this keeps it real, tested TypeScript instead of a hand-written string.
 *
 * The same plugin is used by the build (`tsdown.config.ts`) and by the tests
 * (`vitest.config.ts`), so tests always see exactly what ships. Nothing is
 * written to disk.
 */

export const CLIENT_MODULE = "virtual:client-script";
const RESOLVED = `\0${CLIENT_MODULE}`;

const root = dirname(fileURLToPath(import.meta.url));
const clientDir = join(root, "src", "client");

export async function buildClientScript(): Promise<string> {
	const [result] = await build({
		cwd: root,
		entry: [join(clientDir, "main.ts")],
		format: "iife",
		platform: "browser",
		target: "es2020",
		minify: true,
		write: false,
		dts: false,
		clean: false,
		report: false,
		config: false,
		logLevel: "silent",
	});
	const chunk = result?.chunks.find((output) => output.type === "chunk");
	if (!chunk || chunk.type !== "chunk") throw new Error("client script: nothing was built");
	return chunk.code.trim();
}

interface PluginContext {
	addWatchFile(file: string): void;
}

export function clientScript() {
	return {
		name: "client-script",
		resolveId(id: string) {
			return id === CLIENT_MODULE ? RESOLVED : null;
		},
		async load(this: PluginContext, id: string) {
			if (id !== RESOLVED) return null;
			for (const file of readdirSync(clientDir)) this.addWatchFile(join(clientDir, file));
			return `export default ${JSON.stringify(await buildClientScript())};`;
		},
	};
}
