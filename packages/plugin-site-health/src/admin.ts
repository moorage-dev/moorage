// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { ActionElement, Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { NO_EMAIL_SERVICE, parseRecipients, problemLine, sendTest } from "./alerts.js";
import { fits, type Counter } from "./budget.js";
import { afterExternal, afterOwnPage, afterOwnPath, request, verdict } from "./check.js";
import { linksInData, scanHtml } from "./extract.js";
import { helpLine, hiddenFrom, HIDE_ACTION, hideForm } from "./help-line.js";
import {
	describe,
	foundOn,
	groupOf,
	NEVER,
	type Group,
	type LinkRow,
	type PageRow,
} from "./model.js";
import { estimate, links, pages, passStep, resolveLocal, startPass, STEP_CALLS } from "./scan.js";
import { writeSettings } from "./settings-store.js";
import {
	applyChange,
	KEY,
	OPTIONS,
	load,
	totalFix,
	view,
	type CheckStatus,
	type Loaded,
	type RowView,
	type Summary,
} from "./state.js";
import { normalizePath, parseUrl, publicOrigin, shorten } from "./url.js";

// EmDash role levels: Editors (40) fix links; Admins (50) also see errors and setup.
const ADMIN_ROLE = 50;
/** A running check that has not moved for this long is moved along by page loads. */
const STALLED_MS = 120_000;
/** The scheduled task counts as not running after this long. */
const CRON_SILENT_MS = 10 * 60_000;

const GROUPS: Array<{ group: Group; title: string; text: string }> = [
	{
		group: "site",
		title: "Every page",
		text: "In the site menu or footer, so every visitor can hit it. Fix these first.",
	},
	{
		group: "page",
		title: "One page",
		text: "Visitors who open these pages see an error or an empty box.",
	},
	{ group: "link", title: "One link", text: "A link inside a page that goes nowhere." },
];

type Panel =
	| { kind: "redirect"; id: string; url: string }
	| { kind: "edit"; url: string; title: string; collection: string; entry: string }
	| { kind: "menus"; url: string };

interface PageState {
	tab: 0 | 1;
	panel?: Panel;
	problem?: string;
	/** Rows of one group read from storage after "Show more". */
	more?: { group: Group; rows: RowView[]; cursor?: string };
	pickable?: Array<{ label: string; value: string }>;
	fine?: Array<{ id: string; row: LinkRow }>;
	toast?: BlockResponse["toast"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How long ago, in words. The plugin cannot read the site's time zone, so it
 * never prints a clock time that would be hours out for the owner.
 */
export function when(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "";
	const minutes = Math.round((now - Date.parse(iso)) / 60_000);
	if (Number.isNaN(minutes)) return "";
	if (minutes < 2) return "just now";
	if (minutes < 60) return `${minutes} minutes ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The text of one row: new marker, address, what is wrong, where it was found. */
export function rowText(row: RowView, summary: Summary | null): string {
	const fresh =
		summary?.prevFinishedAt !== undefined &&
		row.since !== undefined &&
		row.since > summary.prevFinishedAt;
	const twice =
		(row.reason === "gone" || row.reason === "no-site") && row.since
			? ` Checked twice since ${new Date(row.since).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}.`
			: "";
	return `${fresh ? "New since the last check. " : ""}${describe(row, shorten(row.url))}${twice}${foundOn(row)}`;
}

function fixMenu(row: RowView, admin: boolean): ActionElement {
	const items: Array<{ label: string; value: string }> = [];
	const local = row.kind === "internal" || row.kind === "page";
	if (admin && local && row.url !== "/" && row.reason !== "draft" && row.reason !== "page-error") {
		items.push({ label: "Send visitors to another page", value: `redirect|${row.id}` });
	}
	if (row.menu) items.push({ label: "Change the link in Menus", value: `menus|${row.id}` });
	row.sources
		.filter((source) => source.c && source.id)
		.slice(0, 3)
		.forEach((source, index) =>
			items.push({ label: `Edit ${source.t}`, value: `edit${index}|${row.id}` }),
		);
	items.push({ label: "Check it again now", value: `check|${row.id}` });
	items.push({ label: "This is fine, stop checking it", value: `fine|${row.id}` });
	return { type: "menu", action_id: "fix", label: "Fix", items };
}

function openLink(row: RowView, siteUrl: string): ActionElement | undefined {
	const origin = publicOrigin(siteUrl) ?? parseUrl(siteUrl)?.origin;
	const url = row.kind === "internal" ? (origin ? `${origin}${row.url}` : null) : row.url;
	if (!url || !/^https?:\/\//.test(url)) return undefined;
	return { type: "link", label: "Open", target: { kind: "external", url } };
}

function table(
	id: string,
	label: string,
	rows: Array<{ text: string; action?: ActionElement }>,
	next?: string,
): Block {
	return {
		type: "table",
		page_action_id: id,
		columns: [
			{ key: "text", label },
			{ key: "fix", label: "", format: "element" },
		],
		rows: rows.map((row) => ({ text: row.text, ...(row.action ? { fix: row.action } : {}) })),
		...(next ? { next_cursor: next } : {}),
	};
}

function firstCheck(data: Loaded): Block[] {
	const scan = data.scan;
	const reading = !scan || ["redirects", "walk", "resolve"].includes(scan.phase);
	const total = scan?.liveTotal ?? scan?.walked ?? 0;
	const howLong = reading
		? "This usually takes 5 to 30 minutes, and a few hours for a very large site."
		: `This takes ${estimate(total, scan?.live === "ok")} for a site with ${plural(total, "page")}.`;
	const blocks: Block[] = [
		{
			type: "banner",
			title: "Checking your site for the first time",
			description: `${howLong} Links to other sites follow a day later: each one is checked twice, a day apart, before we call it broken. You can leave this page.`,
		},
	];
	if (scan && !reading && scan.live === "ok" && (scan.liveTotal ?? 0) > 0) {
		blocks.push({
			type: "meter",
			label: "Pages checked",
			value: Math.min(scan.liveDone, scan.liveTotal ?? 0),
			max: scan.liveTotal ?? 0,
			custom_value: `${Math.min(scan.liveDone, scan.liveTotal ?? 0)} of ${plural(scan.liveTotal ?? 0, "page")}`,
		});
	} else if (scan && !reading) {
		blocks.push({ type: "context", text: `${plural(scan.walked, "page")} read. Finishing off.` });
	}
	blocks.push(
		{
			type: "context",
			text: `Started ${when(scan?.startedAt) || "just now"}. Each page is also checked again when it is published.`,
		},
		{ type: "actions", elements: [{ type: "button", action_id: "refresh", label: "Refresh" }] },
	);
	return blocks;
}

function liveBanner(summary: Summary, siteUrl: string): Block[] {
	if (summary.live === "not-public") {
		const address = siteUrl
			? `Its address is ${siteUrl}, which only this computer or network can open.`
			: "It has no address set yet.";
		return [
			{
				type: "banner",
				title: "This site is not public yet",
				description: `${address} Links inside your pages are checked now; the rest starts once the site has a public address.`,
			},
		];
	}
	if (summary.live === "updating") {
		return [
			{
				type: "banner",
				variant: "alert",
				title: "Your site is in the middle of an update",
				description: `During the check that finished ${when(summary.finishedAt)}, your site showed visitors an error page instead of your pages: an update to its database had not finished. Whoever looks after your site should finish the update. Links inside your pages are still checked; menus and page errors are checked again once your site is back.`,
			},
		];
	}
	if (summary.live === "blocked" || summary.live === "failed") {
		return [
			{
				type: "banner",
				variant: "alert",
				title: "We cannot open your pages to check them",
				description:
					'Links inside your pages are still checked. Menus, page errors and insecure items are not. If your site has bot protection, ask whoever set it up to let "EmDash Site Health" in.',
			},
		];
	}
	return [];
}

function panelBlocks(state: PageState): Block[] {
	const panel = state.panel;
	if (!panel) return [];
	if (panel.kind === "redirect") {
		const options = state.pickable ?? [];
		return [
			{ type: "header", text: "Send visitors to another page" },
			{
				type: "context",
				text: `Anyone who opens ${panel.url}, from your menu, a bookmark or Google, lands on the page you pick. This fixes it everywhere at once.`,
			},
			...(state.problem
				? [
						{
							type: "banner",
							variant: "alert",
							title: "Not added",
							description: state.problem,
						} as Block,
					]
				: []),
			{
				type: "form",
				block_id: "redirect",
				fields: [
					{
						type: "text_input",
						action_id: "source",
						label: "Old address",
						initial_value: panel.url,
					},
					{
						type: "combobox",
						action_id: "destination",
						label: "Send visitors to",
						placeholder: "Pick a page, or type an address",
						options,
					},
				],
				submit: { label: "Send visitors there", action_id: `add_redirect|${panel.id}` },
			},
			{ type: "actions", elements: [{ type: "button", action_id: "close", label: "Close" }] },
		];
	}
	if (panel.kind === "edit") {
		return [
			{
				type: "banner",
				title: `Change the link to ${shorten(panel.url)} on ${panel.title}`,
				description: `Open the page, find the words that link to ${shorten(panel.url)} and point them at the right page: select the words, then use the link button.`,
			},
			{
				type: "actions",
				elements: [
					{
						type: "link",
						label: `Open ${panel.title}`,
						appearance: "primary",
						target: { kind: "content", collection: panel.collection, id: panel.entry },
					},
					{ type: "button", action_id: "close", label: "Close" },
				],
			},
		];
	}
	return [
		{
			type: "banner",
			title: `Change the link to ${shorten(panel.url)} in your menus`,
			description:
				"Open Menus in the sidebar, under Manage. Find the item that goes to this address and point it at the right page. If the address is on this site, sending visitors to another page also fixes it.",
		},
		{ type: "actions", elements: [{ type: "button", action_id: "close", label: "Close" }] },
	];
}

function problemsTab(ctx: PluginContext, data: Loaded, admin: boolean, state: PageState): Block[] {
	const { summary, scan } = data;
	if (!summary) return firstCheck(data);
	const blocks: Block[] = [
		...(admin ? liveBanner(summary, ctx.site.url) : []),
		...panelBlocks(state),
	];
	const shown = (row: RowView) => admin || row.editor;
	const fixCount = admin ? totalFix(summary) : summary.editorFix;
	blocks.push({
		type: "stats",
		items: [
			{ label: "Pages checked", value: summary.pages },
			{ label: "Links checked", value: summary.links },
			{ label: "To fix", value: fixCount },
		],
	});
	let anyRows = false;
	for (const { group, title, text } of GROUPS) {
		const more = state.more?.group === group ? state.more : undefined;
		const rows = (more ? more.rows : summary.rows[group]).filter(shown);
		if (rows.length === 0) continue;
		anyRows = true;
		const count = admin ? summary.fix[group] : rows.length;
		const next = more ? more.cursor : count > rows.length ? "start" : undefined;
		blocks.push(
			{ type: "header", text: title },
			{ type: "context", text },
			table(
				`more_${group}`,
				"Problem",
				rows.map((row) => ({ text: rowText(row, summary), action: fixMenu(row, admin) })),
				next,
			),
		);
	}
	if (!anyRows) {
		blocks.push({
			type: "empty",
			size: "sm",
			title: "Nothing broken. Nice work.",
			description: `We checked ${plural(summary.pages, "page")} and ${plural(summary.links, "link")} ${when(summary.finishedAt)}. Next check: tomorrow.`,
		});
	}
	const look = summary.lookRows.filter(shown);
	if (look.length > 0) {
		blocks.push({
			type: "accordion",
			label: `Worth a look (${admin ? summary.look : look.length})`,
			blocks: [
				{ type: "context", text: "These work, but take a detour. Tidier to fix, not urgent." },
				table(
					"look_table",
					"What we noticed",
					look.map((row) => ({ text: rowText(row, null), action: fixMenu(row, admin) })),
				),
			],
		});
	}
	const unknown = summary.unknownRows.filter(shown);
	if (unknown.length > 0) {
		blocks.push({
			type: "accordion",
			label: `Links we could not check (${admin ? summary.unknown : unknown.length})`,
			blocks: [
				{
					type: "context",
					text: "Some sites, such as LinkedIn and Instagram, turn away automatic checkers. These links are probably fine. Open one to see for yourself; we try again next week.",
				},
				table(
					"unknown_table",
					"What happened",
					unknown.map((row) => {
						// An address on this site can still be fixed (sent elsewhere); another site's is opened.
						const action =
							row.kind === "internal" ? fixMenu(row, admin) : openLink(row, ctx.site.url);
						return { text: rowText(row, null), ...(action ? { action } : {}) };
					}),
				),
			],
		});
	}
	const running = scan?.status === "running";
	blocks.push({
		type: "context",
		text: running
			? `Checking again now. These are the results of the last full check, ${when(summary.finishedAt)}.`
			: `Last full check: ${when(summary.finishedAt)}. Pages on this site are checked every day, links to other sites every week.`,
	});
	if (!admin) {
		blocks.push({
			type: "context",
			text: "Pages that show errors and the site's setup are looked after by your site admin.",
		});
	}
	blocks.push({
		type: "actions",
		elements: [
			{
				type: "button",
				action_id: running ? "refresh" : "check_all",
				label: running ? "Refresh" : "Check everything again",
			},
		],
	});
	return blocks;
}

const STATUS_WORD: Record<CheckStatus, string> = {
	working: "Working",
	attention: "Needs attention",
	untested: "Not tested yet",
	unknown: "Could not tell",
};

const CRON_STEPS = `This EmDash site's scheduled tasks are not running (the Site Health task has not run for 10 minutes).
On Cloudflare: add a Cron Trigger to the Worker, for example in wrangler.jsonc:
  "triggers": { "crons": ["* * * * *"] }
and make sure the Worker's entry exports EmDash's scheduled() handler.
On Node: EmDash runs scheduled tasks inside the server process; check the server stays running.
Then run: npx emdash doctor
See EmDash's deployment guide, "Scheduled tasks".`;

function cronStatus(data: Loaded, now: number): { status: CheckStatus; text: string } {
	const times = [data.queue.cronAt, data.scan?.cronAt]
		.filter((t): t is string => !!t)
		.map(Date.parse);
	const last = times.length > 0 ? Math.max(...times) : 0;
	const started = data.scan ? Date.parse(data.scan.startedAt) : now;
	if (last > 0 && now - last < CRON_SILENT_MS) {
		const minutes = Math.max(1, Math.round((now - last) / 60_000));
		return {
			status: "working",
			text: `Last ran ${plural(minutes, "minute")} ago. Scheduled posts and these checks depend on it.`,
		};
	}
	if (last === 0 && now - started < CRON_SILENT_MS) {
		return {
			status: "untested",
			text: "Waiting for the first run. Scheduled posts and these checks depend on it.",
		};
	}
	return {
		status: "attention",
		text: "Not running. Scheduled posts will not publish, and these checks only move while this page is open.",
	};
}

/** "Goes to a and b." / "Goes to a, b and 2 more." */
function goesTo(list: string[]): string {
	if (list.length <= 2) return `Goes to ${list.join(" and ")}.`;
	return `Goes to ${list.slice(0, 2).join(", ")} and ${list.length - 2} more.`;
}

/**
 * The Email row, worked out on every load from what is true now: is there an
 * email service (`ready`: EmDash gives a plugin in the site's process `ctx.email`
 * only when one is chosen; a sandboxed plugin always has it, so there the last
 * email sent is all we know), is anyone on the list, and how did the last email go.
 */
export function emailStatus(
	data: Loaded,
	ready: boolean,
	now = Date.now(),
): { status: CheckStatus; text: string } {
	const list = data.options.recipients ?? [];
	const last = data.alerts.email;
	if (!ready) {
		return {
			status: "attention",
			text: "Not set up. Your site has no email service chosen, so alerts, form messages and password resets are not sent. Whoever set up your site can choose one in Settings, Email.",
		};
	}
	if (list.length === 0) {
		return {
			status: "attention",
			text: "Nobody is on the list, so no alerts are sent. Add an address under Options below.",
		};
	}
	const goes = goesTo(list);
	if (!last) {
		return {
			status: "untested",
			text: `Not checked yet. ${goes} To find out whether email works, press Send a test email to check now.`,
		};
	}
	const ago = when(last.at, now);
	const what = last.kind === "alert" ? "an alert" : "a test email";
	if (last.state === "working") {
		const same = last.list
			? last.list.length === list.length && last.list.every((a) => list.includes(a))
			: last.to === list.length;
		if (!same) {
			return {
				status: "untested",
				text: `The list has changed since the last email, ${ago}. ${goes} To find out whether it reaches them, press Send a test email to check now.`,
			};
		}
		return {
			status: "working",
			text: `Last checked ${ago}: ${what} was sent. ${goes} To check again, press Send a test email.`,
		};
	}
	// The error's words, not the stored state: before 0.1.x every failure was stored as "not-set-up".
	if (NO_EMAIL_SERVICE.test(last.error ?? "")) {
		return {
			status: "attention",
			text: `Last checked ${ago}: your site had no email service chosen, so nothing was sent. If one has been chosen in Settings, Email since, press Send a test email to check now.`,
		};
	}
	return {
		status: "attention",
		text: `Last checked ${ago}: ${what} could not be sent; the email service turned it down. ${goes} Press Send a test email to try again; if it fails, whoever set up your site can look at Settings, Email.`,
	};
}

/** Checklist rows needing attention (the widget's "Setup" count). */
export function setupRows(
	data: Loaded,
	siteUrl: string,
	emailReady: boolean,
	now = Date.now(),
): Array<{ name: string; status: CheckStatus; text: string }> {
	const site = siteUrl ? parseUrl(siteUrl) : null;
	const address: { status: CheckStatus; text: string } = !site
		? {
				status: "attention",
				text: "Not set. Set it in Settings so links and emails point to your site.",
			}
		: site.protocol !== "https:"
			? {
					status: publicOrigin(site.href) ? "attention" : "unknown",
					text: publicOrigin(site.href)
						? "Set, but not secure. Ask your web person to switch it to https."
						: "Set to an address only this computer or network can open.",
				}
			: { status: "working", text: "Set, secure, and the address visitors use." };
	const stored = data.checklist.rows;
	const rows = [
		...(data.summary?.live === "updating"
			? [
					{
						name: "Site up",
						status: "attention" as const,
						text: `During the check that finished ${when(data.summary.finishedAt, now)}, your site showed visitors an error page: an update to its database had not finished. Whoever looks after your site should finish the update.`,
					},
				]
			: []),
		{ name: "Site address", ...address },
		{ name: "Scheduled tasks", ...cronStatus(data, now) },
		{ name: "Email", ...emailStatus(data, emailReady, now) },
		{
			name: "Secure connection",
			...(stored.secure ?? {
				status: "untested" as const,
				text: "Checked with the next full check.",
			}),
		},
		{
			name: "With and without www",
			...(stored.www ?? { status: "untested" as const, text: "Checked with the next full check." }),
		},
		{
			name: "Missing pages",
			...(stored.missing ?? {
				status: "untested" as const,
				text: "Checked with the next full check.",
			}),
		},
		{
			name: "Search engines",
			...(stored.search ?? {
				status: "untested" as const,
				text: "Checked with the next full check.",
			}),
		},
		{
			name: "Quick repeat visits",
			...(stored.caching ?? {
				status: "untested" as const,
				text: "Checked with the next full check.",
			}),
		},
	];
	return rows;
}

function checklistTab(
	data: Loaded,
	siteUrl: string,
	emailReady: boolean,
	state: PageState,
	now: number,
): Block[] {
	const rows = setupRows(data, siteUrl, emailReady, now);
	// Quick repeat visits only slows a site down; it is never counted as a problem.
	const attention = rows.filter(
		(row) => row.status === "attention" && row.name !== "Quick repeat visits",
	);
	const sorted = [...rows].sort(
		(a, b) => Number(b.status === "attention") - Number(a.status === "attention"),
	);
	const blocks: Block[] = [];
	const cron = rows.find((row) => row.name === "Scheduled tasks");
	if (cron?.status === "attention") {
		blocks.push(
			{
				type: "banner",
				variant: "alert",
				title: "Scheduled tasks are not running",
				description:
					"Scheduled posts will not publish, and these checks only move while this page is open. Whoever set up your site can switch them on in a few minutes.",
			},
			{
				type: "accordion",
				label: "Copy the instructions for your web person",
				blocks: [
					{
						type: "context",
						text: "Send the steps below to whoever set up your site: they switch on the scheduled tasks your site needs.",
					},
					{ type: "code", code: CRON_STEPS, language: "bash" },
				],
			},
		);
	} else if (attention.length > 0) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: `${plural(attention.length, "thing needs", "things need")} attention`,
			description: attention[0]?.text ?? "",
		});
	}
	// The Email row stands on its own under the table, with its status, who gets
	// the emails and the test button together: a third table column for one button
	// pushes the status badges off a 390 px phone screen.
	const email = rows.find((row) => row.name === "Email");
	blocks.push(
		{
			type: "table",
			page_action_id: "checklist_table",
			columns: [
				{ key: "check", label: "Check" },
				{ key: "status", label: "Status", format: "badge" },
			],
			rows: sorted
				.filter((row) => row !== email)
				.map((row) => ({
					check: `${row.name}. ${row.text}`,
					status: STATUS_WORD[row.status],
				})),
		},
		...(email
			? [
					{
						type: "section",
						text: `Email: ${STATUS_WORD[email.status]}. ${email.text}`,
						accessory: { type: "button", action_id: "send_test", label: "Send a test email" },
					} as Block,
				]
			: []),
		{
			type: "context",
			text: data.checklist.checkedAt
				? `Checked ${when(data.checklist.checkedAt)}. Changes you make elsewhere show here after the next check.`
				: "The rest is checked with the next full check.",
		},
	);
	const recipients = data.options.recipients ?? [];
	const fine = state.fine ?? [];
	blocks.push({
		type: "accordion",
		label: "Options",
		// Open when nobody gets emails, so the list is right there to fill in.
		default_open: recipients.length === 0 || (state.toast?.message?.startsWith("Saved") ?? false),
		blocks: [
			{
				type: "form",
				block_id: "options",
				fields: [
					{
						type: "text_input",
						action_id: "recipients",
						label: "Who gets emails (one address per line)",
						multiline: true,
						initial_value: recipients.join("\n"),
					},
					{
						type: "toggle",
						action_id: "outbound",
						label:
							"Check links to other sites (recommended; a few each minute, never one site more than once a minute)",
						initial_value: data.options.outbound,
					},
				],
				submit: { label: "Save", action_id: "save_options" },
			},
			{
				type: "context",
				text: "Emails go out at once when a page shows an error or a menu link breaks, and once a week with anything new. Never more than one email a day of each kind.",
			},
			{ type: "header", text: `Links you marked as fine (${fine.length})` },
			fine.length === 0
				? {
						type: "context",
						text: 'None yet. Pick "This is fine, stop checking it" in a Fix menu to add one.',
					}
				: {
						type: "table",
						page_action_id: "fine_table",
						columns: [
							{ key: "text", label: "Address" },
							{ key: "again", label: "", format: "element" },
						],
						rows: fine.map(({ id, row }) => ({
							text: `${shorten(row.url, 24)} Marked by ${row.fine?.by ?? "someone"}, ${new Date(row.fine?.at ?? Date.now()).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}.`,
							again: {
								type: "button",
								action_id: "check_fine",
								label: "Check it again",
								value: id,
							},
						})),
					},
			hideForm(data.options.hideHelpLine === true),
		],
	});
	return blocks;
}

function render(ctx: PluginContext, data: Loaded, admin: boolean, state: PageState): BlockResponse {
	const intro: Block = {
		type: "context",
		text: "Finds broken links and setup problems before your visitors do.",
	};
	const problems = problemsTab(ctx, data, admin, state);
	const blocks: Block[] = admin
		? [
				intro,
				{
					type: "tab",
					default_tab: state.tab,
					panels: [
						{ label: "Problems", blocks: problems },
						{
							label: "Checklist",
							blocks: checklistTab(data, ctx.site.url, !!ctx.email, state, Date.now()),
						},
					],
				},
			]
		: [intro, ...problems];
	// Under both tabs, for admins only.
	if (admin) blocks.push(...helpLine(data.options.hideHelpLine !== true));
	return { blocks, ...(state.toast ? { toast: state.toast } : {}) };
}

/** The dashboard widget. */
export function widget(
	data: Loaded,
	admin: boolean,
	siteUrl: string,
	emailReady: boolean,
): BlockResponse {
	const open: Block = {
		type: "actions",
		elements: [
			{ type: "link", label: "Open Site Health", target: { kind: "plugin-page", path: "/health" } },
		],
	};
	const { summary, scan } = data;
	if (!summary) {
		const total = scan?.liveTotal;
		const text =
			scan && total && scan.live === "ok"
				? `First check in progress: ${Math.min(scan.liveDone, total)} of ${plural(total, "page")}. Results in ${estimate(Math.max(0, total - scan.liveDone), true)}.`
				: "First check in progress. Results soon.";
		return { blocks: [{ type: "section", text }, open] };
	}
	const fix = admin ? totalFix(summary) : summary.editorFix;
	if (!admin) {
		return {
			blocks: [
				{
					type: "section",
					text:
						fix === 0
							? `Nothing broken. Checked ${when(summary.finishedAt)}.`
							: `${plural(fix, "broken link")} on your pages.`,
				},
				open,
			],
		};
	}
	const setup = setupRows(data, siteUrl, emailReady).filter(
		(row) => row.status === "attention" && row.name !== "Quick repeat visits",
	).length;
	if (fix === 0 && setup === 0) {
		return {
			blocks: [
				{ type: "section", text: `Nothing broken. Checked ${when(summary.finishedAt)}.` },
				open,
			],
		};
	}
	const worst = summary.rows.site[0] ?? summary.rows.page[0] ?? summary.rows.link[0];
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "To fix", value: fix },
					{ label: "Setup", value: setup },
				],
			},
			...(worst
				? [
						{
							type: "context",
							text: `Worst: ${shorten(worst.url)}${worst.menu || worst.url === "/" ? " is broken on every page." : ` ${describe(worst, "").replace(/^[: ]+/, "")}`}`,
						} as Block,
					]
				: []),
			open,
		],
	};
}

/** Pages to pick from when sending visitors somewhere else. */
async function pickable(ctx: PluginContext): Promise<Array<{ label: string; value: string }>> {
	const first = await pages(ctx).query({ where: { status: "published" }, limit: 100 });
	const second =
		first.hasMore && first.cursor
			? await pages(ctx).query({ where: { status: "published" }, limit: 100, cursor: first.cursor })
			: { items: [] };
	return [...first.items, ...second.items]
		.map(({ data }) => ({ label: `${data.title} (${data.path})`, value: data.path }))
		.sort((a, b) => (a.value === "/" ? -1 : b.value === "/" ? 1 : a.label.localeCompare(b.label)));
}

async function finePage(ctx: PluginContext): Promise<Array<{ id: string; row: LinkRow }>> {
	const result = await links(ctx).query({ where: { state: "fine" }, limit: 20 });
	return result.items.map(({ id, data }) => ({ id, row: data }));
}

function rowById(summary: Summary | null, id: string): RowView | undefined {
	if (!summary) return undefined;
	return [
		...summary.rows.site,
		...summary.rows.page,
		...summary.rows.link,
		...summary.lookRows,
		...summary.unknownRows,
	].find((row) => row.id === id);
}

async function saveRow(
	ctx: PluginContext,
	data: Loaded,
	id: string,
	before: LinkRow,
	after: LinkRow,
): Promise<void> {
	await links(ctx).put(id, after);
	if (data.summary) {
		const changed = applyChange(data.summary, id, before, after);
		if (changed) {
			data.summary = changed;
			await ctx.kv.set(KEY.summary, changed);
		}
	}
}

/** "Check it again now": one check, at once. */
async function checkAgain(
	ctx: PluginContext,
	data: Loaded,
	id: string,
	now: number,
): Promise<BlockResponse["toast"]> {
	const row = await links(ctx).get(id);
	if (!row) return { type: "info", message: "That address is no longer on your pages." };
	// Own pages are opened only when the last full check could open the site;
	// otherwise an error page from the host would be taken for the site's answer.
	const origin = data.summary?.live === "ok" ? publicOrigin(ctx.site.url) : null;
	let after: LinkRow = row;
	const base = row.state === "fine" ? { ...row, state: "pending" as const, fine: undefined } : row;
	if (row.kind === "external") {
		let result = verdict(row.url, await request(ctx, row.url, { method: "HEAD" }), "HEAD");
		if (result.kind === "retry") result = verdict(row.url, await request(ctx, row.url), "GET");
		after = afterExternal(base, result, now);
	} else if (row.kind === "internal") {
		const page = await pages(ctx).get(row.url);
		after = resolveLocal(base, page ?? undefined, now);
		if (after.state === "pending") {
			after = origin
				? afterOwnPath(
						after,
						verdict(row.url, await request(ctx, `${origin}${row.url}`), "GET"),
						now,
					)
				: { ...after, state: "unknown", reason: "no-live", due: NEVER };
		}
	} else if (row.kind === "page") {
		after = origin
			? afterOwnPage(
					{
						...base,
						fails: row.state === "broken" ? 1 : 0,
						firstFailAt: new Date(now - 60_000).toISOString(),
					},
					await request(ctx, `${origin}${row.url}`),
					now,
				)
			: row;
	} else {
		// An insecure item: is it still on its page?
		const source = row.sources[0];
		let still = true;
		if (source?.c && source.id) {
			const entry = await ctx.content?.get(source.c, source.id);
			still =
				!!entry && linksInData(entry.data, ctx.site.url).some((found) => found.url === row.url);
		} else if (origin && source) {
			const outcome = await request(ctx, `${origin}${source.p || "/"}`, { body: true });
			const html = outcome.body ? scanHtml(outcome.body, ctx.site.url) : null;
			still = !html || [...html.active, ...html.passive].includes(row.url);
		}
		after = still
			? base
			: { ...base, state: "ok", reason: undefined, group: undefined, since: undefined };
	}
	if (after.state === "broken") after.group = groupOf(after);
	await saveRow(ctx, data, id, row, after);
	const name = shorten(row.url);
	if (after.state === "ok" || after.state === "look")
		return { type: "success", message: `Works now. ${name} is off the list.` };
	if (after.state === "broken")
		return { type: "info", message: `Still broken. ${name} was checked just now.` };
	return {
		type: "info",
		message: `We could not check ${name} just now. It is not counted as broken.`,
	};
}

/**
 * Move a stalled check along: the scheduler may not be running. Only when one
 * step and the page's own read still fit in this run (not after the settings
 * were copied, for one); otherwise the next load or the scheduled task does it.
 */
async function nudge(
	ctx: PluginContext,
	data: Loaded,
	counter: Counter,
	now: number,
	force = false,
): Promise<void> {
	if (!fits(counter, STEP_CALLS + 1)) return;
	try {
		// No check yet, or only one that found no pages (switched on before setup added them).
		if (!data.scan || (!data.summary && data.scan.status === "done")) {
			data.scan = await startPass(ctx, data, now);
			await passStep(ctx, data, counter, now);
			return;
		}
		const last = Date.parse(data.scan.lastStepAt ?? data.scan.startedAt);
		// "Refresh" always moves a running check; a plain visit only when it has stalled.
		if (data.scan.status === "running" && (force || now - last > STALLED_MS))
			await passStep(ctx, data, counter, now);
	} catch (error) {
		ctx.log.warn("could not move the check along", { error: String(error) });
	}
}

/** Handle one interaction from the Site Health page or widget. */
export async function handleAdmin(
	input: unknown,
	user: { role?: number; email?: string; name?: string | null } | undefined,
	ctx: PluginContext,
	counter: Counter,
): Promise<BlockResponse> {
	const now = Date.now();
	const admin = (user?.role ?? 0) >= ADMIN_ROLE;
	const interaction = isRecord(input) ? input : {};
	const action = typeof interaction.action_id === "string" ? interaction.action_id : "";
	const state: PageState = { tab: 0 };
	const isWidget =
		interaction.type === "page_load" &&
		typeof interaction.page === "string" &&
		interaction.page.startsWith("widget:");
	// Settings an earlier release saved are copied forward by the Admin's page only.
	const data = await load(ctx, { copy: admin && !isWidget });

	if (isWidget) {
		await nudge(ctx, data, counter, now);
		return widget(data, admin, ctx.site.url, !!ctx.email);
	}

	// The alert list starts with the first Admin who opens the page.
	if (admin && data.options.recipients === undefined && user?.email) {
		data.options = { ...data.options, recipients: [user.email.toLowerCase()] };
		await writeSettings(ctx, OPTIONS, data.options);
	} else if (interaction.type === "page_load" || action === "refresh") {
		await nudge(ctx, data, counter, now, action === "refresh");
	}

	const withFine = async (s: PageState): Promise<PageState> =>
		admin ? { ...s, fine: await finePage(ctx) } : s;

	if (interaction.type === "block_action") {
		if (action === "fix" && typeof interaction.value === "string") {
			const [op = "", id = ""] = interaction.value.split("|");
			const row = rowById(data.summary, id);
			if (!row)
				return render(ctx, data, admin, {
					tab: 0,
					toast: { type: "info", message: "That problem is no longer listed." },
				});
			if (op === "redirect" && admin) {
				return render(ctx, data, admin, {
					tab: 0,
					panel: { kind: "redirect", id, url: row.url },
					pickable: await pickable(ctx),
				});
			}
			if (op === "menus")
				return render(
					ctx,
					data,
					admin,
					await withFine({ tab: 0, panel: { kind: "menus", url: row.url } }),
				);
			if (op.startsWith("edit")) {
				const source = row.sources.filter((s) => s.c && s.id)[Number(op.slice(4))];
				if (source?.c && source.id) {
					return render(
						ctx,
						data,
						admin,
						await withFine({
							tab: 0,
							panel: {
								kind: "edit",
								url: row.url,
								title: source.t,
								collection: source.c,
								entry: source.id,
							},
						}),
					);
				}
			}
			if (op === "check") {
				const toast = await checkAgain(ctx, data, id, now);
				return render(ctx, data, admin, await withFine({ tab: 0, toast }));
			}
			if (op === "fine") {
				const stored = await links(ctx).get(id);
				if (stored) {
					const by = user?.name || user?.email || "someone";
					await saveRow(ctx, data, id, stored, {
						...stored,
						state: "fine",
						due: NEVER,
						fine: { by, at: new Date(now).toISOString() },
					});
				}
				return render(
					ctx,
					data,
					admin,
					await withFine({
						tab: 0,
						toast: {
							type: "success",
							message: `Marked as fine. ${shorten(row.url)} is not checked any more.`,
						},
					}),
				);
			}
		}
		if (action === "check_fine" && typeof interaction.value === "string" && admin) {
			const toast = await checkAgain(ctx, data, interaction.value, now);
			return render(ctx, data, admin, await withFine({ tab: 1, toast }));
		}
		if (action === "check_all") {
			if (data.scan?.status !== "running") {
				data.scan = await startPass(ctx, data, now);
				await passStep(ctx, data, counter, now);
			}
			return render(
				ctx,
				data,
				admin,
				await withFine({
					tab: 0,
					toast: {
						type: "info",
						message: "Checking everything again. The last results stay here until it is done.",
					},
				}),
			);
		}
		if (action === "send_test" && admin) {
			if ((data.options.recipients ?? []).length === 0) {
				return render(
					ctx,
					data,
					admin,
					await withFine({
						tab: 1,
						toast: { type: "error", message: "Add an address under Options first." },
					}),
				);
			}
			const result = await sendTest(ctx, data, now);
			return render(
				ctx,
				data,
				admin,
				await withFine({
					tab: 1,
					toast: result.ok
						? {
								type: "success",
								message: `Test sent to ${plural(data.options.recipients?.length ?? 0, "address", "addresses")}.`,
							}
						: {
								type: "info",
								message: NO_EMAIL_SERVICE.test(result.error)
									? "Your site has no email service chosen. Whoever set it up can choose one in Settings, Email."
									: "The test email could not be sent. The Email row says what to do.",
							},
				}),
			);
		}
		const group = GROUPS.find((g) => action === `more_${g.group}`)?.group;
		if (group && data.summary) {
			const value = isRecord(interaction.value) ? interaction.value : {};
			const cursor =
				typeof value.cursor === "string" && value.cursor !== "start" ? value.cursor : undefined;
			const result = await links(ctx).query({
				where: { state: "broken", group },
				orderBy: { count: "desc" },
				limit: 50,
				...(cursor ? { cursor } : {}),
			});
			return render(
				ctx,
				data,
				admin,
				await withFine({
					tab: 0,
					more: {
						group,
						rows: result.items.map(({ id, data: row }) => view(id, row)),
						...(result.hasMore && result.cursor ? { cursor: result.cursor } : {}),
					},
				}),
			);
		}
		return render(ctx, data, admin, await withFine({ tab: action === "close" ? 0 : state.tab }));
	}

	if (interaction.type === "form_submit" && admin) {
		const values = isRecord(interaction.values) ? interaction.values : {};
		if (action === HIDE_ACTION) {
			const hidden = hiddenFrom(values, data.options.hideHelpLine === true);
			data.options = { ...data.options, hideHelpLine: hidden };
			await writeSettings(ctx, OPTIONS, data.options);
			return render(
				ctx,
				data,
				admin,
				await withFine({
					tab: 1,
					toast: {
						type: "success",
						message: hidden
							? "Saved. The help line is hidden."
							: "Saved. The help line shows again.",
					},
				}),
			);
		}
		if (action === "save_options") {
			const parsed = parseRecipients(
				typeof values.recipients === "string"
					? values.recipients
					: (data.options.recipients ?? []).join("\n"),
			);
			if ("wrong" in parsed) {
				return render(
					ctx,
					data,
					admin,
					await withFine({
						tab: 1,
						toast: {
							type: "error",
							message: `"${parsed.wrong}" is not an email address. Nothing was saved.`,
						},
					}),
				);
			}
			data.options = {
				...data.options,
				recipients: parsed.list,
				outbound: typeof values.outbound === "boolean" ? values.outbound : data.options.outbound,
			};
			await writeSettings(ctx, OPTIONS, data.options);
			return render(
				ctx,
				data,
				admin,
				await withFine({
					tab: 1,
					toast: {
						type: "success",
						message:
							parsed.list.length === 0
								? "Saved. Nobody gets emails now."
								: `Saved. Emails go to ${plural(parsed.list.length, "address", "addresses")}.`,
					},
				}),
			);
		}
		if (action.startsWith("add_redirect|")) {
			const id = action.slice("add_redirect|".length);
			const row = rowById(data.summary, id);
			const source = normalizePath(
				typeof values.source === "string" ? values.source.trim() : (row?.url ?? ""),
			);
			const raw = typeof values.destination === "string" ? values.destination.trim() : "";
			const destination = raw.startsWith("/") ? normalizePath(raw) : raw;
			const again = async (problem: string) =>
				render(ctx, data, admin, {
					tab: 0,
					panel: { kind: "redirect", id, url: source || row?.url || "" },
					pickable: await pickable(ctx),
					problem,
				});
			if (!source.startsWith("/"))
				return again("The old address must be a page on this site, starting with /.");
			if (!destination.startsWith("/") && !/^https?:\/\//.test(destination))
				return again("Pick a page to send visitors to.");
			if (destination === source) return again("The old address and the new one are the same.");
			const live = await pages(ctx).get(source);
			if (live?.status === "published")
				return again(`${source} is a live page. Change its address in the page editor instead.`);
			try {
				await ctx.redirects?.create?.({ source, destination, type: 301 });
			} catch (error) {
				return again(
					`EmDash did not add it: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const redirectRow: PageRow = {
				status: "redirect",
				path: source,
				title: source,
				dest: destination,
				pass: data.scan?.pass ?? 0,
			};
			await pages(ctx).put(source, redirectRow);
			const stored = await links(ctx).get(id);
			if (stored) await saveRow(ctx, data, id, stored, resolveLocal(stored, redirectRow, now));
			return render(
				ctx,
				data,
				admin,
				await withFine({
					tab: 0,
					toast: { type: "success", message: `Done. ${source} now goes to ${destination}.` },
				}),
			);
		}
	}
	return render(ctx, data, admin, await withFine(state));
}

export { problemLine };
