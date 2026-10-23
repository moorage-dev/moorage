// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

/**
 * Where the plugin keeps what an Admin saves.
 *
 * EmDash keeps a plugin's KV in a different table depending on how the plugin
 * runs: in-process (`plugins: []`) in `options` as `plugin:<id>:<key>`,
 * sandboxed (`sandboxed: []`) in `_plugin_storage` (collection `__kv`). Settings
 * (`ctx.settings`, the same as `settings:` KV keys) are in `options` either way,
 * so only they survive a site moving the plugin from one to the other
 * (emdash-cms/emdash#4269). Settings therefore live in `ctx.settings`.
 *
 * Earlier releases kept them under a plain KV key (`legacy`):
 * - Reading: `ctx.settings` first. When that is empty, the plain key, copied to
 *   `ctx.settings` (a failed copy is logged, never thrown: the read still
 *   answers). The plain key is never preferred: after a switch it is read from
 *   the other mode's table, where an old value may be waiting. A path that must
 *   not write, or has no call to spare (a public page view: a sandboxed plugin
 *   may make only 10 calls per run on Cloudflare), reads with `copy: false`.
 * - Writing: `ctx.settings`, then the plain key as well, so going back to the
 *   earlier release still reads the newest settings. The plain key is kept for
 *   rollback until a later release; then stop writing it.
 *
 * Not covered: going back, saving there, then upgrading again. The earlier
 * release writes only the plain key, so this one keeps reading what it saved
 * itself before the downgrade.
 *
 * The same file is in each plugin that uses it; keep the copies identical.
 */
export interface SettingsKeys {
	/** Name in `ctx.settings` (the KV key `settings:<name>`). */
	name: string;
	/** The plain KV key earlier releases used. Kept for rollback until a later release. */
	legacy: string;
}

type Ctx = Pick<PluginContext, "kv" | "settings" | "log">;

export interface ReadOptions {
	/** Copy settings found only under the plain key to `ctx.settings`. Default true. */
	copy?: boolean;
}

function present(value: unknown): boolean {
	return value !== null && value !== undefined;
}

/** Copy settings read from the plain key to `ctx.settings`. Logs a failure, never throws. */
export async function copyForward(ctx: Ctx, keys: SettingsKeys, value: unknown): Promise<void> {
	try {
		await ctx.settings.set(keys.name, value);
	} catch (error) {
		ctx.log.warn("could not copy the settings to their new place", {
			key: keys.name,
			error: String(error),
		});
	}
}

/** The saved settings, or null when none were ever saved. Throws only when nothing can be read. */
export async function readSettings(
	ctx: Ctx,
	keys: SettingsKeys,
	{ copy = true }: ReadOptions = {},
): Promise<unknown> {
	const value = await ctx.settings.get<unknown>(keys.name);
	if (present(value)) return value;
	const old = await ctx.kv.get<unknown>(keys.legacy);
	if (!present(old)) return null;
	if (copy) await copyForward(ctx, keys, old);
	return old;
}

/**
 * The same, from the result of one `ctx.kv.list()`, which includes settings as
 * `settings:<name>` in both modes.
 */
export async function pickSettings(
	ctx: Ctx,
	entries: ReadonlyMap<string, unknown>,
	keys: SettingsKeys,
	{ copy = true }: ReadOptions = {},
): Promise<unknown> {
	const value = entries.get(`settings:${keys.name}`);
	if (present(value)) return value;
	const old = entries.get(keys.legacy);
	if (!present(old)) return null;
	if (copy) await copyForward(ctx, keys, old);
	return old;
}

/** Whether reading these settings would copy them forward (one more call to the host). */
export function needsCopy(entries: ReadonlyMap<string, unknown>, keys: SettingsKeys): boolean {
	return !present(entries.get(`settings:${keys.name}`)) && present(entries.get(keys.legacy));
}

/** Save the settings. Throws when they could not be saved. */
export async function writeSettings(ctx: Ctx, keys: SettingsKeys, value: unknown): Promise<void> {
	await ctx.settings.set(keys.name, value);
	// Kept for rollback until a later release: the earlier release reads only this key.
	try {
		await ctx.kv.set(keys.legacy, value);
	} catch (error) {
		ctx.log.warn("could not keep a copy of the settings for the earlier release", {
			key: keys.legacy,
			error: String(error),
		});
	}
}
