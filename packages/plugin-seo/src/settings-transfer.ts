// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Copying the SEO settings from one site to another: who the site is for, its details, opening
// hours, profiles and content types, as text an admin copies on one site and pastes on the
// other. There are no secrets in these settings. Redirects are not included: the Redirects tab
// exports them as a list its WordPress import reads back.

import {
	defaultTypeForCollection,
	isFoundingDate,
	normalizeConfig,
	type CollectionRule,
	type OpeningHours,
	type SeoConfig,
	type SiteIdentity,
} from "./config.js";
import { DAYS, formatDayHours, readWeekHours } from "./hours.js";
import { BUSINESS_GROUPS, PRICE_RANGES, typeLabel } from "./page-types.js";
import { readLogo, readProfileLink } from "./url.js";

/** Marks pasted text as settings copied from this plugin. */
export const TRANSFER_FORMAT = "emdash-seo-settings";
const TRANSFER_VERSION = 1;

/**
 * Details no form sets, so an admin could not correct them after an import: each site keeps
 * its own, as it keeps the field a page's own markup is read from.
 */
const PER_SITE = ["geo", "vatID", "taxID", "numberOfEmployees"] as const;
type PerSite = (typeof PER_SITE)[number];

/** The identity without what each site keeps for itself. */
function sharedSite(site: SiteIdentity): Omit<SiteIdentity, PerSite> {
	const { geo: _geo, vatID: _vat, taxID: _tax, numberOfEmployees: _staff, ...shared } = site;
	return shared;
}

/**
 * The settings as copied: what describes the site and the forms can change, none of the
 * per-site switches or details no form sets.
 */
export interface Transfer {
	format: typeof TRANSFER_FORMAT;
	version: number;
	site: Omit<SiteIdentity, PerSite>;
	collections: Record<string, { type?: string; noindex?: boolean }>;
	robots: SeoConfig["robots"];
	breadcrumbs: boolean;
}

/**
 * The settings as copied. Every content type with pages is written out with the type it has and
 * whether it is hidden, guessed ones too, so the other site ends up the same; `slugs` defaults
 * to the content types that have a rule.
 */
function toTransfer(config: SeoConfig, slugs = Object.keys(config.collections)): Transfer {
	const collections: Transfer["collections"] = {};
	for (const slug of slugs) {
		const rule = config.collections[slug];
		// The "this is intended" confirmation stays on the site it was given on.
		collections[slug] = {
			type: rule?.type ?? defaultTypeForCollection(slug),
			noindex: rule?.noindex === true,
		};
	}
	return {
		format: TRANSFER_FORMAT,
		version: TRANSFER_VERSION,
		site: sharedSite(config.site),
		collections,
		robots: config.robots,
		breadcrumbs: config.breadcrumbs,
	};
}

/** The text shown for copying: the settings, with every content type of this site that has pages. */
export function exportSettings(config: SeoConfig, collections: Array<{ slug: string }>): string {
	return JSON.stringify(
		toTransfer(
			config,
			collections.map((collection) => collection.slug),
		),
		null,
		2,
	);
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

/** The site's kind as the "This site is for" question words it. */
function kindLabel(type: string): string {
	if (type === "Organization") return "A company or organisation";
	if (type === "Person") return "A person";
	return "A local business customers visit (shop, cafe, clinic)";
}

/**
 * Read the pasted identity through the same checks and changes as the forms that set it, so a
 * paste cannot store what they refuse or keep what they would change. Returns the identity
 * ready for the normaliser, or why it was refused.
 */
function readSite(
	raw: Record<string, unknown>,
	siteUrl: string,
): { site: Record<string, unknown> } | { error: string } {
	const type = raw.type ?? "Organization";
	const local = BUSINESS_GROUPS.some((group) => group.value === type);
	if (type !== "Organization" && type !== "Person" && !local) {
		return { error: "Couldn't read the kind of site in these settings." };
	}
	const site: Record<string, unknown> = { ...raw, type };

	// The Logo form: a path on this site is stored as a full address.
	site.logo = undefined;
	if (raw.logo !== undefined && raw.logo !== "") {
		const read = typeof raw.logo === "string" ? readLogo(raw.logo.trim(), siteUrl) : undefined;
		if (!read || "error" in read) {
			return {
				error:
					"Couldn't read the logo link in these settings: it must be a web address starting with https://",
			};
		}
		site.logo = read.logo;
	}

	// The Profiles form: empty lines skipped, "instagram.com/name" made a full link.
	if (raw.sameAs !== undefined) {
		const links: unknown[] = Array.isArray(raw.sameAs) ? raw.sameAs : [null];
		const sameAs: string[] = [];
		for (const link of links) {
			if (typeof link === "string" && link.trim() === "") continue;
			const href = typeof link === "string" ? readProfileLink(link.trim()) : null;
			if (!href) {
				return {
					error: "Couldn't read a profile link in these settings: each must be a web address.",
				};
			}
			sameAs.push(href);
		}
		site.sameAs = sameAs;
	}

	// The Opening hours form: each day read as typed, at most two ranges a day. Hours are only
	// kept for a local business, as saving who the site is for drops them for any other kind.
	if (!local) {
		site.openingHours = [];
	} else if (raw.openingHours !== undefined) {
		const rows: unknown[] = Array.isArray(raw.openingHours) ? raw.openingHours : [null];
		const shaped = rows.every(
			(row) =>
				isRecord(row) &&
				Array.isArray(row.days) &&
				row.days.length > 0 &&
				row.days.every((day) => (DAYS as readonly unknown[]).includes(day)) &&
				typeof row.opens === "string" &&
				typeof row.closes === "string",
		);
		const read = shaped
			? readWeekHours((day) => formatDayHours(day, rows as OpeningHours[]))
			: undefined;
		if (!read || "day" in read) {
			return { error: "Couldn't read the opening hours in these settings." };
		}
		site.openingHours = read.hours;
	}

	// The Address and phone form: a price range from its list, the country code in capitals.
	if (raw.priceRange !== undefined && !PRICE_RANGES.includes(String(raw.priceRange))) {
		return { error: "Couldn't read the price range in these settings." };
	}
	if (isRecord(raw.address) && typeof raw.address.addressCountry === "string") {
		site.address = { ...raw.address, addressCountry: raw.address.addressCountry.toUpperCase() };
	}

	// The Company details form: a founding year, or a full date.
	if (raw.foundingDate !== undefined && raw.foundingDate !== "") {
		if (typeof raw.foundingDate !== "string" || !isFoundingDate(raw.foundingDate.trim())) {
			return {
				error:
					"Couldn't read the founding date in these settings: write it as a year, like 2012, or as 2012-05-01.",
			};
		}
	}
	return { site };
}

/**
 * How much of a page search engines may show, as the settings form offers it: no text, a short
 * line (160 characters) or no limit. Video previews are limited the same way: 160 seconds or none.
 */
function readRobots(raw: unknown): SeoConfig["robots"] {
	const { robots } = normalizeConfig({ robots: raw });
	return {
		...robots,
		maxSnippet: !robots.nosnippet && robots.maxSnippet >= 0 ? 160 : -1,
		maxVideoPreview: robots.maxVideoPreview >= 0 ? 160 : -1,
	};
}

const IMAGE_PREVIEW: Record<SeoConfig["robots"]["maxImagePreview"], string> = {
	large: "Large",
	standard: "Small",
	none: "No image",
};

/** Each setting in words, as the forms show it, for showing what an import changes. */
function described(
	config: SeoConfig,
	collections: Array<{ slug: string; label: string }>,
	siteName: string,
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
	const business = BUSINESS_GROUPS.find((group) => group.value === site.type)?.label;
	const { robots } = config;
	const rows: Array<[string, string]> = [
		["This site is for", kindLabel(site.type)],
		["Kind of business", business ?? none],
		["Name", site.name ?? siteName],
		["Also known as", site.alternateName ?? none],
		["Registered legal name", site.legalName ?? none],
		["What you do", site.description ?? none],
		["Logo", site.logo ?? none],
		["Profiles elsewhere", site.sameAs.join(", ") || none],
		["Email", site.email ?? none],
		["Phone", site.telephone ?? none],
		["Address", address || none],
		["Opening hours", hours || none],
		["Price range", site.priceRange ?? "Not shown"],
		["Areas served", site.areaServed.join(", ") || none],
		["Founded", site.foundingDate ?? none],
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
			robots.nosnippet
				? "No text"
				: robots.maxSnippet >= 0
					? "A short line"
					: "As much as Google likes",
		],
		["Picture size in search results", IMAGE_PREVIEW[robots.maxImagePreview]],
		[
			"Video previews in search results",
			robots.maxVideoPreview >= 0 ? "Up to 160 seconds" : "As long as Google likes",
		],
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
	siteName = "",
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
	const read = readSite(raw.site, siteUrl);
	if ("error" in read) return read;

	// Read through the same normaliser as stored settings, so the result has the stored shape.
	const pasted = normalizeConfig({
		site: read.site,
		collections: raw.collections,
		breadcrumbs: raw.breadcrumbs,
	});
	const robots = readRobots(raw.robots);
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
		const before = current.collections[slug];
		const hidden = rule.noindex === true;
		if (hidden && !before?.noindex) hides.push(label);
		// Newly hiding needs this site's own "This is intended", so the warning shows here too; a
		// content type this site already hid keeps the confirmation it was given.
		merged[slug] = {
			type: rule.type,
			noindex: hidden,
			...(hidden && before?.noindex && before.hiddenOk ? { hiddenOk: true } : {}),
		};
	}
	const config: SeoConfig = {
		...current,
		site: {
			...sharedSite(pasted.site),
			...Object.fromEntries(PER_SITE.map((key) => [key, current.site[key]])),
		},
		collections: merged,
		robots,
		breadcrumbs: pasted.breadcrumbs,
		// The question of who the site is for is answered by the paste.
		steps: { ...current.steps, identity: true },
	};
	const before = new Map(described(current, collections, siteName));
	const changes = described(config, collections, siteName)
		.filter(([what, after]) => before.get(what) !== after)
		.map(([what, after]) => ({ what, now: before.get(what) ?? "", after }));
	const transfer = toTransfer({ ...pasted, robots });
	return { config, transfer, changes, leftOut, hides };
}
