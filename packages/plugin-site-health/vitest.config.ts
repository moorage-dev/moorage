// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	// A full check runs dozens of sandboxed steps; leave room on a busy machine.
	// One test file at a time: the harness builds the plugin once per test file into the same
	// dist/manifest.json, and two builds at once let a test read it half-written ("Unexpected end
	// of JSON input" on CI). @emdash-cms/plugin-test 0.2.10 still does this.
	test: { testTimeout: 30_000, fileParallelism: false },
});
