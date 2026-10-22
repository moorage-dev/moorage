// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { UTM_KEYS } from "./enquiry.js";
import type { Delivery, Enquiry, FieldInfo } from "./types.js";

/** The HubSpot fields offered in each dropdown, in the order shown. */
export const CHOICES: Array<{ value: string; label: string; property?: string }> = [
	{ value: "email", label: "Email", property: "email" },
	{ value: "firstname", label: "First name", property: "firstname" },
	{ value: "lastname", label: "Last name", property: "lastname" },
	{ value: "fullname", label: "First and last name (split at the first space)" },
	{ value: "phone", label: "Phone number", property: "phone" },
	{ value: "company", label: "Company name", property: "company" },
	{ value: "message", label: "Message", property: "message" },
	{ value: "website", label: "Website", property: "website" },
	{ value: "jobtitle", label: "Job title", property: "jobtitle" },
	{ value: "city", label: "City", property: "city" },
	{ value: "country", label: "Country", property: "country" },
	{ value: "consent", label: "Consent: agreed to marketing emails" },
	{ value: "other", label: "Other (type the HubSpot field name)" },
	{ value: "skip", label: "Don't send" },
];

/** Not matched yet: not sent until the owner chooses. */
export const UNMATCHED = "";

const RULES: Array<[RegExp, string]> = [
	[/^(first[ _-]?name|firstname|given[ _-]?name)$/i, "firstname"],
	[/^(last[ _-]?name|lastname|surname|family[ _-]?name)$/i, "lastname"],
	[/^(name|full[ _-]?name|your[ _-]?name)$/i, "fullname"],
	[/phone|mobile|telephone|^tel$/i, "phone"],
	[/company|business|organi[sz]ation/i, "company"],
	[/message|enquiry|inquiry|comments?|details|question/i, "message"],
	[/website|^url$|web[ _-]?site/i, "website"],
	[/job[ _-]?title|^role$|position/i, "jobtitle"],
	[/^(city|town)$/i, "city"],
	[/^country$/i, "country"],
];

/** The choice made automatically from a field's name, label and type. */
export function autoChoice(field: FieldInfo): string {
	if (UTM_KEYS.includes(field.key) || field.key === "page_url") return "skip";
	if (field.type === "email" || /e-?mail/i.test(field.key)) return "email";
	if (field.type === "checkbox" && /news|offer|marketing|updates|subscribe/i.test(field.label)) {
		return "consent";
	}
	if (field.type === "file" || field.type === "hidden") return "skip";
	for (const text of [field.key, field.label]) {
		for (const [pattern, choice] of RULES) if (pattern.test(text)) return choice;
	}
	if (field.type === "textarea") return "message";
	if (field.type === "tel") return "phone";
	if (/\bname\b/i.test(field.label)) return "fullname";
	return UNMATCHED;
}

export function choiceFor(place: Delivery, form: string, field: FieldInfo): string {
	return place.mapping?.[form]?.[field.key] ?? autoChoice(field);
}

export function matchedCount(place: Delivery, form: string, fields: FieldInfo[]): number {
	return fields.filter((f) => choiceFor(place, form, f) !== UNMATCHED).length;
}

export interface HubSpotForm {
	portalId: string;
	formGuid: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function guidFromBase64(code: string): string | null {
	try {
		const binary = atob(code.replace(/-/g, "+").replace(/_/g, "/") + "==");
		if (binary.length !== 16) return null;
		const hex = [...binary].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	} catch {
		return null;
	}
}

/**
 * Portal and form ID from what the owner pasted: the embed code, a share link, the form
 * editor's address or the submit address. Share-link decoding is unverified with HubSpot.
 */
export function parseHubSpot(pasted: string): HubSpotForm | { error: string } {
	const text = pasted.trim();
	if (!text) return { error: "Paste your HubSpot form's share link or embed code." };
	const portal = /portalId\s*[:=]\s*["']?(\d{3,12})/i.exec(text)?.[1];
	const form = /formId\s*[:=]\s*["']?([0-9a-f-]{36})/i.exec(text)?.[1];
	if (portal && form && GUID.test(form)) return { portalId: portal, formGuid: form.toLowerCase() };

	const path =
		/(?:\/forms\/|\/submit\/|\/form\/)(\d{3,12})\/(?:editor\/)?([0-9a-f-]{36})/i.exec(text) ??
		/(\d{3,12})\/([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(text);
	if (path && GUID.test(path[2]!)) return { portalId: path[1]!, formGuid: path[2]!.toLowerCase() };

	const share = /share(?:-[a-z0-9]+)?\.hsforms\.com\/[12]([A-Za-z0-9_-]{22})(\d{3,12})/.exec(text);
	if (share) {
		const guid = guidFromBase64(share[1]!);
		if (guid) return { portalId: share[2]!, formGuid: guid };
	}
	return {
		error:
			"That does not look like a HubSpot form. In HubSpot open Marketing → Forms, choose the form, press Share, and copy the link or the embed code.",
	};
}

export function submitUrl(place: Delivery): string {
	return `https://api.hsforms.com/submissions/v3/integration/submit/${place.portalId}/${place.formGuid}`;
}

const PROCESS_TEXT = "I agree to my details being used to answer my enquiry.";

function ticked(value: string): boolean {
	return /^(yes|true|on|1|checked|agreed?)$/i.test(value.trim());
}

/** The page address with UTM values added to its query when they are not already there. */
export function pageWithUtm(enquiry: Enquiry): string | undefined {
	if (!enquiry.pageUrl) return undefined;
	try {
		const url = new URL(enquiry.pageUrl);
		for (const [key, value] of Object.entries(enquiry.utm ?? {})) {
			if (!url.searchParams.has(key)) url.searchParams.set(key, value);
		}
		return url.href;
	} catch {
		return undefined;
	}
}

/** The Forms API v3 body for one enquiry. */
export function hubspotBody(place: Delivery, enquiry: Enquiry): Record<string, unknown> {
	const fields: Array<{ objectTypeId: string; name: string; value: string }> = [];
	const add = (name: string, value: string) => {
		if (name && value) fields.push({ objectTypeId: "0-1", name, value });
	};
	let consent: { ticked: boolean; text: string } | null = null;
	for (const field of enquiry.fields) {
		const choice = choiceFor(place, enquiry.formId, field);
		if (choice === UNMATCHED || choice === "skip") continue;
		if (choice === "fullname") {
			const [first, ...rest] = field.value.trim().split(/\s+/);
			add("firstname", first ?? "");
			add("lastname", rest.join(" "));
		} else if (choice === "consent") {
			consent = { ticked: ticked(field.value), text: field.label };
		} else if (choice === "other") {
			add(place.otherNames?.[enquiry.formId]?.[field.key]?.trim() ?? "", field.value);
		} else {
			add(CHOICES.find((c) => c.value === choice)?.property ?? "", field.value);
		}
	}
	if (place.throwawayField && enquiry.throwaway) add(place.throwawayField, "true");

	const body: Record<string, unknown> = { submittedAt: Date.parse(enquiry.receivedAt), fields };
	const pageUri = pageWithUtm(enquiry);
	if (pageUri) body.context = { pageUri, pageName: enquiry.formName };
	// Consent only when chosen: the person ticked a consent box, or the account asks for it.
	const box = consent as { ticked: boolean; text: string } | null;
	if (box?.ticked || place.gdpr) {
		body.legalConsentOptions = {
			consent: { consentToProcess: true, text: box?.ticked ? box.text : PROCESS_TEXT },
		};
	}
	return body;
}

export interface Outcome {
	kind: "delivered" | "retry" | "fixing";
	plain?: string;
	raw?: string;
	field?: string;
	retryAfter?: number;
}

/** What a HubSpot answer means. */
export function classifyHubSpot(status: number, bodyText: string, name = "HubSpot"): Outcome {
	if (status >= 200 && status < 300) return { kind: "delivered" };
	let errors: Array<{ errorType?: string; message?: string }> = [];
	let message = "";
	try {
		const parsed = JSON.parse(bodyText) as {
			errors?: Array<{ errorType?: string; message?: string }>;
			message?: string;
		};
		errors = parsed.errors ?? [];
		message = parsed.message ?? "";
	} catch {
		message = bodyText.slice(0, 300);
	}
	const first = errors[0];
	const raw =
		`HubSpot answered: ${first?.errorType ?? status}. ${first?.message ?? message}`.trim();
	if (status === 408 || status === 429 || status >= 500) return { kind: "retry", raw };
	const type = first?.errorType ?? "";
	if (type === "FIELD_NOT_IN_FORM_DEFINITION") {
		const field = /["“']([^"”']+)["”']/.exec(first?.message ?? "")?.[1];
		return {
			kind: "fixing",
			raw,
			...(field ? { field } : {}),
			plain: `HubSpot says your HubSpot form does not have the field ${field ?? "it was sent"}. Add that field to the form in HubSpot, or choose another field in Lead delivery → ${name} → Edit. Then press Send again.`,
		};
	}
	if (type === "INVALID_EMAIL") {
		return {
			kind: "fixing",
			raw,
			plain: `HubSpot says the email address in this enquiry is not valid, so it was not added. Check the address with the person, or choose which field is the email in Lead delivery → ${name} → Edit.`,
		};
	}
	if (type === "FORM_HAS_RECAPTCHA_ENABLED") {
		return {
			kind: "fixing",
			raw,
			plain:
				"Turn off CAPTCHA on that HubSpot form: HubSpot refuses enquiries sent from a website to a form that has CAPTCHA on. Then press Send again.",
		};
	}
	if (status === 404) {
		return {
			kind: "fixing",
			raw,
			plain: `HubSpot cannot find that form. It may have been deleted. Paste the form's share link again in Lead delivery → ${name} → Edit.`,
		};
	}
	return {
		kind: "fixing",
		raw,
		plain: `HubSpot refused this enquiry${(first?.message ?? message).trim() ? ". Its own words are below" : ` without saying why (it answered ${status})`}. Fix the HubSpot form or the matching in Lead delivery → ${name} → Edit, then press Send again.`,
	};
}
