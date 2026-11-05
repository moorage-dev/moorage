// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Parse a URL, or return null. `URL.canParse` is missing from the sandbox
 * runtime EmDash uses in development, so this is the only parser used here.
 */
export function parseUrl(value: string, base?: string): URL | null {
	try {
		return new URL(value, base);
	} catch {
		return null;
	}
}

/** Check a pasted logo link. Returns the absolute link, undefined for none, or an error. */
export function readLogo(pasted: string, siteUrl: string): { logo?: string } | { error: string } {
	if (pasted === "") return {};
	// The media library only gives plugins sign-in-protected image links, which
	// Google could not fetch, so the logo is a public address the admin pastes.
	const url = parseUrl(pasted, `${siteUrl.replace(/\/+$/, "")}/`);
	if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
		return { error: "Couldn't save. The logo link must be a web address starting with https://" };
	}
	if (url.pathname.includes("/_emdash/api/media/asset/")) {
		return {
			error: "That link only works when signed in. In Media, use Copy URL on the image instead.",
		};
	}
	return { logo: url.href };
}
