// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import { parseUrl } from "./url.js";

/** "fix" affects how the page appears in search; "look" is advice. */
export type IssueLevel = "fix" | "look";

export interface Issue {
	id: string;
	level: IssueLevel;
	/** What an editor reads. */
	message: string;
	/** The one thing to do about it. */
	fix: string;
}

export type EntryStatus = "ready" | "look" | "fix" | "hidden";

export interface CheckInput {
	slug: string | null;
	data: Record<string, unknown>;
	/** Present when the collection has EmDash's SEO panel. */
	seo?: {
		title: string | null;
		description: string | null;
		image: string | null;
		canonical: string | null;
		noIndex: boolean;
	};
	/** The entry's own title, used when there is no search title. */
	title: string;
	siteUrl: string;
	isArticle: boolean;
	authorCount: number;
	/** Another page shares this page's title. */
	duplicateTitle: boolean;
}

// Google cuts a title at roughly this width on desktop; it publishes no character limit.
const TITLE_PIXELS = 580;
// Below this much text, a page has nothing for a search engine to read.
const MIN_TEXT = 80;

const NARROW = new Set("iIl.,:;|!'`jtfr ()[]".split(""));
const WIDE = new Set("mwMWQO@%".split(""));

/** Rough rendered width of a title in Google's result font, in pixels. */
export function estimateTitlePixels(title: string): number {
	let width = 0;
	for (const char of title) {
		if (NARROW.has(char)) width += 5;
		else if (WIDE.has(char)) width += 15;
		else if (char >= "A" && char <= "Z") width += 12;
		else width += 9.5;
	}
	return Math.round(width);
}

/** A title as Google would probably show it, cut with an ellipsis when too wide. */
export function truncateTitle(title: string): string {
	if (estimateTitlePixels(title) <= TITLE_PIXELS) return title;
	let cut = title;
	while (cut.length > 1 && estimateTitlePixels(`${cut}…`) > TITLE_PIXELS) cut = cut.slice(0, -1);
	return `${cut.trimEnd()}…`;
}

/** Lowercased, whitespace-collapsed title, for spotting duplicates. */
export function titleKey(title: string): string {
	return title.toLowerCase().replace(/\s+/g, " ").trim();
}

interface ContentFacts {
	textLength: number;
	imagesWithoutAlt: number;
	hasImage: boolean;
}

// Titles that say nothing about the page.
const GENERIC_TITLES = new Set(["home", "homepage", "home page", "index", "untitled", "welcome"]);

// Field names that hold addresses or identifiers, not text a visitor reads.
const NOT_TEXT = new Set(["_type", "_key", "id", "slug", "url", "href", "src", "style", "icon"]);

/** Walk an entry's fields (including Portable Text and page blocks) once. */
function contentFacts(data: Record<string, unknown>): ContentFacts {
	const facts: ContentFacts = { textLength: 0, imagesWithoutAlt: 0, hasImage: false };
	const visit = (value: unknown, key: string, depth: number) => {
		if (depth > 12) return;
		if (typeof value === "string") {
			if (!NOT_TEXT.has(key) && !/^(https?:)?\//.test(value))
				facts.textLength += value.trim().length;
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, key, depth + 1);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const node = value as Record<string, unknown>;
		const isImage = node._type === "image" || (typeof node.src === "string" && "alt" in node);
		if (isImage) {
			facts.hasImage = true;
			if (typeof node.alt !== "string" || node.alt.trim() === "") facts.imagesWithoutAlt += 1;
		}
		for (const [childKey, child] of Object.entries(node)) visit(child, childKey, depth + 1);
	};
	for (const [key, value] of Object.entries(data)) {
		if (key !== "json_ld") visit(value, key, 0);
	}
	return facts;
}

/**
 * Check one saved entry. Every rule reads data the plugin already holds and
 * is something Google documents; there are no keyword or word-count rules.
 */
export function checkEntry(input: CheckInput): Issue[] {
	const issues: Issue[] = [];
	const { seo } = input;
	const facts = contentFacts(input.data);
	const searchTitle = seo?.title?.trim() || input.title.trim();

	if (searchTitle === "") {
		issues.push({
			id: "no-title",
			level: "fix",
			message: "This page has no title.",
			fix: "Give the page a title.",
		});
	}
	// "Home" as the headline of the site's own search result says nothing about it.
	if (GENERIC_TITLES.has(searchTitle.toLowerCase())) {
		issues.push({
			id: "generic-title",
			level: "fix",
			message: `The title is just "${searchTitle}", which is what Google shows as the headline.`,
			fix: "Put your name and what you do in SEO Title, in the page's SEO panel.",
		});
	}
	if (seo && !seo.description?.trim()) {
		issues.push({
			id: "no-description",
			level: "fix",
			message: "No search description, so Google writes its own summary of this page.",
			fix: "Fill in Meta Description in the page's SEO panel.",
		});
	}
	if (input.duplicateTitle && searchTitle !== "") {
		issues.push({
			id: "duplicate-title",
			level: "fix",
			message: "Another page has the same title, so Google cannot tell them apart.",
			fix: "Give this page its own title in the SEO panel.",
		});
	}
	if (seo?.canonical && input.slug) {
		const canonical = parseUrl(seo.canonical, `${input.siteUrl.replace(/\/+$/, "")}/`);
		const last = canonical?.pathname.replace(/\/+$/, "").split("/").pop();
		const home = ["home", "index"].includes(input.slug) && (last ?? "") === "";
		if (canonical && last !== input.slug && !home) {
			issues.push({
				id: "canonical-elsewhere",
				level: "fix",
				message: "This page tells Google to show a different page instead (canonical).",
				fix: "Clear the canonical address in the SEO panel unless that is intended.",
			});
		}
	}

	if (searchTitle !== "" && estimateTitlePixels(searchTitle) > TITLE_PIXELS) {
		issues.push({
			id: "title-long",
			level: "look",
			message: "The end of this title may be cut off in Google.",
			fix: "Shorten the title, or put the important words first.",
		});
	}
	if (seo && !seo.image && !facts.hasImage) {
		issues.push({
			id: "no-social-image",
			level: "look",
			message: "Shared links will show no picture, unless your site has a default sharing image.",
			fix: "Add an image in the SEO panel.",
		});
	}
	if (input.isArticle && input.authorCount === 0) {
		issues.push({
			id: "no-author",
			level: "look",
			message: "This article has no author.",
			fix: "Add a byline to the article.",
		});
	}
	if (facts.imagesWithoutAlt > 0) {
		const count = facts.imagesWithoutAlt;
		issues.push({
			id: "images-without-alt",
			level: "look",
			message: `${count} ${count === 1 ? "picture has" : "pictures have"} no description for screen readers.`,
			fix: "Add alt text to each picture.",
		});
	}
	if (facts.textLength < MIN_TEXT) {
		issues.push({
			id: "nearly-empty",
			level: "look",
			message: "This page has almost no text.",
			fix: "Add some content, or hide the page from search.",
		});
	}

	return issues;
}

/** Hidden wins; then anything to fix; then advice; otherwise ready. */
export function statusOf(issues: Issue[], hidden: boolean): EntryStatus {
	if (hidden) return "hidden";
	if (issues.some((issue) => issue.level === "fix")) return "fix";
	return issues.length > 0 ? "look" : "ready";
}
