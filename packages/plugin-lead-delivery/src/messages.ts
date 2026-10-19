// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { inboundUrl, plural, privateEmail } from "./config.js";
import type { Delivery, Enquiry, KnownForm, ReachResult } from "./types.js";

const UTM_LABELS: Record<string, string> = {
	utm_source: "UTM source",
	utm_medium: "UTM medium",
	utm_campaign: "UTM campaign",
	utm_term: "UTM term",
	utm_content: "UTM content",
};

/** The Email place's message: labels, not keys; Reply-To the person. */
export function enquiryEmail(site: string, enquiry: Enquiry, test: boolean) {
	const who = enquiry.name ?? enquiry.email ?? "Someone";
	const lines = [
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

export function failureAlert(site: string, rows: Array<{ delivery: Delivery; place: string }>) {
	const parts = rows.map(({ delivery, place }) => {
		const words = delivery.raw ? ownWords(delivery.raw) : "";
		const reason = delivery.plain ?? "Its service refused it.";
		return [
			`${delivery.who}'s enquiry from the ${delivery.formName} form could not be sent to "${place}".`,
			"",
			// Never point at words that are not there.
			words ? reason : reason.replace(" Its own words are below.", ""),
			...(words ? ["", words] : []),
		].join("\n");
	});
	// Most reasons already end "press Send again"; say where it is only when none does.
	const saysSendAgain = rows.some(({ delivery }) => delivery.plain?.includes("Send again"));
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
			"The enquiry is safe: it is waiting in Lead delivery and in Forms → Submissions.",
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
			"Check the form still sends: send yourself a test through it on your site, then look for it in Lead delivery → Enquiries.",
			"",
			"You get this email at most once a day.",
		].join("\n"),
	};
}

export function schedulerAlert(site: string) {
	return {
		subject: `${site}: enquiries are waiting to be sent again`,
		text: [
			"Some enquiries could not be delivered at the first try and are waiting to be tried again, but scheduled tasks are not running on this site, so they are not being retried.",
			"",
			"Ask your web person to check the site's scheduled tasks (on Cloudflare: a Cron Trigger every minute). Until then you can press Send now in Lead delivery → Enquiries.",
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
	forms: string[];
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
		`Connecting the forms on ${opts.site} (${host}) to Lead Delivery`,
		"",
		`Forms to connect: ${opts.forms.length ? opts.forms.join(", ") : "every form on the site"}`,
		"",
	];
	if (viaEmail) {
		lines.push(
			"This site cannot call its own address, so each form hands its enquiries",
			"over through a private email address. Nobody receives that email.",
			"",
			"For each form, once:",
			"1. Make an API token with Admin scope: Settings → API tokens.",
			"2. Find the form's ID:",
			`   GET ${list}`,
			"3. Add this address to the form's notifyEmails, keeping the addresses",
			"   already there (the update replaces the whole list), digest off:",
			`   ${mail}`,
			`   POST ${update}`,
			`   {"id":"FORM_ID","settings":{"notifyEmails":["${mail}"],"digestEnabled":false}}`,
			"   Headers: Authorization: Bearer TOKEN, X-EmDash-Request: 1",
			"4. Send one test through each form, then open Lead delivery to see it arrive.",
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
			"Each form sends its enquiries straight to Lead Delivery.",
			"",
			"For each form, once:",
			"1. Make an API token with Admin scope: Settings → API tokens.",
			"2. Find the form's ID:",
			`   GET ${list}`,
			"3. Set the form's webhookUrl to this address:",
			`   ${address}`,
			`   POST ${update}`,
			`   {"id":"FORM_ID","settings":{"webhookUrl":"${address}"}}`,
			"   Headers: Authorization: Bearer TOKEN, X-EmDash-Request: 1",
			"4. Send one test through each form, then open Lead delivery to see it arrive.",
			"",
			"On Cloudflare the Worker needs the compatibility flag",
			"global_fetch_strictly_public to call its own address. If enquiries do not",
			"arrive, add the private email address to the form's notifyEmails instead:",
			mail,
		);
	}
	return lines.join("\n");
}
