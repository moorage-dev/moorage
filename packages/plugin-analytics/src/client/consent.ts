// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import type { Choice } from "./types.js";

/**
 * The consent rules, with no browser access, so they can be tested on their
 * own. This file ships inside every public page: keep it small.
 */

/** Name of the first-party cookie that remembers the visitor's answer. */
export const COOKIE = "cookie_consent";

/**
 * Countries where visitors are asked first: the EU and EEA, the UK and
 * Switzerland, plus EU territories that have their own country code.
 */
const ASK =
	"AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH AX GF GP MQ RE YT";

/** Time zones used there, for when the country is unknown. Wider than needed on purpose. */
const ASK_ZONE =
	/^(Europe|Atlantic|Arctic)\/|^Indian\/(Reunion|Mayotte)|^America\/(Cayenne|Guadeloupe|Martinique)|^Asia\/(Nicosia|Famagusta)/;

/**
 * True when this visitor must be asked. A known country decides; otherwise the
 * browser's time zone; and when neither is known the visitor is asked.
 */
export function mustAsk(
	country: string | null | undefined,
	zone: string | null | undefined,
): boolean {
	if (country) return ASK.includes(country.toUpperCase());
	return zone ? ASK_ZONE.test(zone) : true;
}

export function today(now: number): number {
	return Math.floor(now / 864e5);
}

/** Cookie value: `version.analytics-marketing.day.id`, e.g. `k3j2.10.20374.x8f2k1`. */
export function encodeChoice(choice: Choice): string {
	return [choice.v, (choice.a ? "1" : "0") + (choice.m ? "1" : "0"), choice.d, choice.id].join(".");
}

/** Read the saved answer out of `document.cookie`. Anything malformed counts as no answer. */
export function readChoice(cookies: string): Choice | null {
	const match = new RegExp(
		"(?:^|; )" + COOKIE + "=([a-z0-9]+)\\.([01])([01])\\.(\\d+)\\.([a-z0-9]+)",
	).exec(cookies);
	return match
		? { v: match[1]!, a: match[2] === "1", m: match[3] === "1", d: +match[4]!, id: match[5]! }
		: null;
}

export interface Decision {
	/** Analytics tools may load. */
	a: boolean;
	/** Marketing tools may load. */
	m: boolean;
	/** Show the banner. */
	ask: boolean;
}

/**
 * The whole decision in one place.
 *
 * - A saved answer for the current tool list, not yet expired, is followed.
 * - Otherwise, where visitors must be asked, nothing is allowed and the banner shows.
 * - Otherwise everything is allowed without asking.
 * - Global Privacy Control always refuses Marketing, whatever was saved.
 */
export function decide(
	rule: { v: string; who: 0 | 1 | 2; days: number },
	saved: Choice | null,
	inAskRegion: boolean,
	gpc: boolean,
	day: number,
): Decision {
	if (saved && saved.v === rule.v && day - saved.d < rule.days && rule.who) {
		return { a: saved.a, m: saved.m && !gpc, ask: false };
	}
	if (rule.who === 2 || (rule.who === 1 && inAskRegion)) return { a: false, m: false, ask: true };
	return { a: true, m: !gpc, ask: false };
}
