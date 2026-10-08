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
	redirectsTab,
	removeBatch,
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

const TAB = { overview: 0, identity: 1, types: 2, redirects: 3 } as const;

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

function siteKind(identity: SiteIdentity): SiteKind {
	if (identity.type === "Person") return "person";
	return identity.type === "Organization" ? "organization" : "local";
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
	/** Collection whose "Change" form is open on the Page types tab. */
	editing?: string;
	/** The site's redirects as text, when the admin asked to see them. */
	exported?: string;
	toast?: BlockResponse["toast"];
}

interface AdminData {
	config: SeoConfig;
	collections: CollectionSchemaInfo[];
	redirects: ImportState | null;
	scan: ScanState | null;
	/** Page counts and the first pages to fix; null before any page was checked. */
	stats: Stats | null;
}

async function loadData(ctx: PluginContext): Promise<AdminData> {
	// One read for everything the plugin keeps in KV: requests are limited to a
	// handful of operations, and every tab is rendered on every response.
	const [stored, collections] = await Promise.all([
		ctx.kv.list(),
		ctx.schema?.listCollections() ?? [],
	]);
	const kv = new Map(stored.map((item) => [item.key, item.value]));
	const redirects = kv.get(IMPORT_KEY) as ImportState | undefined;
	return {
		config: normalizeConfig(kv.get(CONFIG_KEY)),
		// Only collections with public pages have anything to describe to search engines.
		collections: collections.filter((collection) => collection.routable && !collection.hidden),
		redirects: redirects && Array.isArray(redirects.rows) ? redirects : null,
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

function pagesToFix(data: AdminData): Block[] {
	const { stats, scan } = data;
	if (!stats || stats.checked === 0) return [];
	const ready = stats.checked - stats.fix - stats.hidden;
	const blocks: Block[] = [
		{
			type: "stats",
			items: [
				{ label: "Pages checked", value: stats.checked },
				{ label: "Ready", value: ready },
				{ label: "To fix", value: stats.fix },
			],
		},
		{
			type: "meter",
			label: `Pages ready: ${ready} of ${stats.checked}`,
			value: ready,
			max: stats.checked,
		},
	];
	if (stats.fix === 0) {
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
	if (scan?.status === "done" && scan.finishedAt) {
		blocks.push({
			type: "context",
			text: `All pages last checked ${scan.finishedAt.slice(0, 16).replace("T", " ")} UTC. Each page is also checked when it is saved.`,
		});
	}
	return blocks;
}

function checkButton(data: AdminData): Block[] {
	if (data.scan?.status === "running") {
		return [
			{
				type: "context",
				text: `Checking your pages: ${data.scan.checked} so far. This continues in the background; you can leave this page.`,
			},
			{
				type: "actions",
				elements: [{ type: "button", action_id: "check_more", label: "Check more now" }],
			},
		];
	}
	const first = !data.scan;
	return [
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "check_pages",
					label: first ? "Check my pages" : "Check all pages again",
					...(first ? { style: "primary" as const } : {}),
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
			description: `Every page in ${names} is hidden from search engines. If that is a leftover from building the site, switch it back on in the Page types tab.`,
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

function overviewTab(data: AdminData): Block[] {
	const { steps } = data.config;
	const checked = data.scan !== null;
	const done = Number(steps.identity) + Number(steps.types) + Number(checked);
	const blocks: Block[] = [...hiddenBanner(data, true)];

	if (done < 3) {
		blocks.push(
			{
				type: "banner",
				title: "SEO is already working",
				description:
					"Every page already tells Google what it is. Three short steps make the result more accurate.",
			},
			{ type: "context", text: `Setup: ${done} of 3 done` },
			// A button cannot switch tabs (the admin keeps the tab the user chose), so
			// each step names the tab to open instead of offering a dead-end button.
			{
				type: "section",
				text: steps.identity
					? "Done: Tell Google who you are."
					: '1. Tell Google who you are: your name, logo and where to find you. Open the "Who you are" tab above.',
			},
			{
				type: "section",
				text: steps.types
					? "Done: Choose what each page type is."
					: '2. Choose what each page type is. Most are already right. Open the "Page types" tab above.',
			},
			{
				type: "section",
				text: checked
					? "Done: Check your pages."
					: "3. Check your pages for things to fix, such as a missing description.",
			},
		);
	}

	blocks.push(...pagesToFix(data), ...checkButton(data));
	return blocks;
}

function widget(data: AdminData): BlockResponse {
	const { stats } = data;
	const open: Block = {
		type: "actions",
		elements: [{ type: "link", label: "Open SEO", target: { kind: "plugin-page", path: "/seo" } }],
	};
	if (!stats || stats.checked === 0) {
		const { steps } = data.config;
		const done = Number(steps.identity) + Number(steps.types) + Number(data.scan !== null);
		return {
			blocks: [{ type: "section", text: `Finish SEO setup: ${done} of 3 done.` }, open],
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
			label: "Contact and address",
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
					],
					submit: { label: "Save", action_id: "save_contact" },
				},
			],
		},
	];

	if (local) {
		blocks.push({
			type: "accordion",
			label: "Opening hours",
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

	blocks.push({
		type: "accordion",
		label: "Your profiles elsewhere",
		blocks: [
			{
				type: "context",
				text: "Links to your pages on other sites help Google connect them to you (sameAs).",
			},
			{
				type: "form",
				block_id: "profiles",
				fields: [
					{
						type: "text_input",
						action_id: "profiles",
						label: "Profile links, one per line",
						multiline: true,
						placeholder: "https://www.instagram.com/yourname",
						initial_value: site.sameAs.join("\n"),
					},
					{
						type: "text_input",
						action_id: "areas",
						label: "Areas you serve, one per line (optional)",
						multiline: true,
						placeholder: "Springfield",
						initial_value: site.areaServed.join("\n"),
					},
				],
				submit: { label: "Save", action_id: "save_profiles" },
			},
		],
	});

	return blocks;
}

function collectionType(data: AdminData, slug: string): PageSchemaType {
	return data.config.collections[slug]?.type ?? defaultTypeForCollection(slug);
}

function typesTab(data: AdminData, editing: string | undefined): Block[] {
	const { config } = data;
	const blocks: Block[] = [
		{
			type: "context",
			text: "Tell search engines what each kind of page is. Most are already right. One page can be changed from its own editor.",
		},
	];

	const target = data.collections.find((collection) => collection.slug === editing);
	if (target) {
		blocks.push(
			{ type: "header", text: `Change ${target.label}` },
			{
				type: "form",
				block_id: "page_type",
				fields: [
					{
						type: "select",
						action_id: "type",
						label: "Shown to Google as",
						options: PAGE_TYPES.map(({ value, label }) => ({ value, label })),
						initial_value: collectionType(data, target.slug),
					},
					{
						type: "toggle",
						action_id: "noindex",
						label: "Hide from search results",
						description: `Adds noindex to every page in ${target.label}.`,
						initial_value: config.collections[target.slug]?.noindex === true,
					},
				],
				submit: { label: "Save", action_id: `save_type:${target.slug}` },
			},
			{ type: "divider" },
		);
	}

	blocks.push({
		type: "table",
		page_action_id: "types_table",
		empty_text: "This site has no page types yet.",
		columns: [
			{ key: "name", label: "Type" },
			{ key: "shown", label: "Shown to Google as" },
			{ key: "visible", label: "In search results" },
			{ key: "change", label: "", format: "element" },
		],
		rows: data.collections.map((collection) => ({
			name: collection.label,
			shown: typeLabel(collectionType(data, collection.slug)),
			visible: config.collections[collection.slug]?.noindex === true ? "Hidden from search" : "Yes",
			change: { type: "button", action_id: "edit_type", label: "Change", value: collection.slug },
		})),
	});

	if (!config.steps.types) {
		blocks.push({
			type: "actions",
			elements: [
				{ type: "button", action_id: "types_ok", label: "These look right", style: "primary" },
			],
		});
	}

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
				...hiddenBanner(data, false),
				{
					type: "section",
					text: "Your pages are described to search engines automatically. There is nothing you need to set up.",
				},
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
					{ label: "Overview", blocks: overviewTab(data) },
					{ label: "Who you are", blocks: identityTab(data, ctx.site.name) },
					{ label: "Page types", blocks: typesTab(data, state.editing) },
					{ label: "Redirects", blocks: redirectsTab(data.redirects, state.exported) },
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
	const sameAs = [];
	for (const line of lines(str(values, "profiles", data.config.site.sameAs.join("\n")))) {
		const url = parseUrl(line);
		if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
			return {
				error: `"${line}" is not a web address. Each profile link starts with https://`,
				state,
			};
		}
		sameAs.push(url.href);
	}
	const areaServed = lines(str(values, "areas", data.config.site.areaServed.join("\n")));
	return { config: { ...data.config, site: { ...data.config.site, sameAs, areaServed } }, state };
}

function saveType(data: AdminData, slug: string, values: Record<string, unknown>): Outcome {
	const state: PageState = { tab: TAB.types };
	if (!data.collections.some((collection) => collection.slug === slug)) {
		return { error: "That page type no longer exists.", state };
	}
	const current = data.config.collections[slug];
	const requested = str(values, "type", collectionType(data, slug));
	const type = PAGE_TYPES.find((option) => option.value === requested)?.value;
	if (!type) return { error: "Choose one of the listed page types.", state };
	const noindex = bool(values, "noindex", current?.noindex === true);
	return {
		config: {
			...data.config,
			// Hiding again after confirming needs a fresh confirmation.
			collections: { ...data.config.collections, [slug]: { type, noindex } },
			steps: { ...data.config.steps, types: true },
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

const SAVED = "Saved. Google will pick this up next time it visits.";

/** Handle one interaction from the SEO admin page and return the page to show. */
export async function handleAdmin(
	input: unknown,
	role: number | undefined,
	ctx: PluginContext,
): Promise<BlockResponse> {
	const loaded = await loadData(ctx);
	const admin = (role ?? 0) >= ADMIN_ROLE;
	const interaction = isRecord(input) ? input : {};
	const action = typeof interaction.action_id === "string" ? interaction.action_id : "";

	if (interaction.type === "page_load" && interaction.page === "widget:seo") {
		// The dashboard is how people come back, so it always shows current counts.
		return widget(await refreshStats(ctx, loaded));
	}

	// Editors can look; every change below is for admins only.
	if (!admin || interaction.type === "page_load" || action === "") {
		return render(await refreshStats(ctx, loaded), ctx, admin, { tab: TAB.overview });
	}
	const data = loaded;

	if (
		interaction.type === "block_action" &&
		(action === "check_pages" || action === "check_more")
	) {
		const running = data.scan?.status === "running";
		const scan =
			action === "check_more" && running && data.scan
				? await scanStep(ctx, data.scan, data.config)
				: await startScan(
						ctx,
						data.collections.map((collection) => collection.slug),
						data.config,
					);
		// The check keeps its own totals, so nothing is recounted here: a request
		// only has a handful of operations to spend.
		const stats = scan.tally;
		await ctx.kv.set(STATS_KEY, stats);
		return render({ ...data, scan, stats }, ctx, admin, {
			tab: TAB.overview,
			toast:
				scan.status === "done"
					? { type: "success", message: "All pages checked." }
					: {
							type: "info",
							message: `${scan.checked} pages checked so far. The rest follow in the background.`,
						},
		});
	}

	if (interaction.type === "block_action") {
		if (action === "edit_type" && typeof interaction.value === "string") {
			return render(data, ctx, admin, { tab: TAB.types, editing: interaction.value });
		}
		if (action === "types_ok") {
			const config = { ...data.config, steps: { ...data.config.steps, types: true } };
			await ctx.kv.set(CONFIG_KEY, config);
			return render({ ...data, config }, ctx, admin, {
				tab: TAB.types,
				toast: { type: "success", message: "Great. Nothing to change here." },
			});
		}
		if (action === "hidden_ok") {
			const collections = { ...data.config.collections };
			for (const collection of hiddenCollections(data)) {
				collections[collection.slug] = { ...collections[collection.slug], hiddenOk: true };
			}
			const config = { ...data.config, collections };
			await ctx.kv.set(CONFIG_KEY, config);
			return render({ ...data, config }, ctx, admin, {
				tab: TAB.overview,
				toast: { type: "success", message: "Noted. These pages stay hidden from search." },
			});
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
			// An import that is still running must finish or be removed first.
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
		// Sorting or paging the table changes nothing yet.
		return render(data, ctx, admin, { tab: action === "types_table" ? TAB.types : TAB.overview });
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
	let outcome: Outcome;
	if (action === "save_identity") outcome = saveIdentity(data, values, ctx.site.url);
	else if (action === "save_contact") outcome = saveContact(data, values);
	else if (action === "save_hours") outcome = saveHours(data, values);
	else if (action === "save_profiles") outcome = saveProfiles(data, values);
	else if (action === "save_advanced") outcome = saveAdvanced(data, values);
	else if (action.startsWith("save_type:")) {
		outcome = saveType(data, action.slice("save_type:".length), values);
	} else return render(data, ctx, admin, { tab: TAB.overview });

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
		toast: { type: "success", message: SAVED },
	});
}
