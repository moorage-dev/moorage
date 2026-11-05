// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { privateAddressError } from "./address.js";
import type { Outcome } from "./hubspot.js";
import { chatLabel } from "./names.js";
import type { ChatKind, Delivery, Enquiry } from "./types.js";
import { marksOf } from "./webhook.js";

/**
 * A "Slack or Discord channel" delivery: one message in the channel for each enquiry, through
 * the channel's incoming webhook. The webhook address is the only key, so it is a secret: it is
 * never shown in full after it is saved (host and last four characters) and never logged.
 */

const SLACK_HOSTS = new Set(["hooks.slack.com"]);
const DISCORD_HOSTS = new Set([
	"discord.com",
	"discordapp.com",
	"canary.discord.com",
	"ptb.discord.com",
]);

export const CHAT_HINT =
	"Slack: create an app with Incoming Webhooks and add one to the channel. Discord: Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.";

/** A Slack or Discord incoming-webhook address, or what is wrong with it. */
export function parseChatUrl(
	text: string,
): { platform: ChatKind; url: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(text.trim());
	} catch {
		return { error: "Paste the channel's webhook address, starting with https://." };
	}
	if (url.protocol !== "https:") {
		return { error: "The channel's webhook address must start with https://. Copy it again." };
	}
	const blocked = privateAddressError(url.href);
	if (blocked) return { error: blocked };
	const host = url.hostname.toLowerCase();
	if (SLACK_HOSTS.has(host) && /^\/(services|triggers|workflows)\/.+/.test(url.pathname)) {
		return { platform: "slack", url: url.href };
	}
	if (DISCORD_HOSTS.has(host) && /^\/api\/(v\d+\/)?webhooks\/\d+\/[^/]+/.test(url.pathname)) {
		return { platform: "discord", url: url.href };
	}
	return {
		error:
			"That is not a Slack or Discord webhook address. Slack's start with https://hooks.slack.com/services/, Discord's with https://discord.com/api/webhooks/.",
	};
}

/**
 * Why a saved channel address cannot be sent to, or undefined: checked before every send, so an
 * address written another way (Plugins → Lead delivery → Settings) still goes only to Slack or
 * Discord, never to a private network.
 */
export function chatAddressError(url: string): string | undefined {
	const parsed = parseChatUrl(url);
	return "error" in parsed ? parsed.error : undefined;
}

/** The address as the page may show it: its host and the last four characters. */
export function maskChatUrl(text: string | undefined): string {
	try {
		const url = new URL(text ?? "");
		return `${url.host}/…${url.pathname.replace(/\/$/, "").slice(-4)}`;
	} catch {
		return "the channel";
	}
}

/** The address as it may appear in a log or an error: never the secret part. */
export function redactUrl(text: string, url: string | undefined): string {
	if (!url) return text;
	let out = text.split(url).join(maskChatUrl(url));
	try {
		const { pathname } = new URL(url);
		if (pathname.length > 8) out = out.split(pathname).join("/…");
	} catch {
		// nothing more to hide
	}
	return out;
}

const MARK_WORDS: Record<string, string> = {
	spam: "Possibly spam",
	throwaway: "Possibly fake email address",
	repeat: "Same address again",
};

/** Slack's mrkdwn: only &, < and > are special; escaping them also stops <!channel> pings. */
function slackText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Discord's markdown, so what people wrote cannot restyle the message. Mentions are off anyway. */
function discordText(text: string): string {
	return text.replace(/([\\*_~|`>#[\]])/g, "\\$1");
}

const DISCORD_MAX = 2000;
const VALUE_MAX = 600;

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Where the site's admin shows this form's submissions, when the site's address is known. */
export function submissionsUrl(origin: string, formId: string): string {
	return origin
		? `${origin}/_emdash/admin/plugins/emdash-forms/submissions?formId=${encodeURIComponent(formId)}`
		: "";
}

/** The JSON body Slack or Discord receives for one enquiry. */
export function chatBody(
	d: Delivery,
	enquiry: Enquiry,
	test: boolean,
	origin: string,
): Record<string, unknown> {
	const discord = d.chat === "discord";
	const esc = discord ? discordText : slackText;
	const bold = (text: string) => (discord ? `**${text}**` : `*${text}*`);
	const lines: string[] = [
		bold(esc(`${test ? "Test enquiry" : "New enquiry"}: ${enquiry.formName}`)),
	];
	const marks = marksOf(enquiry).map((m) => MARK_WORDS[m] ?? m);
	if (marks.length) lines.push(esc(marks.join(" · ")));
	if (d.leaveOut) {
		lines.push(esc("What they wrote is in Forms → Submissions."));
	} else {
		for (const field of enquiry.fields) {
			const value = cut(field.value.replace(/\s*\n\s*/g, " / "), VALUE_MAX);
			lines.push(`${bold(esc(`${field.label}:`))} ${esc(value)}`);
		}
		if (enquiry.hasFiles) lines.push(esc("Files are in Forms → Submissions."));
		if (enquiry.pageUrl) lines.push(`${bold(esc("Page:"))} ${esc(enquiry.pageUrl)}`);
	}
	const link = submissionsUrl(origin, enquiry.formId);
	if (link) lines.push(discord ? `[Open in Forms](<${link}>)` : `<${link}|Open in Forms>`);
	if (discord) {
		let content = lines.join("\n");
		if (content.length > DISCORD_MAX) content = cut(content, DISCORD_MAX);
		return { content, allowed_mentions: { parse: [] } };
	}
	return { text: lines.join("\n"), unfurl_links: false, unfurl_media: false };
}

/** The request for one enquiry; `url` is the channel's address, read from where it is kept. */
export function chatRequest(
	d: Delivery,
	url: string,
	enquiry: Enquiry,
	test: boolean,
	origin: string,
) {
	return {
		url,
		init: {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "EmDash Lead Delivery" },
			body: JSON.stringify(chatBody(d, enquiry, test, origin)),
		},
	};
}

const path = (u: URL) => u.pathname.replace(/\/$/, "");

/** What Slack's or Discord's answer means. Never repeats the address. */
export function classifyChat(
	d: Delivery,
	status: number,
	finalUrl: string,
	bodyText: string,
): Outcome {
	const chat = chatLabel(d.chat);
	const words = redactUrl(bodyText.trim(), d.url).slice(0, 200);
	const raw = `${chat} answered ${status}${words ? `: ${words}` : ""}`;
	const edit = `Make a new webhook for the channel in ${chat} and paste it under Lead delivery → ${d.name} → Edit.`;
	if (status >= 200 && status < 300) {
		let moved = false;
		try {
			if (finalUrl && d.url) {
				const [x, y] = [new URL(finalUrl), new URL(d.url)];
				moved = x.origin !== y.origin || path(x) !== path(y);
			}
		} catch {
			moved = false;
		}
		if (moved) {
			return {
				kind: "fixing",
				raw: `${chat} sent it on to another page`,
				plain: `${chat} sent the message on to a different page, so it did not arrive. ${edit}`,
			};
		}
		return { kind: "delivered" };
	}
	if (status === 408 || status === 429 || status >= 500) return { kind: "retry", raw };
	if (status === 404 || status === 410) {
		return {
			kind: "fixing",
			raw,
			plain: `That channel's webhook no longer exists in ${chat}: it was deleted, or the channel was archived. ${edit}`,
		};
	}
	if (status === 401 || status === 403) {
		return {
			kind: "fixing",
			raw,
			plain: `${chat} refused the message: the webhook was turned off or its app removed. ${edit}`,
		};
	}
	return {
		kind: "fixing",
		raw,
		plain: `${chat} refused the message${words ? ". Its own words are below" : ` without saying why (it answered ${status})`}. Check the channel's webhook, then press Send again.`,
	};
}
