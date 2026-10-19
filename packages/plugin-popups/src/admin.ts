// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";

import {
	colorProblems,
	cleanColor,
	DECLINE_LABEL,
	isLive,
	isSafeLink,
	KIND_LABEL,
	MAX_HEADING,
	MAX_POPUPS,
	MAX_TEXT,
	newId,
	normalizeStore,
	parseEmails,
	parsePaths,
	shortHash,
	uniqueHandle,
	type Kind,
	type Picture,
	type Popup,
	type Store,
} from "./config.js";
import { describeCheck, type FormCheck } from "./forms.js";
import { rate, type CountRow, type Totals } from "./stats.js";
import { describeMoment, fromMoment, HALF_HOURS, toMoment } from "./time.js";

/**
 * The one admin page, as Block Kit: Popups, Numbers, Settings, and the four
 * steps of a popup. Pure apart from the form check, which is handed in, so it
 * is tested without a running site.
 */

// EmDash role levels: an Editor may change wording, pictures, dates and on/off; an Admin everything.
export const ADMIN_ROLE = 50;

export type ProblemKind = "missing" | "paused" | "unsupported";
export interface Problem {
	k: ProblemKind;
	/** When a visitor's browser last reported it. */
	at: number;
	/** The UTC day the alert email went out. */
	mailed?: string;
}
export type Problems = Record<string, Problem>;

export interface MediaOption {
	id: string;
	url: string;
	alt: string;
	filename: string;
	width: number | null;
	height: number | null;
}

export interface PageState {
	store: Store;
	admin: boolean;
	zone: string;
	now: number;
	/** The site's address (https://example.com), for preview and download links. */
	origin?: string;
	/** The signed query string for the spreadsheet download of the dates on screen. */
	exportQuery?: string;
	pluginId: string;
	totals: Map<string, Totals>;
	/** Rows for the chosen dates on the Numbers tab. */
	rows: CountRow[];
	range: { from: string; to: string };
	problems: Problems;
	media: MediaOption[];
	collections: Array<{ slug: string; label: string }>;
	/** An email provider is set up in EmDash. */
	emailReady: boolean;
	/** What was typed, kept on screen when a save was refused. */
	draft?: Record<string, unknown>;
	errors?: string[];
	notes?: string[];
	toast?: BlockResponse["toast"];
}

const TAB = { popups: 0, numbers: 1, settings: 2 } as const;
const STEPS = ["What kind", "What it says", "When and where", "Dates and turn on"];

// ── Words ───────────────────────────────────────────────────

const KIND_CHOICE: Record<Kind, string> = {
	bar: "Top bar: a thin strip across the top of the page, for short news such as opening hours or a closure. Recommended for announcements.",
	slide:
		"Slide-in: a small box in the bottom corner that leaves the page usable. Recommended for offers.",
	modal:
		"Popup: a box in the middle of the screen that dims the page until it is closed. It interrupts, so it waits until a visitor's second page (you can change that for computers), and on phones it opens as a sheet at the bottom.",
	inline:
		'Box in a page: a box inside a page or post, placed by you in the editor with the "Popups box" block. Recommended for newsletter sign-ups at the end of posts.',
};

const TRIGGER_CHOICE = {
	read: "After they have read a while (recommended): 40% down the page or 30 seconds, whichever comes first",
	click: "When they click a button or link on the page",
	exit: "When they are about to leave (computers only; phones never see it)",
} as const;

function kindLine(popup: Popup): string {
	if (popup.contains === "form" && popup.form && popup.kind !== "bar") {
		return `${KIND_LABEL[popup.kind]} with a form`;
	}
	return KIND_LABEL[popup.kind];
}

function datesText(popup: Popup, state: PageState): string {
	const when = (ms: number) => describeMoment(ms, state.zone, state.now);
	if (popup.start && popup.end) return `${when(popup.start)} to ${when(popup.end)}`;
	if (popup.start) return `From ${when(popup.start)}`;
	if (popup.end) return `Until ${when(popup.end)}`;
	return "No dates: on until turned off";
}

export function statusOf(popup: Popup, state: PageState): string {
	if (popup.step < 4) return "Not finished";
	if (!popup.on) return "Off";
	if (popup.end !== null && state.now >= popup.end) {
		return `Ended ${describeMoment(popup.end, state.zone, state.now)}`;
	}
	const problem = state.problems[popup.id];
	if (problem && problem.k !== "paused" && isLive(popup, state.now)) return "Cannot open";
	if (popup.start !== null && state.now < popup.start) {
		return `Starts ${describeMoment(popup.start, state.zone, state.now)}`;
	}
	if (popup.end !== null) return `On until ${describeMoment(popup.end, state.zone, state.now)}`;
	return "On";
}

function showsOnText(popup: Popup, state: PageState): string {
	if (popup.kind === "inline") return "Where it is placed";
	let where = "Every page";
	if (popup.where === "prefix")
		where = `Pages under ${popup.prefixes.join(", ") || "(none chosen)"}`;
	if (popup.where === "collections") {
		const names = popup.collections.map(
			(slug) => state.collections.find((c) => c.slug === slug)?.label ?? slug,
		);
		where = names.join(", ") || "(no collection chosen)";
	}
	return popup.exclude.length ? `${where}, except ${popup.exclude.join(", ")}` : where;
}

function responsesText(popup: Popup, totals: Totals | undefined): string {
	if (!totals || totals.seen === 0) return "–";
	const form = popup.contains === "form" && popup.kind !== "bar";
	const n = form ? totals.sent : totals.clicked;
	const word = form ? (n === 1 ? "sign-up" : "sign-ups") : n === 1 ? "click" : "clicks";
	const r = rate(n, totals.seen);
	return `${n.toLocaleString("en")} ${word}${r === null ? "" : ` (${r}%)`}`;
}

const num = (n: number | undefined) => (n ? n.toLocaleString("en") : "–");

/** A form's id changes with the saved data, so the admin shows saved values after a save. */
function formId(name: string, popup: Popup | undefined, extra = ""): string {
	return `${name}:${popup?.id ?? "new"}:${shortHash(JSON.stringify(popup ?? {}) + extra)}`;
}

function typed(state: PageState, key: string, saved: string): string {
	const value = state.draft?.[key];
	return typeof value === "string" ? value : saved;
}

function errorBlocks(state: PageState): Block[] {
	const out: Block[] = [];
	if (state.errors?.length) {
		out.push({
			type: "banner",
			variant: "error",
			title: "Nothing was saved. Please fix this first:",
			description: state.errors.join(" "),
		});
	}
	for (const note of state.notes ?? []) {
		out.push({
			type: "banner",
			variant: note.includes("paused") ? "alert" : "default",
			description: note,
		});
	}
	return out;
}

// ── The list ────────────────────────────────────────────────

const PROBLEM_TEXT: Record<ProblemKind, (popup: Popup) => { title: string; description: string }> =
	{
		missing: (p) => ({
			title: `"${p.name}" cannot open: there is no form called "${p.form}" any more`,
			description:
				"Open Forms, copy the short name of the form you want, then paste it in this popup under Change ▸ What it says. Visitors see nothing broken in the meantime; the popup simply stays closed.",
		}),
		unsupported: (p) => ({
			title: `"${p.name}" cannot open: its form uses Turnstile or a file upload`,
			description:
				"Those only work in a box in a page for now. Choose another form under Change ▸ What it says, or make a box in a page with this form.",
		}),
		paused: (p) => ({
			title: `"${p.name}" is waiting: its form "${p.form}" is paused under Forms`,
			description: "It opens again by itself once the form is turned back on under Forms.",
		}),
	};

function menuFor(popup: Popup, admin: boolean): Record<string, unknown> {
	const items = [
		{ label: "Change", value: `change:${popup.id}` },
		{ label: "Preview", value: `preview:${popup.id}` },
		{ label: popup.on ? "Turn off" : "Turn on", value: `toggle:${popup.id}` },
	];
	if (admin) {
		items.push(
			{ label: "Duplicate", value: `duplicate:${popup.id}` },
			{ label: "Delete", value: `delete:${popup.id}` },
		);
	}
	return { type: "menu", action_id: "row", label: "Edit", items, style: "secondary" };
}

function listBlocks(state: PageState): Block[] {
	const { store } = state;
	const blocks: Block[] = [...errorBlocks(state)];
	for (const popup of store.popups) {
		const problem = state.problems[popup.id];
		if (!problem || !isLive(popup, state.now) || popup.contains !== "form") continue;
		blocks.push({
			type: "banner",
			variant: problem.k === "paused" ? "alert" : "error",
			...PROBLEM_TEXT[problem.k](popup),
		});
	}
	if (store.popups.length === 0) {
		blocks.push({
			type: "empty",
			title: "No popups yet",
			description:
				"Tell visitors about opening hours, an offer or your newsletter: a bar across the top, a box in the corner, a popup, or a box inside a page.",
			actions: state.admin
				? [{ type: "button", action_id: "new", label: "New popup", style: "primary" }]
				: [],
		});
		blocks.push({
			type: "context",
			text: state.admin
				? "Your web person added Popups to this site; nothing else needs installing. It shows on every page of the usual EmDash themes. If a popup never appears, ask them to check that the theme includes EmDash's standard page head and body parts."
				: "An administrator makes new popups. You can change their words, pictures and dates here.",
		});
		return blocks;
	}
	if (state.admin && store.popups.length < MAX_POPUPS) {
		blocks.push({
			type: "actions",
			elements: [{ type: "button", action_id: "new", label: "New popup", style: "primary" }],
		});
	}
	blocks.push({
		type: "table",
		block_id: "list",
		page_action_id: "list_page",
		columns: [
			{ key: "name", label: "Name" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "edit", label: "", format: "element" },
			{ key: "where", label: "Shows on" },
			{ key: "seen", label: "Seen" },
			{ key: "responses", label: "Responses" },
		],
		rows: store.popups.map((popup) => ({
			name: `${popup.name} (${kindLine(popup)})`,
			status: statusOf(popup, state),
			edit: menuFor(popup, state.admin),
			where: showsOnText(popup, state),
			seen: num(state.totals.get(popup.id)?.seen),
			responses: responsesText(popup, state.totals.get(popup.id)),
		})),
	} as Block);
	blocks.push(
		{
			type: "context",
			text: `Edit ▾ opens: Change, Preview, ${state.admin ? "Turn off, Duplicate, Delete" : "Turn off"}. "Seen" counts since each popup started: at least half of it was on screen for a second. Counts are approximate: some browsers block them, and your own visits while signed in are not counted.`,
		},
		{
			type: "context",
			text: "At most one popup or slide-in opens per visit, never while the cookie banner is waiting for an answer, and never again for someone who signed up or clicked its button. Changes reach visitors within a few minutes, when cached pages refresh.",
		},
	);
	if (!state.admin) {
		blocks.push({
			type: "context",
			text: "Only an administrator can make, duplicate or delete popups, or change where they show.",
		});
	}
	return blocks;
}

// ── Numbers ─────────────────────────────────────────────────

/** Noon of a UTC day, for the chart. */
const noon = (day: string) => Date.parse(`${day}T12:00:00Z`);

function numbersBlocks(state: PageState): Block[] {
	const { from, to } = state.range;
	const chosen = from || to;
	const rows = state.rows;
	const byPopup = new Map<string, Totals>();
	for (const row of rows) {
		const t = byPopup.get(row.popup) ?? {
			seen: 0,
			sent: 0,
			clicked: 0,
			closed: 0,
			phone: 0,
			since: null,
		};
		t.seen += row.seen;
		t.sent += row.sent;
		t.clicked += row.clicked;
		t.closed += row.closed;
		t.phone += row.phone;
		if (!t.since || row.day < t.since) t.since = row.day;
		byPopup.set(row.popup, t);
	}
	const all = [...byPopup.values()].reduce(
		(a, t) => ({
			seen: a.seen + t.seen,
			sent: a.sent + t.sent,
			clicked: a.clicked + t.clicked,
			closed: a.closed + t.closed,
		}),
		{ seen: 0, sent: 0, clicked: 0, closed: 0 },
	);
	const blocks: Block[] = [
		...errorBlocks(state),
		{
			type: "header",
			text: chosen
				? `${from ? shortDay(from) : "Start"} to ${to ? shortDay(to) : "today"}`
				: "Since each popup started",
		},
		{
			type: "form",
			block_id: `range:${from}:${to}`,
			fields: [
				{
					type: "date_input",
					action_id: "from",
					label: "From (leave empty for since each popup started)",
					initial_value: from || undefined,
				},
				{
					type: "date_input",
					action_id: "to",
					label: "To (leave empty for today)",
					initial_value: to || undefined,
				},
			],
			submit: { label: "Show these dates", action_id: "range" },
		},
	];
	if (state.origin && state.exportQuery) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "link",
					label: "Download as a spreadsheet (CSV)",
					target: {
						kind: "external",
						url: `${state.origin}/_emdash/api/plugins/${state.pluginId}/export?${state.exportQuery}`,
					},
					appearance: "secondary",
				},
			],
		});
	}
	blocks.push({
		type: "stats",
		items: [
			{ label: "Seen", value: all.seen.toLocaleString("en") },
			{ label: "Sign-ups", value: all.sent.toLocaleString("en") },
			{ label: "Button clicks", value: all.clicked.toLocaleString("en") },
			{ label: "Closed", value: all.closed.toLocaleString("en") },
		],
	});
	if (all.seen >= 100) {
		const days = new Map<string, { seen: number; resp: number }>();
		for (const row of rows) {
			const d = days.get(row.day) ?? { seen: 0, resp: 0 };
			d.seen += row.seen;
			d.resp += row.sent + row.clicked;
			days.set(row.day, d);
		}
		// A fresh copy is sorted; nothing shared changes.
		// oxlint-disable-next-line unicorn/no-array-sort
		const sorted = [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		blocks.push({
			type: "chart",
			config: {
				chart_type: "timeseries",
				style: "line",
				height: 220,
				series: [
					{ name: "Seen per day", data: sorted.map(([day, v]) => [noon(day), v.seen]) },
					{
						name: "Sign-ups and clicks per day",
						data: sorted.map(([day, v]) => [noon(day), v.resp]),
					},
				],
			},
		});
	}
	blocks.push({
		type: "table",
		block_id: "numbers",
		page_action_id: "numbers_page",
		empty_text: "Nothing counted for these dates yet.",
		columns: [
			{ key: "name", label: "Popup" },
			{ key: "seen", label: "Seen" },
			{ key: "responses", label: "Responses" },
			{ key: "closed", label: "Closed" },
			{ key: "phones", label: "On phones" },
			{ key: "since", label: "Counted since" },
		],
		rows: state.store.popups
			.filter((popup) => byPopup.has(popup.id))
			.map((popup) => {
				const t = byPopup.get(popup.id)!;
				const responses = responsesText(popup, t);
				return {
					name: popup.name,
					seen: num(t.seen),
					responses:
						t.seen < 100 && t.seen > 0 ? `${responses} (not enough visitors yet)` : responses,
					closed: popup.kind === "inline" ? "–" : num(t.closed),
					phones: t.seen ? `${Math.round((t.phone / t.seen) * 100)}%` : "–",
					since: t.since ? shortDay(t.since) : "–",
				};
			}),
	});
	blocks.push(
		{
			type: "context",
			text: "Whole percentages only, and only after 100 views: smaller numbers swing too much to mean anything. Approximate: ad blockers hide some visits. Nothing about any single visitor is kept; these are daily totals. The spreadsheet has one row per popup per day for the dates shown.",
		},
		{
			type: "context",
			text: "Button links to other websites carry campaign tags (utm_source=popups), so Google Analytics shows those visits as coming from the popup.",
		},
	);
	return blocks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(day: string): string {
	const [y, m, d] = day.split("-").map(Number);
	return `${d} ${MONTHS[(m ?? 1) - 1]}${y === new Date().getUTCFullYear() ? "" : ` ${y}`}`;
}

// ── Settings ────────────────────────────────────────────────

function settingsBlocks(state: PageState): Block[] {
	const s = state.store.settings;
	return [
		...errorBlocks(state),
		{ type: "header", text: "Look" },
		{ type: "context", text: "One look for every popup, so they match your site and each other." },
		{
			type: "form",
			block_id: formId("look", undefined, JSON.stringify(s)),
			fields: [
				{
					type: "radio",
					action_id: "scheme",
					label: "Light or dark",
					options: [
						{ value: "auto", label: "Follow the visitor's device (recommended)" },
						{ value: "light", label: "Always light" },
						{ value: "dark", label: "Always dark" },
					],
					initial_value: s.scheme,
				},
				{
					type: "toggle",
					action_id: "custom",
					label: "Choose my own colours",
					description:
						"Off: your theme's colours, or calm neutral ones if it sets none (recommended).",
					initial_value: s.custom,
				},
				{
					type: "text_input",
					action_id: "background",
					label: "Background (for example #fbf8f3)",
					placeholder: "#fbf8f3",
					initial_value: typed(state, "background", s.colors.background),
					condition: { field: "custom", eq: true },
				},
				{
					type: "text_input",
					action_id: "text",
					label: "Text",
					placeholder: "#2b2420",
					initial_value: typed(state, "text", s.colors.text),
					condition: { field: "custom", eq: true },
				},
				{
					type: "text_input",
					action_id: "accent",
					label: "Button",
					placeholder: "#8a3b12",
					initial_value: typed(state, "accent", s.colors.accent),
					condition: { field: "custom", eq: true },
				},
				{
					type: "radio",
					action_id: "corner",
					label: "Slide-in corner",
					options: [
						{ value: "right", label: "Bottom right (recommended)" },
						{ value: "left", label: "Bottom left (if a chat button lives on the right)" },
					],
					initial_value: s.corner,
				},
			],
			submit: { label: "Save the look", action_id: "save_look" },
		},
		{
			type: "context",
			text: "Your own colours must be easy to read: text on the background, and the button's words on the button, need a 4.5 to 1 contrast. Colours that do not reach it are refused, with the reason.",
		},
		{ type: "header", text: "Emails when a popup cannot open" },
		{
			type: "context",
			text: state.emailReady
				? "If a visitor's browser finds that a popup cannot open (for example, its form was deleted), these people get one email that day saying which popup and how to fix it."
				: "If a visitor's browser finds that a popup cannot open, these people get one email that day. No email service is set up in EmDash yet, so for now the warning only shows on the Popups tab.",
		},
		{
			type: "form",
			block_id: formId("emails", undefined, s.emails.join()),
			fields: [
				{
					type: "text_input",
					action_id: "emails",
					label: "Email addresses (one per line)",
					multiline: true,
					placeholder: "you@example.com",
					initial_value: typed(state, "emails", s.emails.join("\n")),
				},
			],
			submit: { label: "Save the addresses", action_id: "save_emails" },
		},
		{
			type: "accordion",
			label: "For your web person",
			blocks: [
				{ type: "context", text: "Copy these instructions for whoever looks after your theme." },
				{
					type: "code",
					language: "css",
					code: `/* Popups take your theme's colours from these variables (all optional).
   When one is missing, the cookie banner's --cookie-consent-* value is used,
   then a calm neutral colour. Set them for light and dark. */
:root {
  --popups-background: #fbf8f3;
  --popups-text: #2b2420;
  --popups-surface: #f2ebe1;      /* the box itself */
  --popups-rule: #c9bfb3;         /* its edge */
  --popups-accent: #8a3b12;       /* buttons */
  --popups-accent-text: #ffffff;
  --popups-font: system-ui, sans-serif;
  --popups-heading-font: Georgia, serif;
  --popups-radius: 12px;
  --popups-shadow: 0 24px 64px -24px rgb(0 0 0 / .35);
  --popups-backdrop: rgb(0 0 0 / .45);
}
/* The theme must render EmDash's <EmDashHead /> and <EmDashBodyStart />. */`,
				},
			],
		},
	];
}

// ── The four steps ──────────────────────────────────────────

function stepsLine(popup: Popup | undefined, current: number): Block {
	const done = popup?.step ?? 0;
	const parts = STEPS.map((label, i) => {
		const n = i + 1;
		if (popup?.kind === "inline" && n === 3) return null;
		return n === current ? `${n} ${label} (now)` : n <= done ? `${n} ${label} ✓` : `${n} ${label}`;
	}).filter(Boolean);
	return { type: "context", text: parts.join("   ·   ") };
}

function step1Form(state: PageState, popup: Popup | undefined, wizard: boolean): Block {
	return {
		type: "form",
		block_id: formId("s1", popup),
		fields: [
			{
				type: "text_input",
				action_id: "name",
				label: "Name (only you see it)",
				placeholder: "Monthly letter",
				initial_value: typed(state, "name", popup?.name ?? ""),
			},
			{
				type: "radio",
				action_id: "kind",
				label: "What kind",
				options: (Object.keys(KIND_CHOICE) as Kind[]).map((value) => ({
					value,
					label: KIND_CHOICE[value],
				})),
				...(typed(state, "kind", popup?.kind ?? "")
					? { initial_value: typed(state, "kind", popup?.kind ?? "") }
					: {}),
			},
		],
		submit: { label: wizard ? "Next: what it says" : "Save", action_id: "save_s1" },
	};
}

function pictureOptions(state: PageState, popup: Popup | undefined) {
	const options = [{ value: "none", label: "No picture" }];
	for (const item of state.media) {
		options.push({
			value: item.id,
			label: item.alt ? `${item.alt} (${item.filename})` : item.filename,
		});
	}
	// A picture since removed from the list still shows as chosen.
	if (popup?.picture && !state.media.some((m) => m.id === popup.picture!.id)) {
		options.push({ value: popup.picture.id, label: popup.picture.alt || "The current picture" });
	}
	return options;
}

function step2Blocks(state: PageState, popup: Popup, wizard: boolean): Block[] {
	const bar = popup.kind === "bar";
	const inline = popup.kind === "inline";
	const fields: Array<Record<string, unknown>> = [
		{
			type: "text_input",
			action_id: "heading",
			label: bar
				? `Message (up to ${MAX_HEADING} letters)`
				: `Heading (up to ${MAX_HEADING} letters)`,
			placeholder: bar
				? "Open on Boxing Day, 10:00 to 14:00."
				: "Fresh from the oven, once a month",
			initial_value: typed(state, "heading", popup.heading),
		},
		{
			type: "text_input",
			action_id: "text",
			label: bar ? "More words after the message (optional)" : `Text (up to ${MAX_TEXT} letters)`,
			multiline: !bar,
			initial_value: typed(state, "text", popup.text),
		},
	];
	if (!bar) {
		fields.push({
			type: "combobox",
			action_id: "picture",
			label: "Picture (optional), from your media library",
			placeholder: "Type to search your pictures",
			options: pictureOptions(state, popup),
			initial_value: typed(state, "picture", popup.picture?.id ?? "none"),
		});
	}
	if (!bar && state.admin) {
		fields.push({
			type: "radio",
			action_id: "contains",
			label: "It contains",
			options: [
				{ value: "button", label: "A button that opens a page" },
				{ value: "form", label: "A form from Forms (made once there; sign-ups land in its inbox)" },
			],
			initial_value: typed(state, "contains", popup.contains),
		});
		fields.push(
			{
				type: "text_input",
				action_id: "form",
				label: "The form's short name, as shown under Forms (for example: newsletter)",
				placeholder: "newsletter",
				initial_value: typed(state, "form", popup.form),
				condition: { field: "contains", eq: "form" },
			},
			{
				type: "text_input",
				action_id: "thanks",
				label: "Thank-you heading, shown after the form is sent",
				placeholder: "Thanks, you're on the list",
				initial_value: typed(state, "thanks", popup.thanks),
				condition: { field: "contains", eq: "form" },
			},
		);
	}
	const buttonCondition = bar || !state.admin ? undefined : { field: "contains", eq: "button" };
	if (bar || state.admin || popup.contains === "button") {
		fields.push(
			{
				type: "text_input",
				action_id: "button_label",
				label: bar ? "Link words (optional)" : "Button words",
				placeholder: bar ? "See all opening hours" : "Order a cake",
				initial_value: typed(state, "button_label", popup.buttonLabel),
				...(buttonCondition ? { condition: buttonCondition } : {}),
			},
			{
				type: "text_input",
				action_id: "button_url",
				label: bar
					? "Link: a page on this site such as /hours, or a full address"
					: "Where the button goes: a page on this site such as /cakes, or a full address",
				placeholder: "/cakes",
				initial_value: typed(state, "button_url", popup.buttonUrl),
				...(buttonCondition ? { condition: buttonCondition } : {}),
			},
		);
	}
	if (!bar && !inline) {
		fields.push({
			type: "select",
			action_id: "decline",
			label:
				"The quiet way out, beside the button (fixed words, so nobody is shamed for saying no)",
			options: (Object.keys(DECLINE_LABEL) as Array<keyof typeof DECLINE_LABEL>).map((value) => ({
				value,
				label: DECLINE_LABEL[value],
			})),
			initial_value: typed(state, "decline", popup.decline),
		});
	}
	const blocks: Block[] = [];
	if (popup.picture) {
		blocks.push({
			type: "context",
			text: `Picture now: ${popup.picture.alt || "a picture from your media library"}.`,
		});
	}
	blocks.push({
		type: "form",
		block_id: formId("s2", popup),
		fields: fields as never,
		submit: {
			label: wizard ? (inline ? "Next: turn on" : "Next: when and where") : "Save",
			action_id: "save_s2",
		},
	});
	if (!bar) {
		blocks.push({
			type: "context",
			text: state.admin
				? "Pictures come from Media; add new ones there. With a form: the short name is checked when you save. The thank-you text under the heading is the form's own confirmation message, set under Forms; if the form sends visitors to another page instead, that wins. Forms with file uploads or Cloudflare Turnstile cannot be used in a popup or slide-in yet; put them in a box in a page."
				: popup.contains === "form"
					? `It contains the form "${popup.form}". Only an administrator can change the form.`
					: "Pictures come from Media; add new ones there.",
		});
	}
	return blocks;
}

function step3Form(state: PageState, popup: Popup, wizard: boolean): Block {
	const fields: Array<Record<string, unknown>> = [];
	if (popup.kind !== "bar") {
		fields.push({
			type: "select",
			action_id: "trigger",
			label: "When it opens",
			options: (Object.keys(TRIGGER_CHOICE) as Array<keyof typeof TRIGGER_CHOICE>).map((value) => ({
				value,
				label: TRIGGER_CHOICE[value],
			})),
			initial_value: popup.trigger === "load" ? "read" : popup.trigger,
		});
	}
	if (popup.kind === "modal") {
		fields.push({
			type: "toggle",
			action_id: "first_page",
			label: "Show on the first page they visit (computers only)",
			description:
				"Off by default: a box over the first page someone sees makes many people leave, and Google ranks pages lower on phones when it happens there. Phones always wait for the second page.",
			initial_value: popup.firstPage,
		});
	}
	fields.push(
		{
			type: "radio",
			action_id: "where",
			label: "Where",
			options: [
				{ value: "all", label: "Every page" },
				{ value: "prefix", label: "Only pages whose address starts with…" },
				{ value: "collections", label: "Everything in a collection" },
			],
			initial_value: popup.where,
		},
		{
			type: "text_input",
			action_id: "prefixes",
			label: "Addresses (one per line; /cakes/ covers every page under it)",
			multiline: true,
			placeholder: "/cakes/",
			initial_value: typed(state, "prefixes", popup.prefixes.join("\n")),
			condition: { field: "where", eq: "prefix" },
		},
	);
	if (state.collections.length) {
		fields.push({
			type: "checkbox",
			action_id: "collections",
			label: "Collections",
			options: state.collections.map((c) => ({ value: c.slug, label: c.label })),
			initial_value: popup.collections,
			condition: { field: "where", eq: "collections" },
		});
	}
	fields.push(
		{
			type: "text_input",
			action_id: "exclude",
			label: "Never on these pages (one address per line; /cakes/ also covers every page under it)",
			multiline: true,
			placeholder: "/contact",
			initial_value: typed(state, "exclude", popup.exclude.join("\n")),
		},
		{
			type: "radio",
			action_id: "devices",
			label: "On",
			options: [
				{ value: "all", label: "Phones and computers" },
				{ value: "desktop", label: "Computers only" },
				{ value: "phone", label: "Phones only" },
			],
			initial_value: popup.devices,
		},
		{
			type: "select",
			action_id: "again",
			label: "After someone closes it, show it to them again",
			options: [
				{ value: "week", label: "After a week" },
				{ value: "month", label: "After a month (recommended)" },
				{ value: "never", label: "Never" },
			],
			initial_value: popup.again,
		},
	);
	return {
		type: "form",
		block_id: formId("s3", popup),
		fields: fields as never,
		submit: { label: wizard ? "Next: dates and turn on" : "Save", action_id: "save_s3" },
	};
}

function summary(popup: Popup, state: PageState): Block {
	const opens =
		popup.kind === "bar"
			? "As soon as the page opens"
			: popup.kind === "inline"
				? "Where you place the Popups box block"
				: popup.trigger === "click"
					? "When they click a button or link that your web person sets up"
					: popup.trigger === "exit"
						? "When they are about to leave (computers only)"
						: popup.kind === "modal" && !popup.firstPage
							? "After they have read a while, from their second page"
							: "After they have read a while";
	const says =
		popup.contains === "form" && popup.kind !== "bar"
			? `${popup.heading} (form "${popup.form}")`
			: popup.heading;
	const fields = [
		{ label: "Kind", value: kindLine(popup) },
		{ label: "Says", value: says || "(nothing yet)" },
		{ label: "Opens", value: opens },
	];
	if (popup.kind !== "inline") {
		fields.push(
			{
				label: "Where",
				value: `${showsOnText(popup, state)}; ${popup.devices === "all" ? "phones and computers" : popup.devices === "desktop" ? "computers only" : "phones only"}`,
			},
			{
				label: "Again after closing",
				value:
					popup.again === "never"
						? "Never"
						: popup.again === "week"
							? "After a week"
							: "After a month",
			},
		);
	}
	fields.push({ label: "Dates", value: datesText(popup, state) });
	return { type: "fields", fields };
}

/** Instructions for whoever looks after the theme, never code in the owner's path. */
function clickInstructions(popup: Popup): Block[] {
	if (popup.kind === "inline" || popup.kind === "bar" || popup.trigger !== "click") return [];
	return [
		{
			type: "context",
			text: "Visitors open it by clicking a button or link that your web person sets up. Copy the instructions for your web person:",
		},
		{
			type: "code",
			code: `To open the popup "${popup.name}" when a visitor clicks:\n- link to /#popup-${popup.handle} (also as a menu item's custom link), or\n- add data-popup="${popup.handle}" to any button.\nIt opens on the pages this popup is set to show on.`,
		},
	];
}

function previewLinks(popup: Popup, state: PageState): Block[] {
	if (!state.origin) return [];
	if (popup.kind === "inline") {
		return [
			{
				type: "context",
				text: 'To see it, add the "Popups box" block to a page or post in the editor, choose this box, and preview that page.',
			},
		];
	}
	const page = popup.where === "prefix" && popup.prefixes[0] ? popup.prefixes[0] : "/";
	const url = (scheme: string) =>
		`${state.origin}${page}?popups_preview=${popup.id}&scheme=${scheme}`;
	return [
		{
			type: "actions",
			elements: [
				{
					type: "link",
					label: "Preview on your site",
					target: { kind: "external", url: url("light") },
					appearance: "primary",
				},
				{
					type: "link",
					label: "Preview in dark mode",
					target: { kind: "external", url: url("dark") },
					appearance: "secondary",
				},
			],
		},
		{
			type: "context",
			text: "The preview opens a page of your site with it already showing, and says whether a real visitor would see it now and why not. Nothing is counted and the form does not send. Narrow the window to see the phone layout. Save your changes first.",
		},
	];
}

function step4Blocks(state: PageState, popup: Popup, wizard: boolean): Block[] {
	const start = popup.start ? fromMoment(popup.start, state.zone) : null;
	const end = popup.end ? fromMoment(popup.end, state.zone) : null;
	const times = HALF_HOURS.map((t) => ({ value: t, label: t }));
	return [
		summary(popup, state),
		...clickInstructions(popup),
		...previewLinks(popup, state),
		{ type: "context", text: `Times are ${state.zone} time, your site's time zone.` },
		{
			type: "form",
			block_id: formId("s4", popup),
			fields: [
				{
					type: "date_input",
					action_id: "start_date",
					label: "Starts on (leave empty to start now)",
					initial_value: typed(state, "start_date", start?.date ?? "") || undefined,
				},
				{
					type: "select",
					action_id: "start_time",
					label: "Start time",
					options: times,
					initial_value: typed(state, "start_time", start?.clock ?? "00:00"),
				},
				{
					type: "date_input",
					action_id: "end_date",
					label: "Ends on (leave empty to keep it on)",
					initial_value: typed(state, "end_date", end?.date ?? "") || undefined,
				},
				{
					type: "select",
					action_id: "end_time",
					label: "End time",
					options: times,
					initial_value: typed(state, "end_time", end?.clock ?? "00:00"),
				},
				{
					type: "toggle",
					action_id: "on",
					label: "Turn it on",
					description: "It starts at its start time by itself and stops at its end.",
					initial_value: wizard ? true : popup.on,
				},
			],
			submit: { label: wizard ? "Save and finish" : "Save", action_id: "save_s4" },
		},
	];
}

/** "New popup", one step at a time, or a finished popup with every step as a section. */
function popupPage(state: PageState, popup: Popup | undefined, step: number): BlockResponse {
	const blocks: Block[] = [{ type: "header", text: popup ? popup.name : "New popup" }];
	const wizard = !popup || popup.step < 4;
	blocks.push(...errorBlocks(state));
	if (wizard) {
		blocks.push(stepsLine(popup, step));
		if (step === 1) blocks.push(step1Form(state, popup, true));
		if (step === 2 && popup) blocks.push(...step2Blocks(state, popup, true));
		if (step === 3 && popup) blocks.push(step3Form(state, popup, true));
		if (step === 4 && popup) blocks.push(...step4Blocks(state, popup, true));
		const back =
			step > 1 && popup
				? `back:${popup.id}:${popup.kind === "inline" && step === 4 ? 2 : step - 1}`
				: "list";
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "nav",
					label: step > 1 ? "Back" : "Cancel",
					value: back,
					style: "secondary",
				},
			],
		});
	} else if (popup) {
		blocks.push({ type: "context", text: `${kindLine(popup)} · ${statusOf(popup, state)}` });
		if (state.admin) {
			blocks.push({ type: "header", text: "1 What kind" }, step1Form(state, popup, false));
		}
		blocks.push({ type: "header", text: "2 What it says" }, ...step2Blocks(state, popup, false));
		if (state.admin && popup.kind !== "inline") {
			blocks.push({ type: "header", text: "3 When and where" }, step3Form(state, popup, false));
		}
		blocks.push(
			{ type: "header", text: "4 Dates and turn on" },
			...step4Blocks(state, popup, false),
		);
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "nav",
					label: "Back to the list",
					value: "list",
					style: "secondary",
				},
			],
		});
	}
	return { blocks, ...(state.toast ? { toast: state.toast } : {}) };
}

function previewPage(state: PageState, popup: Popup): BlockResponse {
	return {
		blocks: [
			{ type: "header", text: `Preview "${popup.name}"` },
			...previewLinks(popup, state),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "nav",
						label: "Back to the list",
						value: "list",
						style: "secondary",
					},
				],
			},
		],
	};
}

export function renderPage(state: PageState, tab: number = TAB.popups): BlockResponse {
	const blocks: Block[] = [{ type: "header", text: "Popups" }];
	const panels = [
		{ label: "Popups", blocks: listBlocks(tab === TAB.popups ? state : clean(state)) },
		{ label: "Numbers", blocks: numbersBlocks(tab === TAB.numbers ? state : clean(state)) },
	];
	if (state.admin)
		panels.push({
			label: "Settings",
			blocks: settingsBlocks(tab === TAB.settings ? state : clean(state)),
		});
	blocks.push({ type: "tab", default_tab: tab, panels });
	return { blocks, ...(state.toast ? { toast: state.toast } : {}) };
}

function clean(state: PageState): PageState {
	return { ...state, draft: undefined, errors: undefined, notes: undefined };
}

// ── Saving ──────────────────────────────────────────────────

export interface Interaction {
	type?: unknown;
	action_id?: unknown;
	block_id?: unknown;
	value?: unknown;
	values?: unknown;
}

export interface Outcome {
	save?: Store;
	/** Problems to store (a fixed form clears its warning). */
	problems?: Problems;
	response: BlockResponse;
}

export interface Helpers {
	checkForm(form: string, overlay: boolean): Promise<FormCheck>;
	/** The public address of a media library picture, or null when it cannot be found. */
	publicUrl(mediaId: string): Promise<string | null>;
}

const SAVED = "Saved. It can take a few minutes to reach visitors.";
const REFUSED: BlockResponse["toast"] = {
	type: "error",
	message: "Nothing was saved. See the message at the top.",
};

const has = (values: Record<string, unknown>, key: string) => Object.hasOwn(values, key);
const text = (values: Record<string, unknown>, key: string, saved: string) =>
	has(values, key) && typeof values[key] === "string" ? (values[key] as string).trim() : saved;

function pictureFrom(state: PageState, value: unknown, saved: Picture | null): Picture | null {
	if (value === undefined) return saved;
	if (value === "none" || value === "" || value === null) return null;
	if (saved && value === saved.id) return saved;
	const found = state.media.find((m) => m.id === value);
	return found
		? { id: found.id, url: found.url, alt: found.alt, width: found.width, height: found.height }
		: saved;
}

export async function handleInteraction(
	input: Interaction | undefined,
	state: PageState,
	helpers: Helpers,
): Promise<Outcome> {
	const type = input?.type;
	const action = typeof input?.action_id === "string" ? input.action_id : "";
	const values =
		typeof input?.values === "object" && input.values !== null
			? (input.values as Record<string, unknown>)
			: {};
	const value = typeof input?.value === "string" ? input.value : "";
	const store = state.store;
	const find = (id: string | undefined) => store.popups.find((p) => p.id === id);
	const blockPopup = () =>
		typeof input?.block_id === "string" ? input.block_id.split(":")[1] : undefined;
	const next = (popups: Popup[], settings = store.settings) => normalizeStore({ popups, settings });
	const only = (message: string): Outcome => ({
		response: renderPage({ ...state, toast: { type: "error", message } }),
	});

	if (type !== "block_action" && type !== "form_submit") return { response: renderPage(state) };

	// ── Moving around ──
	if (type === "block_action" && action === "nav") {
		if (value.startsWith("back:")) {
			const [, id, step] = value.split(":");
			const popup = find(id);
			if (popup) return { response: popupPage(state, popup, Number(step) || 1) };
		}
		return { response: renderPage(state) };
	}
	if (type === "block_action" && action === "new") {
		if (!state.admin) return only("Only an administrator can make new popups.");
		if (store.popups.length >= MAX_POPUPS)
			return only(`A site can have ${MAX_POPUPS} popups. Delete one you no longer use first.`);
		return { response: popupPage(state, undefined, 1) };
	}
	if (type === "block_action" && action === "row") {
		const [verb, id] = value.split(":");
		const popup = find(id);
		if (!popup) return { response: renderPage(state) };
		if (verb === "change")
			return {
				response: popupPage(
					state,
					popup,
					popup.step < 4 ? popup.step + (popup.kind === "inline" && popup.step === 2 ? 2 : 1) : 4,
				),
			};
		if (verb === "preview") return { response: previewPage(state, popup) };
		if (verb === "toggle") {
			if (popup.step < 4) return { response: popupPage(state, popup, Math.min(4, popup.step + 1)) };
			const save = next(store.popups.map((p) => (p.id === popup.id ? { ...p, on: !p.on } : p)));
			return {
				save,
				response: renderPage({
					...state,
					store: save,
					toast: {
						type: "success",
						message: popup.on ? `"${popup.name}" is off.` : `"${popup.name}" is on. ${SAVED}`,
					},
				}),
			};
		}
		if (!state.admin) return only("Only an administrator can duplicate or delete popups.");
		if (verb === "duplicate") {
			if (store.popups.length >= MAX_POPUPS)
				return only(`A site can have ${MAX_POPUPS} popups. Delete one you no longer use first.`);
			const name = `${popup.name} (copy)`.slice(0, 80);
			const copy: Popup = {
				...popup,
				id: newId(),
				name,
				handle: uniqueHandle(
					name,
					store.popups.map((p) => p.handle),
				),
				on: false,
				createdAt: new Date(state.now).toISOString(),
			};
			const save = next([...store.popups, copy]);
			return {
				save,
				response: renderPage({
					...state,
					store: save,
					toast: { type: "success", message: `Made "${name}", turned off.` },
				}),
			};
		}
		if (verb === "delete") {
			const save = next(store.popups.filter((p) => p.id !== popup.id));
			const problems = { ...state.problems };
			delete problems[popup.id];
			return {
				save,
				problems,
				response: renderPage({
					...state,
					store: save,
					problems,
					toast: { type: "success", message: `Deleted "${popup.name}".` },
				}),
			};
		}
		return { response: renderPage(state) };
	}

	if (type !== "form_submit") return { response: renderPage(state) };

	// ── Numbers and Settings ──
	if (action === "range") {
		const from = typeof values.from === "string" ? values.from.slice(0, 10) : "";
		const to = typeof values.to === "string" ? values.to.slice(0, 10) : "";
		if (from && to && from > to) {
			return {
				response: renderPage(
					{ ...state, errors: ["The From day must be before the To day."], toast: REFUSED },
					TAB.numbers,
				),
			};
		}
		// The route reads the rows for the new dates and renders again.
		return { response: renderPage({ ...state, range: { from, to } }, TAB.numbers) };
	}
	if (action === "save_look" || action === "save_emails") {
		if (!state.admin) return only("Only an administrator can change the settings.");
		const settings = { ...store.settings };
		if (action === "save_look") {
			if (has(values, "scheme")) settings.scheme = values.scheme as typeof settings.scheme;
			if (has(values, "corner")) settings.corner = values.corner as typeof settings.corner;
			if (typeof values.custom === "boolean") settings.custom = values.custom;
			if (settings.custom) {
				const colors = {
					background: cleanColor(text(values, "background", settings.colors.background)),
					text: cleanColor(text(values, "text", settings.colors.text)),
					accent: cleanColor(text(values, "accent", settings.colors.accent)),
				};
				const problems = colorProblems(colors);
				if (problems.length)
					return {
						response: renderPage(
							{ ...state, draft: values, errors: problems, toast: REFUSED },
							TAB.settings,
						),
					};
				settings.colors = colors;
			}
		} else {
			const { emails, wrong } = parseEmails(values.emails);
			if (wrong.length) {
				return {
					response: renderPage(
						{
							...state,
							draft: values,
							errors: [`These do not look like email addresses: ${wrong.join(", ")}.`],
							toast: REFUSED,
						},
						TAB.settings,
					),
				};
			}
			settings.emails = emails;
		}
		const save = next(store.popups, settings);
		return {
			save,
			response: renderPage(
				{ ...state, store: save, toast: { type: "success", message: SAVED } },
				TAB.settings,
			),
		};
	}

	// ── The steps ──
	const id = blockPopup();
	const existing = id && id !== "new" ? find(id) : undefined;
	const refuse = (popup: Popup | undefined, step: number, errors: string[]): Outcome => ({
		response: popupPage({ ...state, draft: values, errors, toast: REFUSED }, popup, step),
	});
	const finish = (
		popup: Popup,
		step: number,
		extra: Partial<PageState> = {},
		problems?: Problems,
	): Outcome => {
		const updated = { ...popup, step: Math.max(popup.step, step) };
		const popups = store.popups.some((p) => p.id === popup.id)
			? store.popups.map((p) => (p.id === popup.id ? updated : p))
			: [...store.popups, updated];
		const save = next(popups);
		const saved = save.popups.find((p) => p.id === popup.id)!;
		const view = { ...state, ...extra, store: save, ...(problems ? { problems } : {}) };
		if (popup.step < 4) {
			// Next step of "New popup"; a box in a page has no "When and where".
			if (step === 4)
				return {
					save,
					problems,
					response: renderPage({
						...view,
						toast: {
							type: "success",
							message: saved.on
								? `"${saved.name}" is ready and on. ${SAVED}`
								: `"${saved.name}" is saved, turned off.`,
						},
					}),
				};
			const following = saved.kind === "inline" && step === 2 ? 4 : step + 1;
			return { save, problems, response: popupPage(view, saved, following) };
		}
		return {
			save,
			problems,
			response: popupPage({ ...view, toast: { type: "success", message: SAVED } }, saved, 4),
		};
	};

	if (action === "save_s1") {
		if (!state.admin) return only("Only an administrator can change the kind.");
		const name = text(values, "name", existing?.name ?? "");
		const kind = (has(values, "kind") ? values.kind : existing?.kind) as Kind | undefined;
		const errors: string[] = [];
		if (!name) errors.push("Give it a name, so you can find it in the list.");
		if (!kind || !(kind in KIND_LABEL)) errors.push("Choose what kind it is.");
		if (errors.length) return refuse(existing, 1, errors);
		if (!existing && store.popups.length >= MAX_POPUPS)
			return only(`A site can have ${MAX_POPUPS} popups.`);
		const base: Popup =
			existing ??
			({
				id: newId(),
				handle: "",
				name,
				kind: kind!,
				heading: "",
				text: "",
				picture: null,
				contains: "button",
				buttonLabel: "",
				buttonUrl: "",
				form: "",
				thanks: "",
				decline: "no-thanks",
				trigger: kind === "bar" ? "load" : "read",
				where: "all",
				prefixes: [],
				collections: [],
				exclude: [],
				devices: "all",
				again: "month",
				firstPage: false,
				start: null,
				end: null,
				on: false,
				step: 1,
				formNote: "",
				createdAt: new Date(state.now).toISOString(),
			} satisfies Popup);
		const handle =
			existing?.handle ||
			uniqueHandle(
				name,
				store.popups.map((p) => p.handle),
			);
		return finish(
			{
				...base,
				name,
				kind: kind!,
				handle,
				trigger: kind === "bar" ? "load" : base.trigger === "load" ? "read" : base.trigger,
			},
			1,
		);
	}

	if (!existing)
		return {
			response: renderPage({
				...state,
				toast: { type: "error", message: "That popup no longer exists." },
			}),
		};
	const popup = existing;

	if (action === "save_s2") {
		const heading = text(values, "heading", popup.heading);
		const words = text(values, "text", popup.text);
		const errors: string[] = [];
		if (!heading) errors.push(popup.kind === "bar" ? "Write the message." : "Write a heading.");
		if (heading.length > MAX_HEADING)
			errors.push(
				`The ${popup.kind === "bar" ? "message" : "heading"} is ${heading.length} letters; keep it to ${MAX_HEADING}.`,
			);
		if (words.length > MAX_TEXT)
			errors.push(`The text is ${words.length} letters; keep it to ${MAX_TEXT}.`);
		const contains =
			state.admin && popup.kind !== "bar" && has(values, "contains")
				? values.contains === "form"
					? "form"
					: "button"
				: popup.kind === "bar"
					? "button"
					: popup.contains;
		const form = state.admin ? text(values, "form", popup.form) : popup.form;
		const buttonLabel = text(values, "button_label", popup.buttonLabel);
		const buttonUrl = text(values, "button_url", popup.buttonUrl);
		if (contains === "form" && !form)
			errors.push("Type the form's short name, as shown under Forms.");
		if (contains === "button") {
			if (popup.kind !== "bar" && (!buttonLabel || !buttonUrl))
				errors.push("Write the button words and where the button goes.");
			if ((buttonLabel && !buttonUrl) || (!buttonLabel && buttonUrl)) {
				if (popup.kind === "bar")
					errors.push("Write both the link words and the link, or neither.");
			}
			if (buttonUrl && !isSafeLink(buttonUrl))
				errors.push(
					"The link must be a page on this site such as /cakes, a full address starting with https://, or an email (mailto:) or phone (tel:) link.",
				);
		}
		if (errors.length) return refuse(popup, 2, errors);
		let picture = popup.kind === "bar" ? null : pictureFrom(state, values.picture, popup.picture);
		if (picture && picture.id !== popup.picture?.id) {
			// The media library gives plugins a signed-in address; visitors need the public one.
			const url = await helpers.publicUrl(picture.id);
			if (!url)
				return refuse(popup, 2, [
					"That picture could not be prepared for visitors just now. Please save again in a moment.",
				]);
			picture = { ...picture, url };
		}
		const notes: string[] = [];
		let formNote: Popup["formNote"] = "";
		let problems: Problems | undefined;
		if (
			contains === "form" &&
			state.admin &&
			(form !== popup.form ||
				contains !== popup.contains ||
				popup.formNote ||
				state.problems[popup.id] ||
				popup.step < 2)
		) {
			const check = await helpers.checkForm(form, popup.kind !== "inline");
			const said = describeCheck(check, form);
			if (said?.refuse) return refuse(popup, 2, [said.text]);
			if (said) notes.push(said.text);
			formNote =
				check.result === "paused" ? "paused" : check.result === "unchecked" ? "unchecked" : "";
			// A form that was fixed takes its warning away.
			problems = { ...state.problems };
			delete problems[popup.id];
		}
		return finish(
			{
				...popup,
				heading,
				text: words,
				picture,
				contains,
				form,
				thanks: state.admin
					? text(values, "thanks", popup.thanks).slice(0, MAX_HEADING)
					: popup.thanks,
				buttonLabel: buttonLabel.slice(0, 40),
				buttonUrl,
				decline: has(values, "decline") ? (values.decline as Popup["decline"]) : popup.decline,
				formNote:
					contains === "form" ? formNote || (form === popup.form ? popup.formNote : "") : "",
			},
			2,
			{ notes },
			problems,
		);
	}

	if (action === "save_s3") {
		if (!state.admin) return only("Only an administrator can change when and where it shows.");
		const where = has(values, "where") ? (values.where as Popup["where"]) : popup.where;
		const prefixes = has(values, "prefixes") ? parsePaths(values.prefixes) : popup.prefixes;
		const collections = Array.isArray(values.collections)
			? values.collections.filter(
					(c): c is string => typeof c === "string" && state.collections.some((k) => k.slug === c),
				)
			: popup.collections;
		const errors: string[] = [];
		if (where === "prefix" && prefixes.length === 0)
			errors.push("Type at least one address, such as /cakes/.");
		if (where === "collections" && collections.length === 0)
			errors.push("Tick at least one collection.");
		if (errors.length) return refuse(popup, 3, errors);
		return finish(
			{
				...popup,
				trigger:
					popup.kind === "bar"
						? "load"
						: has(values, "trigger")
							? (values.trigger as Popup["trigger"])
							: popup.trigger,
				firstPage:
					popup.kind === "modal" &&
					(typeof values.first_page === "boolean" ? values.first_page : popup.firstPage),
				where,
				prefixes,
				collections,
				exclude: has(values, "exclude") ? parsePaths(values.exclude) : popup.exclude,
				devices: has(values, "devices") ? (values.devices as Popup["devices"]) : popup.devices,
				again: has(values, "again") ? (values.again as Popup["again"]) : popup.again,
			},
			3,
		);
	}

	if (action === "save_s4") {
		const moment = (dateKey: string, timeKey: string, saved: number | null) => {
			if (!has(values, dateKey)) return { ok: true, ms: saved };
			const date =
				typeof values[dateKey] === "string" ? (values[dateKey] as string).slice(0, 10) : "";
			if (!date) return { ok: true, ms: null };
			const clock =
				typeof values[timeKey] === "string"
					? (values[timeKey] as string)
					: saved
						? fromMoment(saved, state.zone).clock
						: "00:00";
			const ms = toMoment(date, clock, state.zone);
			return { ok: ms !== null, ms };
		};
		const start = moment("start_date", "start_time", popup.start);
		const end = moment("end_date", "end_time", popup.end);
		const errors: string[] = [];
		if (!start.ok || !end.ok) errors.push("Choose the days from the calendar.");
		if (start.ms && end.ms && end.ms <= start.ms) errors.push("It must end after it starts.");
		if (errors.length) return refuse(popup, 4, errors);
		// A time chosen without a day moves an existing day to that time.
		const startMs =
			!has(values, "start_date") && popup.start && typeof values.start_time === "string"
				? toMoment(fromMoment(popup.start, state.zone).date, values.start_time, state.zone)
				: start.ms;
		const endMs =
			!has(values, "end_date") && popup.end && typeof values.end_time === "string"
				? toMoment(fromMoment(popup.end, state.zone).date, values.end_time, state.zone)
				: end.ms;
		return finish(
			{
				...popup,
				start: startMs,
				end: endMs,
				on: typeof values.on === "boolean" ? values.on : popup.step < 4 ? true : popup.on,
			},
			4,
		);
	}

	return { response: renderPage(state) };
}
