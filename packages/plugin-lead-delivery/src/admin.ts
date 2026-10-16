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
	saveForms,
	since,
	siteName,
	siteOrigin,
} from "./config.js";
import {
	deliveries,
	enquiries,
	MAX_ATTEMPTS,
	needsFixing,
	placeName,
	quietForms,
	receive,
	schedulerStuck,
	sendAgain,
	servesForm,
	weekCounts,
} from "./deliver.js";
import { UNREADABLE_KEY } from "./enquiry.js";
import { addForm, checkReach, refreshDefinitions } from "./forms.js";
import { CHOICES, choiceFor, matchedCount, parseHubSpot, UNMATCHED } from "./hubspot.js";
import { instructions } from "./messages.js";
import type { Config, Delivery, DeliveryStatus, KnownForm, Place, PlaceKind } from "./types.js";
import { APPS, appLabel, newSecret } from "./webhook.js";

// EmDash role levels: an Editor can open the page and press Send again; only an Admin changes anything.
const ADMIN_ROLE = 50;
export const PAGE = "/enquiries";
const TAB = { enquiries: 0, places: 1, connect: 2 } as const;
const LOG_ROWS = 25;

interface User {
	email: string;
	name: string | null;
	role: number;
}

interface View {
	tab?: number;
	toast?: BlockResponse["toast"];
	cursor?: string;
	/** Where enquiries go: the list, a new place, or one place. */
	place?: "new" | string;
	/** Typed values to show again after a refused save. */
	draft?: Record<string, unknown>;
	/** A new app's signing secret, shown once. */
	secret?: string;
}

interface Data {
	ctx: PluginContext;
	config: Config;
	forms: Record<string, KnownForm>;
	origin: string;
	user?: User;
	admin: boolean;
}

const STATUS: Record<DeliveryStatus, string> = {
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

const tabs = (panels: Array<{ label: string; blocks: Block[] }>, tab: number): Block => ({
	type: "tab",
	panels,
	default_tab: tab,
});
const header = (text: string): Block => ({ type: "header", text });
const section = (text: string): Block => ({ type: "section", text });
const context = (text: string): Block => ({ type: "context", text });
const divider = (): Block => ({ type: "divider" });
const actions = (
	elements: Array<Extract<Block, { type: "actions" }>["elements"][number]>,
): Block => ({
	type: "actions",
	elements,
});
const button = (
	action_id: string,
	label: string,
	opts: Partial<Omit<ButtonElement, "type" | "action_id" | "label">> = {},
): ButtonElement => ({ type: "button", action_id, label, ...opts });

// ─── Enquiries ──────────────────────────────────────────────────────

function kindLabel(place: Place | undefined): string {
	if (!place) return "a place that was deleted";
	if (place.kind === "hubspot") return "HubSpot";
	if (place.kind === "app") return appLabel(place.app);
	return place.name;
}

/**
 * Let long unbroken words (email addresses, web addresses) wrap after "@", "." and "/", so the
 * first column of a table can shrink on a phone and the status and action stay on screen.
 */
export function breakable(text: string): string {
	return text.replace(/([@./])(?=\S)/g, "$1\u200b");
}

function rowText(d: Delivery, config: Config): string {
	const parts = [d.who, `${d.formName} → ${placeName(config, d.destination)}`, ago(d.createdAt)];
	if (d.status === "retrying" && d.nextAt) {
		parts.push(
			`try ${Math.min(d.attempts + 1, MAX_ATTEMPTS)} of ${MAX_ATTEMPTS}, next ${inTime(d.nextAt)}`,
		);
	}
	return breakable([...parts, ...d.notes].filter(Boolean).join(" · "));
}

function rowAction(id: string, d: Delivery) {
	if (d.status === "fixing" || d.status === "gaveup") {
		return button("send_again", "Send again", { value: id });
	}
	if (d.status === "retrying") return button("send_now", "Send now", { value: id });
	return null;
}

async function enquiriesBlocks(data: Data, view: View): Promise<Block[]> {
	const { ctx, config } = data;
	const page = await deliveries(ctx).query({
		orderBy: { createdAt: "desc" },
		limit: LOG_ROWS,
		...(view.cursor ? { cursor: view.cursor } : {}),
	});
	if (page.items.length === 0 && !view.cursor) return firstRun(data);

	const [counts, retrying, fixing, stuck] = await Promise.all([
		weekCounts(ctx),
		deliveries(ctx).query({ where: { status: "retrying" }, orderBy: { nextAt: "asc" }, limit: 1 }),
		needsFixing(ctx, 20),
		schedulerStuck(ctx),
	]);
	const retryingCount = await deliveries(ctx).count({ status: "retrying" });
	const nextAt = retrying.items[0]?.data.nextAt;
	const blocks: Block[] = [
		{
			type: "stats",
			items: [
				{ label: "Received", value: counts.received, description: "Last 7 days" },
				{ label: "Delivered", value: counts.delivered, description: "Last 7 days" },
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
		},
	];

	// One red banner per place that needs the owner; the service's own words beneath.
	const byPlace = new Map<string, Delivery[]>();
	for (const item of fixing) {
		byPlace.set(item.data.destination, [...(byPlace.get(item.data.destination) ?? []), item.data]);
	}
	for (const [placeId, rows] of byPlace) {
		const place = config.places.find((p) => p.id === placeId);
		const latest = rows[0]!;
		blocks.push({
			type: "banner",
			variant: "error",
			title: `${plural(rows.length, "enquiry", "enquiries")} could not reach ${kindLabel(place)}`,
			description: data.admin
				? (latest.plain ?? "It was refused.")
				: "Ask the person who set up this site to check where enquiries go. You can press Send again once it is fixed.",
		});
		if (data.admin && latest.raw) blocks.push(context(latest.raw));
	}
	for (const form of quietForms(data.forms)) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: `No enquiries from ${form.name} ${since(form.lastAt!)}`,
			description:
				"It usually gets some every few days. Check the form still sends: send yourself a test through it on your site.",
		});
	}
	const unreadable = await ctx.kv.get<{ formName: string; at: string }>(UNREADABLE_KEY);
	if (unreadable && Date.now() - Date.parse(unreadable.at) < 7 * 86_400_000) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: `An enquiry from ${unreadable.formName} was sent as plain text`,
			description:
				"Lead delivery could not read its fields one by one, usually because EmDash's forms changed how they write their emails. Nothing was lost. Check for an update to Lead delivery, or connect the form straight to Lead delivery instead (Connect forms).",
		});
	}
	if (stuck) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Retries are waiting because scheduled tasks are not running on this site.",
			description:
				"Ask your web person to check the site's scheduled tasks. Until then, press Send now.",
		});
	}

	blocks.push({
		type: "table",
		block_id: "log",
		page_action_id: "log_page",
		columns: [
			{ key: "enquiry", label: "Enquiry" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "action", label: "", format: "element" },
		],
		rows: page.items.map((item) => {
			const action = rowAction(item.id, item.data);
			return {
				enquiry: rowText(item.data, config),
				status: STATUS[item.data.status],
				...(action ? { action } : {}),
			};
		}),
		...(page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
	});
	if (fixing.length > 0) blocks.push(actions([button("send_all", "Send all failed again")]));

	const latest = fixing[0]?.data;
	if (latest) {
		const enquiry = await enquiries(ctx).get(latest.enquiryId);
		const refused = latest.status === "fixing";
		blocks.push({
			type: "accordion",
			label: "Latest failure in detail",
			default_open: true,
			blocks: [
				{
					type: "fields",
					fields: [
						{
							label: "Enquiry",
							value: `${latest.who}, ${latest.formName}, ${ago(latest.createdAt)}`,
						},
						{ label: "Place", value: placeName(config, latest.destination) },
						{
							label: "Attempts",
							value: refused
								? `${latest.attempts}. Not tried again: ${kindLabel(config.places.find((p) => p.id === latest.destination))} refused the content, so trying again would fail the same way.`
								: `${latest.attempts}, over about two days.`,
						},
						...(enquiry?.pageUrl ? [{ label: "Page", value: enquiry.pageUrl }] : []),
					],
				},
			],
		});
	}
	blocks.push(
		context(
			"Log rows are kept 30 days. An enquiry's contents are deleted here once every place has it; Forms → Submissions keeps the original.",
		),
	);
	return blocks;
}

function firstRun(data: Data): Block[] {
	const connected = Object.values(data.forms).some((f) => f.lastAt);
	const placed = data.config.places.length > 0;
	const tested = Boolean(data.config.testedAt);
	const step = (done: boolean, n: number, text: string) =>
		section(`${done ? "Done:" : `Step ${n}:`} ${text}`);
	return [
		{
			type: "empty",
			title: "Send every enquiry where you work",
			description:
				"Enquiries sent through your forms can go to your inbox, to HubSpot, or to another app such as Zapier, Make or n8n. Each one is logged here and tried again if it does not get through.",
			size: "lg",
		},
		...(data.admin
			? [
					step(
						connected,
						1,
						"connect your forms. Each form is connected once. Open the Connect forms tab.",
					),
					step(
						placed,
						2,
						"choose where enquiries go: email, HubSpot or another app. Open the Where enquiries go tab.",
					),
					step(tested, 3, "send a test, and check it arrives before you rely on it."),
				]
			: [section("Nothing has arrived yet. The person who set up this site connects the forms.")]),
		context("Every enquiry is also kept in Forms → Submissions, whatever happens here."),
	];
}

// ─── Where enquiries go ─────────────────────────────────────────────

async function placeStatus(
	ctx: PluginContext,
	place: Place,
): Promise<{ label: string; lastAt?: string; problem?: Delivery }> {
	const [last, fixing, gaveup, retrying] = await Promise.all([
		deliveries(ctx).query({
			where: { destination: place.id },
			orderBy: { createdAt: "desc" },
			limit: 1,
		}),
		deliveries(ctx).query({
			where: { destination: place.id, status: "fixing" },
			orderBy: { createdAt: "desc" },
			limit: 1,
		}),
		deliveries(ctx).count({ destination: place.id, status: "gaveup" }),
		deliveries(ctx).count({ destination: place.id, status: "retrying" }),
	]);
	const lastAt = last.items[0]?.data.createdAt;
	const problem = fixing.items[0]?.data;
	const base = lastAt ? { lastAt } : {};
	if (!place.on) return { label: "Off", ...base };
	if (problem || gaveup > 0)
		return { label: "Needs fixing", ...base, ...(problem ? { problem } : {}) };
	if (retrying > 0) return { label: "Trying again", ...base };
	if (!lastAt) return { label: "Not used yet" };
	return { label: "Working", ...base };
}

function formsText(place: Place, forms: Record<string, KnownForm>): string {
	if (place.forms === "all") return "All forms";
	return place.forms.map((slug) => forms[slug]?.name ?? slug).join(", ");
}

function sendsTo(place: Place): string {
	if (place.kind === "email") return (place.to ?? []).join(", ");
	if (place.kind === "hubspot") return `HubSpot form in account ${place.portalId}`;
	let host = place.url ?? "";
	try {
		host = new URL(host).host;
	} catch {
		// keep as typed
	}
	return `${appLabel(place.app)} at ${host}`;
}

function testButton(place: Place, user: User | undefined): ButtonElement {
	if (place.kind !== "hubspot") return button("test_place", "Send a test", { value: place.id });
	const name = user?.name || "Test enquiry";
	return button("test_place", "Send a test", {
		value: place.id,
		confirm: {
			title: "Send a test to HubSpot?",
			text: `This adds a contact called ${name} with your email (${user?.email ?? "your address"}) to HubSpot. You can delete it there afterwards.`,
			confirm: "Send test",
			deny: "Cancel",
		},
	});
}

async function placesList(data: Data): Promise<Block[]> {
	const { ctx, config } = data;
	const rows = [];
	for (const place of config.places) {
		const status = await placeStatus(ctx, place);
		rows.push({
			place: breakable(
				[
					place.name,
					formsText(place, data.forms),
					status.lastAt ? `last ${ago(status.lastAt)}` : "",
				]
					.filter(Boolean)
					.join(" · "),
			),
			status: status.label,
			action: testButton(place, data.user),
		});
	}
	const blocks: Block[] = [
		{
			type: "table",
			page_action_id: "places_page",
			columns: [
				{ key: "place", label: "Place" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "action", label: "", format: "element" },
			],
			rows,
			empty_text: "Nothing yet. Add a place: your inbox, HubSpot or another app.",
		},
		actions([
			button("add_place", "Add a place", { style: "primary" }),
			...(config.places.length > 0
				? [
						{
							type: "menu" as const,
							action_id: "open_place",
							label: "Change one",
							items: config.places.map((p) => ({ label: p.name, value: p.id })),
						},
					]
				: []),
		]),
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
	];
	return blocks;
}

function placeForm(
	data: Data,
	place: Place | undefined,
	draft: Record<string, unknown> | undefined,
): Block {
	const value = (key: string, fallback: string) =>
		draft && key in draft ? str(draft[key]) : fallback;
	const kind = value("kind", place?.kind ?? "email");
	const known = Object.values(data.forms);
	const formsValue: string[] =
		draft && Array.isArray(draft.forms)
			? (draft.forms as string[])
			: place && place.forms !== "all"
				? place.forms
				: ["all"];
	const flag = (key: string, fallback: boolean) =>
		draft && key in draft ? draft[key] === true : fallback;
	const fields: FormField[] = [
		{
			type: "radio",
			action_id: "kind",
			label: "Where should enquiries go?",
			options: [
				{ value: "email", label: "Email. Recommended if you read enquiries in your inbox." },
				{
					value: "hubspot",
					label:
						"HubSpot. Recommended if you use HubSpot. Each enquiry becomes a HubSpot form submission, so your HubSpot workflows and notifications run.",
				},
				{
					value: "app",
					label:
						"Another app (Zapier, Make, n8n). Sends each enquiry to an address the app gives you. Zapier needs a paid Zapier plan for this; Make and n8n do not.",
				},
			],
			initial_value: kind,
		},
		{
			type: "text_input",
			action_id: "name",
			label: "Name (only you see it)",
			initial_value: value("name", place?.name ?? ""),
		},
		{
			type: "text_input",
			action_id: "to",
			label: "Send each enquiry to (separate several addresses with commas)",
			initial_value: value("to", (place?.to ?? []).join(", ") || (data.user?.email ?? "")),
			condition: { field: "kind", eq: "email" },
		},
		{
			type: "text_input",
			action_id: "hubspot",
			label:
				"Your HubSpot form: paste its share link or embed code (HubSpot → Marketing → Forms → Share)",
			initial_value: value(
				"hubspot",
				place?.portalId ? `portalId: "${place.portalId}", formId: "${place.formGuid}"` : "",
			),
			condition: { field: "kind", eq: "hubspot" },
		},
		{
			type: "select",
			action_id: "app",
			label: "Which app",
			options: APPS.map((a) => ({ value: a.value, label: a.label })),
			initial_value: value("app", place?.app ?? "zapier"),
			condition: { field: "kind", eq: "app" },
		},
		{
			type: "text_input",
			action_id: "url",
			label: "The address the app gave you (starts with https://)",
			initial_value: value("url", place?.url ?? ""),
			condition: { field: "kind", eq: "app" },
		},
		{
			type: "checkbox",
			action_id: "forms",
			label: "Which forms send here",
			options: [
				{ value: "all", label: "All forms, including new ones" },
				...known.map((f) => ({ value: f.slug, label: f.name })),
			],
			initial_value: formsValue,
		},
		{
			type: "toggle",
			action_id: "no_duplicates",
			label: "Don't send the same person twice within 24 hours",
			description:
				"Recommended for HubSpot and apps that start a task for each enquiry. Every enquiry is still logged here.",
			initial_value: flag("no_duplicates", place?.noDuplicates ?? false),
		},
		{
			type: "toggle",
			action_id: "on",
			label: "Turned on",
			description: "Off keeps the place but sends nothing.",
			initial_value: flag("on", place?.on ?? true),
		},
	];
	return {
		type: "form",
		block_id: `place:${place?.id ?? "new"}`,
		fields,
		submit: { label: "Save", action_id: "save_place" },
	};
}

function matchingBlocks(data: Data, place: Place): Block[] {
	const served = Object.values(data.forms).filter((f) => servesForm(place, f.slug));
	return served.map((form) => {
		const matched = matchedCount(place, form.slug, form.fields);
		const saved = Boolean(place.mapping?.[form.slug]);
		const inner: Block[] = [];
		if (form.fields.length === 0) {
			inner.push(
				context(
					"No fields yet. They appear after the form's first enquiry, or once this site can look the form up.",
				),
			);
		} else {
			inner.push(
				context(
					matched === form.fields.length && !saved
						? "Matched automatically. Choose the HubSpot field each of your form's fields goes to. The HubSpot form must contain every field you send."
						: "Choose the HubSpot field each of your form's fields goes to. The HubSpot form must contain every field you send.",
				),
			);
			const fields: FormField[] = [];
			for (const field of form.fields) {
				const choice = choiceFor(place, form.slug, field);
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
					initial_value: place.otherNames?.[form.slug]?.[field.key] ?? "",
					condition: { field: `f:${field.key}`, eq: "other" },
				});
			}
			fields.push(
				{
					type: "toggle",
					action_id: "gdpr",
					label: "My HubSpot account has its privacy (GDPR) settings on",
					description:
						"Turn on only if HubSpot asks for consent on your forms. Each enquiry then says the person agreed to their details being used to answer them.",
					initial_value: place.gdpr ?? false,
				},
				{
					type: "toggle",
					action_id: "throwaway",
					label: "Mark possibly fake email addresses in HubSpot",
					description:
						"Addresses from services that hand out short-lived inboxes (like mailinator.com) are often made up. They are still sent. Recommended if you want to filter them out in HubSpot.",
					initial_value: Boolean(place.throwawayField),
				},
				{
					type: "text_input",
					action_id: "throwaway_field",
					label: "HubSpot field to mark (a checkbox field on your HubSpot form)",
					initial_value: place.throwawayField || "possibly_fake_email",
					condition: { field: "throwaway", eq: true },
				},
			);
			inner.push({
				type: "form",
				block_id: `match:${place.id}:${form.slug}`,
				fields,
				submit: { label: "Save matching", action_id: "save_matching" },
			});
		}
		inner.push(
			context(
				"Files are never sent; they stay in Forms → Submissions. The page each enquiry came from is sent to HubSpot when your form provides it.",
			),
		);
		return {
			type: "accordion",
			label: `${form.name}: ${matched} of ${form.fields.length} fields matched`,
			default_open: matched < form.fields.length,
			blocks: inner,
		} satisfies Block;
	});
}

async function placeDetail(data: Data, place: Place, view: View): Promise<Block[]> {
	const status = await placeStatus(data.ctx, place);
	const waiting = await deliveries(data.ctx).count({ destination: place.id, status: "retrying" });
	const problem = status.problem;
	const statusText =
		problem?.field && place.kind === "hubspot"
			? `Needs fixing: HubSpot refused ${labelOf(data, problem.formId, problem.field)}`
			: status.label;
	const blocks: Block[] = [
		header(place.name),
		{
			type: "fields",
			fields: [
				{ label: "Sends to", value: sendsTo(place) },
				{
					label: "Forms",
					value:
						place.forms === "all" ? "All forms, including new ones" : formsText(place, data.forms),
				},
				{ label: "Status", value: statusText },
			],
		},
		actions([
			testButton(place, data.user),
			button("toggle_place", place.on ? "Turn off" : "Turn on", { value: place.id }),
			button("delete_place", "Delete", {
				value: place.id,
				style: "danger",
				confirm: {
					title: `Delete ${place.name}?`,
					text: `${waiting > 0 ? `${plural(waiting, "enquiry is", "enquiries are")} waiting to be sent here; they will not be sent. ` : ""}Enquiries already delivered stay in the log.`,
					confirm: "Delete",
					deny: "Cancel",
					style: "danger",
				},
			}),
		]),
	];
	if (view.secret) {
		blocks.push({
			type: "accordion",
			label: "For your web person: how to check an enquiry really came from this site",
			default_open: true,
			blocks: [
				section(
					"Each request is signed with the Standard Webhooks headers webhook-id, webhook-timestamp and webhook-signature. The signing secret is shown only now:",
				),
				{ type: "code", code: view.secret },
			],
		});
	}
	if (place.kind === "hubspot") blocks.push(...matchingBlocks(data, place));
	blocks.push(
		header("Change this place"),
		placeForm(data, place, view.draft),
		actions([button("list_places", "Back to all places")]),
	);
	return blocks;
}

function labelOf(data: Data, formId: string, key: string): string {
	return data.forms[formId]?.fields.find((f) => f.key === key || f.label === key)?.label ?? key;
}

async function placesBlocks(data: Data, view: View): Promise<Block[]> {
	if (view.place === "new") {
		return [
			header("Add a place"),
			placeForm(data, undefined, view.draft),
			actions([button("list_places", "Back to all places")]),
		];
	}
	const place = view.place ? data.config.places.find((p) => p.id === view.place) : undefined;
	if (place) return placeDetail(data, place, view);
	return placesList(data);
}

// ─── Connect forms ──────────────────────────────────────────────────

const REACH_TEXT = {
	self: "Can send to its own address, so your forms will send each enquiry straight to Lead delivery.",
	email:
		"Cannot send to its own address, so your forms will hand enquiries over through a private email address. Nobody receives that email.",
	none: "Cannot send to its own address, and has no way to send email yet.",
} as const;

function connectBlocks(data: Data): Block[] {
	const { config, ctx } = data;
	const forms = Object.values(data.forms).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
	const reach = config.reach;
	const blocks: Block[] = [
		header("Your forms"),
		{
			type: "table",
			page_action_id: "forms_page",
			columns: [
				{ key: "form", label: "Form" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "action", label: "", format: "element" },
			],
			rows: forms.map((form) => ({
				form: `${form.name} (${form.slug}) · ${
					form.lastAt
						? `last enquiry ${ago(form.lastAt)}`
						: `${form.fields.length ? `${plural(form.fields.length, "field")} · ` : ""}no enquiry yet`
				}`,
				status: form.lastAt ? "Connected" : "Waiting",
				action: button("remove_form", "Remove", { value: form.slug }),
			})),
			empty_text: "No forms yet. Add one by its short name below.",
		},
		{
			type: "form",
			block_id: "add_form",
			fields: [
				{
					type: "text_input",
					action_id: "short_name",
					label: "Add a form: its short name (the Slug column under Forms)",
					placeholder: "contact",
				},
			],
			submit: { label: "Add form", action_id: "add_form" },
		},
		divider(),
		header("How a form gets connected"),
		section(
			"EmDash's form editor cannot be pointed at Lead delivery yet, so someone who looks after the site's code connects each form once. It takes about five minutes.",
		),
	];
	if (reach?.result === "none") {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Set up email for this site first",
			description:
				"This site cannot send to its own address, and it has no way to send email, so your forms have no way to hand enquiries over. Ask your web person to set up email for the site, then press Check again.",
		});
	}
	// A sentence, not a fields block: Kumo cuts a long field value short.
	blocks.push(section(`This site: ${reach ? REACH_TEXT[reach.result] : "Not checked yet"}`));
	if (reach) blocks.push(context(`Checked ${ago(reach.at)}.`));
	blocks.push(
		actions([
			reach
				? button("check_reach", "Check again")
				: button("check_reach", "Check this site", { style: "primary" }),
		]),
	);
	blocks.push(
		{
			type: "accordion",
			label: "Instructions for your web person (select and copy them, or email them below)",
			blocks: [
				{
					type: "code",
					code: instructions({
						site: siteName(ctx, data.origin),
						origin: data.origin,
						key: config.key,
						forms: forms.map((f) => f.slug),
						reach: reach?.result,
					}),
				},
			],
		},
		{
			type: "form",
			block_id: "email_instructions",
			fields: [{ type: "text_input", action_id: "to", label: "Email these instructions to" }],
			submit: { label: "Email instructions", action_id: "email_instructions" },
		},
		divider(),
		header("Private address"),
		section(
			"Your forms send enquiries to a private address that only this site knows. If it has been shared by mistake, reset it.",
		),
		actions([
			button("reset_address", "Reset the private address", {
				style: "danger",
				confirm: {
					title: "Reset the private address?",
					text: "Every connected form stops sending to Lead delivery until it is connected again with the new instructions. Enquiries still reach Forms → Submissions.",
					confirm: "Reset address",
					deny: "Cancel",
					style: "danger",
				},
			}),
		]),
	);
	return blocks;
}

const places = (tabView: Omit<View, "tab"> = {}): View => ({ tab: TAB.places, ...tabView });
const connect = (toast: BlockResponse["toast"]): View => ({
	tab: TAB.connect,
	...(toast ? { toast } : {}),
});

// ─── Page ───────────────────────────────────────────────────────────

async function render(data: Data, view: View = {}): Promise<BlockResponse> {
	const log = await enquiriesBlocks(data, view);
	const blocks: Block[] = data.admin
		? [
				header("Lead delivery"),
				tabs(
					[
						{ label: "Enquiries", blocks: log },
						{ label: "Where enquiries go", blocks: await placesBlocks(data, view) },
						{ label: "Connect forms", blocks: connectBlocks(data) },
					],
					view.tab ?? TAB.enquiries,
				),
			]
		: [header("Lead delivery"), ...log];
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
		const place = data.config.places.find((p) => p.id === fixing[0]!.data.destination);
		blocks.push({
			type: "banner",
			variant: "error",
			title: `${fixing.length} needs fixing`,
			description: `An enquiry could not reach ${kindLabel(place)}.`,
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

/** Save a place from the form. Returns the saved place, or the reason it was refused. */
function placeFromForm(
	data: Data,
	existing: Place | undefined,
	values: Record<string, unknown>,
): { place: Place; secret?: string } | { error: string } {
	const kind = (["email", "hubspot", "app"] as const).includes(values.kind as PlaceKind)
		? (values.kind as PlaceKind)
		: "email";
	const picked = Array.isArray(values.forms)
		? values.forms.filter((v): v is string => typeof v === "string")
		: [];
	if (picked.length === 0) return { error: "Choose at least one form that sends here." };
	const forms: Place["forms"] = picked.includes("all") ? "all" : picked;
	const base = {
		id: existing?.id ?? newId(),
		kind,
		forms,
		on: values.on !== false,
		noDuplicates: values.no_duplicates === true,
		createdAt: existing?.createdAt ?? new Date().toISOString(),
		...(existing?.kind === kind
			? { mapping: existing.mapping, otherNames: existing.otherNames }
			: {}),
		...(existing?.kind === kind && existing.gdpr ? { gdpr: true } : {}),
		...(existing?.kind === kind && existing.throwawayField
			? { throwawayField: existing.throwawayField }
			: {}),
	};
	const name = str(values.name).trim().slice(0, 100);
	if (kind === "email") {
		const parsed = parseAddresses(str(values.to));
		if ("bad" in parsed) return { error: `"${parsed.bad}" is not an email address.` };
		if (parsed.list.length === 0) return { error: "Add the email address enquiries should go to." };
		return { place: { ...base, name: name || `Email to ${parsed.list[0]}`, to: parsed.list } };
	}
	if (kind === "hubspot") {
		const parsed = parseHubSpot(str(values.hubspot));
		if ("error" in parsed) return { error: parsed.error };
		return {
			place: {
				...base,
				name: name || "HubSpot",
				portalId: parsed.portalId,
				formGuid: parsed.formGuid,
			},
		};
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
	const app = APPS.some((a) => a.value === values.app) ? (values.app as Place["app"]) : "other";
	const keep = existing?.kind === "app" && existing.secret;
	const secret = keep ? existing.secret! : newSecret();
	return {
		place: { ...base, name: name || appLabel(app), app, url: parsedUrl.href, secret },
		...(keep ? {} : { secret }),
	};
}

function testEnquiry(data: Data, place: Place) {
	const form = Object.values(data.forms).find(
		(f) => servesForm(place, f.slug) && f.fields.length > 0,
	);
	const name = data.user?.name || "Test enquiry";
	const email = data.user?.email ?? "";
	const fields = (
		form?.fields ?? [
			{ key: "name", label: "Your name", type: "text" },
			{ key: "email", label: "Email", type: "email" },
			{ key: "message", label: "Message", type: "textarea" },
		]
	).map((f) => {
		const choice = choiceFor(place, form?.slug ?? "", f);
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
	return {
		formId: form?.slug ?? "test",
		formName: form?.name ?? "Test",
		receivedAt: new Date().toISOString(),
		fields: fields.filter((f) => f.value),
		...(email ? { email } : {}),
		name,
		via: "test" as const,
		throwaway: false,
		hasFiles: false,
	};
}

async function sendTest(data: Data, place: Place): Promise<BlockResponse["toast"]> {
	const id = `test-${newId()}`;
	const enquiry = testEnquiry(data, place);
	const { ctx } = data;
	// Only this place gets the test, even when it is turned off.
	await receive(ctx, id, enquiry, { inline: true, only: place });
	const row = await deliveries(ctx).get(`${id}~${place.id}`);
	const label = kindLabel(place);
	if (row?.status === "delivered") {
		if (place.kind === "hubspot")
			return ok(`HubSpot accepted the test. Look for ${enquiry.name} in HubSpot → Contacts.`);
		if (place.kind === "email")
			return ok(`Test sent to ${(place.to ?? []).join(", ")}. Check the inbox.`);
		return ok(`${label} accepted the test.`);
	}
	if (row?.status === "retrying")
		return fail(`${label} did not answer. It will be tried again; see Enquiries.`);
	return fail(`${label} did not accept the test. ${row?.plain ?? ""}`.trim());
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
	const fresh = async () => ({
		...data,
		config: await loadConfig(ctx),
		forms: await loadForms(ctx),
	});

	if (interaction.type === "page_load" && str(interaction.page) === "widget:enquiries")
		return widget(data);
	if (interaction.type === "page_load" || action === "") return render(data);

	// Anyone who can open the page may look through the log and send an enquiry again.
	if (action === "log_page") {
		const cursor = isRecord(value) ? str(value.cursor) : "";
		return render(data, cursor ? { cursor } : {});
	}
	if (action === "send_again" || action === "send_now") {
		const row = await sendAgain(ctx, str(value));
		const place = data.config.places.find((p) => p.id === row?.destination);
		const toast =
			row?.status === "delivered"
				? ok(`Sent again. ${kindLabel(place)} accepted ${row.who}'s enquiry.`)
				: row?.status === "retrying"
					? info(
							`${kindLabel(place)} did not answer. It will be tried again ${inTime(row.nextAt)}.`,
						)
					: fail(row?.plain ?? "That enquiry is no longer here.");
		return render(await fresh(), { toast });
	}
	if (action === "send_all") {
		const rows = await needsFixing(ctx, 10);
		let sent = 0;
		for (const row of rows) if ((await sendAgain(ctx, row.id))?.status === "delivered") sent += 1;
		return render(await fresh(), {
			toast:
				sent === rows.length
					? ok(`Sent again: ${plural(sent, "enquiry", "enquiries")}.`)
					: fail(`${sent} of ${rows.length} sent. The rest still need fixing.`),
		});
	}
	if (!admin) return render(data, { toast: fail("Only an admin can change this.") });

	// Where enquiries go
	if (action === "add_place") return render(data, places({ place: "new" }));
	if (action === "list_places") return render(data, places());
	if (action === "open_place") return render(data, places({ place: str(value) }));
	if (action === "save_place") {
		const id = blockId.startsWith("place:") ? blockId.slice(6) : "new";
		const existing = data.config.places.find((p) => p.id === id);
		const result = placeFromForm(data, existing, values);
		if ("error" in result) {
			return render(
				data,
				places({ place: existing?.id ?? "new", draft: values, toast: fail(result.error) }),
			);
		}
		const placesNow = existing
			? data.config.places.map((p) => (p.id === existing.id ? result.place : p))
			: [...data.config.places, result.place];
		await saveConfig(ctx, { ...data.config, places: placesNow });
		if (result.place.kind === "hubspot" && data.origin) await refreshDefinitions(ctx, data.origin);
		const message =
			result.place.kind === "hubspot"
				? `Saved. Found HubSpot account ${result.place.portalId}. The HubSpot form must have the fields you send, at least Email.`
				: "Saved.";
		return render(
			await fresh(),
			places({
				place: result.place.id,
				toast: ok(message),
				...(result.secret ? { secret: result.secret } : {}),
			}),
		);
	}
	if (action === "save_matching") {
		const [, placeId, form] = blockId.split(":");
		const place = data.config.places.find((p) => p.id === placeId);
		if (!place || !form) return render(data, places());
		const mapping: Record<string, string> = {};
		const others: Record<string, string> = {};
		for (const [key, v] of Object.entries(values)) {
			if (key.startsWith("f:") && typeof v === "string") mapping[key.slice(2)] = v;
			if (key.startsWith("o:") && typeof v === "string" && v.trim())
				others[key.slice(2)] = v.trim();
		}
		const missing = Object.entries(mapping).find(([key, v]) => v === "other" && !others[key]);
		if (missing) {
			return render(
				data,
				places({
					place: place.id,
					toast: fail(`Type the HubSpot field name for ${labelOf(data, form, missing[0])}.`),
				}),
			);
		}
		const throwawayField =
			values.throwaway === true ? str(values.throwaway_field).trim() || "possibly_fake_email" : "";
		const updated: Place = {
			...place,
			mapping: { ...place.mapping, [form]: mapping },
			otherNames: { ...place.otherNames, [form]: others },
			gdpr: values.gdpr === true,
			throwawayField,
		};
		await saveConfig(ctx, {
			...data.config,
			places: data.config.places.map((p) => (p.id === place.id ? updated : p)),
		});
		return render(await fresh(), places({ place: place.id, toast: ok("Matching saved.") }));
	}
	if (action === "test_place") {
		const place = data.config.places.find((p) => p.id === str(value));
		if (!place) return render(data, places());
		const toast = await sendTest(data, place);
		return render(await fresh(), { tab: TAB.places, toast });
	}
	if (action === "toggle_place") {
		const placesNow = data.config.places.map((p) =>
			p.id === str(value) ? { ...p, on: !p.on } : p,
		);
		await saveConfig(ctx, { ...data.config, places: placesNow });
		const place = placesNow.find((p) => p.id === str(value));
		return render(
			await fresh(),
			places({
				place: str(value),
				toast: ok(
					place?.on ? "Turned on." : "Turned off. Nothing is sent here until you turn it on.",
				),
			}),
		);
	}
	if (action === "delete_place") {
		const id = str(value);
		const waiting = await deliveries(ctx).query({
			where: { destination: id, status: "retrying" },
			limit: 100,
		});
		if (waiting.items.length) await deliveries(ctx).deleteMany(waiting.items.map((i) => i.id));
		await saveConfig(ctx, {
			...data.config,
			places: data.config.places.filter((p) => p.id !== id),
		});
		return render(await fresh(), places({ toast: ok("Deleted.") }));
	}
	if (action === "save_alerts") {
		const parsed = parseAddresses(str(values.alert_to));
		if ("bad" in parsed)
			return render(data, places({ toast: fail(`"${parsed.bad}" is not an email address.`) }));
		if (parsed.list.length === 0)
			return render(
				data,
				places({
					toast: fail(
						"Add at least one address, so someone hears when an enquiry does not arrive.",
					),
				}),
			);
		await saveConfig(ctx, { ...data.config, alertTo: parsed.list });
		return render(await fresh(), places({ toast: ok("Saved.") }));
	}

	// Connect forms
	if (action === "add_form") {
		const result = await addForm(ctx, data.origin, str(values.short_name));
		return render(
			await fresh(),
			connect(
				result.ok
					? result.message.startsWith("Saved.")
						? info(result.message)
						: ok(result.message)
					: fail(result.message),
			),
		);
	}
	if (action === "remove_form") {
		const forms = { ...data.forms };
		const removed = forms[str(value)];
		delete forms[str(value)];
		await saveForms(ctx, forms);
		return render(
			await fresh(),
			connect(
				ok(
					`Removed ${removed?.name ?? "the form"} from this list. Its enquiries still arrive while it stays connected.`,
				),
			),
		);
	}
	if (action === "check_reach") {
		const result = await checkReach(ctx, data.origin);
		await saveConfig(ctx, { ...data.config, reach: { result, at: new Date().toISOString() } });
		if (result === "self") await refreshDefinitions(ctx, data.origin);
		return render(
			await fresh(),
			connect(
				result === "none" ? info("Checked. Set up email for this site first.") : ok("Checked."),
			),
		);
	}
	if (action === "email_instructions") {
		const parsed = parseAddresses(str(values.to));
		if ("bad" in parsed || parsed.list.length === 0) {
			return render(data, connect(fail("Type the email address of your web person.")));
		}
		if (!ctx.email)
			return render(
				data,
				connect(
					fail(
						"This site has no way to send email yet. Select the instructions and copy them instead.",
					),
				),
			);
		const [to, ...cc] = parsed.list;
		await ctx.email.send({
			to: to!,
			...(cc.length ? { cc } : {}),
			...(user?.email ? { replyTo: user.email } : {}),
			subject: `${siteName(ctx, data.origin)}: how to connect the forms to Lead Delivery`,
			text: instructions({
				site: siteName(ctx, data.origin),
				origin: data.origin,
				key: data.config.key,
				forms: Object.keys(data.forms),
				reach: data.config.reach?.result,
			}),
		});
		return render(data, connect(ok(`Instructions sent to ${parsed.list.join(", ")}.`)));
	}
	if (action === "reset_address") {
		await saveConfig(ctx, { ...data.config, key: newKey() });
		return render(
			await fresh(),
			connect(
				ok("The private address was reset. Connect each form again with the new instructions."),
			),
		);
	}
	return render(data);
}
