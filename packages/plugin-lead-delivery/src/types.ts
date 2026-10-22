// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/** One field of an enquiry, as the form defines it. `key` is the form's field name. */
export interface FieldInfo {
	key: string;
	label: string;
	/** The forms plugin's field type when known: text, email, tel, textarea, checkbox, … */
	type?: string;
}

/** A form this plugin knows about: named in New delivery, or seen in an enquiry. */
export interface KnownForm {
	/** The form's short name (the forms plugin's slug), or a name-based key for the email way. */
	slug: string;
	name: string;
	fields: FieldInfo[];
	/** Where the fields came from: the form's own definition, or its last enquiry. */
	source: "definition" | "enquiry";
	addedAt: string;
	lastAt?: string;
	/** Days (YYYY-MM-DD, UTC) with at least one enquiry, newest last, at most 30. */
	days: string[];
	/** `lastAt` of the quiet spell already alerted, so each spell is alerted once. */
	quietAlertedFor?: string;
	/** When the form was connected: marked by hand, or its first enquiry. A form with `lastAt` is connected too. */
	connectedAt?: string;
	connectedWay?: "straight" | "email" | "by hand";
}

export type DeliveryKind = "email" | "hubspot" | "app";
export type AppKind = "zapier" | "make" | "n8n" | "other";
/** The same email address again: send it anyway, or not within 24 hours or 7 days. */
export type Repeat = "off" | "24h" | "7d";

/** A delivery: one form (or several, through Edit) and one destination. */
export interface Delivery {
	id: string;
	kind: DeliveryKind;
	name: string;
	/** The name before the update to deliveries; kept for one release. */
	oldName?: string;
	/** "all" includes forms added later. New delivery always writes one form. */
	forms: "all" | string[];
	on: boolean;
	repeat: Repeat;
	/** Don't send enquiries marked possibly spam: they are logged as Not sent. */
	holdSpam: boolean;
	createdAt: string;
	/** The last test: when, and whether it arrived. */
	testedAt?: string;
	testResult?: { ok: boolean; plain?: string; raw?: string };
	// Email
	to?: string[];
	// HubSpot
	portalId?: string;
	formGuid?: string;
	/** Per form short name: field key → HubSpot choice (see hubspot.ts `CHOICES`). */
	mapping?: Record<string, Record<string, string>>;
	/** Per form short name: field key → typed HubSpot field name for "Other". */
	otherNames?: Record<string, Record<string, string>>;
	gdpr?: boolean;
	/** HubSpot field marked `true` for throwaway addresses; empty means not marked. */
	throwawayField?: string;
	// Another app
	app?: AppKind;
	url?: string;
	secret?: string;
}

/** What the site-reach check found. */
export type ReachResult = "self" | "email" | "none";

export interface Config {
	version: 2;
	deliveries: Delivery[];
	/** Who hears when something needs fixing. */
	alertTo: string[];
	/** The private key in the web address and the email address. */
	key: string;
	/** When the private address was last reset: forms connected before then must be connected again. */
	keySetAt?: string;
	reach?: { result: ReachResult; at: string };
	/** Show the one-time note that the setup is now a list of deliveries. */
	notice?: boolean;
	/**
	 * The 0.1 setup, kept untouched next to `deliveries` so going back to 0.1.2 still works.
	 * 0.2 never reads or changes them. Kept for rollback until 0.3.
	 */
	places?: unknown[];
	testedAt?: string;
}

/** One enquiry as this plugin received it. Contents are deleted once all its deliveries are done. */
export interface Enquiry {
	formId: string;
	formName: string;
	receivedAt: string;
	fields: Array<FieldInfo & { value: string }>;
	email?: string;
	name?: string;
	pageUrl?: string;
	utm?: Record<string, string>;
	via: "web" | "email" | "test";
	throwaway: boolean;
	/** Marked possibly spam on receipt (see spam.ts). */
	spam?: boolean;
	/** Milliseconds since the same address last sent this form (within 7 days). */
	repeatAfterMs?: number;
	hasFiles: boolean;
	/** Read from an email whose format was not recognised; kept as text. */
	unreadable?: boolean;
	/** Contents removed once all its deliveries were done; kept so a repeat is still recognised. */
	cleared?: boolean;
	/** Already counted as delivered in the week's numbers. */
	counted?: boolean;
}

export type SendStatus = "delivered" | "retrying" | "fixing" | "gaveup" | "skipped";

/** The `destination` of log rows for an enquiry that no delivery took. */
export const NO_DELIVERY = "none";

/** One enquiry on its way through one delivery: the log row and the retry queue entry. */
export interface Send {
	enquiryId: string;
	/** The delivery's id (the name dates from before deliveries; log rows keep it), or `NO_DELIVERY`. */
	destination: string;
	formId: string;
	formName: string;
	who: string;
	email?: string;
	status: SendStatus;
	attempts: number;
	/** When the next try is due (ISO); "" when nothing is due. */
	nextAt: string;
	createdAt: string;
	deliveredAt?: string;
	/** What went wrong, in plain words. */
	plain?: string;
	/** The service's own words. */
	raw?: string;
	/** The form field HubSpot refused. */
	field?: string;
	notes: string[];
	/** Not sent on purpose (a repeat, possibly spam, turned off); Send again sends it. */
	held?: boolean;
	test?: boolean;
	ms?: number;
}
