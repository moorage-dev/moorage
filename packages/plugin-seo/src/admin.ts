// Copyright 2026 Moorage. Licensed under FSL-1.1-MIT; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { CollectionSchemaInfo, PluginContext } from "emdash";

import {
	CONFIG_KEY,
	defaultTypeForCollection,
	normalizeConfig,
	type PageSchemaType,
	type SeoConfig,
	type SiteIdentity,
} from "./config.js";
import { DAYS, formatDayHours, parseDayHours } from "./hours.js";
import { PAGE_TYPES, typeLabel } from "./page-types.js";
import {
	addMore,
	checkList,
	exportText,
	IMPORT_KEY,
	loadImport,
	plural,
	listRedirects,
	redirectsTab,
	addOne,
	updateOne,
	removeOne,
	removeBatch,
	type RedirectRow,
	stopImport,
	type ImportState,
} from "./redirects-admin.js";
import {
	FIX_ROWS,
	readStats,
	SCAN_KEY,
	scanStep,
	startScan,
	STATS_KEY,
	type ScanState,
	type Stats,
} from "./scan.js";
import { parseUrl } from "./url.js";

// EmDash role levels: an Editor can open the page, only an Admin can change settings.
const ADMIN_ROLE = 50;

// Three tabs: what needs attention, the redirects task, and everything set once.
const TAB = { overview: 0, redirects: 1, identity: 2, types: 2 } as const;

/** Plain business groups mapped to the schema.org type each one emits. */
const BUSINESS_GROUPS: Array<{ value: string; label: string }> = [
	{ value: "FoodEstablishment", label: "Restaurant, cafe or bakery" },
	{ value: "Store", label: "Shop" },
	{ value: "MedicalBusiness", label: "Health and medical" },
	{ value: "Dentist", label: "Dentist" },
	{ value: "LegalService", label: "Legal" },
	{ value: "FinancialService", label: "Financial" },
	{ value: "HomeAndConstructionBusiness", label: "Home services (plumber, electrician, builder)" },
	{ value: "HealthAndBeautyBusiness", label: "Beauty and hair" },
	{ value: "SportsActivityLocation", label: "Fitness" },
	{ value: "LodgingBusiness", label: "Hotel or lodging" },
	{ value: "AutomotiveBusiness", label: "Automotive" },
	{ value: "ProfessionalService", label: "Professional service" },
	{ value: "LocalBusiness", label: "Other" },
];

const PRICE_RANGES = ["", "$", "$$", "$$$", "$$$$"];

type SiteKind = "organization" | "person" | "local";

/** The networks asked for by name; anything else goes in "Other profiles". */
const NETWORKS = [
	{ id: "facebook", label: "Facebook", hosts: ["www.facebook.com", "facebook.com", "fb.com"] },
	{ id: "instagram", label: "Instagram", hosts: ["www.instagram.com", "instagram.com"] },
	{ id: "linkedin", label: "LinkedIn", hosts: ["www.linkedin.com", "linkedin.com"] },
	{
		id: "x",
		label: "X (Twitter)",
		hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
	},
	{ id: "youtube", label: "YouTube", hosts: ["www.youtube.com", "youtube.com"] },
];

function splitProfiles(links: string[]): { named: Record<string, string>; other: string[] } {
	const named: Record<string, string> = {};
	const other: string[] = [];
	for (const link of links) {
		const host = parseUrl(link)?.host ?? "";
		const network = NETWORKS.find((candidate) => candidate.hosts.includes(host));
		if (network && !(network.id in named)) named[network.id] = link;
		else other.push(link);
	}
	return { named, other };
}

/** A section title that says what is already filled in, so nothing has to be opened to check. */
function summary(title: string, parts: Array<string | undefined>): string {
	const filled = parts.filter((part): part is string => !!part);
	return filled.length > 0 ? `${title}: ${filled.join(", ")}` : `${title} (not added yet)`;
}

function siteKind(identity: SiteIdentity): SiteKind {
	if (identity.type === "Person") return "person";
	return identity.type === "Organization" ? "organization" : "local";
}

/**
 * An absolute link into EmDash's own admin, or undefined when the site's
 * address is not known. A freshly created site can report an empty address,
 * and EmDash rejects the whole page if any link on it is not absolute.
 */
function adminUrl(siteUrl: string, path: string): string | undefined {
	const base = parseUrl(siteUrl);
	if (!base || (base.protocol !== "https:" && base.protocol !== "http:")) return undefined;
	return `${base.origin}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(values: Record<string, unknown>, key: string, fallback = ""): string {
	const value = values[key];
	return typeof value === "string" ? value.trim() : fallback;
}

function bool(values: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = values[key];
	return typeof value === "boolean" ? value : fallback;
}

function lines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

interface PageState {
	tab: number;
	/** The redirect whose edit form is open on the Redirects tab. */
	editing?: RedirectRow;
	/** Keep the add-redirect form open, after a rejected entry. */
	adding?: boolean;
	/** The site's redirects as text, when the admin asked to see them. */
	exported?: string;
	toast?: BlockResponse["toast"];
}

interface AdminData {
	config: SeoConfig;
	collections: CollectionSchemaInfo[];
	redirects: ImportState | null;
	/** The newest redirects, for the Redirects tab. */
	redirectRows: RedirectRow[];
	moreRedirects: boolean;
	scan: ScanState | null;
	/** Page counts and the first pages to fix; null before any page was checked. */
	stats: Stats | null;
}

async function loadData(ctx: PluginContext): Promise<AdminData> {
	// One read for everything the plugin keeps in KV: requests are limited to a
	// handful of operations, and every tab is rendered on every response.
	const [stored, collections, existing] = await Promise.all([
		ctx.kv.list(),
		ctx.schema?.listCollections() ?? [],
		listRedirects(ctx),
	]);
	const kv = new Map(stored.map((item) => [item.key, item.value]));
	const redirects = kv.get(IMPORT_KEY) as ImportState | undefined;
	return {
		config: normalizeConfig(kv.get(CONFIG_KEY)),
		// Only collections with public pages have anything to describe to search engines.
		collections: collections.filter((collection) => collection.routable && !collection.hidden),
		redirects: redirects && Array.isArray(redirects.rows) ? redirects : null,
		redirectRows: existing.rows,
		moreRedirects: existing.more,
		scan: (kv.get(SCAN_KEY) as ScanState | undefined) ?? null,
		stats: (kv.get(STATS_KEY) as Stats | undefined) ?? null,
	};
}

/** Fresh page counts, stored so that other actions can show them without recounting. */
async function refreshStats(ctx: PluginContext, data: AdminData): Promise<AdminData> {
	const stats = await readStats(ctx);
	if (JSON.stringify(stats) !== JSON.stringify(data.stats)) await ctx.kv.set(STATS_KEY, stats);
	return { ...data, stats };
}

/** Current page counts: the stored recount, or the totals of the check that just finished. */
function currentStats(data: AdminData): Stats | null {
	return data.stats ?? (data.scan?.status === "done" ? data.scan.tally : null);
}

function pageStats(data: AdminData): Block[] {
	const { scan } = data;
	const stats = currentStats(data);
	// A partial count would look like the whole site, so nothing is shown
	// until every page has been checked once.
	if (!scan || scan.status === "running") {
		return [
			{
				type: "banner",
				title: "Checking your pages",
				description: scan
					? `${scan.checked} checked so far. The rest are checked in the background.`
					: "This starts by itself and takes about a minute.",
			},
		];
	}
	if (!stats) return [];
	const ready = stats.checked - stats.fix - stats.hidden;
	return [
		{
			type: "stats",
			items: [
				{ label: "Pages checked", value: stats.checked },
				{ label: "Ready", value: ready },
				{ label: "To fix", value: stats.fix },
			],
		},
	];
}

function pagesToFix(data: AdminData): Block[] {
	const { scan } = data;
	const stats = currentStats(data);
	if (!stats || !scan || scan.status === "running") return [];
	const blocks: Block[] = [];
	if (stats.checked === 0) {
		blocks.push({ type: "empty", title: "No published pages yet", size: "sm" });
	} else if (stats.fix === 0) {
		blocks.push({ type: "empty", title: "No pages to fix. Nice work.", size: "sm" });
	} else {
		blocks.push(
			{ type: "header", text: "To fix" },
			{
				type: "table",
				page_action_id: "fix_table",
				columns: [
					{ key: "page", label: "Page" },
					{ key: "missing", label: "What's missing" },
					{ key: "open", label: "", format: "element" },
				],
				rows: stats.rows.map((row) => ({
					page: row.title,
					missing: row.issues.join(" "),
					open: {
						type: "link",
						label: "Open page",
						target: { kind: "content", collection: row.collection, id: row.id },
					},
				})),
			},
		);
		if (stats.more) {
			blocks.push({
				type: "context",
				text: `Showing the first ${FIX_ROWS}. Fix these and the next ones appear.`,
			});
		}
	}
	if (stats.hidden > 0) {
		blocks.push({
			type: "context",
			text: `${stats.hidden} ${stats.hidden === 1 ? "page is" : "pages are"} hidden from search and not counted.`,
		});
	}
	if (scan.finishedAt) {
		blocks.push({
			type: "context",
			text: `Every page is checked again when it is saved. Whole site last checked ${scan.finishedAt.slice(0, 16).replace("T", " ")} UTC.`,
		});
	}
	return blocks;
}

function checkButton(data: AdminData): Block[] {
	if (!data.scan) return [];
	const running = data.scan.status === "running";
	return [
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: running ? "check_more" : "check_pages",
					label: running ? "Update" : "Check all pages again",
				},
			],
		},
	];
}

function hiddenCollections(data: AdminData): CollectionSchemaInfo[] {
	return data.collections.filter((collection) => {
		const rule = data.config.collections[collection.slug];
		return rule?.noindex === true && rule.hiddenOk !== true;
	});
}

function hiddenBanner(data: AdminData, admin: boolean): Block[] {
	const hidden = hiddenCollections(data);
	if (hidden.length === 0) return [];
	const names = hidden.map((collection) => collection.label).join(", ");
	const blocks: Block[] = [
		{
			type: "banner",
			variant: "alert",
			title: "Some pages are hidden from Google",
			description: `Every page in ${names} is hidden from search engines. If that is a leftover from building the site, switch it back on under Settings, Content types.`,
		},
	];
	if (admin) {
		blocks.push({
			type: "actions",
			elements: [{ type: "button", action_id: "hidden_ok", label: "This is intended" }],
		});
	}
	return blocks;
}

/**
 * The one thing worth asking: who the site is for. Everything else has a
 * sensible default. The prompt is two lines so the pages to fix stay in view,
 * and the form opens in place because a button cannot switch tabs.
 */
function setupPrompt(data: AdminData, siteName: string): Block[] {
	const { steps, site } = data.config;
	if (steps.identity) return [];
	const kind = siteKind(site);
	return [
		{
			type: "banner",
			title: "One thing left: tell Google who this site is for",
			description:
				"It takes a minute. Google can then show your name and details beside your pages.",
		},
		{
			type: "accordion",
			label: "Answer now",
			blocks: [
				{
					type: "form",
					block_id: "setup_identity",
					fields: [
						{
							type: "radio",
							action_id: "kind",
							label: "This site is for",
							options: [
								{ label: "A company or organisation", value: "organization" },
								{ label: "A person", value: "person" },
								{ label: "A local business customers visit", value: "local" },
							],
							initial_value: kind,
						},
						{
							type: "select",
							action_id: "business",
							label: "Kind of business",
							options: BUSINESS_GROUPS,
							initial_value: kind === "local" ? site.type : "LocalBusiness",
							condition: { field: "kind", eq: "local" },
						},
						{
							type: "text_input",
							action_id: "name",
							label: "Name",
							placeholder: "Your name or your business's name",
							initial_value: site.name ?? siteName,
						},
						// Google only lists a local business that has an address.
						{
							type: "text_input",
							action_id: "street",
							label: "Street address",
							initial_value: site.address?.streetAddress ?? "",
							condition: { field: "kind", eq: "local" },
						},
						{
							type: "text_input",
							action_id: "town",
							label: "Town or city",
							initial_value: site.address?.addressLocality ?? "",
							condition: { field: "kind", eq: "local" },
						},
					],
					submit: { label: "Save", action_id: "setup_identity" },
				},
				{ type: "context", text: "Logo, phone, opening hours and more are under Settings." },
			],
		},
	];
}

function overviewTab(data: AdminData, siteName: string): Block[] {
	// Results first, then anything alarming, then the one open question, then the work list.
	return [
		...pageStats(data),
		...hiddenBanner(data, true),
		...setupPrompt(data, siteName),
		...pagesToFix(data),
		...checkButton(data),
	];
}

function widget(data: AdminData): BlockResponse {
	const stats = currentStats(data);
	const open: Block = {
		type: "actions",
		elements: [
			{ type: "link", label: "Open SEO", target: { kind: "plugin-page", path: "/overview" } },
		],
	};
	if (!stats || stats.checked === 0) {
		const { steps } = data.config;
		return {
			blocks: [
				{
					type: "section",
					text: steps.identity
						? "Your pages are being checked."
						: "One thing left: tell Google who this site is for.",
				},
				open,
			],
		};
	}
	return {
		blocks: [
			{
				type: "stats",
				items: [
					stats.fix === 0
						? { label: "SEO", value: "All pages ready" }
						: { label: stats.fix === 1 ? "Page to fix" : "Pages to fix", value: stats.fix },
				],
			},
			open,
		],
	};
}

function identityTab(data: AdminData, siteName: string): Block[] {
	const { site } = data.config;
	const kind = siteKind(site);
	const local = kind === "local";
	// Google requires an address on a local business.
	const needsAddress = local && site.address === undefined;

	const blocks: Block[] = [
		{
			type: "context",
			text: "This is what Google can show about you beside your pages. It becomes the site's schema markup (structured data).",
		},
		{
			type: "form",
			block_id: "identity",
			fields: [
				{
					type: "radio",
					action_id: "kind",
					label: "This site is for",
					options: [
						{ label: "A company or organisation", value: "organization" },
						{ label: "A person", value: "person" },
						{ label: "A local business customers visit", value: "local" },
					],
					initial_value: kind,
				},
				{
					type: "select",
					action_id: "business",
					label: "Kind of business",
					options: BUSINESS_GROUPS,
					initial_value: local ? site.type : "LocalBusiness",
					condition: { field: "kind", eq: "local" },
				},
				{
					type: "text_input",
					action_id: "name",
					label: "Name",
					initial_value: site.name ?? siteName,
				},
				{
					type: "text_input",
					action_id: "alternate_name",
					label: "Also known as (a short name or abbreviation, optional)",
					initial_value: site.alternateName ?? "",
				},
				{
					type: "text_input",
					action_id: "description",
					label: "Short description (one or two sentences)",
					multiline: true,
					initial_value: site.description ?? "",
				},
				{
					type: "text_input",
					action_id: "logo_url",
					label:
						"Logo web address (in Media, open your logo and use Copy URL; square, at least 112 pixels wide)",
					placeholder: "https://example.com/logo.png",
					initial_value: site.logo ?? "",
				},
			],
			submit: { label: "Save", action_id: "save_identity" },
		},
		{
			type: "accordion",
			label: summary("Contact and address", [
				site.address?.streetAddress,
				site.address?.addressLocality,
				site.telephone,
				site.email,
			]),
			default_open: needsAddress,
			blocks: [
				{
					type: "context",
					text: needsAddress
						? "Add your address so Google can list you as a local business. Until then you are described as an organisation. Use the same details as your Google Business Profile."
						: "Use the same details as your Google Business Profile. A business with no public address can leave the address empty.",
				},
				{
					type: "form",
					block_id: "contact",
					fields: [
						{
							type: "text_input",
							action_id: "email",
							label: "Email",
							initial_value: site.email ?? "",
						},
						{
							type: "text_input",
							action_id: "telephone",
							label: "Phone",
							initial_value: site.telephone ?? "",
						},
						{
							type: "text_input",
							action_id: "street",
							label: "Street address",
							initial_value: site.address?.streetAddress ?? "",
						},
						{
							type: "text_input",
							action_id: "town",
							label: "Town or city",
							initial_value: site.address?.addressLocality ?? "",
						},
						{
							type: "text_input",
							action_id: "region",
							label: "State or region",
							initial_value: site.address?.addressRegion ?? "",
						},
						{
							type: "text_input",
							action_id: "postcode",
							label: "Postcode",
							initial_value: site.address?.postalCode ?? "",
						},
						{
							type: "text_input",
							action_id: "country",
							label: "Country (two letters, for example GB)",
							initial_value: site.address?.addressCountry ?? "",
						},
						{
							type: "select",
							action_id: "price_range",
							label: "Price range",
							options: PRICE_RANGES.map((range) => ({
								label: range === "" ? "Not shown" : range,
								value: range,
							})),
							initial_value: site.priceRange ?? "",
						},
						{
							type: "text_input",
							action_id: "areas",
							label: "Areas you serve, one per line (for a business that travels to customers)",
							multiline: true,
							placeholder: "Springfield",
							initial_value: site.areaServed.join("\n"),
						},
					],
					submit: { label: "Save", action_id: "save_contact" },
				},
			],
		},
	];

	if (local) {
		blocks.push({
			type: "accordion",
			label: summary(
				"Opening hours",
				DAYS.filter((day) => formatDayHours(day, site.openingHours) !== "").map((day) =>
					day.slice(0, 3),
				),
			),
			blocks: [
				{
					type: "context",
					text: "Type the hours for each day, for example 9:00-17:00. For a break in the day use two ranges: 12:00-14:30, 18:00-22:00. Leave a day empty when closed. One location for now.",
				},
				{
					type: "form",
					block_id: "hours",
					fields: DAYS.map((day) => ({
						type: "text_input" as const,
						action_id: `hours_${day.toLowerCase()}`,
						label: day,
						placeholder: "9:00-17:00",
						initial_value: formatDayHours(day, site.openingHours),
					})),
					submit: { label: "Save", action_id: "save_hours" },
				},
			],
		});
	}

	const profiles = splitProfiles(site.sameAs);
	blocks.push({
		type: "accordion",
		label: summary(
			"Your profiles elsewhere",
			site.sameAs.map((link) => parseUrl(link)?.host.replace(/^www\./, "")),
		),
		blocks: [
			{
				type: "context",
				text: "Links to your pages on other sites help Google connect them to you (sameAs). Paste the full address of each profile you have.",
			},
			{
				type: "form",
				block_id: "profiles",
				fields: [
					...NETWORKS.map((network) => ({
						type: "text_input" as const,
						action_id: `profile_${network.id}`,
						label: network.label,
						placeholder: `https://${network.hosts[0]}/yourname`,
						initial_value: profiles.named[network.id] ?? "",
					})),
					{
						type: "text_input",
						action_id: "profiles",
						label: "Other profiles, one per line",
						multiline: true,
						initial_value: profiles.other.join("\n"),
					},
				],
				submit: { label: "Save", action_id: "save_profiles" },
			},
		],
	});

	if (kind !== "person") {
		blocks.push({
			type: "accordion",
			label: summary("Company details, optional", [
				site.legalName,
				site.foundingDate ? `founded ${site.foundingDate}` : undefined,
				site.vatID ? "VAT" : undefined,
			]),
			blocks: [
				{
					type: "context",
					text: "Extra facts Google can use for a company. Skip anything that does not apply.",
				},
				{
					type: "form",
					block_id: "company",
					fields: [
						{
							type: "text_input",
							action_id: "legal_name",
							label: "Registered legal name",
							initial_value: site.legalName ?? "",
						},
						{
							type: "text_input",
							action_id: "founded",
							label: "Founded (year, or YYYY-MM-DD)",
							placeholder: "2012",
							initial_value: site.foundingDate ?? "",
						},
						{
							type: "text_input",
							action_id: "vat_id",
							label: "VAT number",
							initial_value: site.vatID ?? "",
						},
						{
							type: "text_input",
							action_id: "tax_id",
							label: "Tax ID",
							initial_value: site.taxID ?? "",
						},
						{
							type: "text_input",
							action_id: "employees",
							label: "Number of employees",
							initial_value: site.numberOfEmployees ? String(site.numberOfEmployees) : "",
						},
					],
					submit: { label: "Save", action_id: "save_company" },
				},
			],
		});
	}

	return blocks;
}

function collectionType(data: AdminData, slug: string): PageSchemaType {
	return data.config.collections[slug]?.type ?? defaultTypeForCollection(slug);
}

function typesTab(data: AdminData): Block[] {
	const { config } = data;
	const blocks: Block[] = [
		{
			type: "accordion",
			label: summary(
				"Content types",
				data.collections.map((collection) => {
					const hidden = config.collections[collection.slug]?.noindex === true;
					return `${collection.label} = ${typeLabel(collectionType(data, collection.slug))}${hidden ? " (hidden)" : ""}`;
				}),
			),
			blocks: [
				{
					type: "context",
					text: "Google is told what each kind of content is, so it can show it properly: a blog post with its author and date, a service as a service (schema markup). These were guessed from the names and are usually right. You can also keep a whole kind of content out of search results (noindex). Picking from a menu saves straight away.",
				},
				{
					type: "table",
					page_action_id: "types_table",
					empty_text: "This site has no content types with pages yet.",
					columns: [
						{ key: "name", label: "Content type" },
						{ key: "shown", label: "", format: "element" },
						{ key: "visible", label: "", format: "element" },
					],
					rows: data.collections.map((collection) => {
						const hidden = config.collections[collection.slug]?.noindex === true;
						return {
							name: collection.label,
							shown: {
								type: "menu",
								action_id: "set_type",
								label: `Shown to Google as: ${typeLabel(collectionType(data, collection.slug))}`,
								items: PAGE_TYPES.map(({ value, label }) => ({
									label,
									value: `${collection.slug}|${value}`,
								})),
							},
							visible: {
								type: "menu",
								action_id: "set_visible",
								label: hidden ? "Hidden from search" : "In search results",
								items: [
									{ label: "Show in search results", value: `${collection.slug}|show` },
									{
										label: "Hide from Google and other search engines",
										value: `${collection.slug}|hide`,
									},
								],
							},
						};
					}),
				},
			],
		},
	];

	const snippet = config.robots.nosnippet
		? "none"
		: config.robots.maxSnippet === -1
			? "full"
			: "short";
	blocks.push({
		type: "accordion",
		label: "Advanced",
		blocks: [
			{
				type: "context",
				text: "How much of a page Google may quote (max-snippet, max-image-preview) and the path shown above the title (breadcrumbs).",
			},
			{
				type: "form",
				block_id: "advanced",
				fields: [
					{
						type: "toggle",
						action_id: "breadcrumbs",
						label: "Show the page's path in search results",
						description:
							"Adds breadcrumbs built from the page address when your theme provides none.",
						initial_value: config.breadcrumbs,
					},
					{
						type: "select",
						action_id: "snippet",
						label: "Text Google may quote from a page",
						options: [
							{ label: "As much as it likes (recommended)", value: "full" },
							{ label: "A short line", value: "short" },
							{
								label: "Nothing. Also removes the description from results and AI answers",
								value: "none",
							},
						],
						initial_value: snippet,
					},
					{
						type: "select",
						action_id: "image_preview",
						label: "Image size in search results",
						options: [
							{ label: "Large (recommended)", value: "large" },
							{ label: "Small", value: "standard" },
							{ label: "No image", value: "none" },
						],
						initial_value: config.robots.maxImagePreview,
					},
				],
				submit: { label: "Save", action_id: "save_advanced" },
			},
		],
	});

	return blocks;
}

function render(
	data: AdminData,
	ctx: PluginContext,
	admin: boolean,
	state: PageState,
): BlockResponse {
	const intro: Block[] = [
		{ type: "header", text: "SEO" },
		{ type: "context", text: "How your site appears on Google and other search engines." },
	];

	if (!admin) {
		return {
			blocks: [
				...intro,
				...pageStats(data),
				...hiddenBanner(data, false),
				...pagesToFix(data),
				{ type: "context", text: "Site-wide SEO settings are managed by your site admin." },
			],
		};
	}

	return {
		blocks: [
			...intro,
			{
				type: "tab",
				default_tab: state.tab,
				panels: [
					{ label: "Overview", blocks: overviewTab(data, ctx.site.name) },
					{
						label: "Redirects",
						blocks: redirectsTab({
							state: data.redirects,
							rows: data.redirectRows,
							more: data.moreRedirects,
							editing: state.editing,
							adding: state.adding,
							exported: state.exported,
							managerUrl: adminUrl(ctx.site.url, "/_emdash/admin/redirects"),
						}),
					},
					{
						label: "Settings",
						blocks: [...identityTab(data, ctx.site.name), ...typesTab(data)],
					},
				],
			},
		],
		...(state.toast ? { toast: state.toast } : {}),
	};
}

type Outcome = { config: SeoConfig; state: PageState } | { error: string; state: PageState };

function saveIdentity(data: AdminData, values: Record<string, unknown>, siteUrl: string): Outcome {
	const state: PageState = { tab: TAB.identity };
	const { site } = data.config;
	const kind = str(values, "kind", siteKind(site));
	const business = str(values, "business", "LocalBusiness");
	const type =
		kind === "person"
			? "Person"
			: kind === "local"
				? (BUSINESS_GROUPS.find((group) => group.value === business)?.value ?? "LocalBusiness")
				: "Organization";

	// The media library only gives plugins sign-in-protected image links, which
	// Google could not fetch, so the logo is a public address the admin pastes.
	let logo: string | undefined;
	const pasted = str(values, "logo_url", site.logo ?? "");
	if (pasted !== "") {
		const url = parseUrl(pasted, `${siteUrl.replace(/\/+$/, "")}/`);
		if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
			return {
				error: "Couldn't save. The logo address must be a web address starting with https://",
				state,
			};
		}
		if (url.pathname.includes("/_emdash/api/media/asset/")) {
			return {
				error:
					"That link only works when signed in. In Media, copy the image's public link instead.",
				state,
			};
		}
		logo = url.href;
	}

	const name = str(values, "name");
	return {
		config: {
			...data.config,
			site: {
				...site,
				type,
				name: name === "" ? undefined : name,
				alternateName: str(values, "alternate_name") || undefined,
				description: str(values, "description") || undefined,
				logo,
				// Hours only make sense for a place people visit.
				openingHours: kind === "local" ? site.openingHours : [],
			},
			steps: { ...data.config.steps, identity: true },
		},
		state,
	};
}

function saveContact(data: AdminData, values: Record<string, unknown>): Outcome {
	const { site } = data.config;
	const address = {
		streetAddress: str(values, "street") || undefined,
		addressLocality: str(values, "town") || undefined,
		addressRegion: str(values, "region") || undefined,
		postalCode: str(values, "postcode") || undefined,
		addressCountry: str(values, "country").toUpperCase() || undefined,
	};
	const range = str(values, "price_range");
	return {
		config: {
			...data.config,
			site: {
				...site,
				email: str(values, "email") || undefined,
				telephone: str(values, "telephone") || undefined,
				address: Object.values(address).some((part) => part !== undefined) ? address : undefined,
				priceRange: PRICE_RANGES.includes(range) && range !== "" ? range : undefined,
				areaServed: lines(str(values, "areas", site.areaServed.join("\n"))),
			},
		},
		state: { tab: TAB.identity },
	};
}

function saveHours(data: AdminData, values: Record<string, unknown>): Outcome {
	const state: PageState = { tab: TAB.identity };
	const openingHours = [];
	for (const day of DAYS) {
		const key = `hours_${day.toLowerCase()}`;
		const typed = str(values, key, formatDayHours(day, data.config.site.openingHours));
		const parsed = parseDayHours(day, typed);
		if (!parsed) {
			return {
				error: `Couldn't read the hours for ${day}. Write them like 9:00-17:00, with at most two ranges.`,
				state,
			};
		}
		openingHours.push(...parsed);
	}
	return { config: { ...data.config, site: { ...data.config.site, openingHours } }, state };
}

function saveProfiles(data: AdminData, values: Record<string, unknown>): Outcome {
	const state: PageState = { tab: TAB.identity };
	const current = splitProfiles(data.config.site.sameAs);
	const typed = [
		...NETWORKS.map((network) =>
			str(values, `profile_${network.id}`, current.named[network.id] ?? ""),
		),
		...lines(str(values, "profiles", current.other.join("\n"))),
	].filter((link) => link !== "");
	const sameAs = [];
	for (const link of typed) {
		// People paste "instagram.com/name"; accept it.
		const url = parseUrl(/^https?:\/\//i.test(link) ? link : `https://${link}`);
		if (!url || !url.host.includes(".")) {
			return {
				error: `"${link}" is not a web address. Paste the full link to the profile.`,
				state,
			};
		}
		sameAs.push(url.href);
	}
	return { config: { ...data.config, site: { ...data.config.site, sameAs } }, state };
}

function saveCompany(data: AdminData, values: Record<string, unknown>): Outcome {
	const state: PageState = { tab: TAB.identity };
	const { site } = data.config;
	const founded = str(values, "founded", site.foundingDate ?? "");
	if (founded !== "" && !/^\d{4}(-\d{2}-\d{2})?$/.test(founded)) {
		return { error: "Write the founding date as a year, like 2012, or as 2012-05-01.", state };
	}
	const employees = str(
		values,
		"employees",
		site.numberOfEmployees ? String(site.numberOfEmployees) : "",
	);
	if (employees !== "" && !/^\d+$/.test(employees)) {
		return { error: "Number of employees must be a whole number.", state };
	}
	return {
		config: {
			...data.config,
			site: {
				...site,
				legalName: str(values, "legal_name", site.legalName ?? "") || undefined,
				foundingDate: founded || undefined,
				vatID: str(values, "vat_id", site.vatID ?? "") || undefined,
				taxID: str(values, "tax_id", site.taxID ?? "") || undefined,
				numberOfEmployees: employees === "" ? undefined : Number(employees),
			},
		},
		state,
	};
}

function saveAdvanced(data: AdminData, values: Record<string, unknown>): Outcome {
	const { robots } = data.config;
	const snippet = str(values, "snippet", robots.nosnippet ? "none" : "full");
	const preview = str(values, "image_preview", robots.maxImagePreview);
	return {
		config: {
			...data.config,
			breadcrumbs: bool(values, "breadcrumbs", data.config.breadcrumbs),
			robots: {
				...robots,
				nosnippet: snippet === "none",
				maxSnippet: snippet === "short" ? 160 : -1,
				maxImagePreview:
					preview === "none" || preview === "standard" || preview === "large"
						? preview
						: robots.maxImagePreview,
			},
		},
		state: { tab: TAB.types },
	};
}

/** Handle one interaction from the SEO admin page and return the page to show. */
/** Change one content type's schema type or search visibility from its table menu. */
function setCollection(data: AdminData, value: unknown, change: "type" | "visible"): Outcome {
	const state: PageState = { tab: TAB.types };
	const [slug, choice] = typeof value === "string" ? value.split("|") : [];
	if (!slug || !data.collections.some((collection) => collection.slug === slug)) {
		return { error: "That content type no longer exists.", state };
	}
	const current = data.config.collections[slug] ?? {};
	const type =
		change === "type"
			? PAGE_TYPES.find((option) => option.value === choice)?.value
			: (current.type ?? collectionType(data, slug));
	if (!type) return { error: "Choose one of the listed types.", state };
	// Hiding again after confirming needs a fresh confirmation, so hiddenOk is dropped.
	const noindex = change === "visible" ? choice === "hide" : current.noindex === true;
	return {
		config: {
			...data.config,
			collections: { ...data.config.collections, [slug]: { type, noindex } },
			steps: { ...data.config.steps, types: true },
		},
		state,
	};
}

/**
 * Bring the page counts up to date for a visit. The first visit starts the
 * site-wide check by itself, later visits continue it, and once it has
 * finished the stored results are simply recounted.
 */
async function freshCounts(ctx: PluginContext, data: AdminData): Promise<AdminData> {
	if (data.scan?.status === "done") return refreshStats(ctx, data);
	const scan = data.scan
		? await scanStep(ctx, data.scan, data.config)
		: await startScan(
				ctx,
				data.collections.map((collection) => collection.slug),
				data.config,
			);
	// The check keeps its own totals, so nothing is recounted here: a request
	// only has a handful of operations to spend.
	return { ...data, scan, stats: scan.status === "done" ? scan.tally : null };
}

const SAVED = "Saved. Google will pick this up next time it visits.";

/** Handle one interaction from the SEO admin page and return the page to show. */
export async function handleAdmin(
	input: unknown,
	role: number | undefined,
	ctx: PluginContext,
): Promise<BlockResponse> {
	const data = await loadData(ctx);
	const admin = (role ?? 0) >= ADMIN_ROLE;
	const interaction = isRecord(input) ? input : {};
	const action = typeof interaction.action_id === "string" ? interaction.action_id : "";

	if (interaction.type === "page_load" && interaction.page === "widget:seo") {
		// The dashboard is how people come back, so it always shows current counts.
		return widget(await freshCounts(ctx, data));
	}

	// Editors can look; every change below is for admins only.
	if (!admin || interaction.type === "page_load" || action === "") {
		return render(await freshCounts(ctx, data), ctx, admin, { tab: TAB.overview });
	}

	const save = async (outcome: Outcome, message = SAVED): Promise<BlockResponse> => {
		if ("error" in outcome) {
			return render(data, ctx, admin, {
				...outcome.state,
				toast: { type: "error", message: outcome.error },
			});
		}
		// Normalising before the write keeps stored data in the shape the page hook reads.
		const config = normalizeConfig(outcome.config);
		await ctx.kv.set(CONFIG_KEY, config);
		return render({ ...data, config }, ctx, admin, {
			...outcome.state,
			toast: { type: "success", message },
		});
	};
	/** Show the Redirects tab again after a change, with the list re-read. */
	const redirectsChanged = async (
		error: string | null,
		done: string,
		editing?: RedirectRow,
	): Promise<BlockResponse> => {
		if (error) {
			return render(data, ctx, admin, {
				tab: TAB.redirects,
				editing,
				adding: !editing,
				toast: { type: "error", message: error },
			});
		}
		const { rows, more } = await listRedirects(ctx);
		return render({ ...data, redirectRows: rows, moreRedirects: more }, ctx, admin, {
			tab: TAB.redirects,
			toast: { type: "success", message: done },
		});
	};

	if (interaction.type === "block_action") {
		if (action === "check_pages" || action === "check_more") {
			const again = action === "check_pages" ? { ...data, scan: null } : data;
			const checked = await freshCounts(ctx, again);
			return render(checked, ctx, admin, {
				tab: TAB.overview,
				toast:
					checked.scan?.status === "done"
						? { type: "success", message: "All pages checked." }
						: {
								type: "info",
								message: `${checked.scan?.checked ?? 0} pages checked so far. The rest follow in the background.`,
							},
			});
		}
		if (action === "set_type") return save(setCollection(data, interaction.value, "type"));
		if (action === "set_visible") {
			const hiding = typeof interaction.value === "string" && interaction.value.endsWith("|hide");
			return save(
				setCollection(data, interaction.value, "visible"),
				hiding
					? "These pages are now hidden from Google and other search engines."
					: "These pages can appear in search results again.",
			);
		}
		if (action === "hidden_ok") {
			const collections = { ...data.config.collections };
			for (const collection of hiddenCollections(data)) {
				collections[collection.slug] = { ...collections[collection.slug], hiddenOk: true };
			}
			return save(
				{ config: { ...data.config, collections }, state: { tab: TAB.overview } },
				"Noted. These pages stay hidden from search.",
			);
		}
		if (action === "edit_redirect") {
			const editing = data.redirectRows.find((row) => row.id === interaction.value);
			return render(data, ctx, admin, { tab: TAB.redirects, editing });
		}
		if (action === "cancel_edit") return render(data, ctx, admin, { tab: TAB.redirects });
		if (action === "remove_redirect" && typeof interaction.value === "string") {
			return redirectsChanged(await removeOne(ctx, interaction.value), "Redirect removed.");
		}
		if (action === "add_redirects" || action === "more_redirects") {
			if (!data.redirects || data.redirects.status === "done") {
				return render(data, ctx, admin, { tab: TAB.redirects });
			}
			const redirects = await addMore(ctx, data.redirects);
			return render({ ...data, redirects }, ctx, admin, {
				tab: TAB.redirects,
				toast:
					redirects.status === "done"
						? { type: "success", message: `${plural(redirects.added, "redirect")} added.` }
						: {
								type: "info",
								message: `${redirects.added} added so far. The rest follow in the background.`,
							},
			});
		}
		if (action === "stop_redirects" && data.redirects?.status === "adding") {
			const redirects = await stopImport(ctx, data.redirects);
			return render({ ...data, redirects }, ctx, admin, {
				tab: TAB.redirects,
				toast: { type: "info", message: `Stopped. ${plural(redirects.added, "redirect")} added.` },
			});
		}
		if (action === "reset_redirects") {
			// An import that is still running must finish or be stopped first.
			if (data.redirects?.status !== "adding") await ctx.kv.delete(IMPORT_KEY);
			return render(
				{ ...data, redirects: data.redirects?.status === "adding" ? data.redirects : null },
				ctx,
				admin,
				{ tab: TAB.redirects },
			);
		}
		if (action === "remove_redirects" && data.redirects) {
			const left = await removeBatch(ctx, data.redirects);
			return render({ ...data, redirects: left === 0 ? null : data.redirects }, ctx, admin, {
				tab: TAB.redirects,
				toast:
					left === 0
						? { type: "success", message: "Removed. Your other redirects are untouched." }
						: { type: "info", message: `${left} still to remove. Press Remove again.` },
			});
		}
		if (action === "export_redirects") {
			const { text, count } = await exportText(ctx);
			return render(data, ctx, admin, {
				tab: TAB.redirects,
				exported: text,
				toast: { type: "info", message: `${plural(count, "redirect")} listed below.` },
			});
		}
		// Sorting or paging a table changes nothing yet.
		return render(data, ctx, admin, { tab: TAB.overview });
	}

	if (interaction.type !== "form_submit") return render(data, ctx, admin, { tab: TAB.overview });

	const values = isRecord(interaction.values) ? interaction.values : {};
	if (action === "check_redirects") {
		const list = str(values, "list");
		if (list === "") {
			return render(data, ctx, admin, {
				tab: TAB.redirects,
				toast: { type: "error", message: "Paste a list first." },
			});
		}
		const redirects = await checkList(ctx, list);
		return render({ ...data, redirects }, ctx, admin, {
			tab: TAB.redirects,
			toast: { type: "success", message: "Checked. Nothing has been added yet." },
		});
	}
	if (action === "add_redirect") {
		return redirectsChanged(
			await addOne(
				ctx,
				str(values, "source"),
				str(values, "destination"),
				str(values, "code", "301"),
			),
			"Redirect added.",
		);
	}
	if (action.startsWith("save_redirect:")) {
		const id = action.slice("save_redirect:".length);
		const editing = data.redirectRows.find((row) => row.id === id);
		return redirectsChanged(
			await updateOne(
				ctx,
				id,
				str(values, "source", editing?.source ?? ""),
				str(values, "destination", editing?.destination ?? ""),
				str(values, "code", String(editing?.type ?? 301)),
			),
			"Redirect changed.",
			editing,
		);
	}

	if (action === "setup_identity") {
		const outcome = saveIdentity(data, values, ctx.site.url);
		if ("error" in outcome) return save(outcome);
		const street = str(values, "street");
		const town = str(values, "town");
		const { site } = outcome.config;
		const address =
			street !== "" || town !== ""
				? {
						...site.address,
						...(street ? { streetAddress: street } : {}),
						...(town ? { addressLocality: town } : {}),
					}
				: site.address;
		return save({
			config: { ...outcome.config, site: { ...site, address } },
			state: { tab: TAB.overview },
		});
	}
	if (action === "save_identity") return save(saveIdentity(data, values, ctx.site.url));
	if (action === "save_contact") return save(saveContact(data, values));
	if (action === "save_hours") return save(saveHours(data, values));
	if (action === "save_profiles") return save(saveProfiles(data, values));
	if (action === "save_company") return save(saveCompany(data, values));
	if (action === "save_advanced") return save(saveAdvanced(data, values));
	return render(data, ctx, admin, { tab: TAB.overview });
}
