// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Copying the SEO settings from one site to another: who the site is for, its details, opening
// hours, profiles and content types, as text an admin copies on one site and pastes on the
// other. There are no secrets in these settings. Redirects are not included: the Redirects tab
// exports them as a list its WordPress import reads back.

import {
	defaultTypeForCollection,
	normalizeConfig,
	type CollectionRule,
	type SeoConfig,
	type SiteIdentity,
} from "./config.js";
import { DAYS, formatDayHours } from "./hours.js";
import { BUSINESS_GROUPS, PRICE_RANGES, typeLabel } from "./page-types.js";
import { parseUrl, readLogo } from "./url.js";

/** Marks pasted text as settings copied from this plugin. */
export const TRANSFER_FORMAT = "emdash-seo-settings";
const TRANSFER_VERSION = 1;

/** The settings as copied: what describes the site, none of the per-site switches. */
export interface Transfer {
	format: typeof TRANSFER_FORMAT;
	version: number;
	site: SiteIdentity;
	collections: Record<string, { type?: string; noindex?: boolean }>;
	robots: SeoConfig["robots"];
	jsonLdField: string;
	breadcrumbs: boolean;
}

/** The text shown for copying. */
export function exportSettings(config: SeoConfig): string {
	const collections: Transfer["collections"] = {};
	for (const [slug, rule] of Object.entries(config.collections)) {
		// The "this is intended" confirmation stays on the site it was given on.
		collections[slug] = {
			...(rule.type ? { type: rule.type } : {}),
			...(rule.noindex ? { noindex: true } : {}),
		};
	}
	const transfer: Transfer = {
		format: TRANSFER_FORMAT,
		version: TRANSFER_VERSION,
		site: config.site,
		collections,
		robots: config.robots,
		jsonLdField: config.jsonLdField,
		breadcrumbs: config.breadcrumbs,
	};
	return JSON.stringify(transfer, null, 2);
}

export interface Change {
	what: string;
	now: string;
	after: string;
}

export interface ReadTransfer {
	/** The settings this site would have. */
	config: SeoConfig;
	/** What was pasted, checked, for the Apply button to send back. */
	transfer: Transfer;
	changes: Change[];
	/** Content types in the paste this site does not have. */
	leftOut: string[];
	/** Labels of content types the paste hides from search engines that are shown today. */
	hides: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NOT_SETTINGS =
	"This is not a copy of SEO settings. On the other site, open SEO > Settings > Copy settings to another site and copy the whole text.";
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** The site's kind in the words of the setup question. */
function kindLabel(type: string): string {
	if (type === "Organization") return "A company or organisation";
	if (type === "Person") return "A person";
	const group = BUSINESS_GROUPS.find((candidate) => candidate.value === type);
	return `A local business: ${group?.label ?? type}`;
}

/** Check the parts of the identity the forms check, so a paste cannot store what they refuse. */
function checkSite(raw: Record<string, unknown>, siteUrl: string): string | null {
	const type = raw.type ?? "Organization";
	if (
		type !== "Organization" &&
		type !== "Person" &&
		!BUSINESS_GROUPS.some((group) => group.value === type)
	) {
		return "Couldn't read the kind of site in these settings.";
	}
	if (raw.logo !== undefined && raw.logo !== "") {
		if (typeof raw.logo !== "string" || "error" in readLogo(raw.logo, siteUrl)) {
			return "Couldn't read the logo link in these settings: it must be a web address starting with https://";
		}
	}
	if (raw.sameAs !== undefined) {
		const links = Array.isArray(raw.sameAs) ? raw.sameAs : [null];
		for (const link of links) {
			const protocol = typeof link === "string" ? parseUrl(link)?.protocol : undefined;
			if (protocol !== "https:" && protocol !== "http:") {
				return "Couldn't read a profile link in these settings: each must be a web address.";
			}
		}
	}
	if (raw.openingHours !== undefined) {
		const rows = Array.isArray(raw.openingHours) ? raw.openingHours : [null];
		for (const row of rows) {
			const ok =
				isRecord(row) &&
				Array.isArray(row.days) &&
				row.days.length > 0 &&
				row.days.every((day) => (DAYS as readonly unknown[]).includes(day)) &&
				typeof row.opens === "string" &&
				typeof row.closes === "string" &&
				CLOCK.test(row.opens) &&
				CLOCK.test(row.closes);
			if (!ok) return "Couldn't read the opening hours in these settings.";
		}
	}
	if (raw.priceRange !== undefined && !PRICE_RANGES.includes(String(raw.priceRange))) {
		return "Couldn't read the price range in these settings.";
	}
	return null;
}

/** Each setting in words, for showing what an import changes. */
function described(
	config: SeoConfig,
	collections: Array<{ slug: string; label: string }>,
): Array<[string, string]> {
	const { site } = config;
	const none = "(none)";
	const address = site.address
		? [
				site.address.streetAddress,
				site.address.addressLocality,
				site.address.addressRegion,
				site.address.postalCode,
				site.address.addressCountry,
			]
				.filter(Boolean)
				.join(", ")
		: "";
	const hours = DAYS.map((day) => {
		const text = formatDayHours(day, site.openingHours);
		return text === "" ? "" : `${day.slice(0, 3)} ${text}`;
	})
		.filter(Boolean)
		.join("; ");
	const { robots } = config;
	const rows: Array<[string, string]> = [
		["Who the site is for", kindLabel(site.type)],
		["Name", site.name ?? "(the site's name)"],
		["Also known as", site.alternateName ?? none],
		["Registered legal name", site.legalName ?? none],
		["What you do", site.description ?? none],
		["Logo", site.logo ?? none],
		["Profiles elsewhere", site.sameAs.join(", ") || none],
		["Email", site.email ?? none],
		["Phone", site.telephone ?? none],
		["Address", address || none],
		["Map position", site.geo ? `${site.geo.latitude}, ${site.geo.longitude}` : none],
		["Opening hours", hours || none],
		["Price range", site.priceRange ?? none],
		["Areas served", site.areaServed.join(", ") || none],
		["Founded", site.foundingDate ?? none],
		["VAT number", site.vatID ?? none],
		["Tax number", site.taxID ?? none],
		["Employees", site.numberOfEmployees ? String(site.numberOfEmployees) : none],
	];
	for (const collection of collections) {
		const rule = config.collections[collection.slug];
		rows.push(
			[
				`${collection.label}: Google treats these as`,
				typeLabel(rule?.type ?? defaultTypeForCollection(collection.slug)),
			],
			[
				`${collection.label}: on Google`,
				rule?.noindex ? "Hidden from Google" : "Can appear on Google",
			],
		);
	}
	rows.push(
		["Path to each page on Google", config.breadcrumbs ? "Shown" : "Not shown"],
		[
			"Text in search results",
			robots.nosnippet ? "None" : robots.maxSnippet >= 0 ? "Short" : "As long as Google likes",
		],
		["Picture size in search results", robots.maxImagePreview],
		["Field for a page's own markup", config.jsonLdField],
	);
	return rows;
}

/**
 * Read pasted settings, or an Apply button's value, against this site's settings and content
 * types: what the site would have, and what changes. Nothing is saved here.
 */
export function readTransfer(
	input: unknown,
	current: SeoConfig,
	collections: Array<{ slug: string; label: string }>,
	siteUrl: string,
): ReadTransfer | { error: string } {
	let raw: unknown = input;
	if (typeof input === "string") {
		if (input.trim() === "") return { error: "Paste the settings first." };
		try {
			raw = JSON.parse(input);
		} catch {
			return { error: NOT_SETTINGS };
		}
	}
	if (!isRecord(raw) || raw.format !== TRANSFER_FORMAT || !isRecord(raw.site)) {
		return { error: NOT_SETTINGS };
	}
	if (typeof raw.version !== "number" || raw.version > TRANSFER_VERSION) {
		return {
			error: "These settings come from a newer version of SEO. Update it on this site first.",
		};
	}
	const problem = checkSite(raw.site, siteUrl);
	if (problem) return { error: problem };

	// Read through the same normaliser as stored settings, so the result has the stored shape.
	const logo = typeof raw.site.logo === "string" ? readLogo(raw.site.logo, siteUrl) : {};
	const pasted = normalizeConfig({
		// A logo given as a path on the site is stored as a full address, as the form stores it.
		site: { ...raw.site, logo: "logo" in logo ? logo.logo : undefined },
		collections: raw.collections,
		robots: raw.robots,
		jsonLdField: raw.jsonLdField,
		breadcrumbs: raw.breadcrumbs,
	});
	const known = new Map(collections.map((collection) => [collection.slug, collection.label]));
	const merged: Record<string, CollectionRule> = { ...current.collections };
	const leftOut: string[] = [];
	const hides: string[] = [];
	for (const [slug, rule] of Object.entries(pasted.collections)) {
		const label = known.get(slug);
		if (label === undefined) {
			leftOut.push(slug);
			continue;
		}
		if (rule.noindex && !current.collections[slug]?.noindex) hides.push(label);
		// Hiding needs this site's own "This is intended", so the warning shows here too.
		merged[slug] = { type: rule.type, noindex: rule.noindex === true };
	}
	const config: SeoConfig = {
		...current,
		site: pasted.site,
		collections: merged,
		robots: pasted.robots,
		jsonLdField: pasted.jsonLdField,
		breadcrumbs: pasted.breadcrumbs,
		// The question of who the site is for is answered by the paste.
		steps: { ...current.steps, identity: true },
	};
	const before = new Map(described(current, collections));
	const changes = described(config, collections)
		.filter(([what, after]) => before.get(what) !== after)
		.map(([what, after]) => ({ what, now: before.get(what) ?? "", after }));
	const transfer = JSON.parse(exportSettings(pasted)) as Transfer;
	return { config, transfer, changes, leftOut, hides };
}
