// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";

import {
	cleanPolicyUrl,
	cleanText,
	DEFAULT_MESSAGE,
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
import { checkId, TOOL_EXAMPLES, TOOL_NAMES, type ToolId } from "./ids.js";
import type { ConsentCounts } from "./record.js";

/**
 * The one admin page, as Block Kit: Status, Tracking tools, Cookie banner,
 * Advanced. Everything here is a pure function of the settings, so it is
 * tested without a running site.
 */

// EmDash role levels: an Editor can open the page, only an Admin can change settings.
export const ADMIN_ROLE = 50;

const TAB = { status: 0, tools: 1, banner: 2, advanced: 3 } as const;

const AUDIENCE_LABEL: Record<Audience, string> = {
	europe: "Visitors in Europe and the UK (recommended)",
	everyone: "Everyone",
	none: "No one, I use another consent tool",
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
	counts: ConsentCounts | null;
	/** What was typed, kept on screen when a save was refused. */
	draft?: Record<string, unknown>;
	errors?: string[];
	toast?: BlockResponse["toast"];
}

// ── Status ──────────────────────────────────────────────────

function whoWaits(audience: Audience): string {
	return audience === "everyone" ? "every visitor" : "visitors in Europe and the UK";
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
	const rest = audience === "europe" ? " Loads straight away for everyone else." : "";
	if (tool === "gtm") {
		return config.gtmLoading === "immediate"
			? "Loads straight away for every visitor, before they answer."
			: `Waits for ${whoWaits(audience)} to accept at least one kind of cookie.${rest}`;
	}
	const kind = category === "marketing" ? "Marketing" : "Analytics";
	return `Waits for ${whoWaits(audience)} to accept ${kind} cookies.${rest}`;
}

/** Things the owner should fix or know, most important first. */
export function warnings(config: AnalyticsConfig): Array<{ title: string; description: string }> {
	const list: Array<{ title: string; description: string }> = [];
	const { tools, banner } = config;
	const asks = needsConsent(config);
	if (asks && banner.audience === "none") {
		list.push({
			title: "Your tools load without asking anyone",
			description:
				'You chose "No one, I use another consent tool". Make sure that tool really holds these tools back until visitors agree, or choose who sees the banner under Cookie banner.',
		});
	}
	if (asks && banner.audience !== "none" && banner.policyUrl === "") {
		list.push({
			title: "The banner has no link to your privacy policy",
			description:
				"Visitors must be able to read what they are agreeing to. Add your privacy policy page under Cookie banner.",
		});
	}
	if (tools.gtm && config.gtmLoading === "immediate" && banner.audience !== "none") {
		list.push({
			title: "Google Tag Manager loads before visitors answer",
			description:
				"Every tag inside your container must wait for consent by itself. If you are not sure, set Tag Manager to load after the visitor has chosen, under Advanced.",
		});
	}
	if (tools.ga4 && tools.gtm) {
		list.push({
			title: "Google Analytics may be counting twice",
			description:
				"Google Analytics and Google Tag Manager are both on. If your Tag Manager container also contains Google Analytics, every visit is counted twice. Keep one of the two.",
		});
	}
	return list;
}

function statusBlocks(state: PageState): Block[] {
	const { config, counts } = state;
	const on = enabledTools(config);
	const blocks: Block[] = [];

	for (const warning of warnings(config)) {
		blocks.push({ type: "banner", variant: "alert", ...warning });
	}

	if (on.length === 0) {
		blocks.push({
			type: "banner",
			title: "Nothing is being tracked yet",
			description: state.admin
				? "Open Tracking tools and paste the ID of each tool you use."
				: "An administrator has not added any tracking tools.",
		});
	} else {
		// One short paragraph each. A label-and-value grid would cut these sentences off.
		for (const tool of on) blocks.push({ type: "section", text: toolStatus(config, tool) });
		const asks = needsConsent(config);
		blocks.push({ type: "divider" });
		blocks.push({
			type: "section",
			text: !asks
				? "Cookie banner: not needed. Nothing you use sets cookies."
				: config.banner.audience === "none"
					? "Cookie banner: off. Another consent tool is in charge."
					: `Cookie banner: shown to ${whoWaits(config.banner.audience)}. They are asked again after ${config.banner.months} months, or when you add or remove a tool.`,
		});
		blocks.push({
			type: "section",
			text: config.enquiries
				? "Enquiries: counted. Clicks on phone and email links, and forms that were sent."
				: "Enquiries: not counted.",
		});
		if (asks && config.banner.audience !== "none" && counts) {
			blocks.push({
				type: "stats",
				items: [
					{ label: "Accepted all", value: counts.all, description: "Last 30 days" },
					{ label: "Rejected all", value: counts.none, description: "Last 30 days" },
					{ label: "Chose some", value: counts.some, description: "Last 30 days" },
				],
			});
		}
	}

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
function formId(name: string, config: AnalyticsConfig): string {
	return `${name}-${shortHash(JSON.stringify(config))}`;
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
		{
			type: "context",
			text: 'Visitors must always be able to change their mind. If you turn off the "Cookie settings" button, add a link with the attribute data-cookie-settings to your footer instead.',
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
					label: "Banner text",
					multiline: true,
					initial_value: text(draft, "message", banner.message),
				},
				{
					type: "select",
					action_id: "position",
					label: "Where it appears",
					options: [
						{ value: "bar", label: "Bar across the bottom" },
						{ value: "left", label: "Box in the bottom left corner" },
						{ value: "right", label: "Box in the bottom right corner" },
					],
					initial_value: banner.position,
				},
				{
					type: "select",
					action_id: "scheme",
					label: "Colours",
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
					label: 'Show a small "Cookie settings" button',
					initial_value: banner.settingsButton,
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
					type: "select",
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
	];
}

export function renderPage(state: PageState, tab: number = TAB.status): BlockResponse {
	const blocks: Block[] = [{ type: "header", text: "Analytics" }];
	if (state.admin) {
		blocks.push({
			type: "tab",
			default_tab: tab,
			panels: [
				{ label: "Status", blocks: statusBlocks(state) },
				{ label: "Tracking tools", blocks: toolsBlocks(tab === TAB.tools ? state : clean(state)) },
				{ label: "Cookie banner", blocks: bannerBlocks(tab === TAB.banner ? state : clean(state)) },
				{ label: "Advanced", blocks: advancedBlocks(tab === TAB.advanced ? state : clean(state)) },
			],
		});
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
	return { config: state.config, admin: state.admin, counts: state.counts };
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
const SAVED = "Saved. It can take a few minutes to reach visitors.";

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
	const done = (next: AnalyticsConfig, tab: number, message = SAVED): Outcome => {
		const save = normalizeConfig(next);
		return {
			save,
			response: renderPage({ ...state, config: save, toast: { type: "success", message } }, tab),
		};
	};
	const refuse = (errors: string[], tab: number): Outcome => ({
		response: renderPage({ ...state, draft: values, errors, toast: REFUSED }, tab),
	});
	const flag = (key: string, saved: boolean) =>
		typeof values[key] === "boolean" ? (values[key] as boolean) : saved;

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

	if (action === "save_banner") {
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
		const raw = {
			...banner,
			...pick(values, {
				audience: "audience",
				position: "position",
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
