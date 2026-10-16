// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { defineConfig } from "vitest/config";

import { clientScript } from "./client-script.ts";

export default defineConfig({
	plugins: [clientScript()],
});
