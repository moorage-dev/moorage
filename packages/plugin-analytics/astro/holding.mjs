// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";

/**
 * Whether this site holds videos and maps back: true when the cookie banner can
 * ask someone, read from the plugin's own `embeds` route on the server. Anything
 * that goes wrong means no: the embed renders as it did before this plugin.
 * @param {unknown} locals  Astro.locals
 * @param {URL} url  Astro.url
 * @returns {Promise<boolean>}
 */
export async function holding(locals, url) {
	const handle = getPublicPluginApiRouteHandler(
		/** @type {Parameters<typeof getPublicPluginApiRouteHandler>[0]} */ (locals),
	);
	if (!handle) return false;
	try {
		const answer = /** @type {{ success?: boolean; data?: { hold?: boolean } } | null} */ (
			await handle(
				"analytics-consent",
				"GET",
				"/embeds",
				new Request(new URL("/_emdash/api/plugins/analytics-consent/embeds", url)),
			)
		);
		return answer?.success === true && answer.data?.hold === true;
	} catch {
		return false;
	}
}
