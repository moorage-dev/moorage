// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	// Each test starts a sandboxed EmDash; with several files at once the default 5 s is too short.
	test: { testTimeout: 30_000 },
});
