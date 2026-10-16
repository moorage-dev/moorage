// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	// Each test starts a real sandbox and database; on a busy machine that alone takes seconds.
	test: { testTimeout: 60_000 },
});
