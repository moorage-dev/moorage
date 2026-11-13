// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";
import type { SandboxedMcpTool } from "emdash/plugin";

import { ADMIN_ROLE, canRedirect, details, EDITOR_ROLE, rowText, sendVisitors } from "./admin.js";
import { openReason, type Group, type LinkRow } from "./model.js";
import { links } from "./scan.js";
import { load, totalFix, view, type RowView } from "./state.js";

/**
 * Tools an AI assistant can call through EmDash's MCP server, once an Admin switches them on.
 * Each is a private route: EmDash checks the route's permission and the token's scope first.
 * They read what the Site Health page shows the caller, and add a redirect exactly as its Fix
 * button does. Nothing here publishes, unpublishes or deletes anything.
 */

type Caller = { role?: number } | undefined;

const KINDS = ["broken", "worth_a_look", "could_not_check", "wordpress_leftovers"] as const;
type Kind = (typeof KINDS)[number];

const WHERE: Record<Group, string> = { site: "every page", page: "one page", link: "one link" };
const GROUPS: Group[] = ["site", "page", "link"];

/** Statuses of a row the Problems tab lists with a Fix menu. */
const LISTED = new Set<LinkRow["state"]>(["broken", "look", "unknown", "left"]);

/** The input schemas, as plain JSON Schema (EmDash turns them into its own checks). */
const schema = (value: Record<string, unknown>): SandboxedMcpTool["input"] =>
	value as unknown as SandboxedMcpTool["input"];

const PROBLEMS_INPUT: SandboxedMcpTool["input"] = schema({
	type: "object",
	properties: {
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 100,
			description: "How many problems to return, worst first. Default 25.",
		},
		kind: {
			type: "string",
			enum: [...KINDS],
			description:
				"Only one list: broken (to fix), worth_a_look (works but takes a detour), could_not_check, wordpress_leftovers. Default: all of them.",
		},
	},
	additionalProperties: false,
});

const ADD_REDIRECT_INPUT: SandboxedMcpTool["input"] = schema({
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 64,
			description: "The id of a problem from the problems tool.",
		},
		destination: {
			type: "string",
			minLength: 1,
			maxLength: 2000,
			description: "Where to send visitors: a page on this site, starting with /.",
		},
	},
	required: ["id", "destination"],
	additionalProperties: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Problem {
	id: string;
	list: Kind;
	where?: string;
	kind: RowView["kind"];
	address: string;
	problem: string;
	details: string;
	httpStatus?: number;
	lastChecked?: string;
	brokenSince?: string;
	inSiteMenu: boolean;
	timesFound: number;
	foundOn: Array<{ title: string; address: string; collection?: string; id?: string }>;
	canSendVisitorsElsewhere?: boolean;
}

function problemOf(row: RowView, list: Kind, text: string, admin: boolean, group?: Group): Problem {
	return {
		id: row.id,
		list,
		...(group ? { where: WHERE[group] } : {}),
		kind: row.kind,
		address: row.url,
		problem: text,
		details: details(row),
		...(row.code !== undefined ? { httpStatus: row.code } : {}),
		...(row.checkedAt ? { lastChecked: row.checkedAt } : {}),
		...(row.since && list === "broken" ? { brokenSince: row.since } : {}),
		inSiteMenu: row.menu,
		timesFound: row.count,
		foundOn: row.sources.map((s) => ({
			title: s.t,
			address: s.p,
			...(s.c ? { collection: s.c } : {}),
			...(s.id ? { id: s.id } : {}),
		})),
		...(admin ? { canSendVisitorsElsewhere: row.kind !== "leftover" && canRedirect(row) } : {}),
	};
}

/** The `problems` tool: the Problems tab as the caller sees it. One read, plus up to three for Admins. */
export async function handleProblems(
	input: unknown,
	user: Caller,
	ctx: PluginContext,
): Promise<Record<string, unknown>> {
	const role = user?.role ?? 0;
	if (role < EDITOR_ROLE) {
		return { ok: false, error: "Only Editors and Admins can see Site Health's problems." };
	}
	const values = isRecord(input) ? input : {};
	const limit = values.limit ?? 25;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
		return { ok: false, error: "limit must be a whole number from 1 to 100." };
	}
	const kind = values.kind;
	if (kind !== undefined && !KINDS.includes(kind as Kind)) {
		return { ok: false, error: `kind must be one of ${KINDS.join(", ")}.` };
	}
	const wanted = (k: Kind) => kind === undefined || kind === k;
	const admin = role >= ADMIN_ROLE;
	const data = await load(ctx);
	const summary = data.summary;
	const checkingNow = data.scan?.status === "running";
	if (!summary) {
		return {
			ok: true,
			checked: false,
			checkingNow,
			message:
				"The first check of the site has not finished yet. Problems are listed once it has; it moves on every few minutes.",
			problems: [],
		};
	}
	const shown = (row: RowView) => admin || row.editor;
	const look = summary.lookRows.filter(shown);
	const unknown = summary.unknownRows
		.filter(shown)
		.map((row) =>
			row.kind === "internal" ? { ...row, reason: openReason(row.reason, summary.live) } : row,
		);
	const left = (summary.leftRows ?? []).filter(shown);
	const counts = {
		pagesChecked: summary.pages,
		linksChecked: summary.links,
		toFix: admin ? totalFix(summary) : summary.editorFix,
		worthALook: admin ? summary.look : look.length,
		couldNotCheck: admin ? summary.unknown : unknown.length,
		wordpressLeftovers: admin ? (summary.left ?? left.length) : left.length,
	};
	const list: Problem[] = [];
	const room = () => limit - list.length;
	if (wanted("broken")) {
		for (const group of GROUPS) {
			if (room() <= 0) break;
			let rows = summary.rows[group].filter(shown);
			// An Admin's "Show more": the rest of the group comes from storage, as on the page.
			if (admin && summary.fix[group] > rows.length && room() > rows.length) {
				const result = await links(ctx).query({
					where: { state: "broken", group },
					orderBy: { count: "desc" },
					limit: room(),
				});
				rows = result.items.map(({ id, data: row }) => view(id, row));
			}
			for (const row of rows.slice(0, room())) {
				list.push(problemOf(row, "broken", rowText(row, summary), admin, group));
			}
		}
	}
	const rest: Array<[Kind, RowView[]]> = [
		["wordpress_leftovers", left],
		["worth_a_look", look],
		["could_not_check", unknown],
	];
	for (const [k, rows] of rest) {
		if (!wanted(k)) continue;
		for (const row of rows.slice(0, Math.max(0, room()))) {
			list.push(problemOf(row, k, rowText(row, null), admin));
		}
	}
	const total =
		(wanted("broken") ? counts.toFix : 0) +
		(wanted("worth_a_look") ? counts.worthALook : 0) +
		(wanted("could_not_check") ? counts.couldNotCheck : 0) +
		(wanted("wordpress_leftovers") ? counts.wordpressLeftovers : 0);
	return {
		ok: true,
		checked: true,
		lastFullCheck: summary.finishedAt,
		checkingNow,
		counts,
		problems: list,
		moreNotListed: Math.max(0, total - list.length),
	};
}

/**
 * The `add_redirect` tool: the Fix menu's "Send visitors to another page", for one listed problem.
 * Only where the menu offers it, with the form's own checks; an existing redirect is never replaced.
 */
export async function handleAddRedirect(
	input: unknown,
	user: Caller,
	ctx: PluginContext,
	now = Date.now(),
): Promise<Record<string, unknown>> {
	if ((user?.role ?? 0) < ADMIN_ROLE) {
		return { ok: false, refused: "Only Admins can send visitors to another page." };
	}
	const values = isRecord(input) ? input : {};
	const id = typeof values.id === "string" ? values.id.trim() : "";
	const destination = typeof values.destination === "string" ? values.destination.trim() : "";
	if (!id || !destination || id.length > 64 || destination.length > 2000) {
		return {
			ok: false,
			refused:
				"Give the id of a problem from the problems tool, and the address to send visitors to.",
		};
	}
	const row = await links(ctx).get(id);
	if (!row || !LISTED.has(row.state)) {
		return { ok: false, refused: "That problem is no longer listed." };
	}
	if (row.kind === "leftover" || !canRedirect(row)) {
		return {
			ok: false,
			refused:
				"Sending visitors to another page is not offered for this problem. Its Fix menu on the Site Health page says what to do.",
		};
	}
	const data = await load(ctx);
	const result = await sendVisitors(ctx, data, id, row.url, destination, now, row);
	if (!result.ok) return { ok: false, refused: result.problem };
	return {
		ok: true,
		added: { from: result.source, to: result.destination, type: 301 },
		message: `Done. ${result.source} now goes to ${result.destination}.`,
	};
}

/** What the AI assistant reads about each tool, and an Admin approves before switching them on. */
export const MCP_TOOLS: Record<string, SandboxedMcpTool> = {
	problems: {
		description:
			"List what Site Health found on this site, as its Problems tab shows it to you: broken links and pages to fix (worst first: on every page, on one page, one link), links that work but take a detour, links that could not be checked, and things left over from a move from WordPress. Each problem has its address, a plain sentence saying what is wrong, the pages it was found on, and the HTTP status and time of the last check. Read-only.",
		route: "mcp/problems",
		input: PROBLEMS_INPUT,
		destructive: false,
	},
	add_redirect: {
		description:
			'Send visitors from a broken address on this site to another page (a permanent 301 redirect), like the Fix menu\'s "Send visitors to another page". Give the id of a problem from the problems tool where canSendVisitorsElsewhere is true, and the page to send visitors to. It runs the same checks as the button, refuses a live page, and never replaces a redirect that is already there. Admins only.',
		route: "mcp/add-redirect",
		input: ADD_REDIRECT_INPUT,
		destructive: true,
	},
};
