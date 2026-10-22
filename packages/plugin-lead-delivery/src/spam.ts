// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { FieldInfo } from "./types.js";

/**
 * Phrases that come almost only in sales pitches sent through contact forms. Kept short and
 * built in: a match only marks the enquiry; it is still delivered unless the owner holds spam.
 */
export const SPAM_PHRASES = [
	"seo services",
	"guest post",
	"backlinks",
	"link building",
	"crypto investment",
	"bitcoin investment",
	"increase your traffic",
	"more traffic to your website",
	"first page of google",
	"rank your website",
	"domain authority",
	"web design services for your business",
	"lead generation services",
	"buy followers",
	"make money online",
	"work from home opportunity",
	"cheap essay",
	"casino bonus",
	"viagra",
	"unsubscribe from future messages",
];

const SKIP_KEYS = new Set([
	"page_url",
	"pageUrl",
	"page",
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
]);
const EMAIL = /[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[A-Za-z]{2,}/g;
const LINK =
	/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|io|co|ru|xyz|top|site|online|shop|store|click|link|live)\b/gi;

function links(text: string): number {
	return text.replace(EMAIL, " ").match(LINK)?.length ?? 0;
}

function isOnlyLink(text: string): boolean {
	const value = text.trim();
	return value.length > 0 && !/\s/.test(value) && links(value) === 1;
}

/**
 * A guess from simple signals, any one of which is enough: three or more links across the
 * text, a phrase from the list, a message that is only a link, or a name with a link in it.
 * The page address, UTM values and email addresses never count as links.
 */
export function isPossiblySpam(fields: Array<FieldInfo & { value: string }>): boolean {
	const text = fields.filter((f) => !SKIP_KEYS.has(f.key) && f.type !== "email");
	let count = 0;
	for (const field of text) {
		const value = field.value;
		const lower = value.toLowerCase();
		if (SPAM_PHRASES.some((phrase) => lower.includes(phrase))) return true;
		const n = links(value);
		count += n;
		const what = `${field.key} ${field.label}`;
		if (n > 0 && /\bname\b|^name|name$/i.test(what) && !/company|business|web/i.test(what))
			return true;
		if (
			(field.type === "textarea" || /message|enquiry|inquiry|comment/i.test(what)) &&
			isOnlyLink(value)
		) {
			return true;
		}
	}
	return count >= 3;
}
