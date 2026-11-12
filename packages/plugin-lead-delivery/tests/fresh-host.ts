// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * @emdash-cms/plugin-test 0.2.12 (EmDash 1.5) runs plugin:activate when the host is made, before
 * any fixture: a private key and the schedule are saved, and the every-minute task is asked
 * for. These tests start from a site where the plugin has not run yet (or from an older
 * release's saved setup), so forget them.
 *
 * The task itself cannot be removed, so it is moved a year away: run once on a clock a year
 * ahead (with the daily run that asks for), it next comes due a year from now and never joins
 * a run a test measures. What those runs and the activation wrote is then cleared.
 */
export async function forgetActivation(host: PluginRuntimeTestHost): Promise<void> {
	host.scheduled.setTime(new Date(Date.now() + YEAR_MS));
	await host.scheduled.run();
	await host.scheduled.run();
	host.scheduled.setTime(new Date());
	const tasks = (await host.inspect.scheduledTasks()) as Array<{ name: string; nextRunAt: string }>;
	const soon = tasks.filter((t) => Date.parse(t.nextRunAt) < Date.now() + YEAR_MS / 2);
	if (soon.length > 0) throw new Error(`still due soon: ${soon.map((t) => t.name).join(", ")}`);
	for (const entry of await host.inspect.kv.list()) await host.fixtures.plugin.kv(entry.id, null);
	await host.fixtures.plugin.setting("config", null);
}
