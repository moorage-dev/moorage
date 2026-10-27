// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";

import { cleanColourChoice, COLOUR_OPTIONS, OWN_COLOURS } from "./colour-sets.js";
import {
	cleanColors,
	cleanPolicyUrl,
	cleanText,
	colorProblems,
	DEFAULT_MESSAGE,
	defaultMessage,
	DEFAULT_TITLE,
	enabledTools,
	needsConsent,
	normalizeConfig,
	parseExcludes,
	shortHash,
	TOOL_IDS,
	toolCategories,
	type AnalyticsConfig,
	type Audience,
} from "./config.js";
import { clientConfig } from "./fragment.js";
import { helpLine, hiddenFrom, HIDE_ACTION, hideForm } from "./help-line.js";
import { checkId, TOOL_EXAMPLES, TOOL_NAMES, type ToolId } from "./ids.js";
import type { ConsentSummary } from "./record.js";
import type { SiteCheck } from "./site-check.js";

/**
 * The one admin page, as Block Kit: Status, Tools, Banner,
 * Advanced. Everything here is a pure function of the settings, so it is
 * tested without a running site.
 */

// EmDash role levels: an Editor can open the page, only an Admin can change settings.
export const ADMIN_ROLE = 50;

const TAB = { status: 0, tools: 1, banner: 2, advanced: 3 } as const;

const AUDIENCE_LABEL: Record<Audience, string> = {
	europe:
		"Where the law says ask first: the EU, EEA, UK and Switzerland (recommended if you only count visits, for example with Google Analytics)",
	"europe-india": "Those places, plus India (its consent rules apply from 2027)",
	everyone: "Everyone, everywhere (recommended if you use Clarity, Meta Pixel or Google Ads)",
	none: "No one: another consent tool asks instead",
};

const TOOL_LABEL: Record<ToolId, string> = {
	ga4: "Google Analytics: Measurement ID (starts with G-)",
	gtm: "Google Tag Manager: container ID (starts with GTM-)",
	ads: "Google Ads: conversion ID (starts with AW-, optional)",
	meta: "Meta Pixel: pixel ID (a long number)",
	clarity: "Microsoft Clarity: project ID",
	hubspot: "HubSpot: Hub ID (a number)",
	cloudflare: "Cloudflare Web Analytics: token (simple visitor counts, no cookies)",
};

export interface PageState {
	config: AnalyticsConfig;
	admin: boolean;
	/** The last 30 days of answers to the banner; null when they cannot be read. */
	answers: ConsentSummary | null;
	/** The time the page was made, for "N minutes ago". */
	now?: number;
	/** The site's own address (https://example.com), for the preview links. */
	origin?: string;
	/** The signed address of the consent log download. Admins only. */
	exportUrl?: string;
	/** The last "Check what loads", if it ever ran. */
	siteCheck?: SiteCheck | null;
	/** What was typed, kept on screen when a save was refused. */
	draft?: Record<string, unknown>;
	errors?: string[];
	toast?: BlockResponse["toast"];
	/** Show the Colours section open: after its own save, or a refused one. */
	openColours?: boolean;
}

// ── Status ──────────────────────────────────────────────────

function whoWaits(audience: Audience): string {
	if (audience === "everyone") return "every visitor";
	return audience === "europe-india"
		? "visitors in Europe, the UK and India"
		: "visitors in Europe and the UK";
}

/** One plain line about what a tool does right now: "Google Analytics: on. Waits for ...". */
export function toolStatus(config: AnalyticsConfig, tool: ToolId): string {
	return `${TOOL_NAMES[tool]}: on. ${toolRule(config, tool)}`;
}

function toolRule(config: AnalyticsConfig, tool: ToolId): string {
	const { audience } = config.banner;
	const [category] = toolCategories(config, tool);
	if (category === "none") return "Counts visitors without cookies, so it does not wait.";
	if (audience === "none") return "Loads for every visitor without asking.";
	const rest =
		audience === "europe" || audience === "europe-india"
			? " Loads for everyone else without asking."
			: "";
	if (tool === "gtm") {
		return config.gtmLoading === "immediate"
			? "Loads for every visitor, before they answer."
			: `Waits for ${whoWaits(audience)} to accept at least one kind of cookie.${rest}`;
	}
	const kind = category === "marketing" ? "Marketing" : "Analytics";
	return `Waits for ${whoWaits(audience)} to accept ${kind} cookies.${rest}`;
}

function toolDoes(tool: "clarity" | "meta" | "ads"): string {
	return tool === "clarity" ? "records visits" : "is used for advertising";
}

interface Warning {
	title: string;
	description: string;
}

/** Things the owner should fix or know, most important first. */
export function warnings(config: AnalyticsConfig): Warning[] {
	return allWarnings(config).map(({ title, description }) => ({ title, description }));
}

/** The same, each filed under the Status checklist it belongs to. */
function allWarnings(config: AnalyticsConfig): Array<Warning & { area: "tracking" | "consent" }> {
	const list: Array<Warning & { area?: "tracking" }> = [];
	const { tools, banner } = config;
	const asks = needsConsent(config);
	if (asks && banner.audience === "none") {
		list.push({
			title: "Your tools load without asking anyone",
			description:
				'You chose "No one: another consent tool asks instead". Make sure that tool really holds these tools back until visitors agree, or choose who sees the banner on the Banner tab.',
		});
	}
	if (asks && banner.audience !== "none" && banner.policyUrl === "") {
		list.push({
			title: "The banner has no link to your privacy policy",
			description:
				"Visitors must be able to read what they are agreeing to. Add your privacy policy page on the Banner tab.",
		});
	}
	const watching = (["clarity", "meta", "ads"] as const).filter((tool) => tools[tool]);
	if (watching.length && (banner.audience === "europe" || banner.audience === "europe-india")) {
		list.push({
			title: "Consider asking every visitor",
			description: `${watching.map((tool) => TOOL_NAMES[tool]).join(", ")} ${watching.length > 1 ? "record visits or advertise" : toolDoes(watching[0]!)}. In the US and elsewhere that is safer with consent first. Choose "Everyone, everywhere" on the Banner tab.`,
		});
	}
	if (asks && banner.audience !== "none" && !banner.settingsButton) {
		list.push({
			title: 'The "Cookies" button is off',
			description:
				'Visitors must be able to change their answer as easily as they gave it. Add a menu item called "Cookie settings" to your footer menu, with the link /#cookie-settings, or switch the button back on in the Banner tab.',
		});
	}
	if (tools.gtm && config.gtmLoading === "immediate" && banner.audience !== "none") {
		list.push({
			area: "tracking",
			title: "Google Tag Manager loads before visitors answer",
			description:
				'Every tag inside your container must wait for consent by itself. If you are not sure, set Tag Manager to load "After the visitor has chosen" on the Advanced tab.',
		});
	}
	if (tools.ga4 && tools.gtm) {
		list.push({
			area: "tracking",
			title: "Google Analytics may be counting twice",
			description:
				"Google Analytics and Google Tag Manager are both on. If your Tag Manager container also contains Google Analytics, every visit is counted twice. Keep one of the two.",
		});
	}
	return list.map((warning) => ({ ...warning, area: warning.area ?? "consent" }));
}

/**
 * Where each tool shows its numbers. Only Clarity's address is built from the
 * ID; the others open the tool's own home, which asks which account to show.
 */
export function toolLink(config: AnalyticsConfig, tool: ToolId): string {
	switch (tool) {
		case "ga4":
			return "https://analytics.google.com/";
		case "gtm":
			return "https://tagmanager.google.com/";
		case "ads":
			return "https://ads.google.com/";
		case "meta":
			return "https://business.facebook.com/events_manager2/";
		case "clarity":
			return `https://clarity.microsoft.com/projects/view/${encodeURIComponent(config.tools.clarity)}/dashboard`;
		case "hubspot":
			return config.hubspotEu ? "https://app-eu1.hubspot.com/" : "https://app.hubspot.com/";
		case "cloudflare":
			return "https://dash.cloudflare.com/";
	}
}

const TOOL_SHORT: Record<ToolId, string> = {
	ga4: "Open Google Analytics",
	gtm: "Open Tag Manager",
	ads: "Open Google Ads",
	meta: "Open Events Manager",
	clarity: "Open Clarity",
	hubspot: "Open HubSpot",
	cloudflare: "Open Cloudflare",
};

const external = (label: string, url: string) => ({
	type: "link" as const,
	label,
	target: { kind: "external" as const, url },
	appearance: "secondary" as const,
});

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago". */
export function ago(iso: string, now: number): string {
	const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
	if (Number.isNaN(minutes)) return "some time ago";
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	const days = Math.floor(hours / 24);
	return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Noon UTC on a day, as the chart's time: the bar sits in the middle of its day. */
function noon(day: string): number {
	return Date.parse(`${day}T12:00:00.000Z`);
}

function trackingBlocks(state: PageState): Block[] {
	const { config } = state;
	const on = enabledTools(config);
	const blocks: Block[] = [{ type: "header", text: "Tracking" }];
	for (const warning of allWarnings(config)) {
		if (warning.area === "tracking") {
			blocks.push({
				type: "banner",
				variant: "alert",
				title: warning.title,
				description: warning.description,
			});
		}
	}
	if (on.length === 0) {
		blocks.push({
			type: "banner",
			title: "Nothing is being tracked yet",
			description: state.admin
				? "Open Tools and paste the ID of each tool you use."
				: "An administrator has not added any tracking tools.",
		});
		return blocks;
	}
	// One short line each. The ways to each tool's own numbers follow in one row, which
	// wraps on a phone instead of squeezing the lines.
	for (const tool of on) blocks.push({ type: "section", text: `✓ ${toolStatus(config, tool)}` });
	blocks.push({
		type: "section",
		text: config.enquiries
			? "✓ Enquiries: counted. Clicks on phone and email links, and forms that were sent."
			: "– Enquiries: not counted.",
	});
	blocks.push({
		type: "actions",
		elements: on.map((tool) => external(TOOL_SHORT[tool], toolLink(config, tool))),
	});
	if (on.some((tool) => tool === "ga4" || tool === "gtm" || tool === "ads")) {
		blocks.push(
			{
				type: "context",
				text: "To check that Google receives your visits: open Tag Assistant, type your site's address and accept the cookies there. Then look at Reports, Realtime in Google Analytics: your visit shows within a minute.",
			},
			{
				type: "actions",
				elements: [external("Open Tag Assistant", "https://tagassistant.google.com/")],
			},
		);
	}
	return blocks;
}

function consentBlocks(state: PageState): Block[] {
	const { config, answers } = state;
	const { banner } = config;
	const blocks: Block[] = [{ type: "header", text: "Cookie consent" }];
	for (const warning of allWarnings(config)) {
		if (warning.area === "consent") {
			blocks.push({
				type: "banner",
				variant: "alert",
				title: warning.title,
				description: warning.description,
			});
		}
	}
	const asks = needsConsent(config);
	if (!asks) {
		blocks.push({
			type: "section",
			text:
				enabledTools(config).length === 0
					? "– No banner yet: it appears once you add a tool that sets cookies."
					: "✓ No banner needed: nothing you use sets cookies.",
		});
		return blocks;
	}
	if (banner.audience === "none") {
		blocks.push({ type: "section", text: "– Banner off: another consent tool asks instead." });
		return blocks;
	}
	blocks.push({
		type: "section",
		text: `✓ Asks ${whoWaits(banner.audience)} first. They are asked again after ${banner.months} months, or when you add or remove a tool.`,
	});
	if (banner.policyUrl) {
		const url = banner.policyUrl.startsWith("/")
			? state.origin
				? `${state.origin}${banner.policyUrl}`
				: undefined
			: banner.policyUrl;
		blocks.push({
			type: "section",
			text: `✓ Links to your privacy policy: ${banner.policyUrl}`,
			...(url ? { accessory: external("Open it", url) } : {}),
		});
	}
	if (banner.settingsButton) {
		blocks.push({
			type: "section",
			text: '✓ Visitors can change their answer at any time with the small "Cookies" button.',
		});
	}
	if (!answers) return blocks;
	blocks.push({
		type: "section",
		text: answers.lastAt
			? `Last answer received ${ago(answers.lastAt, state.now ?? Date.now())}.`
			: "No answers received yet. They show here a minute or so after visitors answer the banner.",
	});
	blocks.push({
		type: "stats",
		items: [
			{ label: "Accepted all", value: answers.all, description: "Last 30 days" },
			{ label: "Rejected all", value: answers.none, description: "Last 30 days" },
			{ label: "Chose some", value: answers.some, description: "Last 30 days" },
		],
	});
	if (answers.all + answers.none + answers.some > 0) {
		blocks.push({ type: "context", text: "Accepted all and Rejected all, per day:" });
		blocks.push({
			type: "chart",
			config: {
				chart_type: "timeseries",
				style: "bar",
				height: 200,
				series: [
					{ name: "Accepted all", data: answers.days.map((d) => [noon(d.day), d.all]) },
					{ name: "Rejected all", data: answers.days.map((d) => [noon(d.day), d.none]) },
				],
			},
		});
	}
	if (state.admin && state.exportUrl) {
		blocks.push(
			{
				type: "actions",
				elements: [external("Download the consent log (CSV)", state.exportUrl)],
			},
			{
				type: "context",
				text: "Your proof that visitors were asked: one line per answer from the last 12 months, with the time, country, answer and the random reference the visitor's browser keeps. No addresses or names. The link works for ten minutes.",
			},
		);
	}
	return blocks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const two = (n: number) => String(n).padStart(2, "0");

/** "24 Oct 2026, 10:12 UTC". */
function utcTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

export const CHECK_ACTION = "check_site";

function siteCheckBlocks(state: PageState): Block[] {
	const check = state.siteCheck;
	const blocks: Block[] = [
		{ type: "header", text: "What loads on your site" },
		{
			type: "context",
			text: "Looks at your home page and up to four more, as a visitor gets them, for tracking code pasted in outside this plugin and for videos, maps, booking boxes and social posts that set cookies before a visitor answers. It knows the common ones, not every tool there is, and cannot see what loads later or only for some visitors.",
		},
	];
	if (!check) {
		blocks.push({
			type: "section",
			text: state.admin
				? "Not checked yet."
				: "Not checked yet. An administrator can check what loads on your site here.",
		});
	} else if (check.problem) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "The check could not run",
			description: check.problem,
		});
	} else {
		const paths = check.pages.map((page) => page.path).join(", ");
		blocks.push({
			type: "context",
			text: `Checked ${check.pages.length} ${check.pages.length === 1 ? "page" : "pages"} ${ago(check.at, state.now ?? Date.now())} (${utcTime(check.at)}): ${paths}. A page changed in the last few minutes may still show its older, cached version.`,
		});
		if (check.findings.length === 0) {
			blocks.push({
				type: "section",
				text: "✓ Nothing from the list loads outside this plugin on these pages.",
			});
		}
		for (const finding of check.findings) {
			blocks.push({
				type: "banner",
				variant: finding.kind === "missing" ? "default" : "alert",
				title: finding.title,
				description: `${finding.advice} Found on: ${finding.pages.join(", ")}.`,
			});
		}
	}
	if (state.admin) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: CHECK_ACTION,
					label: check ? "Check again" : "Check what loads",
					style: "secondary",
				},
			],
		});
	}
	return blocks;
}

function statusBlocks(state: PageState): Block[] {
	const blocks: Block[] = [
		...trackingBlocks(state),
		...consentBlocks(state),
		...siteCheckBlocks(state),
	];

	blocks.push({
		type: "context",
		text: "Changes can take a few minutes to reach visitors. Your own visits are not counted in a browser where you have signed in here; use a private window to test.",
	});
	blocks.push({
		type: "context",
		text: "Built to European and UK cookie banner guidance. Not a Google-certified consent platform: if you show Google ads on your own pages (AdSense or Ad Manager), you need a certified one instead.",
	});
	return blocks;
}

// ── Forms ───────────────────────────────────────────────────

function text(draft: Record<string, unknown> | undefined, key: string, saved: string): string {
	const typed = draft?.[key];
	return typeof typed === "string" ? typed : saved;
}

/**
 * A form's id changes whenever the saved settings change. The admin keeps what
 * was typed in a form for as long as its id stays the same, so this is what
 * makes a form show the tidied values after a save (the ID picked out of a
 * pasted snippet, the original text after a reset) and keep the typed ones
 * after a refused save.
 */
function formId(name: FormName, config: AnalyticsConfig): string {
	return `${name}-${shortHash(JSON.stringify(formPart(name, config)))}`;
}

type FormName = "tools" | "banner" | "colours" | "advanced";

/**
 * The part of the settings each form shows. A form's id follows only its own
 * part, so saving one form never clears what is typed, and not yet saved, in another.
 */
function formPart(name: FormName, config: AnalyticsConfig): unknown {
	const { colourSet, colors, darkColors, darkOn, ...banner } = config.banner;
	switch (name) {
		case "tools":
			return [config.tools, config.hubspotEu, config.cloudflareWait, config.enquiries];
		case "banner":
			return banner;
		case "colours":
			return [colourSet, colors, darkColors, darkOn];
		case "advanced":
			return [config.exclude, config.gtmLoading];
	}
}

function errorBlocks(state: PageState): Block[] {
	if (!state.errors?.length) return [];
	return [
		{
			type: "banner",
			variant: "error",
			title: "Nothing was saved. Please fix this first:",
			description: state.errors.join(" "),
		},
	];
}

function toolsBlocks(state: PageState): Block[] {
	const { config, draft } = state;
	return [
		...errorBlocks(state),
		{
			type: "context",
			text: "Paste the ID of each tool you use. You can also paste the whole code the tool gave you; the ID is picked out of it. Leave a box empty to turn that tool off.",
		},
		{
			type: "context",
			text: "Cloudflare Web Analytics sets no cookies, so it starts without asking unless you tell it to wait. Enquiries are clicks on phone and email links and forms that were sent, counted as a lead in Google Analytics and Meta; what people typed is never sent.",
		},
		{
			type: "form",
			block_id: formId("tools", config),
			fields: [
				...TOOL_IDS.map((tool) => ({
					type: "text_input" as const,
					action_id: tool,
					label: TOOL_LABEL[tool],
					placeholder: TOOL_EXAMPLES[tool],
					initial_value: text(draft, tool, config.tools[tool]),
				})),
				{
					type: "toggle",
					action_id: "hubspot_eu",
					label: "My HubSpot account is in the EU data centre",
					initial_value: config.hubspotEu,
				},
				{
					type: "toggle",
					action_id: "cloudflare_wait",
					label: "Cloudflare Web Analytics: wait for consent anyway",
					initial_value: config.cloudflareWait,
				},
				{
					type: "toggle",
					action_id: "enquiries",
					label: "Track enquiries automatically",
					initial_value: config.enquiries,
				},
			],
			submit: { label: "Save tools", action_id: "save_tools" },
		},
	];
}

function bannerBlocks(state: PageState): Block[] {
	const { config, draft } = state;
	const { banner } = config;
	return [
		...errorBlocks(state),
		{ type: "header", text: "Who is asked and what they read" },
		{
			type: "context",
			text: "Visitors who are not asked, for example in the US, can always turn the tools off with Cookie settings, as US state laws such as California's require, and Global Privacy Control is always respected. Tools that record visits or advertise are safer behind a banner for everyone.",
		},
		{
			type: "context",
			text: 'Visitors must always be able to change their mind. A small "Cookies" button lets them. To add your own link, make a menu item or a link on your privacy page that goes to /#cookie-settings. The button steps aside while that link is on screen.',
		},
		{
			type: "form",
			block_id: formId("banner", config),
			fields: [
				{
					type: "radio",
					action_id: "audience",
					label: "Who sees the cookie banner",
					options: (Object.keys(AUDIENCE_LABEL) as Audience[]).map((value) => ({
						value,
						label: AUDIENCE_LABEL[value],
					})),
					initial_value: banner.audience,
				},
				{
					type: "text_input",
					action_id: "policy_url",
					label: "Privacy policy page (for example /privacy)",
					placeholder: "/privacy",
					initial_value: text(draft, "policy_url", banner.policyUrl),
				},
				{
					type: "text_input",
					action_id: "title",
					label: "Banner heading",
					initial_value: text(draft, "title", banner.title),
				},
				{
					type: "text_input",
					action_id: "message",
					label:
						"Banner text (leave empty for the standard text, which names what your tools are used for)",
					multiline: true,
					placeholder: defaultMessage(config),
					initial_value: text(draft, "message", banner.message),
				},
				{
					type: "radio",
					action_id: "position",
					label: "Where it appears",
					options: [
						{ value: "bar", label: "Across the bottom of the screen (recommended)" },
						{ value: "left", label: "Box in the bottom left corner" },
						{ value: "right", label: "Box in the bottom right corner" },
					],
					initial_value: banner.position,
				},
				{
					type: "select",
					action_id: "scheme",
					label: "Light or dark",
					options: [
						{ value: "auto", label: "Follow the visitor's device (light or dark)" },
						{ value: "light", label: "Always light" },
						{ value: "dark", label: "Always dark" },
					],
					initial_value: banner.scheme,
				},
				{
					type: "toggle",
					action_id: "settings_button",
					label: 'Show a small "Cookies" button after a visitor has answered',
					initial_value: banner.settingsButton,
				},
				{
					type: "radio",
					action_id: "settings_side",
					label: 'Corner for the "Cookies" button',
					options: [
						{ value: "left", label: "Bottom left (chat buttons usually sit on the right)" },
						{ value: "right", label: "Bottom right" },
					],
					initial_value: banner.settingsSide,
				},
				{
					type: "select",
					action_id: "months",
					label: "Ask again after",
					options: [
						{ value: "6", label: "6 months (recommended)" },
						{ value: "12", label: "12 months" },
					],
					initial_value: String(banner.months),
				},
			],
			submit: { label: "Save banner", action_id: "save_banner" },
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "reset_text",
					label: "Put back the original heading and text",
					style: "secondary",
				},
			],
		},
		coloursBlock(state),
		...previewBlocks(state),
	];
}

/** The colours, folded away: most sites keep the theme's. A form of their own, inside the fold. */
function coloursBlock(state: PageState): Block {
	const { config, draft } = state;
	const { banner } = config;
	const own = { field: "colour_set", eq: OWN_COLOURS };
	// Dark mode boxes are empty while dark mode uses the same colours.
	const dark = (key: "background" | "text" | "accent") =>
		banner.darkOn ? banner.darkColors[key] : "";
	return {
		type: "accordion",
		label: "Colours",
		...(state.openColours ? { default_open: true } : {}),
		blocks: [
			{
				type: "context",
				text: "Your theme's colours suit most sites. Each ready-made set has a matching dark version for visitors whose device is in dark mode, and Popups offers the same sets, so the two can match. Accept all and Reject all always share one colour, so neither is pushed.",
			},
			{
				type: "form",
				block_id: formId("colours", config),
				fields: [
					{
						type: "radio",
						action_id: "colour_set",
						label: "Colours",
						options: [...COLOUR_OPTIONS],
						initial_value: banner.colourSet,
					},
					{
						type: "text_input",
						action_id: "color_background",
						label: "Banner background colour, for example #fbf7f0",
						placeholder: "#ffffff",
						initial_value: text(draft, "color_background", banner.colors.background),
						condition: own,
					},
					{
						type: "text_input",
						action_id: "color_text",
						label: "Banner text colour, set together with the background",
						placeholder: "#141414",
						initial_value: text(draft, "color_text", banner.colors.text),
						condition: own,
					},
					{
						type: "text_input",
						action_id: "color_accent",
						label: "Button colour, used for both Accept all and Reject all",
						placeholder: "#141414",
						initial_value: text(draft, "color_accent", banner.colors.accent),
						condition: own,
					},
					{
						type: "text_input",
						action_id: "dark_background",
						label:
							"Dark mode: banner background colour, for example #1c1c1c (empty: the colours above)",
						placeholder: "#1c1c1c",
						initial_value: text(draft, "dark_background", dark("background")),
						condition: own,
					},
					{
						type: "text_input",
						action_id: "dark_text",
						label: "Dark mode: banner text colour, set together with the background",
						placeholder: "#f2f2f2",
						initial_value: text(draft, "dark_text", dark("text")),
						condition: own,
					},
					{
						type: "text_input",
						action_id: "dark_accent",
						label: "Dark mode: button colour",
						placeholder: "#f2f2f2",
						initial_value: text(draft, "dark_accent", dark("accent")),
						condition: own,
					},
				],
				submit: { label: "Save colours", action_id: "save_colours" },
			},
		],
	};
}

/** Two links that open the site's home page with the banner shown as saved, in light and in dark. */
function previewBlocks(state: PageState): Block[] {
	if (!state.origin) return [];
	if (enabledTools(state.config).length === 0) {
		return [
			{ type: "header", text: "Preview" },
			{
				type: "context",
				text: "Add a tool on the Tools tab to preview the banner on your site.",
			},
		];
	}
	const link = (label: string, look: "light" | "dark", appearance: "primary" | "secondary") => ({
		type: "link" as const,
		label,
		target: { kind: "external" as const, url: `${state.origin}/?cookie_preview=${look}` },
		appearance,
	});
	return [
		{ type: "header", text: "Preview" },
		{
			type: "context",
			text: "Opens your home page with the banner as saved, whoever you are and wherever you are. Answers there are not saved and no tool loads. Save your changes first.",
		},
		{
			type: "actions",
			elements: [
				link("Preview the banner", "light", "primary"),
				link("Preview in dark mode", "dark", "secondary"),
			],
		},
	];
}

function advancedBlocks(state: PageState): Block[] {
	const { config, draft } = state;
	return [
		...errorBlocks(state),
		{
			type: "form",
			block_id: formId("advanced", config),
			fields: [
				{
					type: "text_input",
					action_id: "exclude",
					label: "Don't track these pages (one address per line, for example /thank-you)",
					multiline: true,
					placeholder: "/thank-you",
					initial_value: text(draft, "exclude", config.exclude.join("\n")),
				},
				{
					type: "radio",
					action_id: "gtm_loading",
					label: "When Google Tag Manager loads",
					options: [
						{ value: "choice", label: "After the visitor has chosen (recommended)" },
						{
							value: "immediate",
							label: "Immediately (only if every tag in your container waits for consent)",
						},
					],
					initial_value: config.gtmLoading,
				},
			],
			submit: { label: "Save", action_id: "save_advanced" },
		},
		{
			type: "context",
			text: "The admin, preview links and the visual editor are never tracked.",
		},
		hideForm(config.hideHelpLine),
	];
}

export function renderPage(state: PageState, tab: number = TAB.status): BlockResponse {
	const blocks: Block[] = [{ type: "header", text: "Analytics & Cookies" }];
	if (state.admin) {
		blocks.push({
			type: "tab",
			default_tab: tab,
			panels: [
				{ label: "Status", blocks: statusBlocks(state) },
				{ label: "Tools", blocks: toolsBlocks(tab === TAB.tools ? state : clean(state)) },
				{ label: "Banner", blocks: bannerBlocks(tab === TAB.banner ? state : clean(state)) },
				{ label: "Advanced", blocks: advancedBlocks(tab === TAB.advanced ? state : clean(state)) },
			],
		});
		// Under every tab, for admins only.
		blocks.push(...helpLine(!state.config.hideHelpLine));
	} else {
		blocks.push(...statusBlocks(state), {
			type: "context",
			text: "Only an administrator can change these settings.",
		});
	}
	return { blocks, ...(state.toast ? { toast: state.toast } : {}) };
}

/** The state without a refused save's leftovers, for the tabs it did not happen on. */
function clean(state: PageState): PageState {
	return {
		config: state.config,
		admin: state.admin,
		answers: state.answers,
		now: state.now,
		origin: state.origin,
		exportUrl: state.exportUrl,
		siteCheck: state.siteCheck,
	};
}

// ── Saving ──────────────────────────────────────────────────

export interface Interaction {
	type?: unknown;
	action_id?: unknown;
	values?: unknown;
}

export interface Outcome {
	/** The settings to store, when something changed. */
	save?: AnalyticsConfig;
	response: BlockResponse;
}

function has(values: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(values, key);
}

const REFUSED: BlockResponse["toast"] = {
	type: "error",
	message: "Nothing was saved. See the message at the top.",
};
/**
 * Cached pages keep the old settings for a few minutes. A plugin cannot clear
 * EmDash's page cache, so a save says so only when it changes what visitors get.
 */
const LATER = "It can take a few minutes to reach visitors.";
const SAVED = `Saved. ${LATER}`;

/**
 * What every public page gets from these settings: nothing while no tool is on
 * (see `pageFragments`), else the browser settings and the pages left out.
 */
function visitorView(config: AnalyticsConfig): string {
	if (enabledTools(config).length === 0) return "";
	return JSON.stringify([clientConfig(config, ""), config.exclude]);
}

/**
 * Work out what an interaction on the page means. Forms send only the fields
 * that were touched or had a value, so a missing field keeps what is stored.
 */
export function handleInteraction(input: Interaction | undefined, state: PageState): Outcome {
	const { config } = state;
	const action = typeof input?.action_id === "string" ? input.action_id : "";
	const changing = input?.type === "form_submit" || input?.type === "block_action";
	if (!changing) return { response: renderPage(state) };
	if (!state.admin) {
		return {
			response: renderPage({
				...state,
				toast: { type: "error", message: "Only an administrator can change these settings." },
			}),
		};
	}
	const values =
		typeof input?.values === "object" && input.values !== null
			? (input.values as Record<string, unknown>)
			: {};
	const done = (next: AnalyticsConfig, tab: number, message = "Saved."): Outcome => {
		const save = normalizeConfig(next);
		const seen = visitorView(normalizeConfig(config)) !== visitorView(save);
		const said = !seen ? message : message === "Saved." ? SAVED : `${message} ${LATER}`;
		return {
			save,
			response: renderPage(
				{ ...state, config: save, openColours, toast: { type: "success", message: said } },
				tab,
			),
		};
	};
	const refuse = (errors: string[], tab: number): Outcome => ({
		response: renderPage({ ...state, draft: values, errors, openColours, toast: REFUSED }, tab),
	});
	const openColours = action === "save_colours";
	const flag = (key: string, saved: boolean) =>
		typeof values[key] === "boolean" ? (values[key] as boolean) : saved;

	// The check itself ran in the route (it fetches pages); this only says how it went.
	if (input?.type === "block_action" && action === CHECK_ACTION) {
		const check = state.siteCheck;
		const found = check?.findings.length ?? 0;
		return {
			response: renderPage(
				{
					...state,
					toast: !check
						? { type: "error", message: "The check could not run. Please try again." }
						: check.problem
							? { type: "error", message: "The check could not run. See Status." }
							: {
									type: "success",
									message:
										found === 0
											? `Checked ${check.pages.length} pages. Nothing found.`
											: `Checked ${check.pages.length} pages. ${found} ${found === 1 ? "thing" : "things"} to look at.`,
								},
				},
				TAB.status,
			),
		};
	}
	if (input?.type === "block_action" && action === "reset_text") {
		return done(
			{ ...config, banner: { ...config.banner, title: DEFAULT_TITLE, message: DEFAULT_MESSAGE } },
			TAB.banner,
			"The original heading and text are back.",
		);
	}
	if (input?.type !== "form_submit") return { response: renderPage(state) };

	if (action === "save_tools") {
		const tools = { ...config.tools };
		const errors: string[] = [];
		for (const tool of TOOL_IDS) {
			if (!has(values, tool)) continue;
			const checked = checkId(tool, values[tool]);
			if (checked.ok) tools[tool] = checked.value;
			else errors.push(checked.message);
		}
		if (errors.length > 0) return refuse(errors, TAB.tools);
		return done(
			{
				...config,
				tools,
				hubspotEu: flag("hubspot_eu", config.hubspotEu),
				cloudflareWait: flag("cloudflare_wait", config.cloudflareWait),
				enquiries: flag("enquiries", config.enquiries),
			},
			TAB.tools,
		);
	}

	if (action === "save_banner" || action === "save_colours") {
		const banner = { ...config.banner };
		if (has(values, "policy_url")) {
			const typed = typeof values.policy_url === "string" ? values.policy_url.trim() : "";
			const link = cleanPolicyUrl(typed);
			if (typed !== "" && link === "") {
				return refuse(
					[
						"Privacy policy page: type a page on this site such as /privacy, or a full link that starts with https://.",
					],
					TAB.banner,
				);
			}
			banner.policyUrl = link;
		}
		if (has(values, "title")) banner.title = cleanText(values.title, 80, DEFAULT_TITLE);
		if (has(values, "message")) banner.message = cleanText(values.message, 400, DEFAULT_MESSAGE);
		if (has(values, "colour_set")) {
			banner.colourSet = cleanColourChoice(values.colour_set, banner.colourSet);
		}
		// The colour boxes count only under "My own colours". Under any other choice they are
		// hidden but still sent; what is stored stays as it is, for older versions and for coming back.
		if (banner.colourSet === OWN_COLOURS) {
			const typed = (key: string, saved: string) =>
				typeof values[key] === "string" ? (values[key] as string).trim() : saved;
			if (
				has(values, "color_background") ||
				has(values, "color_text") ||
				has(values, "color_accent")
			) {
				const light = {
					background: typed("color_background", banner.colors.background),
					text: typed("color_text", banner.colors.text),
					accent: typed("color_accent", banner.colors.accent),
				};
				const problems = colorProblems(light);
				if (problems.length) return refuse(problems, TAB.banner);
				banner.colors = cleanColors(light);
			}
			if (
				has(values, "dark_background") ||
				has(values, "dark_text") ||
				has(values, "dark_accent")
			) {
				const shown = (key: "background" | "text" | "accent") =>
					banner.darkOn ? banner.darkColors[key] : "";
				const dark = {
					background: typed("dark_background", shown("background")),
					text: typed("dark_text", shown("text")),
					accent: typed("dark_accent", shown("accent")),
				};
				// All empty: dark mode uses the colours above, and the old dark ones stay stored.
				banner.darkOn = Object.values(dark).some((value) => value !== "");
				if (banner.darkOn) {
					const problems = colorProblems(dark).map((problem) => `Dark mode: ${problem}`);
					if (problems.length) return refuse(problems, TAB.banner);
					banner.darkColors = cleanColors(dark);
				}
			}
		}
		const raw = {
			...banner,
			...pick(values, {
				audience: "audience",
				position: "position",
				settingsSide: "settings_side",
				scheme: "scheme",
				months: "months",
			}),
		};
		return done(
			{
				...config,
				banner: {
					...raw,
					settingsButton: flag("settings_button", banner.settingsButton),
				} as AnalyticsConfig["banner"],
			},
			TAB.banner,
		);
	}

	if (action === "save_advanced") {
		return done(
			{
				...config,
				exclude: has(values, "exclude") ? parseExcludes(values.exclude) : config.exclude,
				gtmLoading: has(values, "gtm_loading")
					? (values.gtm_loading as AnalyticsConfig["gtmLoading"])
					: config.gtmLoading,
			},
			TAB.advanced,
		);
	}

	if (action === HIDE_ACTION) {
		const hidden = hiddenFrom(values, config.hideHelpLine);
		return done(
			{ ...config, hideHelpLine: hidden },
			TAB.advanced,
			hidden ? "Saved. The help line is hidden." : "Saved. The help line shows again.",
		);
	}

	return { response: renderPage(state) };
}

/** Copy the named form values that were sent, under their config names. */
function pick(
	values: Record<string, unknown>,
	names: Record<string, string>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(names)) {
		if (has(values, field)) out[key] = values[field];
	}
	return out;
}
