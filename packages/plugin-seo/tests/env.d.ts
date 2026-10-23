// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The test worker's bindings (set up by emdashPluginTest()); bridge-budget.ts reads the built
// plugin's code from them.
declare module "cloudflare:workers" {
	export const env: Record<string, unknown>;
}
