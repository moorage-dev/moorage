// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	// Each test starts the plugin in a sandbox; on a busy CI runner that can take longer than
	// vitest's default 5 seconds.
	test: { testTimeout: 30_000 },
});
