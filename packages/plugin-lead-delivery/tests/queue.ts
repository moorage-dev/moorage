// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

import type { Send } from "../src/types.js";

/**
 * Deliver what is waiting, as the site's scheduler does: enquiries are stored on arrival and
 * sent by the runs that follow (the one-shot `deliver` task, its follow-ups, the every-minute
 * task). Runs the delivery tasks one tick at a time, or a `deliver` run when tries are due and
 * no task was asked for, until nothing is due.
 */
export async function runQueued(runtime: PluginRuntimeTestHost, max = 30): Promise<number> {
	for (let n = 0; n < max; n++) {
		const now = new Date().toISOString();
		const due = (await runtime.inspect.storage.list<Send>("deliveries")).some(
			(r) => r.data.status === "retrying" && r.data.nextAt <= now,
		);
		const tasks = ((await runtime.inspect.scheduledTasks()) as Array<{ name: string }>).filter(
			(t) => t.name.startsWith("deliver"),
		);
		if (!due && tasks.length === 0) return n;
		if (tasks.length > 0) {
			runtime.scheduled.setTime(new Date(Date.now() + 5_000));
			await runtime.scheduled.run();
		} else {
			await runtime.transport.invokeHook("cron", { name: "deliver", data: null });
		}
	}
	throw new Error(`still delivering after ${max} runs`);
}
