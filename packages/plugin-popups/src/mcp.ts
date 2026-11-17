// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { z } from "astro/zod";
import { PluginRouteError, type PluginDefinition } from "emdash";

import {
	blankPopup,
	datesPart,
	datesText,
	placesPart,
	PROBLEM_TEXT,
	showsOnText,
	statusOf,
	wordsPart,
	type Helpers,
	type MediaOption,
	type PageState,
	type Problems,
} from "./admin.js";
import {
	DECLINE_LABEL,
	isLive,
	KIND_LABEL,
	MAX_POPUPS,
	normalizeStore,
	uniqueHandle,
	type Kind,
	type Popup,
	type Store,
} from "./config.js";
import { responses, startedOn, sum } from "./results.js";
import { rate, type CountRow, type RowQuery } from "./stats.js";
import { fromMoment, shortDay, zoneDay } from "./time.js";

/**
 * Tools for an AI assistant, through EmDash's MCP server. Off until an Admin switches them
 * on. Each is a private route; EmDash checks the route's permission and the key's scope
 * first, then the handlers apply the admin page's own checks (wordsPart, placesPart and
 * datesPart) and its role rules: Editors change words, pictures, dates and on/off; Admins
 * also the kind, the form, where it shows and the design. Nothing deletes a popup.
 */

export const MCP_ROUTES = {
	list: "mcp/list",
	get: "mcp/get",
	create: "mcp/create",
	update: "mcp/update",
	turn_on: "mcp/turn-on",
	turn_off: "mcp/turn-off",
} as const;
export type ToolName = keyof typeof MCP_ROUTES;
type PluginMcpToolDefinition = NonNullable<PluginDefinition["mcp"]>["tools"][string];

/** EmDash permission keys: Editors use the admin page with plugins:read; only Admins make popups. */
export const MCP_PERMISSION: Record<ToolName, "plugins:read" | "plugins:manage"> = {
	list: "plugins:read",
	get: "plugins:read",
	create: "plugins:manage",
	update: "plugins:read",
	turn_on: "plugins:read",
	turn_off: "plugins:read",
};

/** The names an AI tool uses, as the admin page's kinds, in plain words. */
const KIND_NAMES: Record<string, Kind> = {
	popup: "modal",
	"slide-in": "slide",
	"top-bar": "bar",
	box: "inline",
};
const KIND_NAME: Record<Kind, string> = {
	modal: "popup",
	slide: "slide-in",
	bar: "top-bar",
	inline: "box",
};

const ID = z.string().min(1).describe("The popup's id, from list.");
const MOMENT = z
	.string()
	.describe(
		'A date and time in the site\'s time zone, "YYYY-MM-DD HH:MM" (for example 2026-12-24 18:00). An empty string removes it.',
	);

/** What a popup says and how it shows: every field optional, so update changes only what is given. */
const FIELDS = {
	name: z.string().max(80).describe("The name in the list (Admins only)."),
	kind: z
		.enum(["popup", "slide-in", "top-bar", "box"])
		.describe(
			"popup: centred over the page; slide-in: a bottom corner; top-bar: a strip across the top; box: placed in a page by an editor. Admins only.",
		),
	heading: z.string().max(60).describe("The heading (a top bar's message), up to 60 characters."),
	text: z.string().max(240).describe("The text under the heading, up to 240 characters."),
	label: z.string().max(30).describe("A small label above the heading, up to 30 characters."),
	highlight: z
		.string()
		.max(60)
		.describe("Words copied exactly from the heading, shown in the button colour."),
	note: z.string().max(60).describe("A small note under the button, up to 60 characters."),
	picture: z
		.string()
		.describe('A picture\'s media id from the media library, or "none" to remove it.'),
	design: z
		.enum(["plain", "top"])
		.describe(
			"plain: the picture as a strip across the top, words on the left; top: the whole picture on a coloured panel, words centred, a full-width button. Admins only.",
		),
	highlightColour: z
		.string()
		.describe(
			'The highlighted words\' own colour, like #e8457a; "" uses the button colour. Admins only.',
		),
	panelColour: z
		.string()
		.describe(
			'The panel colour behind the picture, like #fde68a; "" uses the button colour. Admins only.',
		),
	contains: z
		.enum(["button", "form"])
		.describe("A button that opens a page, or a form from the Forms plugin. Admins only."),
	buttonLabel: z.string().max(40).describe("The button's words."),
	buttonUrl: z
		.string()
		.describe(
			"Where the button goes: a page such as /cakes, a full https:// address, mailto: or tel:.",
		),
	buttonNewTab: z.boolean().describe("Open the button's link in a new tab."),
	form: z.string().describe("The form's short name under Forms (Admins only)."),
	thanks: z.string().max(60).describe("The heading shown after the form is sent (Admins only)."),
	decline: z
		.enum(["no-thanks", "not-now", "not-interested", "none"])
		.describe(
			'The fixed words to say no: "No thanks", "Not now", "Thanks, I\'m not interested", or none (only the close button).',
		),
	opens: z
		.enum(["read", "click", "exit"])
		.describe(
			"read: after they have read a while; click: when they click a link to #popup-<name>; exit: when they are about to leave (computers only). Admins only.",
		),
	where: z
		.enum(["all", "prefix", "collections"])
		.describe(
			"Every page, the pages under the addresses in pages, or the collections listed. Admins only.",
		),
	pages: z
		.array(z.string())
		.describe("Addresses such as /journal/ (with where: prefix). Admins only."),
	collections: z
		.array(z.string())
		.describe("Collection slugs (with where: collections). Admins only."),
	notOn: z.array(z.string()).describe("Addresses where it never shows. Admins only."),
	devices: z
		.enum(["all", "desktop", "phone"])
		.describe("Phones and computers, computers only, or phones only. Admins only."),
	showAgain: z
		.enum(["week", "month", "never"])
		.describe("Shows again this long after a visitor closes it. Admins only."),
	firstPage: z
		.boolean()
		.describe("A centred popup may open on the first page of a visit, on computers. Admins only."),
	start: MOMENT,
	end: MOMENT,
};
type FieldName = keyof typeof FIELDS;

/** Every field optional: update changes only what is given. */
function optional<T extends Record<string, z.ZodType>>(
	shape: T,
): { [K in keyof T]: z.ZodOptional<T[K]> } {
	return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as {
		[K in keyof T]: z.ZodOptional<T[K]>;
	};
}

/** Fields only an Admin may send, as on the admin page. */
const ADMIN_ONLY: FieldName[] = [
	"name",
	"kind",
	"design",
	"panelColour",
	"highlightColour",
	"contains",
	"form",
	"thanks",
	"opens",
	"where",
	"pages",
	"collections",
	"notOn",
	"devices",
	"showAgain",
	"firstPage",
];

const ON = z.boolean().describe("Turn it on at once. Off unless true: check it with get first.");

/** The tool definitions for `definePlugin({ mcp: { tools } })`. */
export function mcpTools(): Record<ToolName, PluginMcpToolDefinition> {
	return {
		list: {
			description:
				"List every popup on this site (popups, slide-ins, top bars and boxes in a page): id, name, kind, whether it is on, its status, where it shows, and any warning (for example its form is missing). Read-only.",
			route: MCP_ROUTES.list,
			input: z.object({}).strict(),
			destructive: false,
		},
		get: {
			description:
				"Show one popup's full settings (what it says, its picture, button or form, design, when and where it shows, dates in the site's time zone) and a line of its results since it started. Read-only.",
			route: MCP_ROUTES.get,
			input: z.object({ id: ID }).strict(),
			destructive: false,
		},
		create: {
			description:
				"Make a new popup, finished and turned off (pass on: true to turn it on at once; it then shows to visitors within a few minutes). Needs name, kind, heading, and buttonLabel with buttonUrl, or contains: form with form. The same checks as the admin page: safe links, lengths, readable colours, highlighted words that are in the heading. Administrators only.",
			route: MCP_ROUTES.create,
			input: z
				.object({
					...optional(FIELDS),
					name: FIELDS.name.min(1),
					kind: FIELDS.kind,
					heading: FIELDS.heading.min(1),
					on: ON.optional(),
				})
				.strict(),
			destructive: true,
		},
		update: {
			description:
				"Change the given fields of one popup; anything left out stays as it is. Editors may change words, the picture, the button, the closing words and dates; administrators everything. A live popup's change reaches visitors within a few minutes, and new words show it again to visitors who closed it. Use turn_on or turn_off to switch it.",
			route: MCP_ROUTES.update,
			input: z.object({ id: ID, ...optional(FIELDS) }).strict(),
			destructive: true,
		},
		turn_on: {
			description:
				"Turn one popup on. It shows to visitors within a few minutes, inside its dates and where it is set to show.",
			route: MCP_ROUTES.turn_on,
			input: z.object({ id: ID }).strict(),
			destructive: true,
		},
		turn_off: {
			description:
				"Turn one popup off. Visitors stop seeing it within a few minutes. Nothing is deleted.",
			route: MCP_ROUTES.turn_off,
			input: z.object({ id: ID }).strict(),
			destructive: true,
		},
	};
}

// ── Answers ─────────────────────────────────────────────────

const momentText = (ms: number | null, zone: string) => {
	if (ms === null) return null;
	const { date, clock } = fromMoment(ms, zone);
	return `${date} ${clock}`;
};

/** What the list and the admin page's banners warn about, in their words. */
export function warningsOf(popup: Popup, state: PageState): string[] {
	const out: string[] = [];
	if (popup.step < 4)
		out.push(
			"It is not finished (its steps on the Popups page were never completed), so visitors never see it.",
		);
	const problem = state.problems[popup.id];
	if (problem && isLive(popup, state.now) && popup.contains === "form")
		out.push(PROBLEM_TEXT[problem.k](popup).title);
	else if (popup.contains === "form" && popup.formNote === "paused")
		out.push(
			`Its form "${popup.form}" is paused under Forms, so it will not open until the form is turned back on.`,
		);
	return out;
}

function summary(popup: Popup, state: PageState) {
	return {
		id: popup.id,
		name: popup.name,
		kind: KIND_NAME[popup.kind],
		kindName: KIND_LABEL[popup.kind],
		on: popup.on && popup.step >= 4,
		status: statusOf(popup, state),
		showsOn: showsOnText(popup, state),
		warnings: warningsOf(popup, state),
	};
}

/**
 * What update takes, as update takes it: the same names and values, so a get's settings
 * can be sent back unchanged. Only the fields this person may change.
 */
function settingsOf(popup: Popup, state: PageState): Record<string, unknown> {
	const all: Record<FieldName, unknown> = {
		name: popup.name,
		kind: KIND_NAME[popup.kind],
		heading: popup.heading,
		text: popup.text,
		label: popup.label,
		highlight: popup.highlight,
		highlightColour: popup.highlightColor,
		note: popup.note,
		picture: popup.picture ? popup.picture.id : "none",
		design: popup.design,
		panelColour: popup.panel,
		contains: popup.contains,
		buttonLabel: popup.buttonLabel,
		buttonUrl: popup.buttonUrl,
		buttonNewTab: popup.buttonNewTab,
		form: popup.form,
		thanks: popup.thanks,
		decline: popup.decline,
		// A top bar opens as the page opens; it has no choice to give back.
		opens: popup.kind === "bar" ? undefined : popup.trigger,
		where: popup.where,
		pages: popup.prefixes,
		collections: popup.collections,
		notOn: popup.exclude,
		devices: popup.devices,
		showAgain: popup.again,
		firstPage: popup.firstPage,
		start: momentText(popup.start, state.zone) ?? "",
		end: momentText(popup.end, state.zone) ?? "",
	};
	return Object.fromEntries(
		Object.entries(all).filter(
			([key, value]) =>
				value !== undefined && (state.admin || !ADMIN_ONLY.includes(key as FieldName)),
		),
	);
}

function details(popup: Popup, state: PageState) {
	return {
		...summary(popup, state),
		pictureAlt: popup.picture?.alt ?? "",
		closingWordsText: popup.decline === "none" ? "" : DECLINE_LABEL[popup.decline],
		dates: datesText(popup, state),
		timeZone: state.zone,
		settings: settingsOf(popup, state),
	};
}

/** "Since 3 Oct: seen 1,204 times, 41 sign-ups (3%), closed 300 times." */
async function resultsLine(
	popup: Popup,
	state: PageState,
	rows: (query: RowQuery) => Promise<CountRow[]>,
): Promise<string> {
	const today = zoneDay(state.now, state.zone);
	const from = startedOn(popup, state.zone) ?? today;
	const days = { from: from < today ? from : today, to: today };
	const t = sum(await rows({ ...days, popup: popup.id }), days);
	const got = responses(popup, t);
	const share = rate(got, t.seen);
	const what = popup.contains === "form" && popup.kind !== "bar" ? "sign-ups" : "button clicks";
	const closed =
		popup.kind === "bar" || popup.kind === "inline"
			? ""
			: `, closed ${t.closed.toLocaleString("en")} times`;
	return `Since ${shortDay(days.from, today)}: seen ${t.seen.toLocaleString("en")} times, ${got.toLocaleString("en")} ${what}${share === null ? "" : ` (${share}%)`}${closed}. A rate shows from 100 views.`;
}

// ── Doing ───────────────────────────────────────────────────

export interface ToolDeps {
	state: PageState;
	helpers: Helpers;
	/** One picture from the media library by id, or null. */
	picture(id: string): Promise<MediaOption | null>;
	rows(query: RowQuery): Promise<CountRow[]>;
}

export interface ToolOutcome {
	save?: Store;
	/** The one popup a write changed, and whether it is new: the route merges only it. */
	changed?: { id: string; created?: boolean };
	problems?: Problems;
	answer: Record<string, unknown>;
}

const refuse = (message: string): never => {
	throw PluginRouteError.badRequest(message);
};

function moment(value: unknown, which: "start" | "end"): { date: string; time: string } | null {
	if (typeof value !== "string" || value.trim() === "") return { date: "", time: "" };
	const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/.exec(value.trim());
	if (!m) return null;
	void which;
	return { date: m[1]!, time: m[2]! };
}

/** The tool's fields as the admin page's form values, so the same checks run. */
async function toValues(
	input: Record<string, unknown>,
	deps: ToolDeps,
): Promise<{ values: Record<string, unknown>; media: MediaOption[] }> {
	const values: Record<string, unknown> = {};
	const copy: Array<[FieldName, string]> = [
		["heading", "heading"],
		["text", "text"],
		["label", "label"],
		["highlight", "highlight"],
		["note", "note"],
		["design", "design"],
		["panelColour", "panel"],
		["highlightColour", "highlight_colour"],
		["contains", "contains"],
		["form", "form"],
		["thanks", "thanks"],
		["buttonLabel", "button_label"],
		["buttonUrl", "button_url"],
		["buttonNewTab", "button_new_tab"],
		["decline", "decline"],
		["opens", "trigger"],
		["where", "where"],
		["pages", "prefixes"],
		["collections", "collections"],
		["notOn", "exclude"],
		["devices", "devices"],
		["showAgain", "again"],
		["firstPage", "first_page"],
	];
	for (const [from, to] of copy) if (Object.hasOwn(input, from)) values[to] = input[from];
	const choices: Partial<Record<FieldName, readonly unknown[]>> = {
		design: ["plain", "top"],
		contains: ["button", "form"],
		decline: ["no-thanks", "not-now", "not-interested", "none"],
		opens: ["read", "click", "exit"],
		where: ["all", "prefix", "collections"],
		devices: ["all", "desktop", "phone"],
		showAgain: ["week", "month", "never"],
	};
	for (const [field, allowed] of Object.entries(choices))
		if (Object.hasOwn(input, field) && !allowed!.includes(input[field]))
			refuse(`${field} must be one of: ${allowed!.join(", ")}.`);
	for (const field of ["pages", "collections", "notOn"] as const)
		if (Object.hasOwn(input, field) && !Array.isArray(input[field]))
			refuse(`${field} must be a list of addresses.`);
	for (const which of ["start", "end"] as const) {
		if (!Object.hasOwn(input, which)) continue;
		const at = moment(input[which], which);
		if (!at)
			refuse(
				`Write the ${which} like 2026-12-24 18:00 (a date and a time in the site's time zone, ${deps.state.zone}), or "" for none.`,
			);
		values[`${which}_date`] = at!.date;
		values[`${which}_time`] = at!.time;
	}
	const media: MediaOption[] = [];
	if (Object.hasOwn(input, "picture")) {
		const id = typeof input.picture === "string" ? input.picture.trim() : "";
		if (id === "" || id === "none") values.picture = "none";
		else {
			const found = await deps.picture(id);
			if (!found) refuse(`There is no picture with the id "${id}" in the media library.`);
			// Only the in-process read works for a key (there is no cookie to ask the site with),
			// and trying again cannot change that: say where it can be done instead.
			const url = await deps.helpers.publicUrl(id);
			if (!url)
				refuse(
					"This site could not read that picture for an AI tool's key. Set the picture on the popup's page in the admin.",
				);
			media.push(found!);
			values.picture = id;
		}
	}
	return { values, media };
}

/** Words, places and dates, checked as on the admin page, in that order. */
async function apply(
	popup: Popup,
	input: Record<string, unknown>,
	deps: ToolDeps,
	on: boolean,
): Promise<{ popup: Popup; problems?: Problems; notes: string[] }> {
	const { values, media } = await toValues(input, deps);
	const state = { ...deps.state, media: [...media, ...deps.state.media] };
	const words = await wordsPart(popup, values, state, deps.helpers);
	if (words.errors.length) refuse(words.errors.join(" "));
	const places =
		state.admin && popup.kind !== "inline"
			? placesPart(words.popup, values, state)
			: { popup: words.popup, errors: [] };
	if (places.errors.length) refuse(places.errors.join(" "));
	const dates = datesPart(places.popup, { ...values, on }, state);
	if (dates.errors.length) refuse(dates.errors.join(" "));
	return { popup: { ...dates.popup, step: 4 }, problems: words.problems, notes: words.notes ?? [] };
}

function find(store: Store, id: unknown): Popup {
	const popup = store.popups.find((p) => p.id === id);
	if (!popup)
		refuse(
			`There is no popup with the id "${String(id)}". Call list to see the popups and their ids.`,
		);
	return popup!;
}

const LATER = "Changes reach visitors within a few minutes, when cached pages refresh.";

export async function runTool(name: ToolName, raw: unknown, deps: ToolDeps): Promise<ToolOutcome> {
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const { state } = deps;
	const store = state.store;
	const saveWith = (popups: Popup[]) => normalizeStore({ popups, settings: store.settings });

	if (name === "list")
		return { answer: { popups: store.popups.map((p) => summary(p, state)), max: MAX_POPUPS } };
	if (name === "get") {
		const popup = find(store, input.id);
		return {
			answer: { ...details(popup, state), results: await resultsLine(popup, state, deps.rows) },
		};
	}
	if (name === "turn_on" || name === "turn_off") {
		const popup = find(store, input.id);
		const on = name === "turn_on";
		if (on && popup.step < 4)
			refuse(
				`"${popup.name}" is not finished: open it on the Popups page and finish its steps, or set what it says with update first.`,
			);
		const save = saveWith(store.popups.map((p) => (p.id === popup.id ? { ...p, on } : p)));
		const saved = save.popups.find((p) => p.id === popup.id)!;
		const view = { ...state, store: save };
		return {
			save,
			changed: { id: saved.id },
			answer: {
				...summary(saved, view),
				message:
					`"${saved.name}" is ${on ? "on" : "off"}. ${isLive(popup, state.now) || isLive(saved, state.now) ? LATER : ""}`.trim(),
			},
		};
	}

	if (!state.admin) {
		if (name === "create") refuse("Only an administrator can make new popups.");
		const forbidden = ADMIN_ONLY.filter((field) => Object.hasOwn(input, field));
		if (forbidden.length)
			refuse(
				`Only an administrator can change these: ${forbidden.join(", ")}. Leave them out, or ask an administrator.`,
			);
	}

	if (name === "create") {
		if (store.popups.length >= MAX_POPUPS)
			refuse(
				`A site can have ${MAX_POPUPS} popups. Turn off or delete one you no longer use on the Popups page first.`,
			);
		const popupName = typeof input.name === "string" ? input.name.trim() : "";
		const kind = KIND_NAMES[String(input.kind)];
		if (!popupName) refuse("Give it a name, so you can find it in the list.");
		if (!kind) refuse("Choose what kind it is: popup, slide-in, top-bar or box.");
		const blank = blankPopup(popupName, kind!, state.now);
		blank.handle = uniqueHandle(
			popupName,
			store.popups.map((p) => p.handle),
		);
		const made = await apply(blank, input, deps, input.on === true);
		const save = saveWith([...store.popups, made.popup]);
		const saved = save.popups.find((p) => p.id === made.popup.id)!;
		const view = { ...state, store: save };
		return {
			save,
			changed: { id: saved.id, created: true },
			problems: made.problems,
			answer: {
				...details(saved, view),
				message: saved.on
					? `Made "${saved.name}", turned on. ${LATER}`
					: `Made "${saved.name}", turned off.`,
				notes: made.notes,
			},
		};
	}

	// update
	const popup = find(store, input.id);
	let base = popup;
	if (Object.hasOwn(input, "name") || Object.hasOwn(input, "kind")) {
		const popupName = Object.hasOwn(input, "name") ? String(input.name ?? "").trim() : popup.name;
		const kind = Object.hasOwn(input, "kind") ? KIND_NAMES[String(input.kind)] : popup.kind;
		if (!popupName) refuse("Give it a name, so you can find it in the list.");
		if (!kind) refuse("Choose what kind it is: popup, slide-in, top-bar or box.");
		base = {
			...popup,
			name: popupName.slice(0, 80),
			kind: kind!,
			trigger: kind === "bar" ? "load" : popup.trigger === "load" ? "read" : popup.trigger,
		};
	}
	const changed = await apply(base, input, deps, popup.on);
	// Checked in full like a finished popup's Save changes, so it counts as finished (still off).
	// Only an Admin finishes a half-made popup (where it shows is theirs to choose), as on the page.
	const updated = state.admin ? changed.popup : { ...changed.popup, step: popup.step };
	const save = saveWith(store.popups.map((p) => (p.id === popup.id ? updated : p)));
	const saved = save.popups.find((p) => p.id === popup.id)!;
	const view = { ...state, store: save };
	const visible = isLive(popup, state.now) || isLive(saved, state.now);
	return {
		save,
		changed: { id: saved.id },
		problems: changed.problems,
		answer: {
			...details(saved, view),
			message: `Saved.${visible ? ` ${LATER}` : ""}`,
			notes: changed.notes,
		},
	};
}
