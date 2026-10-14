// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PublicPageContext } from "emdash";

import {
	ARTICLE_TYPES,
	defaultTypeForCollection,
	type PageSchemaType,
	type SeoConfig,
	type SiteIdentity,
} from "./config.js";
import { findImageSize } from "./images.js";
import type { EntryRecord } from "./record.js";
import { parseUrl } from "./url.js";

export type SchemaNode = Record<string, unknown>;

export interface GraphInput {
	page: PublicPageContext;
	config: SeoConfig;
	/** Precomputed entry data; absent on custom pages and before the first build. */
	record: EntryRecord | null;
	/** The page's robots tag says noindex: only the site-level nodes are emitted. */
	noindex?: boolean;
	site: {
		name: string;
		url: string;
		locale: string;
		trailingSlash?: "always" | "never" | "ignore";
	};
}

// Google truncates Article headlines beyond this length.
const HEADLINE_MAX = 110;

function ref(id: string): SchemaNode {
	return { "@id": id };
}

/** Drop undefined, null, empty strings and empty arrays so the output stays small. */
function compact(node: SchemaNode): SchemaNode {
	const result: SchemaNode = {};
	for (const [key, value] of Object.entries(node)) {
		if (value === undefined || value === null || value === "") continue;
		if (Array.isArray(value) && value.length === 0) continue;
		result[key] = value;
	}
	return result;
}

function absolute(url: string, base: string): string {
	return parseUrl(url, base)?.href ?? url;
}

/** Site origin without a trailing slash. */
export function resolveSiteUrl(page: PublicPageContext, siteUrl: string): string {
	const candidate = page.siteUrl || siteUrl || (parseUrl(page.url)?.origin ?? "");
	return candidate.replace(/\/+$/, "");
}

/** The page's own URL: the canonical when set, otherwise the URL without query or hash. */
export function resolvePageUrl(page: PublicPageContext, siteUrl: string): string {
	if (page.canonical) return absolute(page.canonical, `${siteUrl}/`);
	const url = parseUrl(page.url, `${siteUrl}/`);
	if (!url) return page.url;
	url.search = "";
	url.hash = "";
	return url.href;
}

function isHome(page: PublicPageContext): boolean {
	return page.path === "/" || page.path === "";
}

function isArticleType(type: string): boolean {
	return (ARTICLE_TYPES as readonly string[]).includes(type);
}

/**
 * The entry's own type first, then the collection's rule, then a guess from
 * the collection's name, then what the theme said.
 */
export function resolvePageType(
	page: PublicPageContext,
	config: SeoConfig,
	record: EntryRecord | null,
): PageSchemaType {
	const rule = page.content ? config.collections[page.content.collection] : undefined;
	if (record?.type) return record.type;
	if (rule?.type) return rule.type;
	const guessed = page.content ? defaultTypeForCollection(page.content.collection) : "WebPage";
	if (guessed !== "WebPage") return guessed;
	return page.pageType === "article" ? "BlogPosting" : "WebPage";
}

function siteNode(identity: SiteIdentity, name: string, siteUrl: string, id: string): SchemaNode {
	const logoId = `${siteUrl}/#logo`;
	const isPerson = identity.type === "Person";
	// Google requires an address on a local business; without one the site is
	// described as a plain organisation rather than with invalid markup.
	const isLocal = !isPerson && identity.type !== "Organization";
	const type = isLocal && identity.address === undefined ? "Organization" : identity.type;
	const hasLocalDetails =
		!isPerson &&
		(identity.address !== undefined ||
			identity.geo !== undefined ||
			identity.openingHours.length > 0);

	return compact({
		"@type": type,
		"@id": id,
		name,
		alternateName: identity.alternateName,
		legalName: isPerson ? undefined : identity.legalName,
		description: identity.description,
		url: `${siteUrl}/`,
		// Organization uses `logo`; a Person has no logo, only an image.
		logo:
			identity.logo && !isPerson
				? {
						"@type": "ImageObject",
						"@id": logoId,
						url: identity.logo,
						contentUrl: identity.logo,
						caption: name,
					}
				: undefined,
		image: identity.logo ? (isPerson ? identity.logo : ref(logoId)) : undefined,
		sameAs: identity.sameAs,
		email: identity.email,
		telephone: identity.telephone,
		address: identity.address ? { "@type": "PostalAddress", ...identity.address } : undefined,
		geo: identity.geo && !isPerson ? { "@type": "GeoCoordinates", ...identity.geo } : undefined,
		openingHoursSpecification: hasLocalDetails
			? identity.openingHours.map((hours) => ({
					"@type": "OpeningHoursSpecification",
					dayOfWeek: hours.days,
					opens: hours.opens,
					closes: hours.closes,
				}))
			: undefined,
		priceRange: isPerson ? undefined : identity.priceRange,
		areaServed: isPerson ? undefined : identity.areaServed,
		foundingDate: isPerson ? undefined : identity.foundingDate,
		vatID: isPerson ? undefined : identity.vatID,
		taxID: isPerson ? undefined : identity.taxID,
		numberOfEmployees:
			!isPerson && identity.numberOfEmployees
				? { "@type": "QuantitativeValue", value: identity.numberOfEmployees }
				: undefined,
	});
}

function humanize(segment: string): string {
	let decoded = segment;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		// Keep the raw segment when it is not valid percent-encoding.
	}
	const words = decoded.replace(/[-_]+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Crumb {
	name: string;
	url: string;
}

/**
 * The theme's trail when it passes one (an empty array means "no breadcrumbs
 * here"); otherwise Home plus one crumb per URL segment.
 */
export function resolveBreadcrumbs(input: GraphInput, siteUrl: string, pageName: string): Crumb[] {
	const { page, config, site } = input;
	if (page.breadcrumbs) {
		return page.breadcrumbs.map((crumb) => ({
			name: crumb.name,
			url: absolute(crumb.url, `${siteUrl}/`),
		}));
	}
	if (!config.breadcrumbs || isHome(page)) return [];

	const segments = page.path.split("/").filter((segment) => segment !== "");
	if (segments.length === 0) return [];

	const slash = site.trailingSlash === "always" ? "/" : "";
	const crumbs: Crumb[] = [{ name: "Home", url: `${siteUrl}/` }];
	let prefix = "";
	segments.forEach((segment, index) => {
		prefix += `/${segment}`;
		const last = index === segments.length - 1;
		crumbs.push({
			name: last ? pageName : humanize(segment),
			url: `${siteUrl}${prefix}${slash}`,
		});
	});
	return crumbs;
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Add the nodes from an entry's JSON-LD field to the page's graph, and return
 * the `@id` of the first one that has an id, for the page's `mainEntity`.
 *
 * A node whose `@id` is already in the graph is skipped: the nodes built here
 * are linked to each other, and replacing one (say the WebPage) would cut
 * those links. To describe the page differently, give the node its own id.
 */
function appendCustom(
	nodes: SchemaNode[],
	custom: SchemaNode[],
	taken: Set<string>,
): string | undefined {
	let first: string | undefined;
	for (const { "@context": _context, ...node } of custom) {
		const id = typeof node["@id"] === "string" ? node["@id"] : undefined;
		if (id !== undefined) {
			if (taken.has(id)) continue;
			taken.add(id);
			first ??= id;
		}
		nodes.push(node);
	}
	return first;
}

/**
 * Build the linked schema graph for one page. Every node carries an `@id`
 * and points at its neighbours, so a consumer reads one connected graph:
 * site representation ← WebSite ← WebPage ← Article, plus breadcrumbs, the
 * primary image and any nodes from the entry's JSON-LD field.
 *
 * A page kept out of search (noindex) gets the site-level nodes only: nothing
 * describes a page that search engines are told to leave out.
 */
export function buildGraph(input: GraphInput): SchemaNode[] {
	const { page, config, record, site } = input;
	const siteUrl = resolveSiteUrl(page, site.url);
	const pageUrl = resolvePageUrl(page, siteUrl);
	const language = page.locale ?? site.locale;
	const siteName = config.site.name ?? page.siteName ?? site.name;
	const pageName = page.pageTitle ?? page.title ?? siteName;

	const isPerson = config.site.type === "Person";
	const siteId = `${siteUrl}/#${isPerson ? "person" : "organization"}`;
	const websiteId = `${siteUrl}/#website`;
	const webpageId = pageUrl;
	const breadcrumbId = `${pageUrl}#breadcrumb`;

	const pageType = resolvePageType(page, config, record);
	const article = isArticleType(pageType);
	const service = pageType === "Service";
	const profile = pageType === "ProfilePage";
	const serviceId = `${pageUrl}#service`;
	const profileId = `${pageUrl}#person`;
	const published = record?.publishedAt ?? page.articleMeta?.publishedTime ?? undefined;
	const modified = record?.updatedAt ?? page.articleMeta?.modifiedTime ?? undefined;
	const image = page.image ? absolute(page.image, `${siteUrl}/`) : undefined;
	// The image's own address is its id, so every page that uses the same
	// picture points at the same node.
	const imageId = image ?? "";
	const crumbs = resolveBreadcrumbs(input, siteUrl, pageName);

	const nodes: SchemaNode[] = [
		siteNode(config.site, siteName, siteUrl, siteId),
		compact({
			"@type": "WebSite",
			"@id": websiteId,
			url: `${siteUrl}/`,
			name: siteName,
			alternateName: config.site.alternateName,
			description: config.site.description,
			publisher: ref(siteId),
			inLanguage: language,
		}),
	];
	if (input.noindex) return nodes;

	const webpage = compact({
		"@type": article || service ? "WebPage" : pageType,
		"@id": webpageId,
		url: pageUrl,
		name: pageName,
		description: page.description,
		isPartOf: ref(websiteId),
		about: isHome(page) ? ref(siteId) : undefined,
		primaryImageOfPage: image ? ref(imageId) : undefined,
		image: image ? ref(imageId) : undefined,
		breadcrumb: crumbs.length > 0 ? ref(breadcrumbId) : undefined,
		mainEntity: service ? ref(serviceId) : profile ? ref(profileId) : undefined,
		datePublished: published,
		dateModified: modified,
		inLanguage: language,
	});
	nodes.push(webpage);

	if (article) {
		const authors = (record?.authors ?? []).map((author) =>
			compact({ "@type": "Person", name: author.name, url: author.url }),
		);
		const fallbackAuthor = page.articleMeta?.author
			? [{ "@type": "Person", name: page.articleMeta.author }]
			: [ref(siteId)];
		nodes.push(
			compact({
				"@type": pageType,
				"@id": `${pageUrl}#article`,
				isPartOf: ref(webpageId),
				mainEntityOfPage: ref(webpageId),
				headline: truncate(pageName, HEADLINE_MAX),
				description: page.description,
				image: image ? ref(imageId) : undefined,
				datePublished: published,
				dateModified: modified,
				author: authors.length > 0 ? authors : fallbackAuthor,
				publisher: ref(siteId),
				inLanguage: language,
			}),
		);
	}

	if (service) {
		nodes.push(
			compact({
				"@type": "Service",
				"@id": serviceId,
				name: pageName,
				description: page.description,
				url: pageUrl,
				image: image ? ref(imageId) : undefined,
				provider: ref(siteId),
				areaServed: config.site.areaServed,
			}),
		);
	}

	if (profile) {
		// A profile page is about one person, named by the page.
		nodes.push(
			compact({
				"@type": "Person",
				"@id": profileId,
				name: pageName,
				description: page.description,
				url: pageUrl,
				image: image ? ref(imageId) : undefined,
				worksFor: isPerson ? undefined : ref(siteId),
			}),
		);
	}

	if (image) {
		nodes.push({
			"@type": "ImageObject",
			"@id": imageId,
			url: image,
			contentUrl: image,
			// Only when the picture is certainly one of the entry's own images.
			...findImageSize(record?.images, image, siteUrl),
		});
	}

	if (crumbs.length > 0) {
		nodes.push({
			"@type": "BreadcrumbList",
			"@id": breadcrumbId,
			itemListElement: crumbs.map((crumb, index) =>
				compact({
					"@type": "ListItem",
					position: index + 1,
					name: crumb.name,
					// Google reads the last crumb as the current page; it needs no link.
					item: index === crumbs.length - 1 ? undefined : crumb.url,
				}),
			),
		});
	}

	const taken = new Set<string>([`${siteUrl}/#logo`]);
	for (const node of nodes) {
		if (typeof node["@id"] === "string") taken.add(node["@id"]);
	}
	const customId = appendCustom(nodes, record?.custom ?? [], taken);
	// The page type's own main entity (the Service, the Person of a profile page,
	// or the Article, which names this page as its main entity) stays: the type
	// is a deliberate choice and Google reads those links. On any other page the
	// first custom node with an id is what the page is about.
	if (customId !== undefined && !article && webpage.mainEntity === undefined) {
		webpage.mainEntity = ref(customId);
	}

	return nodes;
}
