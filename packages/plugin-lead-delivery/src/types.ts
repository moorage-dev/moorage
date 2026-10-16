// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/** One field of an enquiry, as the form defines it. `key` is the form's field name. */
export interface FieldInfo {
	key: string;
	label: string;
	/** The forms plugin's field type when known: text, email, tel, textarea, checkbox, … */
	type?: string;
}

/** A form this plugin knows about: added by its short name, or seen in an enquiry. */
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
}

export type PlaceKind = "email" | "hubspot" | "app";
export type AppKind = "zapier" | "make" | "n8n" | "other";

/** Where enquiries go. */
export interface Place {
	id: string;
	kind: PlaceKind;
	name: string;
	/** "all" includes forms added later. */
	forms: "all" | string[];
	on: boolean;
	noDuplicates: boolean;
	createdAt: string;
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
	places: Place[];
	/** Who hears when something needs fixing. */
	alertTo: string[];
	/** The private key in the web address and the email address. */
	key: string;
	reach?: { result: ReachResult; at: string };
	/** First successful test, for the setup checklist. */
	testedAt?: string;
}

/** One enquiry as this plugin received it. Contents are deleted once every place has it. */
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
	/** Days since the same address last sent this form (within 7 days). */
	repeatDays?: number;
	hasFiles: boolean;
	/** Read from an email whose format was not recognised; kept as text. */
	unreadable?: boolean;
	/** Contents removed after every place had it; kept so a repeat is still recognised. */
	cleared?: boolean;
}

export type DeliveryStatus = "delivered" | "retrying" | "fixing" | "gaveup" | "skipped";

/** One enquiry on its way to one place: the log row and the retry queue entry. */
export interface Delivery {
	enquiryId: string;
	destination: string;
	formId: string;
	formName: string;
	who: string;
	email?: string;
	status: DeliveryStatus;
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
	test?: boolean;
	ms?: number;
}
