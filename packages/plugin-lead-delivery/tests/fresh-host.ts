// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

/**
 * @emdash-cms/plugin-test 0.2.12 (EmDash 1.5) runs plugin:activate when the host is made, before
 * any fixture: a private key and the schedule are already saved. These tests start from a site
 * where the plugin has not run yet (or from an older release's saved setup), so forget them.
 */
export async function forgetActivation(host: PluginRuntimeTestHost): Promise<void> {
	await host.fixtures.plugin.setting("config", null);
	await host.fixtures.plugin.kv("config", null);
	await host.fixtures.plugin.kv("schedule", null);
}
