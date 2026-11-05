// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";

/**
 * Whether this site holds videos and maps back (`hold`: the cookie banner can
 * ask someone), and whether the banner names this provider (`named`: only then
 * does the visitor's Marketing answer release it; otherwise only its own Load
 * button does). Read from the plugin's own `embeds` route on the server.
 * Anything that goes wrong means no hold: the embed renders as it did before.
 * @param {unknown} locals  Astro.locals
 * @param {URL} url  Astro.url
 * @param {string} name  who shows it (YouTube, Vimeo, Google Maps), so the banner can name it
 * @returns {Promise<{ hold: boolean; named: boolean }>}
 */
export async function holding(locals, url, name) {
	const handle = getPublicPluginApiRouteHandler(
		/** @type {Parameters<typeof getPublicPluginApiRouteHandler>[0]} */ (locals),
	);
	const no = { hold: false, named: false };
	if (!handle) return no;
	try {
		const answer =
			/** @type {{ success?: boolean; data?: { hold?: boolean; named?: boolean } } | null} */ (
				await handle(
					"analytics-consent",
					"GET",
					"/embeds",
					new Request(
						new URL(
							`/_emdash/api/plugins/analytics-consent/embeds?p=${encodeURIComponent(name)}`,
							url,
						),
					),
				)
			);
		const hold = answer?.success === true && answer.data?.hold === true;
		return { hold, named: hold && answer?.data?.named === true };
	} catch {
		return no;
	}
}
