// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The one admin page. Every screen is drawn from Block Kit blocks the host renders itself.

import type { ActionElement, Block, BlockResponse, ButtonElement } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import {
	buildReview,
	check,
	confirmRestore,
	connect,
	explain,
	justBefore,
	putBack,
	putBackLeadRecords,
	recentChanges,
	refusal,
	refusalText,
	type ConnectProblem,
	type Me,
	type RestoreOutcome,
	type Review,
	type ReviewGroup,
	type ReviewState,
	refreshZone,
} from "./operations.js";
import { people, personName } from "./site-data.js";
import {
	allMoments,
	allRestores,
	client,
	emails,
	KEY_SETTING,
	loadConnection,
	loadKey,
	parseEmails,
	siteQuery,
	type Connection,
	type RestoreRecord,
} from "./state.js";
import { clock, DAY, fromLocal, localDay, moment, relative, since, zoneSentence } from "./time.js";

const ADMIN_ROLE = 50;
const LOST_TEXT_LIMIT = 20_000;

/** Cloudflare's key page, opened with the one permission this needs filled in. */
export const KEY_PAGE =
	"https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=" +
	encodeURIComponent('[{"key":"d1","type":"edit"}]') +
	"&name=" +
	encodeURIComponent("Site restore");

type Interaction = {
	type?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
};

interface UserLike {
	id: string;
	name?: string | null;
	email?: string;
	role: number;
	createdAt?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");

// ------------------------------------------------------------------ small block helpers

const header = (text: string): Block => ({ type: "header", text });
const section = (text: string, accessory?: ActionElement): Block => ({
	type: "section",
	text,
	...(accessory ? { accessory } : {}),
});
const context = (text: string): Block => ({ type: "context", text });
const banner = (
	variant: "default" | "alert" | "error",
	title: string,
	description?: string,
): Block => ({
	type: "banner",
	variant,
	title,
	...(description ? { description } : {}),
});
const actions = (...elements: ActionElement[]): Block => ({ type: "actions", elements });
const button = (
	action_id: string,
	label: string,
	extra: Partial<Omit<ButtonElement, "type" | "action_id" | "label">> = {},
): ButtonElement => ({ type: "button", action_id, label, ...extra });
const external = (
	label: string,
	url: string,
	appearance: "primary" | "secondary" = "secondary",
): ActionElement => ({
	type: "link",
	label,
	target: { kind: "external", url },
	appearance,
});

const PAGE_TITLE: Block = header("Restore");
const ONE_PAGE: Block = banner(
	"default",
	"Only one page or post is wrong?",
	"Open it and use its Revisions, or look in the Trash. This page puts the whole site back to an earlier moment.",
);

function siteUrl(ctx: PluginContext): string | null {
	const url = ctx.site.url;
	return /^https?:\/\//.test(url) ? url.replace(/\/$/, "") : null;
}

// ------------------------------------------------------------------ screens

function setupScreen(
	problem?: ConnectProblem,
	reachable?: number,
	replacing = false,
): BlockResponse {
	const blocks: Block[] = [PAGE_TITLE];
	if (problem) blocks.push(problemBanner(problem, reachable));
	if (!replacing) {
		blocks.push(
			ONE_PAGE,
			header("What this does, and what it is not"),
			section(
				"It puts your whole site (pages, settings, people, form enquiries) back to any moment in the last 30 days, and you can undo it.",
			),
			{
				type: "fields",
				fields: [
					{
						label: "Not an off-site backup",
						value:
							"Cloudflare keeps the history in the same account as your site. For a copy to keep elsewhere, use Settings > Backups.",
					},
					{
						label: "Nothing before setup",
						value:
							"It can only go back to moments after today. Set it up on the day a site launches.",
					},
					{
						label: "No pictures",
						value: "Picture files are never deleted, and deleted ones don't come back.",
					},
					{ label: "Up to 30 days", value: "7 days on Cloudflare's free plan." },
				],
			},
		);
	}
	blocks.push(
		header(replacing ? "Replace the key" : "Connect (once)"),
		section("This page needs a key from Cloudflare, the company your site runs on."),
		actions(external("Open Cloudflare to make the key", KEY_PAGE)),
		context(
			"The page opens with everything filled in. Press Continue, then Create, then Copy, and paste the key below.",
		),
		{
			type: "form",
			block_id: "connect",
			fields: [
				{
					type: "secret_input",
					action_id: "key",
					label: "Key from Cloudflare",
					placeholder: "Paste the key here",
				},
			],
			submit: { label: "Check and save", action_id: "connect" },
		},
		section(
			"Someone else looks after your Cloudflare account?",
			button("web_person", "Copy the instructions for your web person"),
		),
	);
	if (replacing) blocks.push(actions(button("back", "Cancel")));
	else {
		blocks.push(
			{ type: "divider" },
			section(
				"Your site doesn't run on Cloudflare, or you're not sure?",
				button("not_cloudflare", "My site isn't on Cloudflare"),
			),
		);
	}
	return { blocks };
}

function problemBanner(problem: ConnectProblem, reachable?: number): Block {
	switch (problem) {
		case "refused":
			return banner(
				"error",
				"Cloudflare did not accept that key",
				"Copy it again from Cloudflare and paste it. Nothing was saved.",
			);
		case "no-access":
			return banner(
				"error",
				"That key can't put sites back",
				'Make a new one with the "Open Cloudflare" button; it fills in the right permission. Nothing was saved.',
			);
		case "not-found":
			return banner(
				"alert",
				"We couldn't find this site's data in that Cloudflare account",
				`The key works, but none of the ${reachable ?? 0} sites it reaches is this one. Make the key in the account your site runs in. If your site doesn't run on Cloudflare, see "My site isn't on Cloudflare" below.`,
			);
		case "network":
			return banner(
				"error",
				"Cloudflare did not answer",
				"Wait a moment and press Check and save again. Nothing was saved.",
			);
	}
}

function webPersonScreen(ctx: PluginContext): BlockResponse {
	const site = ctx.site.name || "this site";
	return {
		blocks: [
			PAGE_TITLE,
			header("Instructions for your web person"),
			section(
				"Select the text in the box, copy it and send it to whoever looks after your Cloudflare account.",
			),
			{
				type: "code",
				code: [
					`${site} uses the Restore plugin to put the site back to an earlier moment (D1 Time Travel).`,
					"It needs an account API token for the Cloudflare account the site's D1 database is in:",
					`1. Open ${KEY_PAGE}`,
					'   (this pre-fills an account token named "Site restore" with one permission: Account > D1 > Edit).',
					"2. Pick the account the site runs in, Continue to summary, Create Token, copy it.",
					"3. Paste it on the site's Restore page (admin > Tools > Restore) and press Check and save.",
					"Cloudflare can't limit D1 permissions to one database, so the token can change every D1",
					"database in that account. Where you can, keep each client in a separate Cloudflare account.",
				].join("\n"),
			},
			actions(button("back", "Back")),
		],
	};
}

function notAvailableScreen(): BlockResponse {
	return {
		blocks: [
			PAGE_TITLE,
			banner(
				"default",
				"Going back in time isn't available on this site",
				"It works when a site runs on Cloudflare. This site keeps its data somewhere else (for example on its own server).",
			),
			header("What you can do instead"),
			{
				type: "fields",
				fields: [
					{
						label: "One page or post is wrong",
						value: "Open it and restore an earlier version from Revisions.",
					},
					{ label: "Something was deleted", value: "Restore it from the Trash." },
					{
						label: "Keep a copy of everything",
						value:
							"Download a backup in Settings > Backups. It is a copy to keep; it can't be loaded back from the admin.",
					},
					{
						label: "Put the whole site back",
						value:
							"Ask whoever runs your server. Most hosts offer their own restore to a point in time.",
					},
				],
			},
			actions(button("back", "My site is on Cloudflare after all")),
		],
	};
}

function reachBlock(connection: Connection): Block {
	const others = connection.reach.filter((r) => !r.isSite);
	if (others.length === 0) return context("This key can change only this site's data.");
	const names = connection.reach
		.map((r) => (r.isSite ? `${r.name} (this site)` : r.name))
		.join(", ");
	return banner(
		"error",
		`This key can change ${connection.reach.length} sites, not only this one`,
		`${names}. Anyone with this key can put any of them back. Keep each client in a separate Cloudflare account where you can.`,
	);
}

function connectedScreen(connection: Connection): BlockResponse {
	return {
		blocks: [
			PAGE_TITLE,
			banner(
				"default",
				"Connected",
				`You can now put the site back to any moment since ${moment(connection.setupAt, connection.zone)}. Each day this reaches further back, up to ${connection.windowDays} days.`,
			),
			reachBlock(connection),
			{
				type: "fields",
				fields: [
					{ label: "Cloudflare account", value: connection.accountName },
					{ label: "This site's data", value: `${connection.databaseName} (found just now)` },
					{ label: "Furthest back", value: moment(connection.setupAt, connection.zone) },
					{
						label: "Key",
						value: `Saved and encrypted. Expires: ${connection.expiresOn ? moment(connection.expiresOn, connection.zone) : "never"}`,
					},
				],
			},
			context(zoneSentence(connection.zone, connection.zoneSet !== false)),
			actions(button("back", "Go to Restore", { style: "primary" })),
		],
		toast: { type: "success", message: "Key checked and saved" },
	};
}

function editorScreen(admins: string[]): BlockResponse {
	const ask = admins.length > 0 ? `Ask ${admins.join(" or ")}.` : "Ask an administrator.";
	return {
		blocks: [
			PAGE_TITLE,
			banner(
				"default",
				"Only an administrator can put the site back",
				`${ask} To undo your own change to one page, open it and use Revisions; deleted items are in the Trash.`,
			),
		],
	};
}

function furthestBack(connection: Connection, now: number): string {
	return new Date(
		Math.max(Date.parse(connection.setupAt), now - connection.windowDays * DAY),
	).toISOString();
}

function hourOptions() {
	return Array.from({ length: 24 }, (_, h) => ({
		label: String(h).padStart(2, "0"),
		value: String(h),
	}));
}
function minuteOptions() {
	return Array.from({ length: 12 }, (_, i) => ({
		label: String(i * 5).padStart(2, "0"),
		value: String(i * 5),
	}));
}

function pastRestoresBlocks(restores: RestoreRecord[], zone: string, now: number): Block[] {
	const blocks: Block[] = [header("Past restores")];
	if (restores.length === 0) {
		blocks.push({
			type: "empty",
			title: "No restores yet",
			description: "Each restore can be undone; it will be listed here.",
			size: "sm",
		});
		return blocks;
	}
	blocks.push({
		type: "table",
		block_id: "restores",
		page_action_id: "restores_page",
		columns: [
			{ key: "restore", label: "Restore" },
			{ key: "result", label: "Result", format: "badge" },
			{ key: "undo", label: "", format: "element" },
		],
		rows: restores.slice(0, 20).map((r) => ({
			restore: `${capital(relative(r.at, zone, now))}, back to ${moment(r.to, zone)}, by ${r.byName}`,
			result: r.result === "done" ? (r.undid ? "Undo done" : "Done") : "Not confirmed",
			undo: undoButton(r, zone, "Undo", false),
		})),
	});
	return blocks;
}

function undoButton(record: RestoreRecord, zone: string, label: string, red = true): ButtonElement {
	return button("undo", label, {
		...(red ? { style: "danger" as const } : {}),
		value: { point: record.undoPoint, to: record.undoTo, of: record.id },
		confirm: {
			title: `Undo the restore made at ${clock(record.at, zone)}?`,
			text: `The site goes back to ${moment(record.undoTo, zone)}, just before that restore. Changes made since the restore are undone.`,
			confirm: "Undo the restore",
			deny: "Cancel",
			style: "danger",
		},
	});
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

async function mainScreen(
	ctx: PluginContext,
	connection: Connection,
	me: Me,
	now: number,
	extra: { toast?: BlockResponse["toast"]; top?: Block[] } = {},
): Promise<BlockResponse> {
	const key = await loadKey(ctx);
	if (key) connection = await refreshZone(ctx, connection, siteQuery(client(ctx, key), connection));
	const zone = connection.zone;
	const blocks: Block[] = [PAGE_TITLE, ...(extra.top ?? [])];
	if (!connection.lastCheck.ok) {
		blocks.push(
			banner(
				"error",
				"Restore has stopped working",
				connection.lastCheck.problem === "not-found"
					? "The key no longer reaches this site's data. Replace the key to fix it."
					: "Cloudflare no longer accepts the key. Replace the key to fix it.",
			),
		);
	}
	blocks.push(
		ONE_PAGE,
		header("Go back to just before a change"),
		context(`Newest first. ${zoneSentence(zone, connection.zoneSet !== false, now)}`),
	);

	let changes: ReviewGroup[] | null = null;
	if (key) {
		changes = await recentChanges(
			ctx,
			siteQuery(client(ctx, key), connection),
			connection,
			me,
			now,
		).catch(() => null);
	}
	if (changes === null) {
		blocks.push(
			banner(
				"alert",
				"We couldn't read the recent changes just now",
				"Press Check now below, or pick a time instead.",
			),
		);
	} else {
		blocks.push({
			type: "table",
			block_id: "changes",
			page_action_id: "changes_page",
			empty_text: "No changes since Restore was set up.",
			columns: [
				{ key: "what", label: "What changed" },
				{ key: "go", label: "", format: "element" },
			],
			rows: changes.map((group) => {
				const at = justBefore(group.from);
				return {
					what: `${group.what} · ${group.whoName}, ${relative(group.to, zone, now)}`,
					go: button("pick", `Go back to ${clock(at, zone)}`, {
						value: {
							at,
							from: group.from,
							to: group.to,
							who: group.who,
							collection: group.collection ?? null,
							what: group.what,
						},
					}),
				};
			}),
		});
		blocks.push(context("Showing changes since Restore was set up."));
	}

	const earliest = furthestBack(connection, now);
	blocks.push(header("Or pick a time"), {
		type: "form",
		block_id: "time",
		fields: [
			{
				type: "date_input",
				action_id: "day",
				label: "Day",
				initial_value: localDay(new Date(now).toISOString(), zone),
			},
			{
				type: "select",
				action_id: "hour",
				label: "Hour",
				options: hourOptions(),
				initial_value: "0",
			},
			{
				type: "select",
				action_id: "minute",
				label: "Minute",
				options: minuteOptions(),
				initial_value: "0",
			},
		],
		submit: { label: "Review this moment", action_id: "pick_time" },
	});
	blocks.push(
		context(
			`Any time from ${moment(earliest, zone)} until now. Nothing changes until you confirm on the next screen.`,
		),
	);

	const moments = (await allMoments(ctx)).filter((m) => Date.parse(m.at) >= Date.parse(earliest));
	blocks.push(header("Saved moments"));
	if (moments.length > 0) {
		blocks.push({
			type: "table",
			block_id: "moments",
			page_action_id: "moments_page",
			columns: [
				{ key: "name", label: "Name" },
				{ key: "saved", label: "Saved" },
				{ key: "go", label: "", format: "element" },
			],
			rows: moments.map((m) => ({
				name: m.name,
				saved: `${m.byName}, ${relative(m.at, zone, now)} (kept until ${moment(new Date(Date.parse(m.at) + connection.windowDays * DAY).toISOString(), zone).split(",")[0]})`,
				go: button("pick_moment", "Go back to this", { value: m.id }),
			})),
		});
	}
	blocks.push({
		type: "form",
		block_id: "save_moment",
		fields: [
			{
				type: "text_input",
				action_id: "name",
				label: "Save this moment as",
				placeholder: 'For example "Before the menu import"',
			},
		],
		submit: { label: "Save this moment", action_id: "save_moment" },
	});
	blocks.push(context("Save a moment before big changes. It is only a name and a time."));

	blocks.push(...pastRestoresBlocks(await allRestores(ctx), zone, now));

	const list = await emails(ctx);
	blocks.push(
		header("Connection and emails"),
		{
			type: "fields",
			fields: [
				{
					label: "Cloudflare account and site",
					value: `${connection.accountName} / ${connection.databaseName}`,
				},
				{
					label: "Last checked",
					value: `${connection.lastCheck.ok ? "Working" : "Not working"}, ${relative(connection.lastCheck.at, zone, now)} (checked weekly)`,
				},
			],
		},
		connection.reach.length > 1
			? context(
					`This key can change ${connection.reach.length} sites: ${connection.reach.map((r) => (r.isSite ? `${r.name} (this site)` : r.name)).join(", ")}.`,
				)
			: context("This key can change only this site's data."),
		{
			type: "form",
			block_id: "emails",
			fields: [
				{
					type: "text_input",
					action_id: "emails",
					label: "Email these people when the site is put back or Restore stops working",
					initial_value: list.join(", "),
				},
			],
			submit: { label: "Save emails", action_id: "save_emails" },
		},
	);
	if (!ctx.email)
		blocks.push(
			context(
				"This site can't send email yet, so nobody is emailed. Set up email for the site to turn this on.",
			),
		);
	blocks.push(
		actions(
			button("check_now", "Check now"),
			button("replace_key", "Replace the key"),
			button("disconnect", "Disconnect", {
				confirm: {
					title: "Disconnect Restore?",
					text: "The key is removed from this site. Past restores stay listed. You can connect again at any time, but you can't go back to before the new setup.",
					confirm: "Disconnect",
					deny: "Cancel",
					style: "danger",
				},
			}),
		),
		context(
			"Copies to download are in Settings > Backups. They are copies to keep; they can't be loaded back from there.",
		),
	);
	return { blocks, ...(extra.toast ? { toast: extra.toast } : {}) };
}

function refusedScreen(at: string, title: string, text: string, zone: string): BlockResponse {
	return {
		blocks: [
			PAGE_TITLE,
			header(`Go back to ${moment(at, zone)}?`),
			banner("alert", title, text),
			actions(button("back", "Pick another moment")),
			context(
				"Need to go back further? Whoever set up your site may be able to do it from Cloudflare. Copies to download are in Settings > Backups.",
			),
		],
	};
}

function lostTextBlock(review: Review): string {
	let out = "";
	let more = 0;
	for (const item of review.lost) {
		const piece = `${item.how}\n${item.title}\n${item.text}`.trim();
		if (out.length + piece.length > LOST_TEXT_LIMIT) {
			more++;
			continue;
		}
		out += (out ? "\n\n" : "") + piece;
	}
	return more > 0 ? `${out}\n\n(and ${more} more, too long to show here)` : out;
}

function reviewScreen(
	ctx: PluginContext,
	state: ReviewState,
	zone: string,
	now: number,
	zoneSet = true,
): BlockResponse {
	const { review } = state;
	const at = clock(review.moment, zone);
	const blocks: Block[] = [
		PAGE_TITLE,
		header(
			state.undo
				? `Undo the restore and go back to ${moment(review.moment, zone)}?`
				: `Go back to ${moment(review.moment, zone)}?`,
		),
	];
	blocks.push(
		section(
			review.picked
				? `Just before "${review.picked.what}" (${review.picked.whoName.toLowerCase() === "you" ? "you" : review.picked.whoName}, ${clock(review.picked.at, zone)}). Nothing has changed yet.`
				: "Nothing has changed yet.",
		),
		context(zoneSentence(zone, zoneSet, now)),
	);
	blocks.push(
		{
			type: "stats",
			items: [
				{ label: "Changes undone", value: review.counts.changes },
				{ label: "Enquiries removed", value: review.counts.enquiries },
			],
		},
		{
			type: "stats",
			items: [
				{ label: "Come back from Trash", value: review.counts.fromTrash },
				{ label: "Time since", value: since(review.moment, now) },
			],
		},
	);

	const enquiriesFirst =
		(review.enquiries.length > 0 || review.pluginRecords.length > 0) && !state.ack;
	if (enquiriesFirst) {
		const n = review.enquiries.length;
		const list = review.enquiries
			.slice(0, 10)
			.map(
				(e) =>
					`${e.form === "a form" ? "A form" : `${capital(e.form)} form`}: ${e.sender}, ${relative(e.at, zone, now)}`,
			)
			.join("; ");
		const others = review.pluginRecords
			.map((r) =>
				r.plugin === "Lead Delivery"
					? `Lead Delivery also saved ${r.count} record${r.count === 1 ? "" : "s"}; they are put back afterwards.`
					: `${r.plugin} saved ${r.count} record${r.count === 1 ? "" : "s"} since then; they will be removed.`,
			)
			.join(" ");
		blocks.push(
			banner(
				"alert",
				n > 0
					? `${n} ${n === 1 ? "enquiry" : "enquiries"} came in since ${at} and will be removed`
					: `Plugins saved records since ${at}`,
				[n > 0 ? `${list}${n > 10 ? ` and ${n - 10} more` : ""}.` : "", others]
					.filter(Boolean)
					.join(" "),
			),
		);
		const url = siteUrl(ctx);
		const elements: ActionElement[] = [];
		if (n > 0 && url)
			elements.push(
				external(
					"Download in Forms > Submissions",
					`${url}/_emdash/admin/plugins/emdash-forms/submissions`,
				),
			);
		elements.push(
			button(
				"enquiries_ok",
				n > 0 ? (n === 1 ? "It reached us, continue" : "They reached us, continue") : "Continue",
			),
		);
		blocks.push(actions(...elements));
		blocks.push(
			context(
				n > 0
					? `Download ${n === 1 ? "the enquiry" : "them"} first${url ? "" : " (Forms > Submissions, Export)"}, or press "${n === 1 ? "It reached us" : "They reached us"}" if ${n === 1 ? "it was" : "they were"} already emailed to you or delivered elsewhere.`
					: "Press Continue once you have what you need from them.",
			),
		);
	} else if (review.enquiries.length > 0) {
		blocks.push(
			context(
				review.enquiries.length === 1
					? `The enquiry from ${review.enquiries[0]?.sender ?? "a visitor"}: you said it reached you.`
					: `The ${review.enquiries.length} enquiries: you said they reached you.`,
			),
		);
	}

	if (!enquiriesFirst && review.lost.length > 0) {
		blocks.push(
			header("Text of edits that will be lost"),
			section(
				"Copy this before you go back, so you can make these edits again. Select the text in the box and copy it.",
			),
			{ type: "code", code: lostTextBlock(review) },
		);
	}

	// Everything is read before the warning, the tick and the red button.
	blocks.push(header("These will be undone"), undoneTable(review, zone));
	blocks.push(
		context(`Settings, menus and plugin settings also go back to how they were at ${at}.`),
	);
	if (enquiriesFirst) return { blocks };

	blocks.push(banner("alert", "Before you go back", warningText(review, at)));
	blocks.push(
		actions({
			type: "checkbox",
			action_id: "understand",
			label: "Confirm",
			options: [
				{
					label: `I understand the ${review.counts.changes} change${review.counts.changes === 1 ? "" : "s"} made since ${at} will be undone.`,
					value: "yes",
				},
			],
			initial_value: state.ticked ? ["yes"] : [],
		}),
	);
	const restoreButton = button("restore", `Put the site back to ${at}`, {
		style: "danger",
		value: { at: review.moment },
		confirm: {
			title: `Put the site back to ${at}?`,
			text: `${review.counts.changes} change${review.counts.changes === 1 ? "" : "s"} made since then will be undone. You can undo this afterwards.`,
			confirm: "Put the site back",
			deny: "Cancel",
			style: "danger",
		},
	});
	blocks.push(
		state.ticked
			? actions(restoreButton, button("cancel", "Cancel"))
			: actions(button("cancel", "Cancel")),
	);
	blocks.push(
		context(
			state.ticked
				? "This takes up to a minute. Keep this page open. You can undo it afterwards."
				: "Tick the box to continue. This takes up to a minute. You can undo it afterwards.",
		),
	);
	return { blocks };
}

function undoneTable(review: Review, zone: string): Block {
	return {
		type: "table",
		block_id: "undone",
		page_action_id: "undone_page",
		empty_text: "Nothing has changed since then.",
		columns: [
			{ key: "what", label: "What" },
			{ key: "when", label: "Who, when" },
		],
		rows: review.groups.map((group) => ({
			what:
				group.kind === "added"
					? `${group.what}: removed`
					: group.kind === "picture"
						? `${group.what}: leaves the media library, the file is kept`
						: group.kind === "edited" && group.count === 1
							? `${group.what}: this edit is lost`
							: group.what,
			when: `${group.whoName}, ${clock(group.to, zone)}`,
		})),
	};
}

function warningText(review: Review, at: string): string {
	const parts: string[] = [];
	if (review.editors.length > 0) {
		parts.push(
			`Ask ${review.editors.join(" and ")} to stop editing and close the editor; anything saved while this runs is lost.`,
		);
	} else parts.push("Make sure nobody else is editing; anything saved while this runs is lost.");
	if (review.regain.length > 0)
		parts.push(
			`${review.regain.join(" and ")} get${review.regain.length === 1 ? "s" : ""} access back, and anyone else removed since ${at}.`,
		);
	else parts.push(`Anyone removed since ${at} gets their access back.`);
	if (review.lose.length > 0)
		parts.push(
			`${review.lose.join(" and ")} (added since then) lose${review.lose.length === 1 ? "s" : ""} access.`,
		);
	parts.push("Visitors may see an error for up to a minute. You may need to sign in again.");
	return parts.join(" ");
}

function outcomeScreen(
	ctx: PluginContext,
	outcome: RestoreOutcome,
	connection: Connection,
	now: number,
	restores: RestoreRecord[],
): BlockResponse {
	const zone = connection.zone;
	if (outcome.kind === "refused") {
		const { title, text } = refusalText(outcome.refusal, zone);
		return {
			blocks: [
				PAGE_TITLE,
				banner("alert", title, text),
				actions(button("back", "Pick another moment")),
			],
		};
	}
	if (outcome.kind === "problem" || outcome.kind === "nothing-changed") {
		return {
			blocks: [
				PAGE_TITLE,
				banner("error", "The site was not put back", outcome.message),
				actions(button("back", "Back to Restore")),
			],
		};
	}
	if (outcome.kind === "unconfirmed") {
		return {
			blocks: [
				PAGE_TITLE,
				banner(
					"error",
					"We couldn't confirm the restore finished",
					"Cloudflare stopped answering. Wait a minute, then press Check. If your site went back, Undo will be offered; if not, nothing was changed.",
				),
				actions(button("confirm_check", "Check", { value: { id: outcome.record.id } })),
			],
		};
	}
	const { record } = outcome;
	const url = siteUrl(ctx);
	const blocks: Block[] = [PAGE_TITLE];
	if (outcome.historySaved) {
		blocks.push(
			banner(
				"default",
				`Done. Your site is back to ${moment(record.to, zone)}.`,
				`Open your site and check a few pages.${outcome.emailed.length > 0 ? ` We emailed ${outcome.emailed.join(", ")}.` : ""}`,
			),
		);
	} else {
		blocks.push(
			banner(
				"alert",
				`Your site is back to ${clock(record.to, zone)}, but the history could not be saved`,
				"Undo still works from this page. Keep it open.",
			),
		);
	}
	blocks.push(
		actions(
			undoButton(record, zone, "Undo this restore"),
			...(url ? [external("View site", url)] : []),
		),
	);
	blocks.push(
		context(
			`Undo puts the site back to ${relative(record.undoTo, zone, now)}, just before this restore. You can undo until ${moment(new Date(Date.parse(record.at) + connection.windowDays * DAY).toISOString(), zone).split(",")[0]}.`,
		),
	);
	if (outcome.leadRows > 0) {
		blocks.push(
			section(
				`Lead Delivery saved ${outcome.leadRows} record${outcome.leadRows === 1 ? "" : "s"} since ${clock(record.to, zone)}. Put ${outcome.leadRows === 1 ? "it" : "them"} back so its log stays complete.`,
				button(
					"put_back",
					`Put back ${outcome.leadRows} record${outcome.leadRows === 1 ? "" : "s"}`,
					{ style: "primary" },
				),
			),
		);
	}
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Went back to", value: moment(record.to, zone) },
			{ label: "Done by", value: `${record.byName}, ${relative(record.at, zone, now)}` },
			{ label: "Took", value: `${Math.max(1, Math.round(record.tookMs / 1000))} seconds` },
			{ label: "Pictures", value: "Picture files are kept" },
		],
	});
	blocks.push({
		type: "accordion",
		label: "If this page ever disappears",
		blocks: [
			section(
				"Whoever set up your site can undo this restore from their computer. Select the instructions and send them.",
			),
			{
				type: "code",
				code: `To undo the restore of ${connection.databaseName} made on ${moment(record.at, zone)} (${zone}), run:\nnpx wrangler d1 time-travel restore ${connection.databaseName} --bookmark=${record.undoPoint}`,
			},
		],
	});
	blocks.push(
		...pastRestoresBlocks(
			restores.some((r) => r.id === record.id) ? restores : [record, ...restores],
			zone,
			now,
		),
	);
	return {
		blocks,
		toast: { type: "success", message: `Site put back to ${clock(record.to, zone)}` },
	};
}

// ------------------------------------------------------------------ dispatch

export async function handleAdmin(
	input: unknown,
	user: UserLike | undefined,
	ctx: PluginContext,
	now = Date.now(),
): Promise<BlockResponse> {
	const interaction: Interaction = isRecord(input) ? input : {};
	const action = str(interaction.action_id);
	const connection = await loadConnection(ctx);

	if (!user || user.role < ADMIN_ROLE) return editorScreen(await adminNames(ctx, connection));
	const me: Me = {
		id: user.id,
		name: user.name?.trim() || user.email?.split("@")[0] || "An administrator",
		createdAt: user.createdAt ?? "",
	};

	if (!connection) {
		if (action === "connect") return connectAction(ctx, interaction, now, false);
		if (action === "web_person") return webPersonScreen(ctx);
		if (action === "not_cloudflare") return notAvailableScreen();
		return setupScreen();
	}

	switch (action) {
		case "connect":
			return connectAction(ctx, interaction, now, true);
		case "replace_key":
			return setupScreen(undefined, undefined, true);
		case "web_person":
			return webPersonScreen(ctx);
		case "disconnect": {
			await ctx.settings.delete("connection");
			await ctx.settings.delete(KEY_SETTING);
			const screen = setupScreen();
			return { ...screen, toast: { type: "success", message: "Disconnected" } };
		}
		case "check_now": {
			const checked = (await check(ctx, now)) ?? connection;
			return mainScreen(ctx, checked, me, now, {
				toast: checked.lastCheck.ok
					? { type: "success", message: "Working" }
					: { type: "error", message: "Restore is not working; see the message at the top" },
			});
		}
		case "save_emails": {
			const list = parseEmails(str(interaction.values?.emails));
			if (!list)
				return mainScreen(ctx, connection, me, now, {
					toast: { type: "error", message: "One of those isn't an email address" },
				});
			await ctx.settings.set("emails", list);
			return mainScreen(ctx, connection, me, now, {
				toast: { type: "success", message: "Emails saved" },
			});
		}
		case "save_moment": {
			const name = str(interaction.values?.name).trim().slice(0, 80);
			if (!name)
				return mainScreen(ctx, connection, me, now, {
					toast: { type: "error", message: "Give the moment a name first" },
				});
			const at = new Date(now).toISOString();
			await ctx.storage.moments!.put(`m${now.toString(36)}`, { name, at, byName: me.name });
			return mainScreen(ctx, connection, me, now, {
				toast: { type: "success", message: `Saved "${name}"` },
			});
		}
		case "pick":
		case "pick_time":
		case "pick_moment":
			return pickAction(ctx, connection, me, interaction, now);
		case "enquiries_ok":
		case "understand": {
			const state = await ctx.kv.get<ReviewState>("review");
			if (!state || state.byId !== me.id) return mainScreen(ctx, connection, me, now);
			if (action === "enquiries_ok") state.ack = true;
			else state.ticked = Array.isArray(interaction.value) && interaction.value.includes("yes");
			await ctx.kv.set("review", state);
			return reviewScreen(ctx, state, connection.zone, now, connection.zoneSet !== false);
		}
		case "restore": {
			const state = await ctx.kv.get<ReviewState>("review");
			const at = isRecord(interaction.value) ? str(interaction.value.at) : "";
			const enquiriesPending = state
				? (state.review.enquiries.length > 0 || state.review.pluginRecords.length > 0) && !state.ack
				: true;
			if (
				!state ||
				state.byId !== me.id ||
				state.review.moment !== at ||
				!state.ticked ||
				enquiriesPending
			) {
				return mainScreen(ctx, connection, me, now, {
					toast: { type: "error", message: "Review the moment again first" },
				});
			}
			const target = state.undo
				? { point: state.undo.point, pointTo: state.review.moment, undid: state.undo.of }
				: { moment: at };
			const outcome = await keepPending(ctx, await putBack(ctx, target, me, now));
			return outcomeScreen(
				ctx,
				outcome,
				(await loadConnection(ctx)) ?? connection,
				now,
				await allRestores(ctx).catch(() => []),
			);
		}
		case "undo": {
			const value = isRecord(interaction.value) ? interaction.value : {};
			const point = str(value.point);
			const to = str(value.to);
			if (!point || Number.isNaN(Date.parse(to))) return mainScreen(ctx, connection, me, now);
			// Anything that happened since the restore is reviewed first, exactly like a restore:
			// enquiries, lost text, people, the tick. Only a quiet site goes straight back.
			const key = await loadKey(ctx);
			if (!key) return setupScreen("refused", undefined, true);
			const query = siteQuery(client(ctx, key), connection);
			const refused = await refusal(ctx, connection, query, to, me, now).catch(() => null);
			if (refused) {
				const { title, text } = refusalText(refused, connection.zone);
				return refusedScreen(to, title, text, connection.zone);
			}
			let review: Review;
			try {
				review = await buildReview(ctx, query, to, me, now);
			} catch (error) {
				return mainScreen(ctx, connection, me, now, {
					toast: { type: "error", message: `${explain(error)} Nothing was changed.` },
				});
			}
			if (review.counts.changes > 0 || review.pluginRecords.length > 0) {
				const state: ReviewState = {
					review,
					byId: me.id,
					ack: false,
					ticked: false,
					undo: { point, of: str(value.of), at: str(value.at) },
				};
				await ctx.kv.set("review", state);
				return reviewScreen(ctx, state, connection.zone, now, connection.zoneSet !== false);
			}
			const outcome = await keepPending(
				ctx,
				await putBack(ctx, { point, pointTo: to, undid: str(value.of) }, me, now),
			);
			return outcomeScreen(
				ctx,
				outcome,
				(await loadConnection(ctx)) ?? connection,
				now,
				await allRestores(ctx).catch(() => []),
			);
		}
		case "confirm_check": {
			const pending = await ctx.kv.get<{ record: RestoreRecord; marker: string }>("pending");
			if (!pending) return mainScreen(ctx, connection, me, now);
			const outcome = await confirmRestore(ctx, pending.record, pending.marker, now);
			if (outcome.kind !== "unconfirmed") await ctx.kv.delete("pending");
			return outcomeScreen(
				ctx,
				outcome,
				(await loadConnection(ctx)) ?? connection,
				now,
				await allRestores(ctx).catch(() => []),
			);
		}
		case "put_back": {
			try {
				const written = await putBackLeadRecords(ctx);
				return mainScreen(ctx, connection, me, now, {
					toast: {
						type: "success",
						message: `Put back ${written} Lead Delivery record${written === 1 ? "" : "s"}`,
					},
				});
			} catch (error) {
				return mainScreen(ctx, connection, me, now, {
					toast: { type: "error", message: `${explain(error)} The records were not put back.` },
				});
			}
		}
		default:
			return mainScreen(ctx, connection, me, now);
	}
}

/** An unconfirmed restore is kept so "Check" can finish it. */
async function keepPending(ctx: PluginContext, outcome: RestoreOutcome): Promise<RestoreOutcome> {
	if (outcome.kind === "unconfirmed")
		await ctx.kv.set("pending", { record: outcome.record, marker: outcome.marker });
	return outcome;
}

async function connectAction(
	ctx: PluginContext,
	interaction: Interaction,
	now: number,
	replacing: boolean,
): Promise<BlockResponse> {
	const key = str(interaction.values?.key).trim();
	if (!key) return setupScreen("refused", undefined, replacing);
	const result = await connect(ctx, key, now);
	if (!result.ok) return setupScreen(result.problem, result.reachable, replacing);
	return connectedScreen(result.connection);
}

async function pickAction(
	ctx: PluginContext,
	connection: Connection,
	me: Me,
	interaction: Interaction,
	now: number,
): Promise<BlockResponse> {
	const siteKey = await loadKey(ctx);
	if (siteKey) {
		connection = await refreshZone(ctx, connection, siteQuery(client(ctx, siteKey), connection));
	}
	const zone = connection.zone;
	let at = "";
	let picked: Parameters<typeof buildReview>[5];
	if (interaction.action_id === "pick" && isRecord(interaction.value)) {
		const v = interaction.value;
		at = str(v.at);
		picked = {
			from: str(v.from),
			to: str(v.to),
			who: typeof v.who === "string" ? v.who : null,
			collection: typeof v.collection === "string" ? v.collection : undefined,
			what: str(v.what),
		};
	} else if (interaction.action_id === "pick_time") {
		const values = interaction.values ?? {};
		at =
			fromLocal(str(values.day), Number(values.hour ?? 0), Number(values.minute ?? 0), zone) ?? "";
		if (!at)
			return mainScreen(ctx, connection, me, now, {
				toast: { type: "error", message: "Pick a day first" },
			});
	} else if (interaction.action_id === "pick_moment") {
		const saved = await ctx.storage.moments!.get(str(interaction.value));
		at = str((saved as { at?: unknown } | null)?.at);
	}
	if (!at || Number.isNaN(Date.parse(at))) return mainScreen(ctx, connection, me, now);

	const key = await loadKey(ctx);
	if (!key) return setupScreen("refused", undefined, true);
	const query = siteQuery(client(ctx, key), connection);
	const refused = await refusal(ctx, connection, query, at, me, now).catch(() => null);
	if (refused) {
		const { title, text } = refusalText(refused, zone);
		return refusedScreen(at, title, text, zone);
	}
	let review: Review;
	try {
		review = await buildReview(ctx, query, at, me, now, picked);
	} catch (error) {
		return mainScreen(ctx, connection, me, now, {
			toast: { type: "error", message: `${explain(error)} Nothing was changed.` },
		});
	}
	const state: ReviewState = { review, byId: me.id, ack: false, ticked: false };
	await ctx.kv.set("review", state);
	return reviewScreen(ctx, state, zone, now, connection.zoneSet !== false);
}

async function adminNames(ctx: PluginContext, connection: Connection | null): Promise<string[]> {
	if (!connection) return [];
	const key = await loadKey(ctx);
	if (!key) return [];
	try {
		const team = await people(siteQuery(client(ctx, key), connection));
		return team
			.filter((p) => p.role >= ADMIN_ROLE && !p.disabled)
			.slice(0, 3)
			.map((p) => personName(p));
	} catch {
		return [];
	}
}
