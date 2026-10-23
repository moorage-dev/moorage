// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

/**
 * On Cloudflare a sandboxed plugin may make at most 10 calls to the site (ctx.*, logging
 * included) in one hook call, route call or cron run; the 11th fails, and so does every call
 * after it. The plugin keeps to 9, so one call is always spare.
 */
export const CALLS_PER_RUN = 9;

export interface Meter {
	/** The same context; every call through it is counted. */
	ctx: PluginContext;
	/** Calls made so far. */
	used(): number;
	/** Calls left before CALLS_PER_RUN. */
	left(): number;
}

/**
 * Count the calls made through a context, so a path whose cost depends on the data (how many
 * emails, how many pages of people) can stop before the limit and leave the rest for later.
 * Every function under ctx counts as one call: overcounting is safe, undercounting is not.
 */
export function meter(ctx: PluginContext): Meter {
	let calls = 0;
	const wrap = <T>(value: T, depth: number): T => {
		if (depth > 3 || value === null || typeof value !== "object") return value;
		return new Proxy(value as object, {
			get(target, key) {
				const member = (target as Record<string | symbol, unknown>)[key];
				if (typeof member === "function") {
					return (...args: unknown[]) => {
						calls++;
						return (member as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return wrap(member, depth + 1);
			},
		}) as T;
	};
	return {
		ctx: wrap(ctx, 0),
		used: () => calls,
		left: () => CALLS_PER_RUN - calls,
	};
}

/** Log a warning only when a call is left for it: a log must never cost the run itself. */
export function warnIfRoom(m: Meter, message: string, data: Record<string, unknown>): void {
	if (m.left() < 1) return;
	void Promise.resolve(m.ctx.log.warn(message, data)).catch(() => {});
}
