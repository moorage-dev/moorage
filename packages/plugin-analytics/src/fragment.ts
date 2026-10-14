// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PageFragmentContribution } from "emdash";
import clientCode from "virtual:client-script";

import type { ClientConfig } from "./client/types.js";
import {
	bannerVersion,
	enabledTools,
	isExcluded,
	needsConsent,
	vendorNames,
	type AnalyticsConfig,
} from "./config.js";

/** The name the browser bundle uses for its settings; swapped for JSON below. */
const PLACEHOLDER = "__CC_CONFIG__";

const BACKSLASH = String.fromCharCode(92);
/** `<` and the two line separators that older browsers treat as line ends inside a script. */
const UNSAFE_IN_SCRIPT = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/** Fixed wording of the banner. The title and message come from settings. */
const TEXT = {
	policy: "Read our privacy policy",
	accept: "Accept all",
	reject: "Reject all",
	choose: "Choose",
	save: "Save my choices",
	settings: "Cookie settings",
	panel: "Your cookie choices",
	need: "Necessary",
	needText: "Remembers your choice here. Always on.",
	an: "Analytics",
	anText: "Shows us how visitors use this site, so we can improve it.",
	mk: "Marketing",
	mkText: "Lets us measure our advertising and show you relevant ads elsewhere.",
	uses: "Used by:",
	gpc: "Your browser asks sites not to share your data (Global Privacy Control), so Marketing stays off.",
} as const;

/** What the browser needs to know, and nothing else from the settings. */
export function clientConfig(config: AnalyticsConfig, pluginId: string): ClientConfig {
	const { tools, banner } = config;
	// Nothing waits for an answer (no tools, or only cookie-free visitor counts): no banner at all.
	const asks = needsConsent(config) && banner.audience !== "none";
	const out: ClientConfig = {
		v: bannerVersion(config),
		who: !asks ? 0 : banner.audience === "everyone" ? 2 : 1,
		days: banner.months === 12 ? 365 : 183,
		api: `/_emdash/api/plugins/${pluginId}/`,
		pos: banner.position,
		scheme: banner.scheme,
		an: vendorNames(config, "analytics"),
		mk: vendorNames(config, "marketing"),
		t: { ...TEXT, title: banner.title, text: banner.message },
	};
	if (tools.ga4) out.ga = tools.ga4;
	if (tools.gtm) out.gtm = tools.gtm;
	if (tools.ads) out.aw = tools.ads;
	if (tools.meta) out.fb = tools.meta;
	if (tools.clarity) out.cl = tools.clarity;
	if (tools.hubspot) out.hs = tools.hubspot;
	if (tools.hubspot && config.hubspotEu) out.hsEu = 1;
	if (tools.cloudflare) out.cf = tools.cloudflare;
	if (tools.cloudflare && config.cloudflareWait) out.cfWait = 1;
	if (tools.gtm && config.gtmLoading === "immediate") out.gtmNow = 1;
	if (config.enquiries) out.ev = 1;
	if (asks) out.rec = 1;
	if (asks && banner.settingsButton) out.btn = 1;
	if (banner.policyUrl) out.policy = banner.policyUrl;
	return out;
}

/**
 * JSON that is safe inside a `<script>`: `<` is written as an escape, so no
 * setting can close the script element or open an HTML comment.
 */
export function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(UNSAFE_IN_SCRIPT, (ch) => {
		return `${BACKSLASH}u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}

/** The script for one page: the fixed browser bundle with the settings put in. */
export function clientScriptFor(config: ClientConfig): string {
	return clientCode.replace(PLACEHOLDER, () => scriptJson(config));
}

export interface PageFacts {
	path: string;
	url: string;
	editMode: boolean;
	preview: boolean;
}

/** True for pages that must never be tracked. */
export function isUntracked(config: AnalyticsConfig, page: PageFacts): boolean {
	if (page.editMode || page.preview) return true;
	if (page.path === "/_emdash" || page.path.startsWith("/_emdash/")) return true;
	if (/[?&]_preview=/.test(page.url)) return true;
	return isExcluded(page.path, config.exclude);
}

/**
 * Everything the plugin adds to a public page: one inline script in the head,
 * or nothing. Pure: the same settings and page always give the same answer.
 */
export function pageFragments(
	config: AnalyticsConfig,
	pluginId: string,
	page: PageFacts,
): PageFragmentContribution | null {
	if (enabledTools(config).length === 0 || isUntracked(config, page)) return null;
	return {
		kind: "inline-script",
		placement: "head",
		key: `${pluginId}:bootstrap`,
		code: clientScriptFor(clientConfig(config, pluginId)),
	};
}
