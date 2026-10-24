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
import type { ExportRange } from "./export-link.js";
import { describeCheck, type FormCheck, type FormOption } from "./forms.js";
import { hiddenFrom, HIDE_ACTION, hideForm } from "./help-line.js";
import {
	compare,
	COMPARE_PERIOD,
	daysText,
	ENOUGH_VIEWS,
	isForm,
	isPeriod,
	parseSort,
	PERIODS,
	periodDays,
	periodLabel,
	POPUP_PERIOD,
	popupTiles,
	responseBars,
	startedOn,
	sum,
	type Period,
	type Sort,
	type Tile,
} from "./results.js";
import type { CountRow, RowQuery } from "./stats.js";
import { describeMoment, fromMoment, HALF_HOURS, toMoment, zoneDay } from "./time.js";

/**
 * The one admin page, as Block Kit: Popups, Results, Settings, and the four
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
	pluginId: string;
	/** The period picked for results, kept while moving between a popup's page and Results. */
	period?: Period;
	/** How "How your popups compare" is sorted, when someone sorted it. */
	sort?: Sort | null;
	problems: Problems;
	media: MediaOption[];
	/** The site's forms for step 2's dropdown; absent when Forms could not list them. */
	forms?: FormOption[] | null;
	collections: Array<{ slug: string; label: string }>;
	/** An email provider is set up in EmDash. */
	emailReady: boolean;
	/** What was typed, kept on screen when a save was refused. */
	draft?: Record<string, unknown>;
	errors?: string[];
	notes?: string[];
	toast?: BlockResponse["toast"];
}

// "numbers" is the Results tab: the old name stays in action values so nothing breaks.
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

// ── Results ─────────────────────────────────────────────────

/**
 * Results are drawn in two passes. The screens put a placeholder where results
 * go (`resultsSlot`); once the screen is known, the route reads the count rows
 * for exactly that popup and period, once, and `fillResults` puts the blocks
 * in. So a screen without results (a step, a preview) reads no rows at all.
 */
const SLOT = "results-slot";

interface SlotRequest {
	/** A popup's id, or "" for every popup (the Results tab). */
	popup: string;
	period: Period;
	sort: Sort | null;
}

function resultsSlot(request: SlotRequest): Block {
	return { type: "context", block_id: SLOT, text: JSON.stringify(request) };
}

/** What `fillResults` needs: the screen's facts, a way to read rows and to sign a download. */
export interface ResultsSource {
	store: Store;
	zone: string;
	now: number;
	origin?: string;
	pluginId: string;
	rows(query: RowQuery): Promise<CountRow[]>;
	sign(range: ExportRange): Promise<string | undefined>;
}

function findSlot(blocks: Block[]): SlotRequest | null {
	for (const block of blocks) {
		if (block.type === "context" && block.block_id === SLOT) return JSON.parse(block.text);
		if (block.type === "tab")
			for (const panel of block.panels) {
				const found = findSlot(panel.blocks);
				if (found) return found;
			}
	}
	return null;
}

function replaceSlot(blocks: Block[], filled: Block[]): Block[] {
	return blocks.flatMap((block): Block[] => {
		if (block.type === "context" && block.block_id === SLOT) return filled;
		if (block.type === "tab")
			return [
				{
					...block,
					panels: block.panels.map((p) => ({ ...p, blocks: replaceSlot(p.blocks, filled) })),
				},
			];
		return [block];
	});
}

/** Puts the results into a drawn screen, reading only the rows it shows. */
export async function fillResults(
	response: BlockResponse,
	source: ResultsSource,
): Promise<BlockResponse> {
	const request = findSlot(response.blocks);
	if (!request) return response;
	const popup = request.popup ? source.store.popups.find((p) => p.id === request.popup) : undefined;
	const filled =
		request.popup && popup
			? await popupResults(popup, request.period, source)
			: request.popup
				? []
				: await compareResults(request.period, request.sort, source);
	return { ...response, blocks: replaceSlot(response.blocks, filled) };
}

type SelectElement = Extract<
	Extract<Block, { type: "actions" }>["elements"][number],
	{ type: "select" }
>;

function periodPicker(scope: string, period: Period, one: boolean): SelectElement {
	return {
		type: "select",
		action_id: "period",
		label: "Period",
		// The select tells the page only its value, so the value says which screen it is on.
		options: PERIODS.map((p) => ({ label: periodLabel(p, one), value: `${scope}:${p}` })),
		initial_value: `${scope}:${period}`,
	};
}

const statsRow = (tiles: Tile[]): Block => ({ type: "stats", items: tiles });

function downloadLink(source: ResultsSource, query: string | undefined, label: string): Block[] {
	if (!source.origin || !query) return [];
	return [
		{
			type: "actions",
			elements: [
				{
					type: "link",
					label,
					target: {
						kind: "external",
						url: `${source.origin}/_emdash/api/plugins/${source.pluginId}/export?${query}`,
					},
					appearance: "secondary",
				},
			],
		},
	];
}

/** A finished popup's results: the period, four tiles, a bar a day, and its own download. */
async function popupResults(popup: Popup, period: Period, source: ResultsSource): Promise<Block[]> {
	const today = zoneDay(source.now, source.zone);
	const days = periodDays(period, source.now, source.zone, startedOn(popup, source.zone));
	const first = days.before && days.before.from < days.from ? days.before.from : days.from;
	const [rows, query] = await Promise.all([
		source.rows({ from: first, to: days.to, popup: popup.id }),
		source.sign({ from: days.from, to: days.to, popup: popup.id }),
	]);
	const current = sum(rows, days);
	const before = days.before ? sum(rows, days.before) : null;
	const tiles = popupTiles(popup, current, before);
	const compared = tiles.some((t) => t.description?.includes(" from "));
	const when = [
		daysText(days, today),
		days.cut ? " (counts are kept for 400 days)" : "",
		compared && days.before ? `, compared with ${daysText(days.before, today)}` : "",
	].join("");
	const blocks: Block[] = [
		{ type: "header", text: "Results" },
		{
			type: "actions",
			// The period in the id: arriving from another screen draws the picker afresh, showing it.
			block_id: `period:p:${popup.id}:${period}`,
			elements: [
				periodPicker(`p:${popup.id}`, period, true),
				{
					type: "button",
					action_id: "nav",
					label: "Compare with other popups",
					value: `numbers:${period}`,
					style: "secondary",
				},
			],
		},
		{ type: "context", text: `${when}.` },
		// Two by two: EmDash lays a stats block out in one line that never wraps, and four boxes
		// run off a 390 px phone.
		statsRow(tiles.slice(0, 2)),
		statsRow(tiles.slice(2)),
	];
	if (current.seen >= ENOUGH_VIEWS) {
		const bars = responseBars(popup, rows, days);
		const word = isForm(popup) ? "Sign-ups" : "Button clicks";
		blocks.push({
			type: "chart",
			config: {
				chart_type: "timeseries",
				style: "bar",
				height: 180,
				series: [{ name: `${word} per ${bars.weekly ? "week" : "day"}`, data: bars.data }],
			},
		});
	}
	blocks.push(...downloadLink(source, query, "Download this popup's numbers (CSV)"));
	return blocks;
}

/** Results tab: every popup side by side for one period, sortable by Seen and Rate. */
async function compareResults(
	period: Period,
	sort: Sort | null,
	source: ResultsSource,
): Promise<Block[]> {
	const today = zoneDay(source.now, source.zone);
	const days = periodDays(period, source.now, source.zone);
	const [rows, query] = await Promise.all([
		source.rows({ from: days.from, to: days.to }),
		source.sign({ from: days.from, to: days.to }),
	]);
	const { rows: table, total } = compare(source.store.popups, rows, days, sort);
	const n = (x: number) => x.toLocaleString("en");
	return [
		{ type: "header", text: "How your popups compare" },
		{
			type: "actions",
			block_id: `period:r:${period}`,
			elements: [periodPicker("r", period, false)],
		},
		{ type: "context", text: `${daysText(days, today)}.` },
		statsRow([
			{ label: "Seen", value: n(total.seen) },
			{ label: "Sign-ups", value: n(total.sent) },
		]),
		statsRow([
			{ label: "Button clicks", value: n(total.clicked) },
			{ label: "Closed", value: n(total.closed) },
		]),
		{
			type: "table",
			// The period in the id: sorting then knows the period, and a new period starts unsorted.
			block_id: `results:${period}`,
			page_action_id: "numbers_page",
			empty_text: "No popups yet.",
			columns: [
				{ key: "name", label: "Popup" },
				{ key: "seen", label: "Seen", sortable: true },
				{ key: "responses", label: "Sign-ups or clicks" },
				{ key: "rate", label: "Rate", sortable: true },
				{ key: "closed", label: "Closed" },
				{ key: "phones", label: "Seen on phones" },
			],
			rows: table as unknown as Array<Record<string, unknown>>,
		},
		...downloadLink(source, query, "Download as a spreadsheet (CSV)"),
		{
			type: "context",
			text: "Forms counts every sign-up to a form, wherever it sits; here you see only those that came through a popup. Ad blockers hide some visits.",
		},
		{
			type: "context",
			text: `Rate is sign-ups or clicks out of views, in whole percent, shown from 100 views: smaller numbers swing too much to mean anything. Days follow your site's time zone (${source.zone}). Counts are daily totals, kept for 400 days, with nothing about any single visitor.`,
		},
		{
			type: "context",
			text: 'Button links to other websites carry campaign tags (utm_source=popups), so Google Analytics shows those visits as coming from the popup. To see in Forms which popup a sign-up came from, add a hidden field named "utm_campaign" to the form.',
		},
	];
}

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
				"Open Forms, copy the short name of the form you want, then paste it in this popup under Edit ▸ What it says. Visitors see nothing broken in the meantime; the popup simply stays closed.",
		}),
		unsupported: (p) => ({
			title: `"${p.name}" cannot open: its form uses Turnstile or a file upload`,
			description:
				"Those only work in a box in a page for now. Choose another form under Edit ▸ What it says, or make a box in a page with this form.",
		}),
		paused: (p) => ({
			title: `"${p.name}" is waiting: its form "${p.form}" is paused under Forms`,
			description: "It opens again by itself once the form is turned back on under Forms.",
		}),
	};

/**
 * A popup's own actions (change, preview, toggle, duplicate, delete) all send
 * "verb:id". The More menu has its own id, "row_more": Block Kit keys each
 * element of an actions block by its action id, so a "row" button beside a
 * "row" menu repeats a React key. Both ids go to the same handler.
 */
const ROW_ACTIONS: readonly string[] = ["row", "row_more"];

const rowButton = (popup: Popup, label: string, verb: string) => ({
	type: "button",
	action_id: "row",
	label,
	value: `${verb}:${popup.id}`,
});

/**
 * A row's own buttons: Edit and Preview, each one tap away. Only two fit next to
 * the name and status on a 390 px phone (a table scrolls sideways and clips
 * whatever is past the edge), so Turn on or off, Duplicate and Delete are on the
 * popup's own page, one tap behind Edit (see pageActions).
 */
function rowActions(popup: Popup): Record<string, unknown> {
	return {
		edit: rowButton(popup, "Edit", "change"),
		preview: rowButton(popup, "Preview", "preview"),
	};
}

/**
 * On a popup's own page: Turn on or off (a finished popup; anyone who can edit
 * it) and, for an Admin, Duplicate and Delete in a menu. Same actions as the
 * list's rows had, so each lands back on the list with its message.
 */
function pageActions(popup: Popup, admin: boolean): Block | null {
	const elements: unknown[] = [];
	if (popup.step >= 4) elements.push(rowButton(popup, popup.on ? "Turn off" : "Turn on", "toggle"));
	if (admin)
		elements.push({
			type: "menu",
			action_id: "row_more",
			label: "More",
			items: [
				{ label: "Duplicate", value: `duplicate:${popup.id}` },
				{ label: "Delete", value: `delete:${popup.id}` },
			],
			style: "secondary",
		});
	return elements.length ? ({ type: "actions", elements } as Block) : null;
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
			// Name and status share one cell: a column of its own costs its padding, and with
			// Linux or Android fonts that pushed Preview off a 390 px phone. Plain text, not a
			// badge: a badge never wraps.
			{ key: "name", label: "Popup" },
			{ key: "edit", label: "", format: "element" },
			{ key: "preview", label: "", format: "element" },
			{ key: "where", label: "Shows on" },
		],
		rows: store.popups.map((popup) => ({
			name: `${popup.name} (${kindLine(popup)}) · ${statusOf(popup, state)}`,
			...rowActions(popup),
			where: showsOnText(popup, state),
		})),
	} as Block);
	blocks.push(
		{
			type: "context",
			text: "Each popup's results are on its own page (Edit); the Results tab compares them. A popup counts as seen when at least half of it was on screen for a second; your own visits while signed in are not counted.",
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
		hideForm(s.hideHelpLine),
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
	// A short label, the file name: alt text is a sentence, and media has no title of its own.
	const options = [{ value: "none", label: "No picture" }];
	for (const item of state.media) options.push({ value: item.id, label: item.filename });
	// A picture since removed from the list still shows as chosen.
	if (popup?.picture && !state.media.some((m) => m.id === popup.picture!.id)) {
		options.push({ value: popup.picture.id, label: "The current picture" });
	}
	return options;
}

/** A dropdown of the site's forms, or a box to type the short name in when Forms cannot list them. */
function formField(state: PageState, popup: Popup): Record<string, unknown> {
	const chosen = typed(state, "form", popup.form);
	const condition = { field: "contains", eq: "form" };
	if (!state.forms?.length) {
		return {
			type: "text_input",
			action_id: "form",
			label: "The form's short name, as shown under Forms (for example: newsletter)",
			placeholder: "newsletter",
			initial_value: chosen,
			condition,
		};
	}
	const options = state.forms.map((form) => ({
		value: form.slug,
		label: form.paused ? `${form.name} (paused under Forms)` : form.name,
	}));
	// A form since deleted under Forms still shows as chosen.
	if (chosen && !state.forms.some((form) => form.slug === chosen)) {
		options.push({ value: chosen, label: `${chosen} (no longer under Forms)` });
	}
	return {
		type: "select",
		action_id: "form",
		label: "Form",
		options,
		...(chosen ? { initial_value: chosen } : {}),
		condition,
	};
}

/** Whether the page drawn after this interaction can show step 2, which lists the site's forms. */
export function mayShowStep2(input: Interaction | undefined): boolean {
	const action = typeof input?.action_id === "string" ? input.action_id : "";
	const value = typeof input?.value === "string" ? input.value : "";
	if (input?.type === "form_submit") return /^save_(s[1-4]|all)(:[a-z0-9-]+)?$/.test(action);
	if (input?.type !== "block_action") return false;
	// A finished popup's page, drawn again for another period.
	if (action === "period") return value.startsWith("p:");
	if (ROW_ACTIONS.includes(action))
		return value.startsWith("change:") || value.startsWith("toggle:");
	return action === "nav" && value.startsWith("back:");
}

type Field = Record<string, unknown>;

function step2Fields(state: PageState, popup: Popup): Field[] {
	const bar = popup.kind === "bar";
	const inline = popup.kind === "inline";
	const fields: Field[] = [
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
		fields.push(formField(state, popup), {
			type: "text_input",
			action_id: "thanks",
			label: "Thank-you heading, shown after the form is sent",
			placeholder: "Thanks, you're on the list",
			initial_value: typed(state, "thanks", popup.thanks),
			condition: { field: "contains", eq: "form" },
		});
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
	return fields;
}

/** One line under what it says: where pictures and forms come from. */
function step2Note(state: PageState, popup: Popup): Block[] {
	if (popup.kind === "bar") return [];
	return [
		{
			type: "context",
			text: state.admin
				? "Pictures come from Media; forms and their thank-you message from Forms."
				: popup.contains === "form"
					? `It contains the form "${popup.form}". Only an administrator can change the form.`
					: "Pictures come from Media; add new ones there.",
		},
	];
}

function step2Blocks(state: PageState, popup: Popup): Block[] {
	return [
		{
			type: "form",
			block_id: formId("s2", popup),
			fields: step2Fields(state, popup) as never,
			submit: {
				label: popup.kind === "inline" ? "Next: turn on" : "Next: when and where",
				action_id: "save_s2",
			},
		},
		...step2Note(state, popup),
	];
}

function step3Form(state: PageState, popup: Popup): Block {
	return {
		type: "form",
		block_id: formId("s3", popup),
		fields: step3Fields(state, popup) as never,
		submit: { label: "Next: dates and turn on", action_id: "save_s3" },
	};
}

function step3Fields(state: PageState, popup: Popup): Field[] {
	const fields: Field[] = [];
	if (popup.kind !== "bar") {
		// Radio, not a dropdown: a dropdown is as wide as its chosen words and these
		// run past a phone's screen; radio labels wrap.
		fields.push({
			type: "radio",
			action_id: "trigger",
			label: "When it opens",
			options: (Object.keys(TRIGGER_CHOICE) as Array<keyof typeof TRIGGER_CHOICE>).map((value) => ({
				value,
				label: TRIGGER_CHOICE[value],
			})),
			initial_value: typed(state, "trigger", popup.trigger === "load" ? "read" : popup.trigger),
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
			initial_value: typed(state, "where", popup.where),
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
			initial_value: typed(state, "devices", popup.devices),
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
			initial_value: typed(state, "again", popup.again),
		},
	);
	return fields;
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

/**
 * The preview shows what is saved. `unsaved` says what to add about changes on
 * screen: in "New popup" the dates sit below it; on a finished popup's page it
 * sits under the one Save.
 */
function previewLinks(popup: Popup, state: PageState, unsaved = ""): Block[] {
	if (!state.origin) return [];
	const inline = popup.kind === "inline";
	const page = !inline && popup.where === "prefix" && popup.prefixes[0] ? popup.prefixes[0] : "/";
	const url = (scheme: string) =>
		`${state.origin}${page}?popups_preview=${popup.id}&scheme=${scheme}`;
	const notes: Block[] = [];
	if (inline)
		notes.push({
			type: "context",
			text: 'On your site it shows where an editor adds the "Popups box" block to a page or post and chooses this box. The preview cannot know that place, so it puts the box at the top of your home page\'s content.',
		});
	else if (popup.where === "collections")
		notes.push({
			type: "context",
			text: `It is set for a collection, so the preview opens your home page, where it may say it does not show. To see it where visitors do, open a page of that collection and add ?popups_preview=${popup.id} to its address.`,
		});
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
			text: `The preview opens a page of your site with it already showing, and says whether a real visitor would see it now and why not. Nothing is counted and the form does not send. Narrow the window to see the phone layout.${unsaved ? ` ${unsaved}` : ""}`,
		},
		...notes,
	];
}

const zoneLine = (state: PageState): Block => ({
	type: "context",
	text: `Times are ${state.zone} time, your site's time zone.`,
});

function step4Blocks(state: PageState, popup: Popup): Block[] {
	return [
		summary(popup, state),
		...clickInstructions(popup),
		...previewLinks(popup, state, "Save your changes first."),
		zoneLine(state),
		{
			type: "form",
			block_id: formId("s4", popup),
			fields: step4Fields(state, popup, true) as never,
			submit: { label: "Save and finish", action_id: "save_s4" },
		},
	];
}

function step4Fields(state: PageState, popup: Popup, wizard: boolean): Field[] {
	const start = popup.start ? fromMoment(popup.start, state.zone) : null;
	const end = popup.end ? fromMoment(popup.end, state.zone) : null;
	const times = HALF_HOURS.map((t) => ({ value: t, label: t }));
	return [
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
	];
}

/** Whether a finished popup's page has "When and where": an Admin's, and not for a box in a page. */
const editsPlaces = (state: PageState, popup: Popup) => state.admin && popup.kind !== "inline";

/**
 * A finished popup's one form: what it says, when and where (Admin), and dates.
 * Its id follows the saved popup only, so a refused save keeps every box as
 * typed and a saved one draws the saved values.
 */
function editForm(state: PageState, popup: Popup): Block {
	return {
		type: "form",
		block_id: formId("edit", popup),
		fields: [
			...step2Fields(state, popup),
			...(editsPlaces(state, popup) ? step3Fields(state, popup) : []),
			...step4Fields(state, popup, false),
		] as never,
		// The period on screen rides along, so the results keep it after the save. Not in the
		// form's id: a new id would draw the form afresh and drop what was typed.
		submit: {
			label: "Save changes",
			action_id:
				state.period && state.period !== POPUP_PERIOD ? `save_all:${state.period}` : "save_all",
		},
	};
}

const backTo = (label: string, value: string): Block => ({
	type: "actions",
	elements: [{ type: "button", action_id: "nav", label, value, style: "secondary" }],
});

/** A finished popup's name and kind, on a screen of their own: the kind decides the other boxes. */
function kindPage(state: PageState, popup: Popup): BlockResponse {
	return {
		blocks: [
			{ type: "header", text: popup.name },
			...errorBlocks(state),
			{
				type: "context",
				text: "The kind decides which boxes the popup has. What it says, where it shows and its dates are kept.",
			},
			step1Form(state, popup, false),
			backTo("Back", `back:${popup.id}:4`),
		],
		...(state.toast ? { toast: state.toast } : {}),
	};
}

function finishedBlocks(state: PageState, popup: Popup): Block[] {
	const blocks: Block[] = [
		{ type: "context", text: `${kindLine(popup)} · ${statusOf(popup, state)}` },
		resultsSlot({ popup: popup.id, period: state.period ?? POPUP_PERIOD, sort: null }),
	];
	const own = pageActions(popup, state.admin);
	if (own) blocks.push(own);
	blocks.push(summary(popup, state));
	if (state.admin)
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "nav",
					label: "Change name or kind",
					value: `kind:${popup.id}`,
					style: "secondary",
				},
			],
		});
	blocks.push(
		{
			type: "header",
			text: editsPlaces(state, popup)
				? "What it says, when and where, and dates"
				: "What it says, and dates",
		},
		{
			type: "context",
			text: `Change anything below, then press Save changes once at the end. Times are ${state.zone} time, your site's time zone.`,
		},
		editForm(state, popup),
		...step2Note(state, popup),
		...clickInstructions(popup),
		...previewLinks(popup, state, "It shows what was last saved."),
		backTo("Back to the list", "list"),
	);
	return blocks;
}

/** "New popup", one step at a time, or a finished popup with one form for everything. */
function popupPage(state: PageState, popup: Popup | undefined, step: number): BlockResponse {
	const blocks: Block[] = [{ type: "header", text: popup ? popup.name : "New popup" }];
	const wizard = !popup || popup.step < 4;
	blocks.push(...errorBlocks(state));
	if (wizard) {
		blocks.push(stepsLine(popup, step));
		if (step === 1) blocks.push(step1Form(state, popup, true));
		if (step === 2 && popup) blocks.push(...step2Blocks(state, popup));
		if (step === 3 && popup) blocks.push(step3Form(state, popup));
		if (step === 4 && popup) blocks.push(...step4Blocks(state, popup));
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
		// A half-made popup can still be duplicated or deleted (Admin).
		const own = popup ? pageActions(popup, state.admin) : null;
		if (own) blocks.push(own);
	} else if (popup) {
		blocks.push(...finishedBlocks(state, popup));
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
		{ label: "Results", blocks: resultsTab(tab === TAB.numbers ? state : clean(state)) },
	];
	if (state.admin)
		panels.push({
			label: "Settings",
			blocks: settingsBlocks(tab === TAB.settings ? state : clean(state)),
		});
	blocks.push({ type: "tab", default_tab: tab, panels });
	return { blocks, ...(state.toast ? { toast: state.toast } : {}) };
}

/** The Results tab: its blocks come in through `fillResults`, for the period picked. */
function resultsTab(state: PageState): Block[] {
	return [
		...errorBlocks(state),
		resultsSlot({ popup: "", period: state.period ?? COMPARE_PERIOD, sort: state.sort ?? null }),
	];
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

/**
 * Cached pages keep a popup's old version for a few minutes at each Cloudflare
 * location. A plugin cannot clear EmDash's page cache (its route handlers get
 * no cache handle), so a save that changes what visitors see says so, and one
 * that does not (a popup nobody sees yet, the alert addresses) does not.
 */
const LATER = "It can take a few minutes to reach visitors.";
const SAVED = `Saved. ${LATER}`;
const savedFor = (visible: boolean) => (visible ? SAVED : "Saved.");
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
	let action = typeof input?.action_id === "string" ? input.action_id : "";
	// Save changes on a popup's page carries the period on screen: "save_all:this-month".
	if (type === "form_submit" && action.startsWith("save_all:")) {
		const picked = action.slice("save_all:".length);
		if (isPeriod(picked)) state = { ...state, period: picked };
		action = "save_all";
	}
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

	// ── Results: another period, or a sort ──
	if (type === "block_action" && action === "period") {
		// "r:<period>" on the Results tab, "p:<popup>:<period>" on a popup's page.
		const [scope, id, picked] = value.split(":");
		if (scope === "r" && isPeriod(id))
			return { response: renderPage({ ...state, period: id }, TAB.numbers) };
		const popup = find(id);
		if (scope === "p" && popup && popup.step >= 4 && isPeriod(picked))
			return { response: popupPage({ ...state, period: picked }, popup, 4) };
		return { response: renderPage(state) };
	}
	if (type === "block_action" && action === "numbers_page") {
		// The table's id holds its period ("results:this-month"); the value holds the sort.
		const period = typeof input?.block_id === "string" ? input.block_id.split(":")[1] : "";
		return {
			response: renderPage(
				{
					...state,
					...(isPeriod(period) ? { period } : {}),
					sort: parseSort(input?.value),
				},
				TAB.numbers,
			),
		};
	}
	// The list never pages or sorts; a table must name an action all the same.
	if (type === "block_action" && action === "list_page") return { response: renderPage(state) };

	// ── Moving around ──
	if (type === "block_action" && action === "nav") {
		if (value.startsWith("back:")) {
			const [, id, step] = value.split(":");
			const popup = find(id);
			if (popup) return { response: popupPage(state, popup, Number(step) || 1) };
		}
		if (value.startsWith("kind:")) {
			if (!state.admin) return only("Only an administrator can change the kind.");
			const popup = find(value.slice(5));
			if (popup) return { response: kindPage(state, popup) };
		}
		if (value === "numbers" || value.startsWith("numbers:")) {
			const picked = value.slice("numbers:".length);
			return {
				response: renderPage(isPeriod(picked) ? { ...state, period: picked } : state, TAB.numbers),
			};
		}
		return { response: renderPage(state) };
	}
	if (type === "block_action" && action === "new") {
		if (!state.admin) return only("Only an administrator can make new popups.");
		if (store.popups.length >= MAX_POPUPS)
			return only(`A site can have ${MAX_POPUPS} popups. Delete one you no longer use first.`);
		return { response: popupPage(state, undefined, 1) };
	}
	if (type === "block_action" && ROW_ACTIONS.includes(action)) {
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
						message: popup.on
							? `"${popup.name}" is off.${isLive(popup, state.now) ? ` ${LATER}` : ""}`
							: `"${popup.name}" is on. ${SAVED}`,
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
					toast: {
						type: "success",
						message: `Deleted "${popup.name}".${isLive(popup, state.now) ? ` ${LATER}` : ""}`,
					},
				}),
			};
		}
		return { response: renderPage(state) };
	}

	if (type !== "form_submit") return { response: renderPage(state) };

	// ── Settings ──
	if (action === HIDE_ACTION) {
		if (!state.admin) return only("Only an administrator can change the settings.");
		const hidden = hiddenFrom(values, store.settings.hideHelpLine);
		const save = next(store.popups, { ...store.settings, hideHelpLine: hidden });
		return {
			save,
			response: renderPage(
				{
					...state,
					store: save,
					toast: {
						type: "success",
						message: hidden
							? "Saved. The help line is hidden."
							: "Saved. The help line shows again.",
					},
				},
				TAB.settings,
			),
		};
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
				{
					...state,
					store: save,
					toast: {
						type: "success",
						// The look shows on every live popup; the alert addresses never reach visitors.
						message: savedFor(
							action === "save_look" && store.popups.some((p) => isLive(p, state.now)),
						),
					},
				},
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
		// Visitors see the change if the popup was live before the save or is live after it.
		const before = find(popup.id);
		const visible = (!!before && isLive(before, state.now)) || isLive(saved, state.now);
		return {
			save,
			problems,
			response: popupPage(
				{ ...view, toast: { type: "success", message: savedFor(visible) } },
				saved,
				4,
			),
		};
	};

	if (action === "save_s1") {
		if (!state.admin) return only("Only an administrator can change the kind.");
		const name = text(values, "name", existing?.name ?? "");
		const kind = (has(values, "kind") ? values.kind : existing?.kind) as Kind | undefined;
		const errors: string[] = [];
		if (!name) errors.push("Give it a name, so you can find it in the list.");
		if (!kind || !(kind in KIND_LABEL)) errors.push("Choose what kind it is.");
		if (errors.length)
			return existing && existing.step >= 4
				? {
						response: kindPage({ ...state, draft: values, errors, toast: REFUSED }, existing),
					}
				: refuse(existing, 1, errors);
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
		const part = await wordsPart(popup, values, state, helpers);
		if (part.errors.length) return refuse(popup, 2, part.errors);
		return finish(part.popup, 2, { notes: part.notes }, part.problems);
	}
	if (action === "save_s3") {
		if (!state.admin) return only("Only an administrator can change when and where it shows.");
		const part = placesPart(popup, values, state);
		if (part.errors.length) return refuse(popup, 3, part.errors);
		return finish(part.popup, 3);
	}
	if (action === "save_s4") {
		const part = datesPart(popup, values, state);
		if (part.errors.length) return refuse(popup, 4, part.errors);
		return finish(part.popup, 4);
	}
	if (action === "save_all") {
		// Only a finished popup's page has the one form; "New popup" goes one step at a time.
		if (popup.step < 4) return { response: popupPage(state, popup, popup.step + 1) };
		const words = await wordsPart(popup, values, state, helpers);
		// An Editor's page has no "When and where", and whatever arrives for it is ignored.
		const places = editsPlaces(state, popup)
			? placesPart(words.popup, values, state)
			: { popup: words.popup, errors: [] };
		const dates = datesPart(places.popup, values, state);
		const errors = [...words.errors, ...places.errors, ...dates.errors];
		if (errors.length) return refuse(popup, 4, errors);
		return finish(dates.popup, 4, { notes: words.notes }, words.problems);
	}

	return { response: renderPage(state) };
}

/** What one part of a popup's form changes, or why it cannot be saved. */
interface Part {
	popup: Popup;
	errors: string[];
	notes?: string[];
	problems?: Problems;
}

/** What it says: words, picture, button or form. */
async function wordsPart(
	popup: Popup,
	values: Record<string, unknown>,
	state: PageState,
	helpers: Helpers,
): Promise<Part> {
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
		errors.push(
			state.forms?.length
				? "Choose the form."
				: "Type the form's short name, as shown under Forms.",
		);
	if (contains === "button") {
		if (popup.kind !== "bar" && (!buttonLabel || !buttonUrl))
			errors.push("Write the button words and where the button goes.");
		if ((buttonLabel && !buttonUrl) || (!buttonLabel && buttonUrl)) {
			if (popup.kind === "bar") errors.push("Write both the link words and the link, or neither.");
		}
		if (buttonUrl && !isSafeLink(buttonUrl))
			errors.push(
				"The link must be a page on this site such as /cakes, a full address starting with https://, or an email (mailto:) or phone (tel:) link.",
			);
	}
	if (errors.length) return { popup, errors };
	let picture = popup.kind === "bar" ? null : pictureFrom(state, values.picture, popup.picture);
	if (picture && picture.id !== popup.picture?.id) {
		// The media library gives plugins a signed-in address; visitors need the public one.
		const url = await helpers.publicUrl(picture.id);
		if (!url)
			return {
				popup,
				errors: [
					"That picture could not be prepared for visitors just now. Please save again in a moment.",
				],
			};
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
		if (said?.refuse) return { popup, errors: [said.text] };
		if (said) notes.push(said.text);
		formNote =
			check.result === "paused" ? "paused" : check.result === "unchecked" ? "unchecked" : "";
		// A form that was fixed takes its warning away.
		problems = { ...state.problems };
		delete problems[popup.id];
	}
	return {
		popup: {
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
			formNote: contains === "form" ? formNote || (form === popup.form ? popup.formNote : "") : "",
		},
		errors: [],
		notes,
		problems,
	};
}

/** When and where: Admins only; the callers check. */
function placesPart(popup: Popup, values: Record<string, unknown>, state: PageState): Part {
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
	if (errors.length) return { popup, errors };
	return {
		popup: {
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
		errors: [],
	};
}

/** Dates and on or off. */
function datesPart(popup: Popup, values: Record<string, unknown>, state: PageState): Part {
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
	if (errors.length) return { popup, errors };
	// A time chosen without a day moves an existing day to that time.
	const startMs =
		!has(values, "start_date") && popup.start && typeof values.start_time === "string"
			? toMoment(fromMoment(popup.start, state.zone).date, values.start_time, state.zone)
			: start.ms;
	const endMs =
		!has(values, "end_date") && popup.end && typeof values.end_time === "string"
			? toMoment(fromMoment(popup.end, state.zone).date, values.end_time, state.zone)
			: end.ms;
	return {
		popup: {
			...popup,
			start: startMs,
			end: endMs,
			on: typeof values.on === "boolean" ? values.on : popup.step < 4 ? true : popup.on,
		},
		errors: [],
	};
}
