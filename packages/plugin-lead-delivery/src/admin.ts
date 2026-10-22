// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse, ButtonElement, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import {
	ago,
	inTime,
	loadConfig,
	loadForms,
	newId,
	newKey,
	parseAddresses,
	plural,
	saveConfig,
	since,
	siteName,
	siteOrigin,
} from "./config.js";
import {
	deliveryName,
	isConnected,
	MAX_ATTEMPTS,
	needsFixing,
	quietForms,
	receive,
	schedulerStuck,
	sendAgain,
	sends,
	servesForm,
	weekCounts,
	adoptForm,
	notSentForms,
} from "./deliver.js";
import { UNREADABLE_KEY } from "./enquiry.js";
import { checkReach, findForm, markConnected, refreshDefinitions, rememberForm } from "./forms.js";
import { CHOICES, choiceFor, matchedCount, parseHubSpot, UNMATCHED } from "./hubspot.js";
import { instructions } from "./messages.js";
import {
	APPS,
	appLabel,
	formName,
	formWords,
	formsLabel,
	generatedName,
	kindWord,
	rowLabel,
} from "./names.js";
import {
	type Config,
	type Delivery,
	type DeliveryKind,
	type Enquiry,
	type FieldInfo,
	type KnownForm,
	NO_DELIVERY,
	type Repeat,
	type Send,
	type SendStatus,
} from "./types.js";
import { newSecret } from "./webhook.js";

// EmDash role levels: an Editor can open the page and press Send again; only an Admin changes anything.
const ADMIN_ROLE = 50;
export const PAGE = "/enquiries";
const LOG_ROWS = 25;
const HOME_ROWS = 10;
const OTHER = "__other";

interface User {
	email: string;
	name: string | null;
	role: number;
}

/** What to draw: home, or one of the views drawn on the same page. */
type View = (
	| { screen: "home"; settingsOpen?: boolean }
	| { screen: "new"; draft?: Record<string, unknown> }
	| {
			screen: "new2";
			form: { slug: string; name: string; fields: FieldInfo[]; checked: boolean };
			kind: DeliveryKind;
			draft?: Record<string, unknown>;
			duplicate?: Delivery;
	  }
	| { screen: "delivery"; id: string; cursor?: string; secret?: string }
	| { screen: "edit"; id: string; draft?: Record<string, unknown> }
	| { screen: "log"; filter: string; cursor?: string }
	| { screen: "connect"; id: string; form: string; secret?: string }
	| { screen: "adopt"; form: string }
) & { toast?: BlockResponse["toast"] };

interface Data {
	ctx: PluginContext;
	config: Config;
	forms: Record<string, KnownForm>;
	origin: string;
	user?: User;
	admin: boolean;
}

const STATUS: Record<SendStatus, string> = {
	delivered: "Delivered",
	retrying: "Trying again",
	fixing: "Needs fixing",
	gaveup: "Gave up",
	skipped: "Not sent",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

const header = (text: string): Block => ({ type: "header", text });
const section = (text: string): Block => ({ type: "section", text });
const context = (text: string): Block => ({ type: "context", text });
const divider = (): Block => ({ type: "divider" });
type ActionElement = Extract<Block, { type: "actions" }>["elements"][number];
const actions = (elements: ActionElement[]): Block => ({ type: "actions", elements });
const button = (
	action_id: string,
	label: string,
	opts: Partial<Omit<ButtonElement, "type" | "action_id" | "label">> = {},
): ButtonElement => ({ type: "button", action_id, label, ...opts });
const back = (label = "Back to Lead delivery", action = "home", value?: unknown): Block =>
	actions([button(action, `← ${label}`, value === undefined ? {} : { value })]);

/**
 * Let long unbroken words (email addresses, web addresses) wrap after "@", "." and "/", so the
 * first column of a table can shrink on a phone and the status and buttons stay on screen.
 */
export function breakable(text: string): string {
	return text.replace(/([@./])(?=\S)/g, "$1​");
}

/** "just now", "12 min ago", "2 h ago", "1 day ago", "3 days ago": short, for a table cell. */
export function shortAgo(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "";
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (!Number.isFinite(minutes)) return "";
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return plural(Math.floor(hours / 24), "day") + " ago";
}

function findDelivery(data: Data, id: string): Delivery | undefined {
	return data.config.deliveries.find((d) => d.id === id);
}

// ─── Statuses ───────────────────────────────────────────────────────

type StatusKind = "off" | "fixing" | "retrying" | "working" | "waiting";

interface Status {
	kind: StatusKind;
	label: string;
	/** The latest real enquiry delivered. */
	last?: Send;
	/** Real sends that need fixing, newest first. */
	fixing: Array<{ id: string; data: Send }>;
}

/** The first match wins: Turned off, Needs fixing, Trying again, Working, Not sending yet. Tests never count. */
async function statusOf(ctx: PluginContext, delivery: Delivery): Promise<Status> {
	const [fixing, retrying, delivered] = await Promise.all([
		needsFixing(ctx, 20, delivery.id),
		sends(ctx).query({ where: { destination: delivery.id, status: "retrying" }, limit: 20 }),
		sends(ctx).query({
			where: { destination: delivery.id, status: "delivered" },
			orderBy: { createdAt: "desc" },
			limit: 20,
		}),
	]);
	const last = delivered.items.find((item) => !item.data.test)?.data;
	const base = { fixing, ...(last ? { last } : {}) };
	if (!delivery.on) return { ...base, kind: "off", label: "Turned off" };
	if (fixing.length > 0) return { ...base, kind: "fixing", label: "Needs fixing" };
	if (retrying.items.some((item) => !item.data.test))
		return { ...base, kind: "retrying", label: "Trying again" };
	if (last) return { ...base, kind: "working", label: `Working, last ${shortAgo(last.createdAt)}` };
	return { ...base, kind: "waiting", label: "Not sending yet" };
}

function servedForms(data: Data, delivery: Delivery): KnownForm[] {
	if (delivery.forms === "all") return Object.values(data.forms);
	return delivery.forms.map(
		(slug) =>
			data.forms[slug] ?? {
				slug,
				name: slug,
				fields: [],
				source: "enquiry" as const,
				addedAt: "",
				days: [],
			},
	);
}

/** The first of a delivery's forms that was never connected, if none of them is. */
function unconnectedForm(data: Data, delivery: Delivery): KnownForm | undefined {
	const forms = servedForms(data, delivery);
	if (forms.some((f) => isConnected(data.forms[f.slug], data.config.keySetAt))) return undefined;
	return forms[0];
}

// ─── The log ────────────────────────────────────────────────────────

function sendLabel(s: Send, config: Config): string {
	if (s.destination === NO_DELIVERY) return s.formName;
	const delivery = config.deliveries.find((d) => d.id === s.destination);
	if (!delivery) return `${s.formName} → a delivery that was deleted`;
	if (Array.isArray(delivery.forms) && delivery.forms.length === 1) return delivery.name;
	return `${delivery.name} (${s.formName})`;
}

function rowText(s: Send, config: Config): string {
	const parts = [s.who, sendLabel(s, config), ago(s.createdAt)];
	if (s.status === "retrying" && s.nextAt) {
		parts.push(
			`try ${Math.min(s.attempts + 1, MAX_ATTEMPTS)} of ${MAX_ATTEMPTS}, next ${inTime(s.nextAt)}`,
		);
	}
	return breakable([...parts, ...s.notes].filter(Boolean).join(" · "));
}

/** Where a log button was pressed, so the same view comes back. */
type From =
	| { screen: "home" }
	| { screen: "delivery"; id: string }
	| { screen: "log"; filter: string };

function rowAction(id: string, s: Send, from: From) {
	if (s.destination === NO_DELIVERY) return null;
	const value = { row: id, from };
	if (s.status === "fixing" || s.status === "gaveup" || (s.status === "skipped" && s.held)) {
		return button("send_again", "Send again", { value });
	}
	if (s.status === "retrying") return button("send_now", "Send now", { value });
	return null;
}

async function logTable(
	data: Data,
	opts: { destination?: string; limit: number; cursor?: string; from: From; empty: string },
): Promise<Block> {
	const page = await sends(data.ctx).query({
		...(opts.destination ? { where: { destination: opts.destination } } : {}),
		orderBy: { createdAt: "desc" },
		limit: opts.limit,
		...(opts.cursor ? { cursor: opts.cursor } : {}),
	});
	const paged = opts.from.screen !== "home";
	return {
		type: "table",
		block_id:
			opts.from.screen === "delivery"
				? `log:delivery:${opts.from.id}`
				: opts.from.screen === "log"
					? `log:all:${opts.from.filter}`
					: "log:home",
		page_action_id: "log_page",
		columns: [
			{ key: "enquiry", label: "Enquiry" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "action", label: "", format: "element" },
		],
		rows: page.items.map((item) => {
			const action = rowAction(item.id, item.data, opts.from);
			return {
				enquiry: rowText(item.data, data.config),
				status: STATUS[item.data.status],
				...(action ? { action } : {}),
			};
		}),
		...(paged && page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
		empty_text: opts.empty,
	};
}

const KEEP_NOTE =
	"Log rows are kept 30 days. An enquiry's contents are deleted here once all its deliveries are done; Forms → Submissions keeps the original.";

// ─── Home ───────────────────────────────────────────────────────────

const REACH_TEXT = {
	self: "Your forms can send each enquiry straight to Lead delivery.",
	email:
		"Your forms hand enquiries over through a private email address. Nobody receives that email.",
	none: "Your forms have no way to hand enquiries over yet: set up email for the site first.",
} as const;

function firstSentence(text: string): string {
	const end = text.indexOf(". ");
	return end > 0 ? text.slice(0, end + 1) : text;
}

function settingsAccordion(data: Data, open: boolean): Block {
	const { config, ctx } = data;
	const reach = config.reach;
	return {
		type: "accordion",
		label: "Settings for the whole site",
		default_open: open || config.alertTo.length === 0 || reach?.result === "none",
		blocks: [
			header("Who hears when something needs fixing"),
			{
				type: "form",
				block_id: "alerts",
				fields: [
					{
						type: "text_input",
						action_id: "alert_to",
						label: "Email these people (separate several addresses with commas)",
						initial_value: config.alertTo.join(", "),
					},
				],
				submit: { label: "Save", action_id: "save_alerts" },
			},
			context(
				`One email a day at most for each kind of problem: an enquiry that could not be delivered, a form that has gone quiet, or retries that are not running. The subject starts with "${siteName(ctx, data.origin)}".`,
			),
			header("This site"),
			{
				type: "section",
				text: reach ? REACH_TEXT[reach.result] : "Not checked yet.",
				accessory: button("check_reach", reach ? "Check again" : "Check this site"),
			},
			...(reach ? [context(`Checked ${ago(reach.at)}.`)] : []),
			header("Private address"),
			section(
				"Your forms send enquiries to a private address only this site knows. If it has been shared by mistake, reset it.",
			),
			actions([
				button("reset_address", "Reset the private address", {
					style: "danger",
					confirm: {
						title: "Reset the private address?",
						text: "Every connected form stops sending to Lead delivery until it is connected again. Enquiries still reach Forms → Submissions.",
						confirm: "Reset address",
						deny: "Cancel",
						style: "danger",
					},
				}),
			]),
			context(KEEP_NOTE),
		],
	};
}

async function home(data: Data, view: Extract<View, { screen: "home" }>): Promise<Block[]> {
	const { ctx, config, admin } = data;
	const blocks: Block[] = [header("Lead delivery")];
	if (admin) blocks.push(actions([button("new", "+ New delivery", { style: "primary" })]));
	if (admin && config.notice) {
		blocks.push({
			type: "banner",
			variant: "default",
			title: "Lead delivery's setup is now a list of deliveries",
			description:
				"Each one is named after its form and where it sends. To rename one, open it and press Edit.",
		});
		blocks.push(actions([button("dismiss_notice", "OK")]));
	}

	if (config.deliveries.length === 0) {
		blocks.push(
			admin
				? {
						type: "empty",
						title: "Send every enquiry where you work",
						description:
							"Your forms' enquiries can go to your inbox, to HubSpot, or to another app such as Zapier, Make or n8n. Each one is logged here and tried again if it does not get through.",
						size: "lg",
						actions: [button("new", "+ New delivery", { style: "primary" })],
					}
				: {
						type: "empty",
						title: "Nothing is set up yet",
						description: "An admin of this site decides where enquiries are sent.",
						size: "lg",
					},
		);
		if (admin && config.alertTo.length === 0) blocks.push(settingsAccordion(data, true));
		blocks.push(
			context("Every enquiry is also kept in Forms → Submissions, whatever happens here."),
		);
		// The page shows the header button and the empty block's button; one is enough.
		if (admin) blocks.splice(1, 1);
		return blocks;
	}

	const statuses = new Map<string, Status>();
	for (const delivery of config.deliveries)
		statuses.set(delivery.id, await statusOf(ctx, delivery));
	const [counts, retrying, fixing, stuck, retryingCount] = await Promise.all([
		weekCounts(ctx),
		sends(ctx).query({ where: { status: "retrying" }, orderBy: { nextAt: "asc" }, limit: 1 }),
		needsFixing(ctx, 20),
		schedulerStuck(ctx),
		sends(ctx).count({ status: "retrying" }),
	]);
	const nextAt = retrying.items[0]?.data.nextAt;
	blocks.push({
		type: "stats",
		items: [
			{ label: "Received", value: counts.received, description: "Last 7 days" },
			{
				label: "Delivered",
				value: counts.delivered,
				description: "Last 7 days, to every delivery",
			},
			{
				label: "Trying again",
				value: retryingCount,
				description: nextAt ? `Next try ${inTime(nextAt)}` : "",
			},
			{
				label: "Needs fixing",
				value: fixing.length,
				description: fixing.length ? "See below" : "",
			},
		],
	});

	// One red banner per delivery that needs fixing; the service's own words beneath.
	for (const delivery of config.deliveries) {
		const status = statuses.get(delivery.id)!;
		const latest = status.fixing[0]?.data;
		if (!latest) continue;
		const plain = latest.plain ?? "It was refused.";
		blocks.push({
			type: "banner",
			variant: "error",
			title: `${delivery.name} needs fixing`,
			description: admin
				? plain
				: `${firstSentence(plain)} Ask the person who set up this site to fix it. You can press Send again once it is fixed.`,
		});
		if (latest.raw) blocks.push(context(latest.raw));
		blocks.push(
			actions([
				...(admin ? [button("open", `Open ${delivery.name}`, { value: delivery.id })] : []),
				button("send_all", "Send all failed again", {
					value: { delivery: delivery.id, from: { screen: "home" } },
				}),
			]),
		);
	}
	for (const form of quietForms(data.forms)) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: `No enquiries from ${form.name} ${since(form.lastAt!)}`,
			description:
				"It usually gets some every few days. Check the form still sends: send yourself an enquiry through it on your site.",
		});
	}
	if (stuck) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Retries are not running on this site",
			description:
				"Some enquiries did not get through at the first try. Lead delivery tries them again, but scheduled tasks are not running on this site, so it cannot. Ask your web person to check the site's scheduled tasks. Until then, press Send now.",
		});
	}
	const unreadable = await ctx.kv.get<{ formName: string; at: string }>(UNREADABLE_KEY);
	if (unreadable && Date.now() - Date.parse(unreadable.at) < 7 * 86_400_000) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: `An enquiry from ${unreadable.formName} was read as plain text`,
			description:
				"Lead delivery could not read its fields one by one, usually because EmDash's forms changed how they write their emails. Nothing was lost. Check for an update to Lead delivery, or reconnect the form from its delivery's page.",
		});
	}
	for (const group of await notSentForms(ctx)) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: `${plural(group.count, "enquiry", "enquiries")} from ${group.formName} ${group.count === 1 ? "was" : "were"} not sent: no delivery takes this form`,
			description: admin
				? "Add the form to a delivery to send them. They are also in Forms → Submissions."
				: "Ask the person who set up this site to add this form to a delivery. They are also in Forms → Submissions.",
		});
		if (!admin) continue;
		const only = config.deliveries.length === 1 ? config.deliveries[0]! : undefined;
		blocks.push(
			actions([
				only
					? button("adopt", `Add ${group.formName} to ${only.name} and send them`, {
							value: { form: group.formId, delivery: only.id },
						})
					: button("adopt_choose", `Add ${group.formName} to a delivery`, {
							value: group.formId,
						}),
			]),
		);
	}
	if (admin && config.alertTo.length === 0) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Nobody hears when an enquiry does not arrive",
			description: "Add an address under Settings for the whole site.",
		});
	}

	const order: StatusKind[] = ["fixing", "retrying", "waiting", "working", "off"];
	const sorted = [...config.deliveries].sort((a, b) => {
		const x = order.indexOf(statuses.get(a.id)!.kind) === 0 ? 0 : 1;
		const y = order.indexOf(statuses.get(b.id)!.kind) === 0 ? 0 : 1;
		return x - y || a.name.localeCompare(b.name);
	});
	blocks.push(header("Deliveries"), {
		type: "table",
		block_id: "deliveries",
		page_action_id: "deliveries_page",
		columns: [
			{ key: "delivery", label: "Delivery" },
			{ key: "status", label: "Status" },
			// One button per row: a second one runs off a 390 px phone with wider
			// fonts. Admins reach a delivery's enquiries from its page; Editors,
			// who have no page, open its enquiries directly.
			{ key: "go", label: "", format: "element" },
		],
		rows: sorted.map((d) => ({
			delivery: breakable(rowLabel(d)),
			status: statuses.get(d.id)!.label,
			go: admin
				? button("open", "Open", { value: d.id })
				: button("open_log", "Enquiries", { value: d.id }),
		})),
	});

	blocks.push(
		header("Latest enquiries"),
		await logTable(data, {
			limit: HOME_ROWS,
			from: { screen: "home" },
			empty: "No enquiries yet. They appear here as soon as someone sends one of your forms.",
		}),
		actions([button("see_all", "See all enquiries")]),
	);
	if (admin) blocks.push(settingsAccordion(data, view.settingsOpen === true));
	blocks.push(context("Every enquiry is also kept in Forms → Submissions."));
	return blocks;
}

// ─── All enquiries ──────────────────────────────────────────────────

async function allEnquiries(data: Data, view: Extract<View, { screen: "log" }>): Promise<Block[]> {
	const filter = findDelivery(data, view.filter) ? view.filter : "";
	const fixing = await needsFixing(data.ctx, 1, filter || undefined);
	return [
		back(),
		header("Enquiries"),
		{
			type: "form",
			block_id: "filter",
			fields: [
				{
					type: "select",
					action_id: "delivery",
					label: "Delivery",
					options: [
						{ value: "", label: "All deliveries" },
						...data.config.deliveries.map((d) => ({ value: d.id, label: d.name })),
					],
					initial_value: filter,
				},
			],
			submit: { label: "Show", action_id: "filter_log" },
		},
		...(fixing.length > 0
			? [
					actions([
						button("send_all", "Send all failed again", {
							value: { ...(filter ? { delivery: filter } : {}), from: { screen: "log", filter } },
						}),
					]),
				]
			: []),
		await logTable(data, {
			...(filter ? { destination: filter } : {}),
			limit: LOG_ROWS,
			...(view.cursor ? { cursor: view.cursor } : {}),
			from: { screen: "log", filter },
			empty: filter
				? "No enquiries through this delivery in the last 30 days."
				: "No enquiries yet. They appear here as soon as someone sends one of your forms.",
		}),
		context(KEEP_NOTE),
	];
}

// ─── New delivery ───────────────────────────────────────────────────

const KIND_LABELS = (hasEmail: boolean) => [
	{
		value: "email",
		label: hasEmail ? "Email: an inbox, or several" : "Email: set up email for this site first",
	},
	{ value: "hubspot", label: "HubSpot: each enquiry becomes a HubSpot form submission" },
	{
		value: "app",
		label:
			"Another app: Zapier, Make, n8n or your own. Zapier needs a paid plan for this; Make and n8n do not",
	},
];

function knownForms(data: Data): KnownForm[] {
	return Object.values(data.forms).sort((a, b) => a.name.localeCompare(b.name));
}

function newStep1(data: Data, view: Extract<View, { screen: "new" }>): Block[] {
	const known = knownForms(data);
	const draft = view.draft ?? {};
	const picked = str(draft.form) || known[0]?.slug || OTHER;
	return [
		back(),
		header("New delivery"),
		...(known.length === 0
			? [
					context(
						"Lead delivery learns your forms' names once one is connected or sends an enquiry.",
					),
				]
			: []),
		{
			type: "form",
			block_id: "new1",
			fields: [
				{
					type: "select",
					action_id: "form",
					label: "Which form?",
					options: [
						...known.map((f) => ({ value: f.slug, label: f.name })),
						{ value: OTHER, label: "Another form" },
					],
					initial_value: picked,
				},
				{
					type: "text_input",
					action_id: "short_name",
					label: "Its short name (Forms lists it under each form's name)",
					placeholder: "for example: quote",
					initial_value: str(draft.short_name),
					condition: { field: "form", eq: OTHER },
				},
				{
					type: "radio",
					action_id: "kind",
					label: "Send to?",
					options: KIND_LABELS(Boolean(data.ctx.email)),
					initial_value: str(draft.kind) || "email",
				},
			],
			submit: { label: "Continue", action_id: "new_continue" },
		},
	];
}

function matchingFields(
	delivery: Partial<Delivery>,
	form: KnownForm | { slug: string; fields: FieldInfo[] },
): FormField[] {
	const fields: FormField[] = [];
	const asDelivery = delivery as Delivery;
	for (const field of form.fields) {
		const choice = choiceFor(asDelivery, form.slug, field);
		fields.push({
			type: "select",
			action_id: `f:${field.key}`,
			label: field.label,
			options: [
				...(choice === UNMATCHED
					? [{ value: UNMATCHED, label: "Not matched yet: choose one" }]
					: []),
				...CHOICES.map((c) => ({ value: c.value, label: c.label })),
			],
			initial_value: choice,
		});
		fields.push({
			type: "text_input",
			action_id: `o:${field.key}`,
			label: `HubSpot field name for ${field.label}`,
			initial_value: delivery.otherNames?.[form.slug]?.[field.key] ?? "",
			condition: { field: `f:${field.key}`, eq: "other" },
		});
	}
	return fields;
}

function hubspotToggles(delivery: Partial<Delivery>): FormField[] {
	return [
		{
			type: "toggle",
			action_id: "gdpr",
			label: "My HubSpot account has its privacy (GDPR) settings on",
			description:
				"Turn on only if HubSpot asks for consent on your forms. Each enquiry then says the person agreed to their details being used to answer them.",
			initial_value: delivery.gdpr ?? false,
		},
		{
			type: "toggle",
			action_id: "throwaway",
			label: "Mark possibly fake email addresses in HubSpot",
			description:
				"Addresses from services that hand out short-lived inboxes (like mailinator.com) are often made up. They are still sent.",
			initial_value: Boolean(delivery.throwawayField),
		},
		{
			type: "text_input",
			action_id: "throwaway_field",
			label: "HubSpot field to mark (a checkbox field on your HubSpot form)",
			initial_value: delivery.throwawayField || "possibly_fake_email",
			condition: { field: "throwaway", eq: true },
		},
	];
}

function newStep2(data: Data, view: Extract<View, { screen: "new2" }>): Block[] {
	const { form, kind } = view;
	const draft = view.draft ?? {};
	const value = (key: string, fallback: string) => (key in draft ? str(draft[key]) : fallback);
	const prefilled = `${form.name} → ${kindWord(kind)}`;
	const fields: FormField[] = [];
	if (kind === "email") {
		fields.push({
			type: "text_input",
			action_id: "to",
			label: "Send each enquiry to (separate several addresses with commas)",
			initial_value: value("to", data.user?.email ?? ""),
		});
	} else if (kind === "hubspot") {
		fields.push({
			type: "text_input",
			action_id: "hubspot",
			label: "Your HubSpot form's share link or embed code (HubSpot → Marketing → Forms → Share)",
			initial_value: value("hubspot", ""),
		});
		fields.push(...matchingFields({}, form), ...hubspotToggles({}));
	} else {
		fields.push(
			{
				type: "select",
				action_id: "app",
				label: "Which app?",
				options: APPS.map((a) => ({ value: a.value, label: a.label })),
				initial_value: value("app", "zapier"),
			},
			{
				type: "text_input",
				action_id: "url",
				label: "The address the app gave you (starts with https://)",
				initial_value: value("url", ""),
			},
		);
	}
	fields.push({
		type: "text_input",
		action_id: "name",
		label: "Name (only admins see it)",
		initial_value: value("name", prefilled),
	});
	if (kind === "hubspot") {
		fields.push({
			type: "toggle",
			action_id: "test_now",
			// The warning is in the label: EmDash's admin does not show a switch's description.
			label: `Send a test to HubSpot now. It adds a contact called ${data.user?.name || "Test Enquiry"} with your email${data.user?.email ? ` (${data.user.email})` : ""} to HubSpot; you can delete it there afterwards.`,
			initial_value: draft.test_now === true,
		});
	}
	const blocks: Block[] = [
		back("Back", "new", { form: form.slug, kind }),
		header(`${form.name} → ${kindWord(kind)}`),
	];
	if (view.duplicate) {
		blocks.push(
			actions([button("open", `Open ${view.duplicate.name}`, { value: view.duplicate.id })]),
		);
	}
	if (kind === "hubspot") {
		blocks.push(
			context(
				form.fields.length
					? "Match your form's fields to HubSpot below. They were matched automatically where the names were obvious. The HubSpot form must have every field you send, at least Email."
					: "Your form's fields appear here after its first enquiry, or once this form is connected. You can match them later under Edit.",
			),
		);
	}
	blocks.push(
		{
			type: "form",
			block_id: `new2:${kind}:${form.slug}`,
			fields,
			submit: {
				label: kind === "hubspot" ? "Save" : "Save and send a test",
				action_id: "new_save",
			},
		},
		context("Change the name if you like."),
	);
	return blocks;
}

// ─── A delivery ─────────────────────────────────────────────────────

function sendsTo(data: Data, d: Delivery): string {
	const from = `from ${formsLabel(d.forms, data.forms)}`;
	if (d.kind === "email") return `Email to ${(d.to ?? []).join(", ")} · ${from}`;
	if (d.kind === "hubspot") return `HubSpot form in account ${d.portalId} · ${from}`;
	let host = d.url ?? "";
	try {
		host = new URL(host).host;
	} catch {
		// keep as typed
	}
	return `${appLabel(d.app)} at ${host} · ${from}`;
}

function testButton(d: Delivery, user: User | undefined): ButtonElement {
	if (d.kind !== "hubspot") return button("test", "Send a test", { value: d.id });
	return button("test", "Send a test", {
		value: d.id,
		confirm: {
			title: "Send a test to HubSpot?",
			text: `This adds a contact called ${user?.name || "Test Enquiry"} with your email${user?.email ? ` (${user.email})` : ""} to HubSpot. You can delete it there afterwards.`,
			confirm: "Send the test",
			deny: "Not now",
		},
	});
}

function testText(d: Delivery): string {
	if (!d.testedAt || !d.testResult) return "Not sent yet";
	const when = ago(d.testedAt);
	if (!d.testResult.ok) return `Did not arrive: ${d.testResult.plain ?? "it was refused"}`;
	if (d.kind === "email") return `Sent ${when}. Check the inbox, and the spam folder.`;
	const who = d.kind === "hubspot" ? "HubSpot" : appLabel(d.app);
	return `Arrived ${when}: ${who} accepted it.`;
}

function realText(data: Data, d: Delivery, status: Status): { text: string; connect?: KnownForm } {
	if (status.kind === "off") return { text: "Turned off: nothing is sent until you turn it on" };
	if (status.kind === "working" || (status.last && status.kind !== "waiting")) {
		return {
			text: status.last
				? `Arriving: last one ${ago(status.last.createdAt)} (${status.last.who})`
				: status.label,
		};
	}
	const forms = servedForms(data, d);
	const names = formsLabel(d.forms, data.forms);
	if (forms.length === 0) return { text: "Not sending yet: no form has sent an enquiry yet" };
	const missing = unconnectedForm(data, d);
	if (missing)
		return { text: `Not sending yet: ${missing.name} is not connected`, connect: missing };
	const sending = forms.some((f) => data.forms[f.slug]?.lastAt);
	if (!sending)
		return {
			text: `Not sending yet: ${names} ${forms.length === 1 ? "is" : "are"} connected. Send yourself an enquiry through it on your site`,
		};
	return {
		text: `Not sending yet: ${names} ${forms.length === 1 ? "sends" : "send"} enquiries, but none has come through this delivery yet`,
	};
}

function secretAccordion(secret: string | undefined, d: Delivery): Block {
	const blocks: Block[] = [
		section(
			"Each request is signed with the Standard Webhooks headers webhook-id, webhook-timestamp and webhook-signature. Your app checks the signature with this delivery's secret.",
		),
	];
	if (secret) {
		blocks.push(
			{ type: "code", code: secret },
			context("This secret is shown only now. Copy it before you leave this page."),
		);
	} else {
		blocks.push(
			context("The secret was shown when you saved this delivery."),
			actions([
				button("new_secret", "Make a new secret", {
					value: d.id,
					confirm: {
						title: "Make a new secret?",
						text: "Your app stops accepting enquiries until you give it the new secret.",
						confirm: "Make a new secret",
						deny: "Cancel",
					},
				}),
			]),
		);
	}
	return {
		type: "accordion",
		label: "For your web person: how to check an enquiry came from this site",
		default_open: Boolean(secret),
		blocks,
	};
}

async function deliveryPage(
	data: Data,
	d: Delivery,
	view: Extract<View, { screen: "delivery" }>,
): Promise<Block[]> {
	const status = await statusOf(data.ctx, d);
	const real = realText(data, d, status);
	const blocks: Block[] = [back()];
	if (view.secret && d.kind === "app") blocks.push(secretAccordion(view.secret, d));
	blocks.push(header(d.name), context(`${sendsTo(data, d)} · ${d.on ? "On" : "Off"}`));
	const latest = status.fixing[0]?.data;
	if (latest) {
		blocks.push({
			type: "banner",
			variant: "error",
			title: `${d.name} needs fixing`,
			description: latest.plain ?? "It was refused.",
		});
		if (latest.raw) blocks.push(context(latest.raw));
		blocks.push(
			actions([
				button("send_all", "Send all failed again", {
					value: { delivery: d.id, from: { screen: "delivery", id: d.id } },
				}),
			]),
		);
	}
	blocks.push(
		header("Checks"),
		{
			type: "fields",
			fields: [
				{ label: "Test", value: testText(d) },
				{ label: "Real enquiries", value: real.text },
			],
		},
		actions([
			...(real.connect
				? [
						button("connect", "Connect this form", {
							style: "primary",
							value: { id: d.id, form: real.connect.slug },
						}),
					]
				: []),
			testButton(d, data.user),
			button("edit", "Edit", { value: d.id }),
			button("toggle", d.on ? "Turn off" : "Turn on", { value: d.id }),
		]),
	);
	// A typed short name that never received anything, while another form's enquiries went nowhere.
	const silent = silentForms(data, d)[0];
	const arrived = silent
		? (await notSentForms(data.ctx)).find((g) => !servesForm(d, g.formId))
		: undefined;
	if (silent && arrived) {
		blocks.push(
			context(
				`Nothing has arrived from ${formName(silent, data.forms)}. Enquiries arrived from ${arrived.formName} instead: is that the one?`,
			),
			actions([
				button("adopt", `Yes, use ${arrived.formName}`, {
					value: { form: arrived.formId, delivery: d.id },
				}),
			]),
		);
	}
	if (d.kind === "hubspot") {
		const forms = servedForms(data, d).filter((f) => f.fields.length > 0);
		const unmatched = forms.some((f) => matchedCount(d, f.slug, f.fields) < f.fields.length);
		if (unmatched) {
			blocks.push(
				context(
					"Some of your form's fields are not matched to HubSpot yet, so they are not sent. Press Edit to match them.",
				),
			);
		}
	}
	blocks.push(
		header("Repeats and spam"),
		{
			type: "form",
			block_id: `repeats:${d.id}`,
			fields: [
				{
					type: "radio",
					action_id: "repeat",
					label: "Same email address again",
					options: [
						{ value: "off", label: "Send every enquiry (recommended for email)" },
						{ value: "24h", label: "Don't send the same address twice within 24 hours" },
						{ value: "7d", label: "Don't send the same address twice within 7 days" },
					],
					initial_value: d.repeat,
				},
				{
					type: "toggle",
					action_id: "hold_spam",
					label: "Don't send possibly spam",
					description:
						"Enquiries marked possibly spam are kept in the log as Not sent, with Send again.",
					initial_value: d.holdSpam,
				},
			],
			submit: { label: "Save", action_id: "save_repeats" },
		},
		context(
			'Marked enquiries (possibly fake address, same address again, possibly spam) are still sent, with the marks at the top of each email. Turn on "Don\'t send possibly spam" to hold those. Every enquiry is also in Forms → Submissions.',
		),
		header("Enquiries through this delivery"),
		await logTable(data, {
			destination: d.id,
			limit: LOG_ROWS,
			...(view.cursor ? { cursor: view.cursor } : {}),
			from: { screen: "delivery", id: d.id },
			empty: "No enquiries through this delivery yet.",
		}),
	);
	if (d.kind === "app" && !view.secret) blocks.push(secretAccordion(undefined, d));
	const others = data.config.deliveries.filter(
		(o) => o.id !== d.id && servedForms(data, d).some((f) => servesForm(o, f.slug)),
	);
	const where =
		d.kind === "email"
			? (d.to ?? []).join(", ")
			: d.kind === "hubspot"
				? "HubSpot"
				: appLabel(d.app);
	const names = formsLabel(d.forms, data.forms);
	blocks.push(
		divider(),
		actions([
			button("delete", "Delete this delivery", {
				value: d.id,
				style: "danger",
				confirm: {
					title: `Delete ${d.name}?`,
					text: `Nothing more is sent to ${where} from ${names}. Its past enquiries stay in the log for 30 days, and every enquiry stays in Forms → Submissions. ${
						others.length > 0
							? "The form stays connected for its other deliveries."
							: `${names} will have nowhere to send. Its enquiries still arrive here and are listed as Not sent.`
					}`,
					confirm: "Delete",
					deny: "Cancel",
					style: "danger",
				},
			}),
		]),
	);
	return blocks;
}

/** A delivery's forms that were named but never sent anything (usually a typed short name). */
function silentForms(data: Data, d: Delivery): string[] {
	if (d.forms === "all") return [];
	return d.forms.filter((slug) => !data.forms[slug]?.lastAt);
}

/** Pick the delivery that takes a form no delivery took; the silent ones first. */
async function adoptPage(data: Data, form: string): Promise<Block[]> {
	const group = (await notSentForms(data.ctx)).find((g) => g.formId === form);
	const name = group?.formName ?? formName(form, data.forms);
	const ordered = [...data.config.deliveries].sort(
		(a, b) => Number(silentForms(data, b).length > 0) - Number(silentForms(data, a).length > 0),
	);
	return [
		back(),
		header(`Send the enquiries from ${name}`),
		section(
			`${group ? plural(group.count, "enquiry", "enquiries") : "Enquiries"} from ${name} arrived, but no delivery takes this form. Choose the delivery that should: the form is added to it and the enquiries are sent.`,
		),
		{
			type: "form",
			block_id: `adopt:${form}`,
			fields: [
				{
					type: "radio",
					action_id: "delivery",
					label: "Which delivery should take them?",
					options: ordered.map((d) => {
						const silent = silentForms(data, d);
						return {
							value: d.id,
							label: silent.length
								? `${d.name} (nothing has arrived from ${silent.map((s) => formName(s, data.forms)).join(" or ")} yet)`
								: d.name,
						};
					}),
					...(ordered[0] ? { initial_value: ordered[0].id } : {}),
				},
			],
			submit: { label: "Add and send", action_id: "adopt" },
		},
	];
}

// ─── Edit ───────────────────────────────────────────────────────────

function editPage(data: Data, d: Delivery, view: Extract<View, { screen: "edit" }>): Block[] {
	const draft = view.draft ?? {};
	const value = (key: string, fallback: string) => (key in draft ? str(draft[key]) : fallback);
	const flag = (key: string, fallback: boolean) => (key in draft ? draft[key] === true : fallback);
	const fields: FormField[] = [
		{
			type: "text_input",
			action_id: "name",
			label: "Name (only admins see it)",
			initial_value: value("name", d.name),
		},
	];
	if (d.kind === "email") {
		fields.push({
			type: "text_input",
			action_id: "to",
			label: "Send each enquiry to (separate several addresses with commas)",
			initial_value: value("to", (d.to ?? []).join(", ")),
		});
	} else if (d.kind === "hubspot") {
		fields.push({
			type: "text_input",
			action_id: "hubspot",
			label: "Your HubSpot form's share link or embed code",
			initial_value: value("hubspot", `portalId: "${d.portalId}", formId: "${d.formGuid}"`),
		});
	} else {
		fields.push(
			{
				type: "select",
				action_id: "app",
				label: "Which app?",
				options: APPS.map((a) => ({ value: a.value, label: a.label })),
				initial_value: value("app", d.app ?? "other"),
			},
			{
				type: "text_input",
				action_id: "url",
				label: "The address the app gave you (starts with https://)",
				initial_value: value("url", d.url ?? ""),
			},
		);
	}
	const slugs = new Set([...Object.keys(data.forms), ...(d.forms === "all" ? [] : d.forms)]);
	const formsValue =
		"forms" in draft && Array.isArray(draft.forms)
			? (draft.forms as string[])
			: d.forms === "all"
				? ["all"]
				: d.forms;
	fields.push(
		{
			type: "checkbox",
			action_id: "forms",
			label: "Which forms",
			options: [
				{ value: "all", label: "All forms, including new ones" },
				...[...slugs]
					.map((slug) => ({ value: slug, label: formName(slug, data.forms) }))
					.sort((a, b) => a.label.localeCompare(b.label)),
			],
			initial_value: formsValue,
		},
		{
			type: "toggle",
			action_id: "on",
			label: "On",
			description: "Off keeps the delivery but sends nothing.",
			initial_value: flag("on", d.on),
		},
	);
	const blocks: Block[] = [
		back(`Back to ${d.name}`, "open", d.id),
		header(`Edit ${d.name}`),
		{
			type: "form",
			block_id: `edit:${d.id}`,
			fields,
			submit: { label: "Save", action_id: "save_edit" },
		},
		context(
			"Usually one form. Several forms suit an inbox that gets everything. Off keeps the delivery but sends nothing.",
		),
	];
	if (d.kind === "hubspot") {
		blocks.splice(3, 0, context(`HubSpot account ${d.portalId}, form ${d.formGuid}.`));
		blocks.push(header("Match your form's fields to HubSpot"));
		const served = servedForms(data, d);
		if (served.length === 0) {
			blocks.push(context("Your forms' fields appear here after their first enquiry."));
		}
		for (const form of served) {
			const matched = matchedCount(d, form.slug, form.fields);
			const inner: Block[] = [];
			if (form.fields.length === 0) {
				inner.push(
					context(
						"Your form's fields appear here after its first enquiry, or once this site can look the form up.",
					),
				);
			} else {
				inner.push(
					context(
						"Choose the HubSpot field each of your form's fields goes to. The HubSpot form must have every field you send, at least Email.",
					),
					{
						type: "form",
						block_id: `match:${d.id}:${form.slug}`,
						fields: [...matchingFields(d, form), ...hubspotToggles(d)],
						submit: { label: "Save matching", action_id: "save_matching" },
					},
				);
			}
			inner.push(
				context(
					"Files are never sent; they stay in Forms → Submissions. The page each enquiry came from is sent to HubSpot when your form provides it.",
				),
			);
			blocks.push({
				type: "accordion",
				label: `${form.name}: ${matched} of ${form.fields.length} fields matched`,
				default_open: matched < form.fields.length,
				blocks: inner,
			});
		}
	}
	return blocks;
}

// ─── Connect this form ──────────────────────────────────────────────

function connectPage(data: Data, d: Delivery, view: Extract<View, { screen: "connect" }>): Block[] {
	const { config, ctx } = data;
	const name = formName(view.form, data.forms);
	const reach = config.reach?.result;
	const blocks: Block[] = [back(`Back to ${d.name}`, "open", d.id)];
	if (view.secret && d.kind === "app") blocks.push(secretAccordion(view.secret, d));
	blocks.push(header(`Connect ${name}`));
	if (reach === "none") {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Set up email for this site first",
			description:
				"This site cannot send to its own address, and it has no way to send email, so your forms have no way to hand enquiries over. Ask your web person to set up email for the site, then press Check again under Settings for the whole site.",
		});
	}
	blocks.push(
		section(
			"Your form needs to be told to hand each enquiry to Lead delivery. EmDash's form editor cannot do that yet, so someone who looks after the site's code does it once. It takes about five minutes.",
		),
		{
			type: "accordion",
			label: "Instructions for your web person",
			default_open: true,
			blocks: [
				context("Select the text and copy it, or email it."),
				{
					type: "code",
					code: instructions({
						site: siteName(ctx, data.origin),
						origin: data.origin,
						key: config.key,
						form: { slug: view.form, name },
						reach,
					}),
				},
				{
					type: "form",
					block_id: `instructions:${d.id}:${view.form}`,
					fields: [{ type: "text_input", action_id: "to", label: "Email these instructions to" }],
					submit: { label: "Email instructions", action_id: "email_instructions" },
				},
				actions([
					button("connected", "I have done this", { value: { id: d.id, form: view.form } }),
				]),
				context(
					"I have done this marks the form connected. The delivery says Working once its first real enquiry arrives.",
				),
			],
		},
		actions([button("open", "Skip for now", { value: d.id })]),
	);
	return blocks;
}

// ─── Page ───────────────────────────────────────────────────────────

async function render(data: Data, view: View = { screen: "home" }): Promise<BlockResponse> {
	let blocks: Block[];
	const delivery = "id" in view ? findDelivery(data, view.id) : undefined;
	if (view.screen === "new" && data.admin) blocks = newStep1(data, view);
	else if (view.screen === "new2" && data.admin) blocks = newStep2(data, view);
	else if (view.screen === "delivery" && delivery && data.admin)
		blocks = await deliveryPage(data, delivery, view);
	else if (view.screen === "edit" && delivery && data.admin)
		blocks = editPage(data, delivery, view);
	else if (view.screen === "connect" && delivery && data.admin)
		blocks = connectPage(data, delivery, view);
	else if (view.screen === "log") blocks = await allEnquiries(data, view);
	else if (view.screen === "adopt" && data.admin) blocks = await adoptPage(data, view.form);
	else blocks = await home(data, view.screen === "home" ? view : { screen: "home" });
	return { blocks, ...(view.toast ? { toast: view.toast } : {}) };
}

async function widget(data: Data): Promise<BlockResponse> {
	const counts = await weekCounts(data.ctx);
	const fixing = await needsFixing(data.ctx, 20);
	const blocks: Block[] = [
		{
			type: "stats",
			items: [
				{ label: "Received", value: counts.received },
				{ label: "Delivered", value: counts.delivered },
			],
		},
	];
	if (fixing.length > 0) {
		blocks.push({
			type: "banner",
			variant: "error",
			title: `${fixing.length} needs fixing`,
			description: `"${deliveryName(data.config, fixing[0]!.data.destination)}" needs fixing.`,
		});
	}
	blocks.push(
		actions([
			{ type: "link", label: "Open Lead delivery", target: { kind: "plugin-page", path: PAGE } },
		]),
	);
	return { blocks };
}

const ok = (message: string): BlockResponse["toast"] => ({ type: "success", message });
const fail = (message: string): BlockResponse["toast"] => ({ type: "error", message });
const info = (message: string): BlockResponse["toast"] => ({ type: "info", message });

/** Destination details from a form. The kind never changes after a delivery is made. */
function detailsFromForm(
	kind: DeliveryKind,
	values: Record<string, unknown>,
	existing: Delivery | undefined,
): { details: Partial<Delivery>; secret?: string } | { error: string } {
	if (kind === "email") {
		const parsed = parseAddresses(str(values.to));
		if ("bad" in parsed) return { error: `"${parsed.bad}" is not an email address.` };
		if (parsed.list.length === 0) return { error: "Add the email address enquiries should go to." };
		return { details: { to: parsed.list } };
	}
	if (kind === "hubspot") {
		const parsed = parseHubSpot(str(values.hubspot));
		if ("error" in parsed) {
			return {
				error: str(values.hubspot).trim()
					? "That does not look like a HubSpot form's share link or embed code. In HubSpot open Marketing → Forms → your form → Share, and copy the link."
					: parsed.error,
			};
		}
		return { details: { portalId: parsed.portalId, formGuid: parsed.formGuid } };
	}
	const url = str(values.url).trim();
	let parsedUrl: URL | null = null;
	try {
		parsedUrl = new URL(url);
	} catch {
		parsedUrl = null;
	}
	if (!parsedUrl || parsedUrl.protocol !== "https:") {
		return { error: "The app's address must start with https://. Copy it again from the app." };
	}
	if (
		/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(parsedUrl.hostname) ||
		parsedUrl.hostname.endsWith(".local")
	) {
		return { error: "That address is on a private network, so this site cannot send to it." };
	}
	const app = APPS.some((a) => a.value === values.app) ? (values.app as Delivery["app"]) : "other";
	const keep = existing?.kind === "app" && existing.secret;
	const secret = keep ? existing.secret! : newSecret();
	return { details: { app, url: parsedUrl.href, secret }, ...(keep ? {} : { secret }) };
}

/** HubSpot matching for one form from a form's values; or the field that still needs a name. */
function matchingFromForm(
	values: Record<string, unknown>,
): { mapping: Record<string, string>; others: Record<string, string> } | { missing: string } {
	const mapping: Record<string, string> = {};
	const others: Record<string, string> = {};
	for (const [key, v] of Object.entries(values)) {
		if (key.startsWith("f:") && typeof v === "string") mapping[key.slice(2)] = v;
		if (key.startsWith("o:") && typeof v === "string" && v.trim()) others[key.slice(2)] = v.trim();
	}
	const missing = Object.entries(mapping).find(([key, v]) => v === "other" && !others[key]);
	return missing ? { missing: missing[0] } : { mapping, others };
}

function sameDestination(a: Delivery, b: Partial<Delivery> & { kind: DeliveryKind }): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "email") return (a.to ?? []).some((x) => (b.to ?? []).includes(x));
	if (a.kind === "hubspot") return a.portalId === b.portalId && a.formGuid === b.formGuid;
	return a.url === b.url;
}

function testEnquiry(data: Data, d: Delivery): Enquiry {
	const form = servedForms(data, d).find((f) => f.fields.length > 0);
	const name = data.user?.name || "Test Enquiry";
	const email = data.user?.email ?? "";
	const fields = (
		form?.fields ?? [
			{ key: "name", label: "Your name", type: "text" },
			{ key: "email", label: "Email", type: "email" },
			{ key: "message", label: "Message", type: "textarea" },
		]
	).map((f) => {
		const choice = choiceFor(d, form?.slug ?? "", f);
		const value =
			choice === "email" || f.type === "email"
				? email
				: choice === "fullname" || /name/i.test(f.key)
					? name
					: choice === "consent"
						? "no"
						: "Test from Lead delivery";
		return { ...f, value };
	});
	const single = Array.isArray(d.forms) && d.forms.length === 1 ? d.forms[0]! : undefined;
	return {
		formId: form?.slug ?? single ?? "test",
		formName: form?.name ?? (single ? formName(single, data.forms) : "Test"),
		receivedAt: new Date().toISOString(),
		fields: fields.filter((f) => f.value),
		...(email ? { email } : {}),
		name,
		via: "test",
		throwaway: false,
		hasFiles: false,
	};
}

/** Send a test through one delivery (even when it is off), and remember how it went. */
async function sendTest(data: Data, d: Delivery): Promise<{ ok: boolean; message: string }> {
	const id = `test-${newId()}`;
	const enquiry = testEnquiry(data, d);
	const { ctx } = data;
	await receive(ctx, id, enquiry, { inline: true, only: d });
	const row = await sends(ctx).get(`${id}~${d.id}`);
	const label = d.kind === "hubspot" ? "HubSpot" : d.kind === "app" ? appLabel(d.app) : "Email";
	const result: Delivery["testResult"] =
		row?.status === "delivered"
			? { ok: true }
			: row?.status === "retrying"
				? { ok: false, plain: `${label} did not answer. It is tried again.` }
				: {
						ok: false,
						plain: row?.plain ?? `${label} did not accept it.`,
						...(row?.raw ? { raw: row.raw } : {}),
					};
	const config = await loadConfig(ctx);
	await saveConfig(ctx, {
		...config,
		deliveries: config.deliveries.map((x) =>
			x.id === d.id ? { ...x, testedAt: new Date().toISOString(), testResult: result } : x,
		),
	});
	if (!result.ok) return { ok: false, message: result.plain ?? "" };
	if (d.kind === "email")
		return {
			ok: true,
			message: `A test went to ${(d.to ?? []).join(", ")}: check the inbox, and the spam folder.`,
		};
	if (d.kind === "hubspot")
		return {
			ok: true,
			message: `HubSpot accepted the test. Look for ${enquiry.name} in HubSpot → Contacts.`,
		};
	return { ok: true, message: `${label} accepted the test.` };
}

function valueOf(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function fromView(from: unknown): View {
	const f = valueOf(from);
	if (f.screen === "delivery" && typeof f.id === "string") return { screen: "delivery", id: f.id };
	if (f.screen === "log") return { screen: "log", filter: str(f.filter) };
	return { screen: "home" };
}

export async function handleAdmin(
	input: unknown,
	user: User | undefined,
	requestUrl: string,
	ctx: PluginContext,
): Promise<BlockResponse> {
	const config = await loadConfig(ctx);
	const admin = (user?.role ?? 0) >= ADMIN_ROLE;
	// Alerts go to the admin who first opens the page until someone changes the list.
	if (admin && user?.email && config.alertTo.length === 0) {
		config.alertTo = [user.email.toLowerCase()];
		await saveConfig(ctx, config);
	}
	const data: Data = {
		ctx,
		config,
		forms: await loadForms(ctx),
		origin: siteOrigin(ctx, requestUrl),
		...(user ? { user } : {}),
		admin,
	};
	const interaction = isRecord(input) ? input : {};
	const action = str(interaction.action_id);
	const value = interaction.value;
	const values = isRecord(interaction.values) ? interaction.values : {};
	const blockId = str(interaction.block_id);
	const fresh = async (): Promise<Data> => ({
		...data,
		config: await loadConfig(ctx),
		forms: await loadForms(ctx),
	});

	if (interaction.type === "page_load" && str(interaction.page) === "widget:enquiries")
		return widget(data);
	if (interaction.type === "page_load" || action === "" || action === "home") return render(data);

	// Anyone who can open the page may look through the log and send an enquiry again.
	if (action === "see_all") return render(data, { screen: "log", filter: "" });
	if (action === "open_log") return render(data, { screen: "log", filter: str(value) });
	if (action === "filter_log") return render(data, { screen: "log", filter: str(values.delivery) });
	if (action === "log_page") {
		const cursor = str(valueOf(value).cursor);
		const [, where, ref] = blockId.split(":");
		if (where === "delivery" && ref && admin)
			return render(data, { screen: "delivery", id: ref, ...(cursor ? { cursor } : {}) });
		return render(data, { screen: "log", filter: ref ?? "", ...(cursor ? { cursor } : {}) });
	}
	if (action === "send_again" || action === "send_now") {
		const v = valueOf(value);
		const row = await sendAgain(ctx, str(v.row) || str(value));
		const name = row ? deliveryName(data.config, row.destination) : "";
		const toast =
			row?.status === "delivered"
				? ok(`Sent again. "${name}" delivered ${row.who}'s enquiry.`)
				: row?.status === "retrying"
					? info(`"${name}" did not answer. It is tried again ${inTime(row.nextAt)}.`)
					: fail(row?.plain ?? "That enquiry is no longer here.");
		const returnTo = fromView(v.from);
		return render(await fresh(), {
			...(returnTo.screen === "delivery" && !admin ? { screen: "home" } : returnTo),
			toast,
		});
	}
	if (action === "send_all") {
		const v = valueOf(value);
		const only = str(v.delivery);
		const rows = await needsFixing(ctx, 10, only || undefined);
		let sent = 0;
		for (const row of rows) if ((await sendAgain(ctx, row.id))?.status === "delivered") sent += 1;
		const returnTo = fromView(v.from);
		return render(await fresh(), {
			...(returnTo.screen === "delivery" && !admin ? { screen: "home" } : returnTo),
			toast:
				sent === rows.length
					? ok(`Sent again: ${plural(sent, "enquiry", "enquiries")}.`)
					: fail(`${sent} of ${rows.length} sent. The rest still need fixing.`),
		});
	}
	if (!admin)
		return render(data, { screen: "home", toast: fail("Only an admin can change this.") });

	// New delivery
	if (action === "new") {
		const v = valueOf(value);
		return render(data, { screen: "new", ...(v.form ? { draft: v } : {}) });
	}
	if (action === "new_continue") {
		const picked = str(values.form);
		const kind = (["email", "hubspot", "app"] as const).find((k) => k === values.kind) ?? "email";
		const again = (message: string) =>
			render(data, { screen: "new", draft: values, toast: fail(message) });
		if (!picked) return again("Choose a form.");
		if (picked === OTHER && !str(values.short_name).trim())
			return again("Type the form's short name.");
		if (kind === "email" && !ctx.email)
			return again("Set up email for this site first: it has no way to send email yet.");
		const form = await findForm(
			ctx,
			data.origin,
			picked === OTHER ? str(values.short_name) : picked,
			data.forms,
		);
		if ("error" in form) return again(form.error);
		return render(data, { screen: "new2", form, kind });
	}
	if (action === "new_save") {
		const [, kindText, slug] = blockId.split(":");
		const kind = (["email", "hubspot", "app"] as const).find((k) => k === kindText);
		if (!kind || !slug) return render(data, { screen: "new" });
		const form = await findForm(ctx, data.origin, slug, data.forms);
		if ("error" in form) return render(data, { screen: "new", toast: fail(form.error) });
		const again = (message: string, duplicate?: Delivery) =>
			render(data, {
				screen: "new2",
				form,
				kind,
				draft: values,
				...(duplicate ? { duplicate } : {}),
				toast: fail(message),
			});
		const parsed = detailsFromForm(kind, values, undefined);
		if ("error" in parsed) return again(parsed.error);
		const matching = kind === "hubspot" ? matchingFromForm(values) : undefined;
		if (matching && "missing" in matching) {
			const field = form.fields.find((f) => f.key === matching.missing)?.label ?? matching.missing;
			return again(`Type the HubSpot field name for ${field}.`);
		}
		const draftDelivery = { kind, ...parsed.details };
		const duplicate = data.config.deliveries.find(
			(d) =>
				servesForm(d, form.slug) && Array.isArray(d.forms) && sameDestination(d, draftDelivery),
		);
		if (duplicate) {
			const where =
				kind === "email"
					? (duplicate.to ?? []).join(", ")
					: kind === "hubspot"
						? "that HubSpot form"
						: "that address";
			return again(`${form.name} already goes to ${where} (${duplicate.name}).`, duplicate);
		}
		await rememberForm(ctx, form);
		const forms = await loadForms(ctx);
		const typed = str(values.name).trim().slice(0, 100);
		const prefilled = `${form.name} → ${kindWord(kind)}`;
		const name =
			!typed || typed === prefilled ? generatedName([form.slug], draftDelivery, forms) : typed;
		const delivery: Delivery = {
			id: newId(),
			kind,
			name,
			forms: [form.slug],
			on: true,
			repeat: "off",
			holdSpam: false,
			createdAt: new Date().toISOString(),
			...parsed.details,
			...(matching && "mapping" in matching
				? {
						mapping: { [form.slug]: matching.mapping },
						otherNames: { [form.slug]: matching.others },
						gdpr: values.gdpr === true,
						throwawayField:
							values.throwaway === true
								? str(values.throwaway_field).trim() || "possibly_fake_email"
								: "",
					}
				: {}),
		};
		await saveConfig(ctx, { ...data.config, deliveries: [...data.config.deliveries, delivery] });
		let saved = await fresh();
		let toast: BlockResponse["toast"];
		if (kind !== "hubspot" || values.test_now === true) {
			const test = await sendTest(saved, delivery);
			toast = test.ok
				? ok(`Saved as "${name}". ${test.message}`)
				: fail(`Saved, but the test did not arrive: ${test.message}`);
			saved = await fresh();
		} else {
			toast = ok(
				`Saved as "${name}". Found HubSpot account ${delivery.portalId}. Press Send a test when you are ready: it adds a contact to HubSpot.`,
			);
		}
		if (!form.checked && toast?.type === "success") {
			toast = info(
				`${toast.message} This site could not look the form up, so its fields will be learned from its first enquiry.`,
			);
		}
		const secret = parsed.secret ? { secret: parsed.secret } : {};
		if (!isConnected(saved.forms[form.slug], saved.config.keySetAt)) {
			if (!saved.config.reach) {
				const result = await checkReach(ctx, data.origin);
				await saveConfig(ctx, { ...saved.config, reach: { result, at: new Date().toISOString() } });
				saved = await fresh();
			}
			return render(saved, {
				screen: "connect",
				id: delivery.id,
				form: form.slug,
				...secret,
				toast,
			});
		}
		return render(saved, { screen: "delivery", id: delivery.id, ...secret, toast });
	}

	// A delivery
	if (action === "open") return render(data, { screen: "delivery", id: str(value) });
	if (action === "edit") return render(data, { screen: "edit", id: str(value) });
	if (action === "test") {
		const d = findDelivery(data, str(value));
		if (!d) return render(data);
		const test = await sendTest(data, d);
		return render(await fresh(), {
			screen: "delivery",
			id: d.id,
			toast: test.ok ? ok(test.message) : fail(`The test did not arrive: ${test.message}`),
		});
	}
	if (action === "toggle") {
		const deliveries = data.config.deliveries.map((d) =>
			d.id === str(value) ? { ...d, on: !d.on } : d,
		);
		await saveConfig(ctx, { ...data.config, deliveries });
		const d = deliveries.find((x) => x.id === str(value));
		return render(await fresh(), {
			screen: "delivery",
			id: str(value),
			toast: ok(d?.on ? "Turned on." : "Turned off. Nothing is sent until you turn it on."),
		});
	}
	if (action === "save_repeats") {
		const id = blockId.slice("repeats:".length);
		const repeat = (["off", "24h", "7d"] as Repeat[]).find((r) => r === values.repeat) ?? "off";
		await saveConfig(ctx, {
			...data.config,
			deliveries: data.config.deliveries.map((d) =>
				d.id === id ? { ...d, repeat, holdSpam: values.hold_spam === true } : d,
			),
		});
		return render(await fresh(), { screen: "delivery", id, toast: ok("Saved.") });
	}
	if (action === "new_secret") {
		const id = str(value);
		const secret = newSecret();
		await saveConfig(ctx, {
			...data.config,
			deliveries: data.config.deliveries.map((d) => (d.id === id ? { ...d, secret } : d)),
		});
		return render(await fresh(), {
			screen: "delivery",
			id,
			secret,
			toast: ok("A new secret was made. Give it to your app now."),
		});
	}
	if (action === "delete") {
		const id = str(value);
		const d = findDelivery(data, id);
		// Enquiries still on their way here stay in the log as Not sent.
		for (const status of ["retrying", "fixing", "gaveup"]) {
			const open = await sends(ctx).query({ where: { destination: id, status }, limit: 100 });
			if (open.items.length === 0) continue;
			await sends(ctx).putMany(
				open.items.map((item) => ({
					id: item.id,
					data: {
						...item.data,
						status: "skipped" as const,
						nextAt: "",
						held: false,
						notes: [...item.data.notes, "Its delivery was deleted; not sent"],
					},
				})),
			);
		}
		await saveConfig(ctx, {
			...data.config,
			deliveries: data.config.deliveries.filter((x) => x.id !== id),
		});
		return render(await fresh(), {
			screen: "home",
			toast: ok(`Deleted ${d?.name ?? "the delivery"}.`),
		});
	}
	if (action === "save_edit") {
		const id = blockId.slice("edit:".length);
		const d = findDelivery(data, id);
		if (!d) return render(data);
		const again = (message: string) =>
			render(data, { screen: "edit", id, draft: values, toast: fail(message) });
		const picked = Array.isArray(values.forms)
			? values.forms.filter((v): v is string => typeof v === "string")
			: [];
		if (picked.length === 0) return again("Choose a form.");
		const forms: Delivery["forms"] = picked.includes("all") ? "all" : picked;
		const parsed = detailsFromForm(d.kind, values, d);
		if ("error" in parsed) return again(parsed.error);
		const name =
			str(values.name).trim().slice(0, 100) ||
			generatedName(forms, { ...d, ...parsed.details }, data.forms);
		const updated: Delivery = { ...d, ...parsed.details, name, forms, on: values.on !== false };
		await saveConfig(ctx, {
			...data.config,
			deliveries: data.config.deliveries.map((x) => (x.id === id ? updated : x)),
		});
		if (d.kind === "hubspot" && data.origin) await refreshDefinitions(ctx, data.origin);
		const saved = await fresh();
		const message =
			forms === "all" && picked.length > 1
				? "Saved. It takes all forms, including new ones, so the other ticks were not needed."
				: "Saved.";
		const newForm =
			forms === "all"
				? undefined
				: forms.find((slug) => !isConnected(saved.forms[slug], saved.config.keySetAt));
		if (newForm && (d.forms === "all" || !d.forms.includes(newForm))) {
			return render(saved, { screen: "connect", id, form: newForm, toast: ok(message) });
		}
		return render(saved, { screen: "delivery", id, toast: ok(message) });
	}
	if (action === "save_matching") {
		const [, id, form] = blockId.split(":");
		const d = id ? findDelivery(data, id) : undefined;
		if (!d || !form) return render(data);
		const matching = matchingFromForm(values);
		if ("missing" in matching) {
			const label =
				data.forms[form]?.fields.find((f) => f.key === matching.missing)?.label ?? matching.missing;
			return render(data, {
				screen: "edit",
				id: d.id,
				toast: fail(`Type the HubSpot field name for ${label}.`),
			});
		}
		const updated: Delivery = {
			...d,
			mapping: { ...d.mapping, [form]: matching.mapping },
			otherNames: { ...d.otherNames, [form]: matching.others },
			gdpr: values.gdpr === true,
			throwawayField:
				values.throwaway === true
					? str(values.throwaway_field).trim() || "possibly_fake_email"
					: "",
		};
		await saveConfig(ctx, {
			...data.config,
			deliveries: data.config.deliveries.map((x) => (x.id === d.id ? updated : x)),
		});
		return render(await fresh(), { screen: "edit", id: d.id, toast: ok("Matching saved.") });
	}

	// Enquiries from a form no delivery took
	if (action === "adopt_choose") return render(data, { screen: "adopt", form: str(value) });
	if (action === "adopt") {
		const v = valueOf(value);
		const form = blockId.startsWith("adopt:") ? blockId.slice("adopt:".length) : str(v.form);
		const deliveryId = blockId.startsWith("adopt:") ? str(values.delivery) : str(v.delivery);
		const group = (await notSentForms(ctx)).find((g) => g.formId === form);
		const result = await adoptForm(ctx, form, deliveryId);
		if (!result) return render(data, { screen: "home", toast: fail("Choose a delivery.") });
		const name = group?.formName ?? formName(form, data.forms);
		return render(await fresh(), {
			screen: "home",
			toast: ok(
				`"${result.delivery.name}" now takes ${name}. ${
					result.count === 0
						? ""
						: result.count === 1
							? "Sending its enquiry."
							: `Sending its ${result.count} enquiries.`
				}`.trim(),
			),
		});
	}

	// Connect this form
	if (action === "connect") {
		const v = valueOf(value);
		const id = str(v.id);
		if (!data.config.reach) {
			const result = await checkReach(ctx, data.origin);
			await saveConfig(ctx, { ...data.config, reach: { result, at: new Date().toISOString() } });
		}
		return render(await fresh(), { screen: "connect", id, form: str(v.form) });
	}
	if (action === "connected") {
		const v = valueOf(value);
		await markConnected(ctx, str(v.form), data.config.keySetAt);
		return render(await fresh(), {
			screen: "delivery",
			id: str(v.id),
			toast: ok(
				`${formName(str(v.form), data.forms)} is marked connected. Send yourself an enquiry through it on your site to check.`,
			),
		});
	}
	if (action === "email_instructions") {
		const [, id, form] = blockId.split(":");
		const view: View = { screen: "connect", id: id ?? "", form: form ?? "" };
		const parsed = parseAddresses(str(values.to));
		if ("bad" in parsed || parsed.list.length === 0) {
			return render(data, { ...view, toast: fail("Type the email address of your web person.") });
		}
		if (!ctx.email) {
			return render(data, {
				...view,
				toast: fail(
					"This site has no way to send email yet. Select the instructions and copy them instead.",
				),
			});
		}
		const name = formName(form ?? "", data.forms);
		const [to, ...cc] = parsed.list;
		await ctx.email.send({
			to: to!,
			...(cc.length ? { cc } : {}),
			...(user?.email ? { replyTo: user.email } : {}),
			subject: `${siteName(ctx, data.origin)}: how to connect the ${formWords(name)} to Lead Delivery`,
			text: instructions({
				site: siteName(ctx, data.origin),
				origin: data.origin,
				key: data.config.key,
				form: { slug: form ?? "", name },
				reach: data.config.reach?.result,
			}),
		});
		return render(data, { ...view, toast: ok(`Instructions sent to ${parsed.list.join(", ")}.`) });
	}

	// Settings for the whole site
	if (action === "dismiss_notice") {
		const { notice: _notice, ...rest } = data.config;
		await saveConfig(ctx, rest);
		return render(await fresh());
	}
	if (action === "save_alerts") {
		const settings: View = { screen: "home", settingsOpen: true };
		const parsed = parseAddresses(str(values.alert_to));
		if ("bad" in parsed)
			return render(data, { ...settings, toast: fail(`"${parsed.bad}" is not an email address.`) });
		if (parsed.list.length === 0)
			return render(data, {
				...settings,
				toast: fail("Add at least one address, so someone hears when an enquiry does not arrive."),
			});
		await saveConfig(ctx, { ...data.config, alertTo: parsed.list });
		return render(await fresh(), { ...settings, toast: ok("Saved.") });
	}
	if (action === "check_reach") {
		const result = await checkReach(ctx, data.origin);
		await saveConfig(ctx, { ...data.config, reach: { result, at: new Date().toISOString() } });
		if (result === "self") await refreshDefinitions(ctx, data.origin);
		return render(await fresh(), {
			screen: "home",
			settingsOpen: true,
			toast:
				result === "none" ? info("Checked. Set up email for this site first.") : ok("Checked."),
		});
	}
	if (action === "reset_address") {
		await saveConfig(ctx, { ...data.config, key: newKey(), keySetAt: new Date().toISOString() });
		return render(await fresh(), {
			screen: "home",
			settingsOpen: true,
			toast: ok(
				"The private address was reset. Connect each form again: open its delivery and press Connect this form.",
			),
		});
	}
	return render(data);
}
