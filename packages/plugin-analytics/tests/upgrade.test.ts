// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { bannerVersion, normalizeConfig } from "../src/config.js";
import { clientConfig } from "../src/fragment.js";

/**
 * What existing sites keep after an update. These values were taken from 0.3.3
 * and must not change: a different banner version asks every visitor again, and
 * different words change what English visitors read.
 */

const ALL_TOOLS = {
	ga4: "G-AB12CD34EF",
	gtm: "GTM-AB12CD3",
	ads: "AW-123456789",
	meta: "123456789012345",
	clarity: "ab12cd34ef",
	hubspot: "12345678",
	cloudflare: "0123456789abcdef0123456789abcdef",
};

const SAVED = {
	ga4: { tools: { ga4: "G-AB12CD34EF" } },
	all: { tools: ALL_TOOLS, banner: { policyUrl: "/privacy" } },
	custom: {
		tools: { meta: "123456789012345" },
		banner: { title: "Cookies?", message: "We use cookies.", audience: "everyone" },
	},
	waiting: { tools: { cloudflare: ALL_TOOLS.cloudflare }, cloudflareWait: true },
};

const view = (raw: unknown) => {
	const config = normalizeConfig(raw);
	const client = clientConfig(config, "analytics-consent");
	return { version: bannerVersion(config), v: client.v, t: client.t };
};

describe("a site saved by 0.3.3", () => {
	it("keeps its banner version, so visitors are not asked again", () => {
		expect(Object.fromEntries(Object.entries(SAVED).map(([k, raw]) => [k, view(raw).version])))
			.toMatchInlineSnapshot(`
				{
				  "all": "1cut5mn",
				  "custom": "17y2xxk",
				  "ga4": "1hgar8j",
				  "waiting": "183hfrc",
				}
			`);
	});

	it("keeps every word its English visitors read", () => {
		expect(Object.fromEntries(Object.entries(SAVED).map(([k, raw]) => [k, view(raw).t])))
			.toMatchInlineSnapshot(`
				{
				  "all": {
				    "accept": "Accept all",
				    "always": "Always on",
				    "an": "Analytics",
				    "anText": "Shows us how visitors use this site, so we can improve it.",
				    "choose": "Choose",
				    "gpc": "Your browser asks sites not to share your data (Global Privacy Control), so Marketing stays off.",
				    "mk": "Marketing",
				    "mkText": "Lets us measure our advertising and show you relevant ads elsewhere.",
				    "need": "Essential",
				    "needText": "Remembers your answer, so you are not asked on every page.",
				    "panel": "Your cookie choices",
				    "policy": "Privacy policy",
				    "reject": "Reject all",
				    "save": "Save my choices",
				    "saved": "Your choice is saved. Change it any time under Cookies.",
				    "settings": "Cookies",
				    "text": "We would like to use analytics cookies to see how this site is used, and marketing cookies to measure our ads. Essential cookies are always on.",
				    "title": "Can we use cookies?",
				    "uses": "Used by:",
				  },
				  "custom": {
				    "accept": "Accept all",
				    "always": "Always on",
				    "an": "Analytics",
				    "anText": "Shows us how visitors use this site, so we can improve it.",
				    "choose": "Choose",
				    "gpc": "Your browser asks sites not to share your data (Global Privacy Control), so Marketing stays off.",
				    "mk": "Marketing",
				    "mkText": "Lets us measure our advertising and show you relevant ads elsewhere.",
				    "need": "Essential",
				    "needText": "Remembers your answer, so you are not asked on every page.",
				    "panel": "Your cookie choices",
				    "policy": "Privacy policy",
				    "reject": "Reject all",
				    "save": "Save my choices",
				    "saved": "Your choice is saved. Change it any time under Cookies.",
				    "settings": "Cookies",
				    "text": "We use cookies.",
				    "title": "Cookies?",
				    "uses": "Used by:",
				  },
				  "ga4": {
				    "accept": "Accept all",
				    "always": "Always on",
				    "an": "Analytics",
				    "anText": "Shows us how visitors use this site, so we can improve it.",
				    "choose": "Choose",
				    "gpc": "Your browser asks sites not to share your data (Global Privacy Control), so Marketing stays off.",
				    "mk": "Marketing",
				    "mkText": "Lets us measure our advertising and show you relevant ads elsewhere.",
				    "need": "Essential",
				    "needText": "Remembers your answer, so you are not asked on every page.",
				    "panel": "Your cookie choices",
				    "policy": "Privacy policy",
				    "reject": "Reject all",
				    "save": "Save my choices",
				    "saved": "Your choice is saved. Change it any time under Cookies.",
				    "settings": "Cookies",
				    "text": "We would like to use analytics cookies to see how this site is used. Essential cookies are always on.",
				    "title": "Can we use cookies?",
				    "uses": "Used by:",
				  },
				  "waiting": {
				    "accept": "Accept all",
				    "always": "Always on",
				    "an": "Analytics",
				    "anText": "Shows us how visitors use this site, so we can improve it.",
				    "choose": "Choose",
				    "gpc": "Your browser asks sites not to share your data (Global Privacy Control), so Marketing stays off.",
				    "mk": "Marketing",
				    "mkText": "Lets us measure our advertising and show you relevant ads elsewhere.",
				    "need": "Essential",
				    "needText": "Remembers your answer, so you are not asked on every page.",
				    "panel": "Your cookie choices",
				    "policy": "Privacy policy",
				    "reject": "Reject all",
				    "save": "Save my choices",
				    "saved": "Your choice is saved. Change it any time under Cookies.",
				    "settings": "Cookies",
				    "text": "We would like to use analytics cookies to see how this site is used. Essential cookies are always on.",
				    "title": "Can we use cookies?",
				    "uses": "Used by:",
				  },
				}
			`);
	});
});
