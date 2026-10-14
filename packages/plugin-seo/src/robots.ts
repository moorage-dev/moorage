// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { RobotsDefaults } from "./config.js";

const SPLIT = /\s*,\s*/;

/**
 * Build the robots meta content for a page.
 *
 * Plugin metadata is resolved before EmDash's own, so whatever this returns
 * replaces the tag core would have written from the editor's SEO panel. The
 * panel's directives (`panelRobots`) are therefore always carried over: an
 * editor's noindex is never turned back into index.
 */
export function mergeRobots(
	panelRobots: string | null | undefined,
	collectionNoindex: boolean,
	defaults: RobotsDefaults,
): string {
	const panel = (panelRobots ?? "")
		.toLowerCase()
		.split(SPLIT)
		.map((directive) => directive.trim())
		.filter((directive) => directive !== "");

	const noindex = collectionNoindex || panel.includes("noindex") || panel.includes("none");
	const nofollow = panel.includes("nofollow") || panel.includes("none");

	const directives = [noindex ? "noindex" : "index", nofollow ? "nofollow" : "follow"];
	const handled = new Set(["index", "noindex", "follow", "nofollow", "none", "all"]);
	const extras = panel.filter((directive) => !handled.has(directive));

	// Snippet limits mean nothing on a page that is not indexed.
	if (!noindex) {
		const has = (prefix: string) => extras.some((directive) => directive.startsWith(prefix));
		if (defaults.nosnippet || extras.includes("nosnippet")) {
			if (!extras.includes("nosnippet")) extras.push("nosnippet");
		} else if (!has("max-snippet:")) {
			extras.push(`max-snippet:${defaults.maxSnippet}`);
		}
		if (!has("max-image-preview:")) extras.push(`max-image-preview:${defaults.maxImagePreview}`);
		if (!has("max-video-preview:")) extras.push(`max-video-preview:${defaults.maxVideoPreview}`);
	}

	return [...directives, ...new Set(extras)].join(", ");
}

/** Whether a robots tag built by `mergeRobots` keeps the page out of search. */
export function isNoindex(robots: string): boolean {
	return robots.startsWith("noindex");
}
