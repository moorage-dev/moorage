// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import { parseUrl } from "./url.js";

/** KV key holding the site-wide configuration. */
export const CONFIG_KEY = "config";

/** Page-level schema types a collection can map to. */
export const WEB_PAGE_TYPES = [
	"WebPage",
	"AboutPage",
	"ContactPage",
	"CollectionPage",
	"ProfilePage",
] as const;
export const ARTICLE_TYPES = ["Article", "BlogPosting", "NewsArticle"] as const;
/** Types that describe the thing a page is about, emitted next to a plain WebPage. */
export const ENTITY_TYPES = ["Service"] as const;

export type WebPageType = (typeof WEB_PAGE_TYPES)[number];
export type ArticleType = (typeof ARTICLE_TYPES)[number];
export type EntityType = (typeof ENTITY_TYPES)[number];
export type PageSchemaType = WebPageType | ArticleType | EntityType;

/**
 * What a collection is, guessed from its slug, so that most sites never need
 * to open the Page types tab.
 */
export function defaultTypeForCollection(slug: string): PageSchemaType {
	const name = slug.toLowerCase();
	if (["posts", "post", "blog"].includes(name)) return "BlogPosting";
	if (["news", "articles", "article"].includes(name)) return "Article";
	if (["services", "service"].includes(name)) return "Service";
	if (["team", "people", "staff", "authors"].includes(name)) return "ProfilePage";
	return "WebPage";
}

export interface PostalAddress {
	streetAddress?: string;
	addressLocality?: string;
	addressRegion?: string;
	postalCode?: string;
	addressCountry?: string;
}

export interface OpeningHours {
	/** schema.org day names, e.g. "Monday". */
	days: string[];
	/** 24h "HH:MM". */
	opens: string;
	closes: string;
}

/**
 * Who the site represents. `type` is "Organization", "Person", or any
 * schema.org LocalBusiness subtype ("LocalBusiness", "Dentist", "Restaurant").
 */
export interface SiteIdentity {
	type: string;
	name?: string;
	alternateName?: string;
	legalName?: string;
	description?: string;
	/** Absolute URL; plugin settings have no media picker. */
	logo?: string;
	sameAs: string[];
	email?: string;
	telephone?: string;
	address?: PostalAddress;
	geo?: { latitude: number; longitude: number };
	openingHours: OpeningHours[];
	priceRange?: string;
	/** Places served, for a business with no public address. */
	areaServed: string[];
	// Optional company facts Google lists for organisations.
	foundingDate?: string;
	vatID?: string;
	taxID?: string;
	numberOfEmployees?: number;
}

export interface CollectionRule {
	type?: PageSchemaType;
	noindex?: boolean;
	/** An admin confirmed that hiding this collection from search is intended. */
	hiddenOk?: boolean;
}

/** Setup steps an admin has completed on the SEO page. */
export interface SetupSteps {
	identity: boolean;
	types: boolean;
}

export interface RobotsDefaults {
	/** -1 means no limit. */
	maxSnippet: number;
	maxImagePreview: "none" | "standard" | "large";
	/** -1 means no limit. */
	maxVideoPreview: number;
	nosnippet: boolean;
}

export interface SeoConfig {
	site: SiteIdentity;
	collections: Record<string, CollectionRule>;
	robots: RobotsDefaults;
	/** Entry field whose JSON value is emitted as extra schema nodes. */
	jsonLdField: string;
	/** Derive a breadcrumb trail from the URL when the theme passes none. */
	breadcrumbs: boolean;
	steps: SetupSteps;
}

export const DEFAULT_CONFIG: SeoConfig = {
	site: { type: "Organization", sameAs: [], openingHours: [], areaServed: [] },
	collections: {},
	robots: { maxSnippet: -1, maxImagePreview: "large", maxVideoPreview: -1, nosnippet: false },
	jsonLdField: "json_ld",
	breadcrumbs: true,
	steps: { identity: false, types: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function httpUrl(value: unknown): string | undefined {
	const candidate = text(value);
	const protocol = candidate ? parseUrl(candidate)?.protocol : undefined;
	return protocol === "https:" || protocol === "http:" ? candidate : undefined;
}

function integer(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= -1 ? value : fallback;
}

function pageSchemaType(value: unknown): PageSchemaType | undefined {
	const all: readonly string[] = [...WEB_PAGE_TYPES, ...ARTICLE_TYPES, ...ENTITY_TYPES];
	return typeof value === "string" && all.includes(value) ? (value as PageSchemaType) : undefined;
}

function address(value: unknown): PostalAddress | undefined {
	if (!isRecord(value)) return undefined;
	const result: PostalAddress = {};
	for (const key of [
		"streetAddress",
		"addressLocality",
		"addressRegion",
		"postalCode",
		"addressCountry",
	] as const) {
		const part = text(value[key]);
		if (part) result[key] = part;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function openingHours(value: unknown): OpeningHours[] {
	if (!Array.isArray(value)) return [];
	const result: OpeningHours[] = [];
	for (const row of value) {
		if (!isRecord(row) || !Array.isArray(row.days)) continue;
		const days = row.days.filter((day): day is string => typeof day === "string" && day !== "");
		const opens = text(row.opens);
		const closes = text(row.closes);
		if (days.length > 0 && opens && closes) result.push({ days, opens, closes });
	}
	return result;
}

function siteIdentity(value: unknown): SiteIdentity {
	if (!isRecord(value)) return { ...DEFAULT_CONFIG.site };
	const geo = isRecord(value.geo) ? value.geo : undefined;
	const latitude = geo?.latitude;
	const longitude = geo?.longitude;
	return {
		type: text(value.type) ?? "Organization",
		name: text(value.name),
		alternateName: text(value.alternateName),
		legalName: text(value.legalName),
		description: text(value.description),
		logo: httpUrl(value.logo),
		sameAs: Array.isArray(value.sameAs)
			? value.sameAs.map(httpUrl).filter((url): url is string => url !== undefined)
			: [],
		email: text(value.email),
		telephone: text(value.telephone),
		address: address(value.address),
		geo:
			typeof latitude === "number" && typeof longitude === "number"
				? { latitude, longitude }
				: undefined,
		openingHours: openingHours(value.openingHours),
		priceRange: text(value.priceRange),
		areaServed: Array.isArray(value.areaServed)
			? value.areaServed.map(text).filter((area): area is string => area !== undefined)
			: [],
		foundingDate: text(value.foundingDate),
		vatID: text(value.vatID),
		taxID: text(value.taxID),
		numberOfEmployees:
			typeof value.numberOfEmployees === "number" && value.numberOfEmployees > 0
				? Math.round(value.numberOfEmployees)
				: undefined,
	};
}

/**
 * Turn whatever is stored in KV into a complete config. Stored values come
 * from an admin form and from older plugin versions, so nothing is trusted.
 */
export function normalizeConfig(raw: unknown): SeoConfig {
	if (!isRecord(raw)) return DEFAULT_CONFIG;

	const collections: Record<string, CollectionRule> = {};
	if (isRecord(raw.collections)) {
		for (const [slug, rule] of Object.entries(raw.collections)) {
			if (!isRecord(rule)) continue;
			collections[slug] = {
				type: pageSchemaType(rule.type),
				noindex: rule.noindex === true,
				...(rule.hiddenOk === true ? { hiddenOk: true } : {}),
			};
		}
	}

	const robots = isRecord(raw.robots) ? raw.robots : {};
	const preview = robots.maxImagePreview;

	return {
		site: siteIdentity(raw.site),
		collections,
		robots: {
			maxSnippet: integer(robots.maxSnippet, DEFAULT_CONFIG.robots.maxSnippet),
			maxImagePreview:
				preview === "none" || preview === "standard" || preview === "large"
					? preview
					: DEFAULT_CONFIG.robots.maxImagePreview,
			maxVideoPreview: integer(robots.maxVideoPreview, DEFAULT_CONFIG.robots.maxVideoPreview),
			nosnippet: robots.nosnippet === true,
		},
		jsonLdField: text(raw.jsonLdField) ?? DEFAULT_CONFIG.jsonLdField,
		breadcrumbs: raw.breadcrumbs !== false,
		steps: {
			identity: isRecord(raw.steps) && raw.steps.identity === true,
			types: isRecord(raw.steps) && raw.steps.types === true,
		},
	};
}
