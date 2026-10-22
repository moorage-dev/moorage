// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { inboundUrl, plural, privateEmail } from "./config.js";
import type { Enquiry, KnownForm, ReachResult, Send } from "./types.js";

const UTM_LABELS: Record<string, string> = {
	utm_source: "UTM source",
	utm_medium: "UTM medium",
	utm_campaign: "UTM campaign",
	utm_term: "UTM term",
	utm_content: "UTM content",
};

/** The email an Email delivery sends: marks first, labels not keys; Reply-To the person. */
export function enquiryEmail(site: string, enquiry: Enquiry, test: boolean) {
	const who = enquiry.name ?? enquiry.email ?? "Someone";
	const marks = markWords(enquiry);
	const lines = [
		...(marks.length
			? [
					`Marked: ${marks.join(" · ")}`,
					"These marks are a guess. Lead delivery still sends marked enquiries.",
					"",
				]
			: []),
		`${who}${enquiry.name && enquiry.email ? ` (${enquiry.email})` : ""} sent the ${enquiry.formName} form on your website.${test ? " This is a test from Lead delivery." : ""}`,
		"",
		...enquiry.fields
			.filter((f) => !(f.key in UTM_LABELS) && f.key !== "page_url")
			.map((f) => `${f.label}: ${f.value}`),
	];
	const extra: string[] = [];
	if (enquiry.pageUrl) extra.push(`Page: ${enquiry.pageUrl}`);
	for (const [key, value] of Object.entries(enquiry.utm ?? {})) {
		extra.push(`${UTM_LABELS[key] ?? key}: ${value}`);
	}
	if (extra.length) lines.push("", ...extra);
	if (enquiry.hasFiles) lines.push("", "It has an attachment: see Forms → Submissions.");
	const first = enquiry.name?.split(/\s+/)[0];
	lines.push(
		"",
		`${enquiry.email ? `Reply to this email to answer ${first ?? "them"}. ` : ""}Every enquiry is also in Forms → Submissions.`,
	);
	return {
		subject: `${site}: ${test ? "test enquiry" : "new enquiry"} from ${who} (${enquiry.formName})`,
		text: lines.join("\n"),
	};
}

/** An enquiry's marks in words, as the top of a delivered email lists them. */
export function markWords(enquiry: Enquiry): string[] {
	const marks: string[] = [];
	if (enquiry.throwaway) marks.push("possibly fake address");
	if (enquiry.repeatAfterMs !== undefined)
		marks.push(repeatNote(enquiry.repeatAfterMs).toLowerCase());
	if (enquiry.spam) marks.push("possibly spam");
	return marks;
}

/** The service's own words as one plain line: no markup, no runs of spaces, not too long. */
export function ownWords(raw: string, max = 300): string {
	const flat = raw
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The log note on a repeat enquiry, by elapsed time: the sandbox does not know the site's time zone. */
export function repeatNote(elapsedMs: number): string {
	const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
	if (minutes < 1) return "Same address less than a minute earlier";
	if (minutes < 60) return `Same address ${plural(minutes, "minute")} earlier`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `Same address ${plural(hours, "hour")} earlier`;
	return `Same address ${plural(Math.floor(hours / 24), "day")} earlier`;
}

export function failureAlert(site: string, rows: Array<{ send: Send; name: string }>) {
	const parts = rows.map(({ send, name }) => {
		const words = send.raw ? ownWords(send.raw) : "";
		const reason = send.plain ?? "Its service refused it.";
		return [
			`${send.who}'s enquiry from the ${send.formName} form could not be delivered by "${name}".`,
			"",
			// Never point at words that are not there.
			words ? reason : reason.replace(" Its own words are below.", ""),
			...(words ? ["", words] : []),
		].join("\n");
	});
	// Most reasons already end "press Send again"; say where it is only when none does.
	const saysSendAgain = rows.some(({ send }) => send.plain?.includes("Send again"));
	return {
		subject:
			rows.length === 1
				? `${site}: an enquiry could not be delivered`
				: `${site}: ${rows.length} enquiries could not be delivered`,
		text: [
			...parts.flatMap((part) => [part, ""]),
			...(saysSendAgain
				? []
				: ["When it is fixed, press Send again in Lead delivery → Enquiries.", ""]),
			"The enquiry is safe: it is kept in Lead delivery and in Forms → Submissions.",
			"You get this email at most once a day.",
		].join("\n"),
	};
}

export function quietLine(form: KnownForm, sinceText: string): string {
	return `No enquiries from ${form.name} ${sinceText}.`;
}

export function quietAlert(site: string, lines: string[]) {
	return {
		subject:
			lines.length === 1
				? `${site}: ${lines[0]!.replace(/\.$/, "").replace(/^No/, "no")}`
				: `${site}: ${lines.length} forms have gone quiet`,
		text: [
			...lines.map((line) => `${line} It usually gets some every few days.`),
			"",
			"Check the form still sends: send yourself an enquiry through it on your site, then look for it in Lead delivery.",
			"",
			"You get this email at most once a day.",
		].join("\n"),
	};
}

export function schedulerAlert(site: string) {
	return {
		subject: `${site}: retries are not running`,
		text: [
			"Some enquiries did not get through at the first try. Lead delivery tries them again, but scheduled tasks are not running on this site, so it cannot.",
			"",
			"Ask your web person to check the site's scheduled tasks (on Cloudflare: a Cron Trigger every minute). Until then you can press Send now in Lead delivery.",
			"",
			"You get this email at most once a day.",
		].join("\n"),
	};
}

/** The written step for whoever looks after the site's code. */
export function instructions(opts: {
	site: string;
	origin: string;
	key: string;
	form: { slug: string; name: string };
	reach: ReachResult | undefined;
}): string {
	const { origin, key } = opts;
	const host = origin ? new URL(origin).host : "this site";
	const address = inboundUrl(origin, key);
	const mail = privateEmail(key);
	const list = `${origin}/_emdash/api/plugins/emdash-forms/forms/list`;
	const update = `${origin}/_emdash/api/plugins/emdash-forms/forms/update`;
	const viaEmail = opts.reach === "email" || opts.reach === "none";
	const lines = [
		`Connecting the ${opts.form.name} form on ${opts.site} (${host}) to Lead Delivery`,
		"",
		`Its short name in Forms: ${opts.form.slug}`,
		"",
	];
	if (viaEmail) {
		lines.push(
			"This site cannot call its own address, so the form hands its enquiries",
			"over through a private email address. Nobody receives that email.",
			"",
			"For the form, once:",
			"1. Make an API token with Admin scope: Settings → API tokens.",
			"2. Find the form's ID (look for its short name in the list):",
			`   GET ${list}`,
			"3. Add this address to the form's notifyEmails, keeping the addresses",
			"   already there (the update replaces the whole list), digest off:",
			`   ${mail}`,
			`   POST ${update}`,
			`   {"id":"FORM_ID","settings":{"notifyEmails":["${mail}"],"digestEnabled":false}}`,
			"   Headers: Authorization: Bearer TOKEN, X-EmDash-Request: 1",
			"4. Send one enquiry through the form, then open Lead delivery to see it arrive.",
			"",
			"If Lead Delivery is ever removed, take the private address out of notifyEmails too:",
			"the .invalid domain can never receive mail, so your email provider would only",
			"report it as undeliverable.",
			"",
			"If the site can call itself (Cloudflare: compatibility flag",
			"global_fetch_strictly_public), set the form's webhookUrl instead:",
			address,
		);
	} else {
		lines.push(
			"The form sends its enquiries straight to Lead Delivery.",
			"",
			"For the form, once:",
			"1. Make an API token with Admin scope: Settings → API tokens.",
			"2. Find the form's ID (look for its short name in the list):",
			`   GET ${list}`,
			"3. Set the form's webhookUrl to this address:",
			`   ${address}`,
			`   POST ${update}`,
			`   {"id":"FORM_ID","settings":{"webhookUrl":"${address}"}}`,
			"   Headers: Authorization: Bearer TOKEN, X-EmDash-Request: 1",
			"4. Send one enquiry through the form, then open Lead delivery to see it arrive.",
			"",
			"On Cloudflare the Worker needs the compatibility flag",
			"global_fetch_strictly_public to call its own address. If enquiries do not",
			"arrive, add the private email address to the form's notifyEmails instead:",
			mail,
		);
	}
	return lines.join("\n");
}
