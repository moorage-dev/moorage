// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	// A full check runs dozens of sandboxed steps; leave room on a busy machine.
	test: { testTimeout: 30_000 },
});
