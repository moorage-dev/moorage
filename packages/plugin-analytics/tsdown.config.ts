// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import { defineConfig } from "tsdown";

import { clientScript } from "./client-script.ts";

export default defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	dts: true,
	clean: true,
	plugins: [clientScript()],
});
