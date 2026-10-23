// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

/**
 * A sandboxed run may make 10 calls to the host and use about 50 ms of CPU.
 * Every `ctx.*` call is one, `ctx.log` included; the 11th throws. A run here
 * makes at most `OPS_LIMIT`, one to spare. Every run goes through `counted`,
 * so each step can see what it has spent: work that would not fit is left
 * to the next run.
 */
export const OPS_LIMIT = 9;

export interface Counter {
	ops: number;
}

/** Can `calls` more host calls still be made in this run? */
export function fits(counter: Counter, calls: number): boolean {
	return counter.ops + calls <= OPS_LIMIT;
}

const SERVICES = [
	"kv",
	"settings",
	"content",
	"schema",
	"redirects",
	"http",
	"email",
	"cron",
	"log",
] as const;

function countMethods<T extends object>(target: T, counter: Counter): T {
	return new Proxy(target, {
		get(object, key, receiver) {
			const value = Reflect.get(object, key, receiver) as unknown;
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				counter.ops += 1;
				return (value as (...a: unknown[]) => unknown).apply(object, args);
			};
		},
	});
}

/** A context whose host calls are counted in `counter`. */
export function counted(ctx: PluginContext, counter: Counter): PluginContext {
	const wrapped: Record<string, unknown> = {};
	for (const name of SERVICES) {
		const service = ctx[name] as object | undefined;
		if (service) wrapped[name] = countMethods(service, counter);
	}
	// Collections are wrapped when first used: the sandbox's storage object
	// may not list them.
	const cache = new Map<string, object>();
	const storageWrapped = new Proxy(ctx.storage as Record<string, object>, {
		get(object, key, receiver) {
			const collection = Reflect.get(object, key, receiver) as unknown;
			if (typeof key !== "string" || !collection || typeof collection !== "object") {
				return collection;
			}
			let proxy = cache.get(key);
			if (!proxy) {
				proxy = countMethods(collection, counter);
				cache.set(key, proxy);
			}
			return proxy;
		},
	});
	return new Proxy(ctx, {
		get(object, key, receiver) {
			if (key === "storage") return storageWrapped;
			if (typeof key === "string" && key in wrapped) return wrapped[key];
			return Reflect.get(object, key, receiver) as unknown;
		},
	});
}
