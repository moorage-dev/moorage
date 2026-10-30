// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Counts the calls a sandboxed plugin makes to its host, one invocation at a time (B39).
//
// On Cloudflare, EmDash runs each sandboxed hook call, route call and cron run in a Worker Loader
// isolate limited to 10 subrequests (DEFAULT_LIMITS.subrequests in @emdash-cms/cloudflare's sandbox
// runner, not configurable in EmDash 1.3.1). Every ctx.* call the plugin makes (kv, settings,
// storage, content, media, schema, redirects, users, http.fetch, email.send, cron AND log) is one
// RPC to the host's PluginBridge, so each counts as one subrequest. The 11th throws "Too many
// subrequests by single Worker invocation", and so does every call after it. Neither workerd's
// test loader nor @emdash-cms/plugin-test enforces the limit, so only counting catches it.
//
// This patches PluginBridge.prototype in the test worker (the class @emdash-cms/plugin-test hands
// to the sandbox as its BRIDGE binding), so it counts the real RPCs the real sandbox wrapper
// makes, whatever the plugin code looks like. Each RPC gets a fresh PluginBridge instance, so a
// method the bridge calls on itself (settings.get -> this.kvGet) is counted once.
//
// The same file is copied into each sandbox-capable plugin's tests; keep the copies identical.

import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import { PluginBridge } from "@emdash-cms/plugin-test/worker";
import { env } from "cloudflare:workers";

/** Worker Loader's subrequest limit for one sandboxed invocation (EmDash 1.3.1 and 1.4.0). */
export const SANDBOX_SUBREQUESTS = 10;

/**
 * Every PluginBridge method the generated sandbox wrapper calls (`bridge.X(` in
 * generatePluginWrapper, @emdash-cms/cloudflare 1.3.1). Each is one RPC, one subrequest.
 */
export const BRIDGE_RPCS = [
	"bylineEntriesBylines",
	"bylineGet",
	"bylineList",
	"commentCount",
	"commentGet",
	"commentList",
	"commentSetStatus",
	"contentCreate",
	"contentDelete",
	"contentGet",
	"contentGetRevision",
	"contentGetTrashedVersioned",
	"contentGetVersioned",
	"contentList",
	"contentListRevisions",
	"contentPublicUrl",
	"contentPublish",
	"contentRestore",
	"contentSchedule",
	"contentTranslations",
	"contentUnpublish",
	"contentUnschedule",
	"contentUpdate",
	"cronCancel",
	"cronList",
	"cronSchedule",
	"emailSend",
	"httpFetch",
	"kvCompareAndDelete",
	"kvCompareAndSet",
	"kvDelete",
	"kvGet",
	"kvGetVersioned",
	"kvList",
	"kvSet",
	"log",
	"mediaDelete",
	"mediaGet",
	"mediaList",
	"mediaReadBytes",
	"mediaUpdateMetadata",
	"mediaUpload",
	"redirectCreate",
	"redirectDelete",
	"redirectGet",
	"redirectList",
	"redirectUpdate",
	"schemaGetCollection",
	"schemaListCollections",
	"settingsCompareAndDelete",
	"settingsCompareAndSet",
	"settingsDelete",
	"settingsGet",
	"settingsGetVersioned",
	"settingsList",
	"settingsSet",
	"storageCompareAndDelete",
	"storageCompareAndSet",
	"storageCount",
	"storageDelete",
	"storageDeleteMany",
	"storageGet",
	"storageGetMany",
	"storageGetVersioned",
	"storagePut",
	"storagePutMany",
	"storageQuery",
	"storageUpdateIf",
	"taxonomyAddEntryTerms",
	"taxonomyCreateTerm",
	"taxonomyEntryTerms",
	"taxonomyList",
	"taxonomyRemoveEntryTerms",
	"taxonomyTerms",
	"userGet",
	"userGetByEmail",
	"userList",
] as const;

/**
 * EmDash 1.4.0 (emdash-cms/emdash#4394) moved the content actions, content.create, taxonomy writes
 * and comment moderation off PluginBridge onto a PluginRuntimeBridge: an RpcTarget the host creates
 * for each invocation and hands to the sandbox with the call. Its calls still cross from the
 * sandbox isolate to the host, so they are counted as subrequests too (whether Worker Loader counts
 * calls on a stub received this way is not documented; counting them is the safe reading, and the
 * pinned totals are the same as on 1.3.1 when they count). One instance serves a whole invocation
 * and its methods never call each other, so every call is counted.
 */
export const RUNTIME_RPCS = [
	"commentSetStatus",
	"contentCreate",
	"contentGetTrashedVersioned",
	"contentGetVersioned",
	"contentPublish",
	"contentRestore",
	"contentSchedule",
	"contentUnpublish",
	"contentUnschedule",
	"taxonomyAddEntryTerms",
	"taxonomyCreateTerm",
	"taxonomyRemoveEntryTerms",
] as const;

/**
 * RPCs after which the host may run hooks, including this plugin's own (email:beforeSend,
 * content:beforeSave, content:afterSave, content:afterPublish ...). Those hook runs are separate
 * sandbox invocations with their own budget, so calls made while one of these is pending are
 * recorded apart, in `nested`.
 */
const HOOK_TRIGGERS = new Set<string>([
	"emailSend",
	"contentCreate",
	"contentUpdate",
	"contentDelete",
	"contentPublish",
	"contentUnpublish",
	"contentRestore",
	"contentSchedule",
	"contentUnschedule",
	"mediaUpload",
	"mediaDelete",
	"mediaUpdateMetadata",
]);

export interface Measured<T> {
	/** The RPCs the measured invocation made, in order; its length is the subrequest count. */
	calls: string[];
	/** RPCs made while one of its hook-triggering calls was pending: other invocations' budgets. */
	nested: string[];
	/** With `enforce`, the RPCs refused because the limit was reached (counted in `calls` too). */
	refused: string[];
	result?: T;
	error?: unknown;
}

export interface MeasureOptions {
	/**
	 * Refuse every RPC after the 10th, as Cloudflare does ("Too many subrequests by single Worker
	 * invocation"), to see how a path that goes over behaves there. Off by default: then every
	 * call goes through and `calls` is what the path would need.
	 */
	enforce?: boolean;
}

/** The message Worker Loader throws once an invocation has used up its subrequests. */
export const TOO_MANY = "Too many subrequests by single Worker invocation.";

type AnyFn = (...args: unknown[]) => unknown;

const PATCHED = Symbol.for("moorage.bridgeBudget");

interface Window {
	calls: string[];
	nested: string[];
	refused: string[];
	pending: number;
	enforce: boolean;
}

let window: Window | null = null;
const counted = new WeakSet<object>();

/**
 * A test's failure injection for PluginRuntimeBridge calls (it cannot patch a class it cannot
 * import). Return an error to make that call fail after it is counted; undefined lets it through.
 */
let runtimeFault: ((name: string) => Error | undefined) | undefined;
export function setRuntimeFault(fault: ((name: string) => Error | undefined) | undefined): void {
	runtimeFault = fault;
}

/** Wraps each RPC method of `proto` so a call made while a window is open is recorded in it. */
function patch(
	proto: Record<string | symbol, unknown>,
	names: readonly string[],
	kind: string,
	oncePerInstance: boolean,
): void {
	if (proto[PATCHED]) return;
	proto[PATCHED] = true;
	for (const name of names) {
		const original = proto[name];
		if (typeof original !== "function")
			throw new Error(`${kind}.${name} is gone; update the RPC lists for this EmDash version`);
		const run = (self: object, args: unknown[]): unknown => {
			const fault = kind === "PluginRuntimeBridge" ? runtimeFault?.(name) : undefined;
			return fault ? Promise.reject(fault) : (original as AnyFn).apply(self, args);
		};
		proto[name] = function (this: object, ...args: unknown[]) {
			const open = window;
			// PluginBridge: a fresh instance per RPC, so a second patched call on the same instance is
			// the bridge calling itself (settings.* -> this.kv*), not another subrequest.
			if (!open || (oncePerInstance && counted.has(this))) return run(this, args);
			if (oncePerInstance) counted.add(this);
			if (open.pending > 0) open.nested.push(name);
			else {
				open.calls.push(name);
				if (open.enforce && open.calls.length > SANDBOX_SUBREQUESTS) {
					open.refused.push(name);
					return Promise.reject(new Error(TOO_MANY));
				}
			}
			if (!HOOK_TRIGGERS.has(name) || open.pending > 0) return run(this, args);
			open.pending++;
			const done = () => void open.pending--;
			try {
				const out = run(this, args);
				return Promise.resolve(out).finally(done);
			} catch (error) {
				done();
				throw error;
			}
		};
	}
}

function install(): void {
	patch(
		PluginBridge.prototype as unknown as Record<string | symbol, unknown>,
		BRIDGE_RPCS,
		"PluginBridge",
		true,
	);
}

/**
 * PluginRuntimeBridge is not exported, so its prototype is taken from the first instance the
 * loaded plugin creates. Patched before any host starts: hosts load the plugin when they start.
 */
function installRuntimeBridge(): void {
	const runner = CloudflareSandboxRunner.prototype as unknown as Record<string | symbol, unknown>;
	if (runner[PATCHED]) return;
	runner[PATCHED] = true;
	const load = runner.load as AnyFn;
	runner.load = async function (this: object, ...args: unknown[]) {
		const plugin = (await load.apply(this, args)) as {
			createRuntimeBridge?: (id: string) => object;
		};
		const create = plugin.createRuntimeBridge;
		if (typeof create === "function") {
			plugin.createRuntimeBridge = (id: string) => {
				const bridge = create(id);
				patch(
					Object.getPrototypeOf(bridge) as Record<string | symbol, unknown>,
					RUNTIME_RPCS,
					"PluginRuntimeBridge",
					false,
				);
				return bridge;
			};
		}
		return plugin;
	};
}

/**
 * Prepended to the built plugin the sandbox loads. A call the plugin does not await (typically
 * `ctx.log.*`) still costs a subrequest on Cloudflare, but in the test loader it is dropped when
 * the invocation returns, so it never reaches the bridge to be counted. This wraps every hook and
 * route handler so the invocation waits for the calls it started before it returns. Counts and
 * results are unchanged; only the moment the invocation ends moves.
 */
const DRAIN_SHIM = `
const __budgetTrack = (ctx) => {
	const pending = [];
	const wrap = (value, depth) => {
		if (depth > 3 || value === null || typeof value !== "object") return value;
		return new Proxy(value, {
			get(target, key) {
				const member = target[key];
				if (typeof member === "function") {
					return (...args) => {
						const out = member.apply(target, args);
						if (out && typeof out.then === "function") pending.push(Promise.resolve(out).catch(() => {}));
						return out;
					};
				}
				return wrap(member, depth + 1);
			},
		});
	};
	return { ctx: wrap(ctx, 0), drain: async () => { while (pending.length) await pending.shift(); } };
};
const __budgetHandler = (handler) => async (input, ctx) => {
	const tracked = __budgetTrack(ctx);
	try { return await handler(input, tracked.ctx); } finally { await tracked.drain(); }
};
const __budgetWrapAll = (table) => {
	const out = {};
	for (const [name, entry] of Object.entries(table ?? {})) {
		out[name] = typeof entry === "function"
			? __budgetHandler(entry)
			: { ...entry, handler: __budgetHandler(entry.handler) };
	}
	return out;
};
const __budgetWrap = (plugin) => ({ ...plugin, hooks: __budgetWrapAll(plugin.hooks), routes: __budgetWrapAll(plugin.routes) });
`;

/** The bundle's closing export list, e.g. `export{kn as default};` or `export{vt as cronRun,bt as default};`. */
const EXPORTS = /export\s*\{([^}]*)\}\s*;?\s*$/;
const AS_DEFAULT = /\s+as\s+default$/;

function drainUnawaitedCalls(): void {
	const bound = env as unknown as Record<string, unknown>;
	const code = bound.EMDASH_PLUGIN_CODE;
	if (typeof code !== "string" || code.includes("__budgetWrap")) return;
	const names = (EXPORTS.exec(code)?.[1] ?? "").split(",").map((name) => name.trim());
	const plugin = names.find((name) => AS_DEFAULT.test(name))?.replace(AS_DEFAULT, "");
	if (!plugin)
		throw new Error("bridge-budget: the built plugin's default export has an unexpected form");
	const others = names.filter((name) => name !== "" && !AS_DEFAULT.test(name));
	const rest = others.length > 0 ? `export{${others.join(",")}};\n` : "";
	bound.EMDASH_PLUGIN_CODE = `${DRAIN_SHIM}\n${code.replace(
		EXPORTS,
		`${rest}const __budgetPlugin = ${plugin};\nexport default __budgetWrap(__budgetPlugin);`,
	)}`;
}

// Before any host is created: the runtime host reads the plugin code when it starts.
drainUnawaitedCalls();
installRuntimeBridge();

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * Runs `invoke` (one hook call, route call or admin interaction) and returns the RPCs it made.
 * Errors are captured, not thrown, so a test can pin the count of a path that fails. Call
 * `host.restart()` first for the cold-isolate worst case: the plugins keep settings in memory.
 */
export async function measure<T>(
	invoke: () => Promise<T>,
	{ enforce = false }: MeasureOptions = {},
): Promise<Measured<T>> {
	install();
	await settle();
	const open: Window = { calls: [], nested: [], refused: [], pending: 0, enforce };
	window = open;
	const out: Measured<T> = { calls: open.calls, nested: open.nested, refused: open.refused };
	try {
		out.result = await invoke();
	} catch (error) {
		out.error = error;
	}
	// Let anything the invocation left running finish inside its own window.
	await settle();
	window = null;
	return out;
}

/** One line for the test log: `path: 7 kvGet settingsGet ...`. */
export function describeCalls(path: string, measured: Measured<unknown>): string {
	const nested = measured.nested.length ? ` | nested hooks: ${measured.nested.join(" ")}` : "";
	const refused = measured.refused.length ? ` | refused: ${measured.refused.length}` : "";
	return `${path}: ${measured.calls.length} ${measured.calls.join(" ")}${nested}${refused}`;
}
