// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * The plugin's settings, kept in memory for a short while so a page view does
 * not wait on a database read for them. Each `ctx.kv.get` is a round trip, and
 * EmDash runs every plugin's page hooks one after another, so on a remote
 * database the reads add up on every uncached page.
 *
 * - Module scope lives as long as the isolate (Workers) or the process (Node),
 *   or the plugin's own isolate when it runs sandboxed; a cold start reads again.
 * - A save in this isolate forgets the copy at once (call `forgetSettings` after
 *   the write). Other isolates see a save within `SETTINGS_TTL_MS`.
 * - Kept per site as well as per plugin: one isolate could serve more than one
 *   site (several sites in one Worker, or a shared sandbox isolate), and one
 *   site's settings must never answer for another.
 * - Previews and edit mode read fresh (`fresh: true`): see `MemoOptions`.
 * - Only the settings, never anything that depends on the visitor or the request.
 * - Every caller gets its own copy, so code that changes the object it was given
 *   cannot change what the next page view sees.
 * - What is kept is the value that was read, never the promise of it. On
 *   Cloudflare Workers a promise that does I/O belongs to the request that made
 *   it: when that request ends first, every other request waiting on it fails
 *   ("This promise was created by a request that has since ended"), and the page
 *   goes out without the plugin's output. So page views that arrive together on
 *   a cold isolate each do their own read; the ones after them get the value.
 *
 * The same file is in each plugin that uses it; keep the copies identical.
 */

/** How long settings saved in another isolate can take to show. */
export const SETTINGS_TTL_MS = 30_000;

interface Held {
	value: unknown;
	until: number;
}

interface Owner {
	plugin: { id: string };
	site?: { url?: string } | undefined;
}

/** Plugin id, then site address. */
const held = new Map<string, Map<string, Held>>();

export interface MemoOptions {
	/**
	 * Read now, whatever is kept: for previews and edit mode. The person looking
	 * has usually just saved, perhaps in another isolate, and an old copy would
	 * look as if the save failed. What is read replaces the kept copy, since it
	 * is the newest there is.
	 */
	fresh?: boolean;
	now?: number;
}

/** The settings from `read`, or the copy read less than `SETTINGS_TTL_MS` ago. */
export async function memoSettings<T>(
	ctx: Owner,
	read: () => Promise<T>,
	{ fresh = false, now = Date.now() }: MemoOptions = {},
): Promise<T> {
	const site = ctx.site?.url ?? "";
	let sites = held.get(ctx.plugin.id);
	if (!sites) held.set(ctx.plugin.id, (sites = new Map()));
	const entry = sites.get(site);
	if (!fresh && entry && now < entry.until) return structuredClone(entry.value as T);
	// This request's own read. A failed read throws here, so nothing is kept and the next page view tries again.
	const value = await read();
	// A save while the read was out took this plugin's map away (`forgetSettings`), and what was
	// read may be older than the save: keep it only where the map is still the one in use.
	if (held.get(ctx.plugin.id) === sites) sites.set(site, { value, until: now + SETTINGS_TTL_MS });
	return structuredClone(value);
}

/** Forget this plugin's settings in this isolate, for every site. Call after each save. */
export function forgetSettings(pluginId: string): void {
	held.delete(pluginId);
}

/** Forget everything. For tests, which start each case with a new site. */
export function forgetAllSettings(): void {
	held.clear();
}
