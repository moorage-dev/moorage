// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { approve, ask, sendBack, withdraw, type Decision, type Outcome } from "./actions.js";
import {
	BULK,
	bulkBlocks,
	changedText,
	confirmView,
	readDo,
	readItems,
	type BulkState,
	type Names,
	wantsText,
} from "./bulk.js";
import {
	approverRole,
	CONFIG,
	DEFAULT_CONFIG,
	isHeldRole,
	loadConfigWith,
	normalizeConfig,
	ROLE,
	type Config,
} from "./config.js";
import { hiddenFrom, hideField, withHelpLine } from "./help-line.js";
import { CALLS_PER_RUN_1_5, type Meter } from "./meter.js";
import type { CollectionInfo, Draft, UserInfo } from "./requests.js";
import {
	ago,
	approvers,
	collectionInfo,
	entryName,
	inSentence,
	mayApprove,
	nameNow,
	personName,
	readDraft,
	requests,
	titleOf,
	UNNAMED,
	versions,
	when,
	type ApprovalRequest,
	type ApprovedVersion,
} from "./requests.js";
import {
	dismissRun,
	needsLook,
	pickOf,
	RUN_ACTION,
	runBlocks,
	runOf,
	startRun,
	stopRun,
	staleKeys,
	storePick,
} from "./runs.js";
import { writeSettings } from "./settings-store.js";
import { nameList, readableDates } from "./text.js";
import {
	ACTION,
	askedLine,
	buttonValue,
	canDecide,
	decisionBlocks,
	formKey,
	historyBlock,
	liveChanges,
	mayWithdraw,
	peopleList,
	withdrawButton,
} from "./views.js";

export const WIDGET_PAGE = "widget:approvals";
/** Old bulk-run keys deleted per page load at most. */
const STALE_PER_LOAD = 6;
const LIST_LIMIT = 200;
const HISTORY_ROWS = 20;
const OVERRIDE_WINDOW_MS = 30 * 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Lists {
	waiting: ApprovalRequest[];
	sentBack: ApprovalRequest[];
	done: ApprovalRequest[];
	all: ApprovalRequest[];
}

export async function loadLists(ctx: PluginContext): Promise<Lists> {
	const result = await requests(ctx).query({ orderBy: { updatedAt: "desc" }, limit: LIST_LIMIT });
	const all = result.items.map((row) => row.data);
	return {
		all,
		waiting: all
			.filter((r) => r.status === "waiting")
			.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
		sentBack: all.filter((r) => r.status === "sent_back"),
		done: all.filter((r) => r.status !== "waiting"),
	};
}

function key(request: ApprovalRequest): string {
	return `${request.collection}:${request.entryId}`;
}

/** Approvers review; an admin may also open their own request to publish it without review. */
function canReview(config: Config, request: ApprovalRequest, user: UserInfo | undefined): boolean {
	if (canDecide(config, request, user)) return true;
	return request.status === "waiting" && !request.ai && (user?.role ?? 0) >= ROLE.admin;
}

export function isApprover(config: Config | null, user: UserInfo | undefined): boolean {
	return Boolean(config && user && user.role >= approverRole(config.preset));
}

/** Only an approver sees everyone's requests; writers see their own. */
export function visible(
	config: Config | null,
	user: UserInfo | undefined,
	list: ApprovalRequest[],
): ApprovalRequest[] {
	if (isApprover(config, user)) return list;
	return list.filter((r) => user && r.requestedBy?.id === user.id);
}

type CollectionList = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["schema"]>["listCollections"]>>
>;

/** Content type and field labels, from one read of the content types. */
function namesOf(collections: CollectionList): Names {
	return {
		types: new Map(collections.map((c) => [c.slug, c.label])),
		fields: new Map(
			collections.map((c) => [c.slug, new Map(c.fields.map((f) => [f.slug, f.label]))]),
		),
	};
}

/** "2 things to check", noted on the request when the page was saved or held. */
function checkCount(config: Config | null, request: ApprovalRequest): number {
	if (!config || config.checks === "off" || !request.checks) return 0;
	return (request.checks.description ? 1 : 0) + (request.checks.picture ? 1 : 0);
}

function openLink(request: ApprovalRequest) {
	return {
		type: "link" as const,
		label: "Open",
		target: { kind: "content" as const, collection: request.collection, id: request.entryId },
	};
}

/** Requests this person may decide on. */
function forYouRows(list: ApprovalRequest[], names: Names, config: Config | null): Block[] {
	if (list.length === 0) {
		return [
			{
				type: "empty",
				title: "Nothing waiting for you",
				description: "Pages you're asked to approve appear here.",
			},
		];
	}
	const blocks: Block[] = [];
	for (const request of list) {
		const checks = checkCount(config, request);
		const asker = request.ai
			? `from an AI tool (${request.requestedBy?.name ?? "someone"}'s key)`
			: `asked by ${request.requestedBy?.name ?? "a scheduled publish"}`;
		blocks.push(
			{
				type: "section",
				text: request.title,
				accessory: {
					type: "button",
					action_id: ACTION.review,
					label: "Review",
					value: { key: key(request) },
				},
			},
			{
				type: "context",
				text: [
					names.types.get(request.collection) ?? request.collection,
					asker,
					ago(request.requestedAt),
					...(request.wants === "schedule" ? [wantsText(request)] : []),
					changedText(request, names.fields.get(request.collection)),
					...(checks > 0 ? [`${checks} ${checks === 1 ? "thing" : "things"} to check`] : []),
				]
					.filter(Boolean)
					.join(" · "),
			},
			{ type: "divider" },
		);
	}
	return blocks;
}

/** This person's own requests, each with why it waits. An admin may open theirs to publish it without review. */
function yoursRows(
	list: ApprovalRequest[],
	config: Config | null,
	user: UserInfo | undefined,
	names: Map<string, string>,
	others: UserInfo[],
): Block[] {
	if (list.length === 0) {
		return [
			{
				type: "empty",
				title: "Nothing of yours waiting",
				description: "Pages you send for approval appear here.",
			},
		];
	}
	const alone = others.length === 0;
	const reason = alone
		? "needs a second person: nobody else on this site can approve it"
		: `waiting for ${peopleList(others)}`;
	const blocks: Block[] = [];
	for (const request of list) {
		const open = config ? canReview(config, request, user) : false;
		blocks.push(
			{
				type: "section",
				text: request.title,
				accessory: open
					? {
							type: "button",
							action_id: ACTION.review,
							label: alone ? "Publish without review" : "View",
							value: { key: key(request) },
						}
					: openLink(request),
			},
			{
				type: "context",
				text: [
					names.get(request.collection) ?? request.collection,
					`asked ${ago(request.requestedAt)}`,
					reason,
				].join(" · "),
			},
			...(mayWithdraw(request, user)
				? [{ type: "actions" as const, elements: [withdrawButton(key(request))] }]
				: []),
			{ type: "divider" },
		);
	}
	return blocks;
}

function sentBackRows(list: ApprovalRequest[], names: Map<string, string>): Block[] {
	if (list.length === 0) return [{ type: "empty", title: "Nothing sent back" }];
	const blocks: Block[] = [];
	for (const request of list) {
		blocks.push(
			{ type: "section", text: request.title, accessory: openLink(request) },
			{
				type: "context",
				text: `${names.get(request.collection) ?? request.collection} · sent back by ${inSentence(request.sentBack?.by.name ?? "an approver")}, ${ago(request.sentBack?.at ?? request.updatedAt)}: "${request.sentBack?.note ?? ""}"`,
			},
			{ type: "divider" },
		);
	}
	return blocks;
}

function summary(request: ApprovalRequest): string {
	const a = request.approval;
	const edited = (request.edits ?? []).map((e) => e.by.name);
	const approvedBy = a
		? a.override !== undefined
			? `approved without review by ${inSentence(a.by.name)}, ${when(a.at)}: "${a.override}"`
			: `approved by ${inSentence(a.by.name)}${edited.length > 0 ? `, edited by ${nameList([...new Set(edited)])} before approving` : ""}`
		: "";
	switch (request.status) {
		case "published":
			return `Published ${when(request.publishedAt ?? request.updatedAt)}${approvedBy ? ` · ${approvedBy}` : ""}`;
		case "approved":
			return a?.override !== undefined
				? approvedBy.charAt(0).toUpperCase() + approvedBy.slice(1)
				: `Approved by ${inSentence(a?.by.name ?? "?")}, ${when(a?.at ?? request.updatedAt)}`;
		case "sent_back":
			return `Sent back by ${inSentence(request.sentBack?.by.name ?? "an approver")}, ${when(request.sentBack?.at ?? request.updatedAt)}: "${request.sentBack?.note ?? ""}"`;
		case "closed":
			return request.history[0]?.text ?? "Closed";
		default:
			return askedLine(request);
	}
}

/** The approved text copies of the History rows: one call, none when nothing was approved. */
async function approvedCopies(
	ctx: PluginContext,
	rows: ApprovalRequest[],
): Promise<Map<string, ApprovedVersion>> {
	const ids = rows
		.map((r) => r.approval?.versionId)
		.filter((id): id is string => typeof id === "string");
	return ids.length > 0 ? await versions(ctx).getMany(ids) : new Map();
}

function historyRows(rows: ApprovalRequest[], copies: Map<string, ApprovedVersion>): Block[] {
	if (rows.length === 0)
		return [
			{
				type: "empty",
				title: "No decisions yet",
				description: "Approvals and pages sent back appear here.",
			},
		];
	const blocks: Block[] = [];
	for (const request of rows) {
		blocks.push(
			{ type: "section", text: request.title, accessory: openLink(request) },
			{ type: "context", text: summary(request) },
		);
		const copy = request.approval ? copies.get(request.approval.versionId) : undefined;
		if (copy) {
			blocks.push({
				type: "accordion",
				label: `Show the approved text (${when(copy.at)})`,
				blocks: copy.fields
					.filter((f: { text: string }) => f.text !== "")
					.map((f: { label: string; text: string }) => ({
						type: "section" as const,
						text: `${f.label}: ${readableDates(f.text)}`,
					})),
			});
		}
		blocks.push({ type: "divider" });
	}
	return blocks;
}

/** Requests stored as "Untitled" by an earlier release, named again per page load. */
const RENAMED_PER_LOAD = 5;

/**
 * Name the requests an earlier release stored as "Untitled" (an entry whose content type has no
 * `title` field): two calls each, the entry and the request's name, while the run has calls to
 * spare under EmDash 1.5's limit. Only the name is written, so a decision made meanwhile is kept.
 * The rows shown are renamed in place.
 */
async function nameUnnamed(
	m: Meter,
	shown: ApprovalRequest[],
	titleFields: Map<string, string | null>,
): Promise<void> {
	const ctx = m.ctx;
	if (!ctx.content) return;
	// Closed rows are left as they are; a row whose entry is gone is marked, so the next load
	// moves on to the rows after it.
	const unnamed = shown
		.filter((r) => r.title === UNNAMED && r.status !== "closed" && !r.nameTried)
		.slice(0, RENAMED_PER_LOAD);
	for (const request of unnamed) {
		if (m.left(CALLS_PER_RUN_1_5) < 3) return;
		try {
			const item = await ctx.content.get(request.collection, request.entryId);
			if (!item) {
				await requests(ctx).updateIf(key(request), { where: {}, set: { nameTried: true } });
				continue;
			}
			const title = entryName(
				titleFields.get(request.collection),
				item.data ?? {},
				item.slug,
				request.entryId,
			);
			if (title === UNNAMED) continue;
			await requests(ctx).updateIf(key(request), { where: {}, set: { title } });
			request.title = title;
		} catch {
			// Shown as before; tried again on the next load.
		}
	}
}

/** Content types read for pages already scheduled: one call each. */
const SCHEDULED_TYPES = 3;
const SCHEDULED_NAMED = 5;

/** Pages already scheduled to go live, in the content types that were read. */
interface Scheduled {
	pages: Array<{ title: string; type: string; at: string }>;
	/** Content types that approval holds (or would) but that were not read: no calls to spare. */
	unread: string[];
}

/**
 * Pages already scheduled in the content that needs approval (before the first save, in every
 * type that could need it), so the Settings tab names what approval will hold when their time
 * comes. One call per content type, at most SCHEDULED_TYPES, and only while the run has calls
 * left. A live page's scheduled changes count too (EmDash keeps such a page "published", with
 * a time). Pages already cleared (an admin's own schedule, an approved request) are left out.
 *
 * Read with the latest time first: on SQLite and D1 entries without a time sort last, so the
 * first 50 hold every scheduled one. PostgreSQL sorts them first; there a type with more than
 * 50 entries may show none.
 */
async function scheduledPages(
	m: Meter,
	config: Config | null,
	everything: CollectionList,
	all: ApprovalRequest[],
): Promise<Scheduled | null> {
	const ctx = m.ctx;
	if (!ctx.content) return null;
	const holdable = everything.filter((c) => !c.hidden && c.supports.includes("revisions"));
	const types = config ? holdable.filter((c) => config.collections.includes(c.slug)) : holdable;
	const cleared = new Set(all.filter((r) => r.status === "approved").map((r) => key(r)));
	const pages: Scheduled["pages"] = [];
	const unread: string[] = [];
	for (const [index, type] of types.entries()) {
		if (index >= SCHEDULED_TYPES || m.left() < 1) {
			unread.push(type.label);
			continue;
		}
		const result = await ctx.content.list(type.slug, {
			limit: 50,
			orderBy: { scheduledAt: "desc" },
		});
		for (const item of result.items) {
			if (!item.scheduledAt || cleared.has(`${type.slug}:${item.id}`)) continue;
			const title = entryName(type.titleField, item.data ?? {}, item.slug, item.id);
			pages.push({ title, type: type.label, at: item.scheduledAt });
		}
	}
	pages.sort((a, b) => a.at.localeCompare(b.at));
	return { pages, unread };
}

/** The Settings tab's line about pages already scheduled. */
function scheduledText(config: Config | null, scheduled: Scheduled | null): string {
	const general = "Pages already scheduled will need approval before they go live.";
	if (!scheduled) return general;
	const { pages, unread } = scheduled;
	const named = pages.slice(0, SCHEDULED_NAMED).map((p) => `${p.title} (${p.type}, ${when(p.at)})`);
	const more = pages.length - named.length;
	const list = more > 0 ? `${named.join(", ")} and ${more} more` : nameList(named);
	const parts: string[] = [];
	if (pages.length > 0) {
		parts.push(
			config
				? `Already scheduled, and will need approval before they go live: ${list}.`
				: `Already scheduled: ${list}. Once their content type needs approval, they wait for it before going live.`,
		);
	} else if (config && unread.length === 0) {
		parts.push("Nothing already scheduled needs approval.");
	}
	if (unread.length > 0)
		parts.push(
			`Pages scheduled in ${nameList(unread)} weren't checked here; they too will need approval before they go live.`,
		);
	return parts.length > 0 ? parts.join(" ") : general;
}

function settingsBlocks(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
	all: ApprovalRequest[],
	everything: CollectionList,
	people: UserInfo[],
	scheduled: Scheduled | null,
): Block[] {
	const current = config ?? DEFAULT_CONFIG;
	const collections = everything.filter((c) => !c.hidden);
	const holdable = collections.filter((c) => c.supports.includes("revisions"));
	const notHoldable = collections.filter((c) => !c.supports.includes("revisions"));
	// Under "I need someone else's OK" the admin's own work waits for another approver.
	const alone =
		config?.preset === "me" && user !== undefined && !people.some((p) => p.id !== user.id);
	const overrides = all.filter(
		(r) =>
			r.approval?.override !== undefined &&
			Date.now() - Date.parse(r.approval.at) < OVERRIDE_WINDOW_MS,
	).length;
	const cantHold = notHoldable.map((c) => c.label);

	const blocks: Block[] = [
		{
			type: "context",
			text: "A second person OKs a page before it goes live. When approval is on, pressing Publish sends the page for approval instead.",
		},
	];
	if (!config) {
		blocks.push({
			type: "banner",
			title: "Approval is off until you save these settings",
			description:
				"Nothing is held yet, not even work from AI tools. Pick what needs approval, then press Save.",
		});
	}
	if (alone) {
		blocks.push({
			type: "banner",
			title: "Approval needs a second person",
			description:
				"Nobody else here can approve your pages: that takes an editor or another admin. Until there is one, publish yours with Publish without review.",
		});
	}
	if (!ctx.email) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "This site can't send email",
			description:
				"Approvers won't get an email when someone asks. They will see requests on the dashboard and on this page.",
		});
	}
	const scheduleWarning = scheduledText(config, scheduled);
	blocks.push({
		type: "form",
		block_id: "settings",
		fields: [
			{
				type: "checkbox",
				action_id: "collections",
				label: "Which content needs approval",
				options: holdable.map((c) => ({ label: c.label, value: c.slug })),
				initial_value: current.collections.filter((slug) => holdable.some((c) => c.slug === slug)),
			},
			{
				type: "radio",
				action_id: "preset",
				label: "Who needs approval",
				options: [
					{
						label:
							"Others need my OK before publishing (recommended for agencies). Admins approve everyone else's changes.",
						value: "others",
					},
					{
						label:
							"I need someone else's OK before publishing. Everyone needs approval, admins too; an editor or another admin approves.",
						value: "me",
					},
				],
				initial_value: current.preset,
			},
			{
				type: "toggle",
				action_id: "ai",
				label: "Hold what AI tools publish for approval",
				description:
					"Holds anything an AI tool publishes, on every content type, even those not ticked above. The person whose key the tool uses may approve it.",
				initial_value: current.ai,
			},
			{
				type: "toggle",
				action_id: "aiApprove",
				label: "AI tools may approve",
				description:
					"Lets an AI tool connected to your site approve and publish, or send back, what waits for approval, acting for the person whose key it uses, that person's own requests included. Each decision is recorded as made by an AI tool for that person. This includes pages the AI tool itself wrote or published: with this on, an AI tool can put its own work live without a person. Off: only people decide.",
				initial_value: current.aiApprove,
			},
			{
				type: "select",
				action_id: "checks",
				label: "Check for a search description and a sharing picture",
				options: [
					{ label: "Show as a reminder (recommended)", value: "remind" },
					{
						label: "Require before approval (both filled in, in the page's SEO panel)",
						value: "require",
					},
					{ label: "Don't check", value: "off" },
				],
				initial_value: current.checks,
			},
			...(ctx.email
				? [
						{
							type: "toggle" as const,
							action_id: "remind",
							label: "Remind approvers once after 2 days",
							initial_value: current.remind,
						},
					]
				: []),
			// In this form, not one of its own: the first save of this form is what turns
			// approval on, so the switch must never save settings by itself.
			hideField(current.hideHelpLine),
		],
		submit: { label: "Save", action_id: ACTION.saveSettings },
	});
	blocks.push(
		{
			type: "context",
			text: [
				cantHold.length > 0
					? `${nameList(cantHold)} can't be held: EmDash publishes every save of ${cantHold.length === 1 ? "that type" : "those types"} at once, because ${cantHold.length === 1 ? "it keeps" : "they keep"} no drafts.`
					: "",
				scheduleWarning,
			]
				.filter(Boolean)
				.join(" "),
		},
		{
			type: "context",
			text: current.aiApprove
				? "Nobody approves their own request on these pages; an AI tool may, as set above. A change after approval needs approval again."
				: "Nobody approves their own request. A change after approval needs approval again.",
		},
		{ type: "divider" },
		{ type: "header", text: "What approval can't hold" },
		{ type: "section", text: "These go live as soon as they are saved, with or without approval:" },
		{
			type: "context",
			text: "The SEO panel, categories, tags and bylines of a page that is already live. EmDash saves those straight to the live page.",
		},
		...(cantHold.length > 0
			? [
					{
						type: "context" as const,
						text: `Every save in ${nameList(cantHold)}, because ${cantHold.length === 1 ? "it keeps" : "they keep"} no drafts.`,
					},
				]
			: []),
		{
			type: "context",
			text: "Taking a page off the site (Unpublish) is not held, by choice: a page that is wrong can always come down at once, without waiting for anyone.",
		},
		{ type: "divider" },
		{ type: "header", text: "Approvers on this site" },
		{
			type: "section",
			text:
				people.length > 0
					? `${nameList(people.map((p) => personName(p)))} (${current.preset === "me" ? "site editors and admins" : "site admins"}).`
					: "Nobody yet.",
		},
		{
			type: "context",
			text: `Approved or published without review ${overrides} ${overrides === 1 ? "time" : "times"} in the last 30 days.`,
		},
	);
	return blocks;
}

const DRAFTS_PER_TYPE = 50;
/** Content types read for a Contributor's drafts: one call each. */
const DRAFT_TYPES = 3;

/**
 * Contributors' drafts, each with "Ask for approval". EmDash shows plugin panels and
 * toolbar buttons only to people who may edit and publish their own work (Authors and
 * up), so this list is a Contributor's way to ask. From the first DRAFT_TYPES content types
 * that need approval.
 */
async function draftRows(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
	all: ApprovalRequest[],
	names: Map<string, string>,
	titleFields: Map<string, string | null>,
): Promise<Block[]> {
	if (!config || !user || user.role >= ROLE.author || !ctx.content) return [];
	const open = new Set(all.filter((r) => r.status === "waiting").map((r) => key(r)));
	const rows: Block[] = [];
	const types = config.collections.filter((slug) => names.has(slug));
	for (const collection of types.slice(0, DRAFT_TYPES)) {
		const label = names.get(collection) ?? collection;
		const result = await ctx.content.list(collection, {
			limit: DRAFTS_PER_TYPE,
			orderBy: { updatedAt: "desc" },
		});
		for (const item of result.items) {
			if (item.authorId !== user.id || item.status === "published") continue;
			if (open.has(`${collection}:${item.id}`)) continue;
			const title = entryName(titleFields.get(collection), item.data ?? {}, item.slug, item.id);
			rows.push(
				{
					type: "section",
					text: title,
					accessory: {
						type: "button",
						action_id: ACTION.ask,
						label: "Ask for approval",
						value: { collection, id: item.id },
					},
				},
				{ type: "context", text: `${label} · saved ${ago(item.updatedAt)}` },
				{ type: "divider" },
			);
		}
	}
	if (rows.length === 0) return [];
	const more = types.slice(DRAFT_TYPES).map((slug) => names.get(slug) ?? slug);
	return [
		{ type: "header", text: "Your drafts" },
		{ type: "context", text: "Ask for approval when a draft is ready. An approver publishes it." },
		...rows,
		...(more.length > 0
			? [
					{
						type: "context" as const,
						text: `Drafts in ${nameList(more)} aren't listed here; ask an approver to review them.`,
					},
				]
			: []),
	];
}

const TABS = { waiting: 0, sentBack: 1, history: 2, settings: 3 } as const;

/**
 * The Approvals page. The same 4 calls however many pages wait (the requests, the content
 * types, one page of approvers, the approved text copies), plus one per content type for a
 * Contributor's drafts (at most DRAFT_TYPES).
 */
async function listPage(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
	tab: number,
	toast?: BlockResponse["toast"],
	/** Read the pages already scheduled for the Settings tab, with the calls this run has left. */
	scheduledWith?: Meter,
	/** The "Decide several at once" form as it should open (ticked, open). */
	bulk?: BulkState,
	/** The plugin's KV as read with the settings: a bulk run's progress for the banner. */
	entries?: ReadonlyMap<string, unknown>,
): Promise<BlockResponse> {
	const lists = await loadLists(ctx);
	const collections = (await ctx.schema?.listCollections()) ?? [];
	const names = new Map(collections.map((c) => [c.slug, c.label]));
	const labels = namesOf(collections);
	const approver = isApprover(config, user);
	const waiting = visible(config, user, lists.waiting);
	const sentBack = visible(config, user, lists.sentBack);
	const done = visible(config, user, lists.done);
	const titleFields = new Map(collections.map((c) => [c.slug, c.titleField]));
	// Nobody decides on their own request: an approver's own requests are listed apart.
	const forYou = config ? waiting.filter((r) => canDecide(config, r, user)) : [];
	const yours = waiting.filter((r) => !forYou.includes(r));
	const admin = (user?.role ?? 0) >= ROLE.admin;
	// One read of the approvers serves the Settings tab and "waiting for" alike.
	const people =
		admin || (config && user && (approver || yours.length > 0))
			? await approvers(ctx, config ?? DEFAULT_CONFIG, null)
			: [];
	const others = config && user ? people.filter((p) => p.id !== user.id) : [];
	// Under "I need someone else's OK" an approver's own work is held too.
	const onlyApprover =
		approver && config !== null && isHeldRole(config.preset, user?.role) && others.length === 0;

	// Every read first, the rows after: the names an earlier release could not store are filled
	// in last, with what is left of EmDash 1.5's allowance, so they never take the calls of the
	// reads this page made before (the Settings tab's pages already scheduled among them).
	const drafts = await draftRows(ctx, config, user, lists.all, names, titleFields);
	const historyShown = done.slice(0, HISTORY_ROWS);
	const copies = await approvedCopies(ctx, historyShown);
	// Last of the page's own reads, so it uses only the calls left over.
	const scheduled =
		admin && scheduledWith
			? await scheduledPages(scheduledWith, config, collections, lists.all)
			: null;
	if (scheduledWith)
		await nameUnnamed(scheduledWith, [...waiting, ...sentBack, ...historyShown], titleFields);

	const waitingBlocks: Block[] = [
		{
			type: "stats",
			items: approver
				? [
						{ label: "Waiting for you", value: forYou.length },
						{ label: "Yours waiting", value: yours.length },
						{ label: "Sent back", value: sentBack.length },
					]
				: [
						{ label: "Yours waiting", value: yours.length },
						{ label: "Sent back", value: sentBack.length },
					],
		},
	];
	if (onlyApprover) {
		waitingBlocks.push({
			type: "banner",
			title: "Only you can approve on this site",
			description: admin
				? "Your own pages wait for a second person, an editor or another admin. Until there is one, open yours below and use Publish without review."
				: "Your own pages wait for a second person. Until there is one, an admin can publish them without review.",
		});
	}
	// A bulk decision of this person's: its banner, and what needs a look left ticked.
	const run = entries && user ? runOf(entries, user.id) : null;
	const look = needsLook(run);
	const stillWaiting = forYou.filter((r) => look.has(key(r))).length;
	waitingBlocks.push(...runBlocks(run, ctx.cron ? stillWaiting : 0));
	const form: BulkState | undefined = bulk ?? (look.size > 0 ? { ticked: look } : undefined);
	if (approver) {
		waitingBlocks.push(
			{ type: "header", text: "For you to approve" },
			...forYouRows(forYou, labels, config),
			// Decided in background runs (cron): no form while one of theirs runs, or without cron.
			...(ctx.cron && !run?.running ? bulkBlocks(forYou, labels, form) : []),
		);
		if (yours.length > 0)
			waitingBlocks.push(
				{ type: "header", text: "Yours, waiting" },
				...yoursRows(yours, config, user, names, others),
			);
	} else {
		waitingBlocks.push(
			{ type: "header", text: "Yours, waiting" },
			...yoursRows(yours, config, user, names, others),
		);
	}

	// Short labels, no counts: four tabs with counts ran off a 390 px phone's screen.
	// The numbers at the top of Waiting carry the counts.
	const history = historyRows(historyShown, copies);
	const panels = [
		{ label: "Waiting", blocks: [...waitingBlocks, ...drafts] },
		{ label: "Sent back", blocks: sentBackRows(sentBack, names) },
		{ label: "History", blocks: history },
		...(admin
			? [
					{
						label: "Settings",
						blocks: settingsBlocks(ctx, config, user, lists.all, collections, people, scheduled),
					},
				]
			: []),
	];
	return {
		blocks: [
			{ type: "header", text: "Approvals" },
			{ type: "tab", panels, default_tab: Math.min(tab, panels.length - 1) },
		],
		...(toast ? { toast } : {}),
	};
}

/**
 * One request, to review. 5 calls (the request, the page, its content type, the approvers),
 * fewer for what the caller already read.
 */
async function detailPage(
	ctx: PluginContext,
	config: Config,
	user: UserInfo | undefined,
	requestKey: string,
	toast?: BlockResponse["toast"],
	known: { request?: ApprovalRequest; draft?: Draft; info?: CollectionInfo } = {},
): Promise<BlockResponse | null> {
	const request = known.request ?? (await requests(ctx).get(requestKey));
	if (!request || !canReview(config, request, user)) return null;
	const draft = known.draft ?? (await readDraft(ctx, request.collection, request.entryId));
	if (!draft) return null;
	const info = known.info ?? (await collectionInfo(ctx, request.collection));
	const others = await approvers(ctx, config, request.ai ? null : request.requestedBy?.id);
	const blocks: Block[] = [
		{ type: "header", text: "Approvals" },
		{
			type: "actions",
			elements: [{ type: "button", action_id: ACTION.back, label: "‹ Back to the list" }],
		},
		{
			type: "header",
			text:
				request.title === UNNAMED
					? titleOf(info, draft.data, draft.slug, request.entryId)
					: request.title,
		},
		{
			type: "fields",
			fields: [
				{
					label: "Asked by",
					value: `${request.ai ? "An AI tool" : (request.requestedBy?.name ?? "A scheduled publish")}, ${when(request.requestedAt)}`,
				},
				{ label: "Content type", value: info.label },
				{
					label: "Wants to",
					value:
						request.wants === "schedule"
							? `Schedule${request.scheduledAt ? ` for ${when(request.scheduledAt)}` : ""}`
							: "Publish now",
				},
				{ label: "Live now", value: draft.live ? "Yes, an earlier version" : "No" },
			],
		},
		...decisionBlocks({
			config,
			request,
			draft,
			info,
			user,
			key: requestKey,
			changes: liveChanges(info, draft),
			surface: "page",
			others,
		}),
		historyBlock(request),
	];
	return { blocks, ...(toast ? { toast } : {}) };
}

function toastOf(outcome: Outcome): BlockResponse["toast"] {
	return { type: outcome.ok ? "success" : "error", message: outcome.message };
}

async function widget(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
): Promise<BlockResponse> {
	const lists = await loadLists(ctx);
	if (!isApprover(config, user)) {
		const mine = visible(config, user, lists.waiting).length;
		const back = visible(config, user, lists.sentBack).length;
		return {
			blocks: [
				{ type: "section", text: `${mine} of yours waiting · ${back} sent back` },
				{
					type: "actions",
					elements: [
						{
							type: "link",
							label: "See all in Approvals",
							target: { kind: "plugin-page", path: "/overview" },
						},
					],
				},
			],
		};
	}
	const mine = config ? lists.waiting.filter((r) => canDecide(config, r, user)) : [];
	const yours = lists.waiting.filter(
		(r) => !r.ai && user !== undefined && r.requestedBy?.id === user.id,
	).length;
	const blocks: Block[] = [
		{ type: "stats", items: [{ label: "Waiting for you", value: mine.length }] },
	];
	if (yours > 0) blocks.push({ type: "context", text: `${yours} of yours waiting` });
	const shown = mine.slice(0, 5);
	// Requests an earlier release stored as "Untitled": named from their entries (one read each,
	// and the content types once): 8 calls at most.
	if (shown.some((r) => r.title === UNNAMED)) {
		const types = (await ctx.schema?.listCollections()) ?? [];
		const fields = new Map(types.map((c) => [c.slug, c.titleField]));
		for (const request of shown)
			request.title = await nameNow(ctx, request, fields.get(request.collection) ?? null);
	}
	for (const request of shown) {
		blocks.push(
			{ type: "section", text: request.title },
			{
				type: "context",
				text: `${request.ai ? "AI tool" : (request.requestedBy?.name ?? "Scheduled")} · ${ago(request.requestedAt)}`,
			},
		);
	}
	blocks.push({
		type: "actions",
		elements: [
			{
				type: "link",
				label: "See all in Approvals",
				target: { kind: "plugin-page", path: "/overview" },
			},
		],
	});
	return { blocks };
}

/**
 * After an approval or an ask: the outcome, and the way back to the list. Drawn from what the
 * action already holds: the action itself may use up to 8 of the run's calls, and the list
 * costs 4 more.
 */
function doneView(
	decision: Outcome & { request?: ApprovalRequest },
	toast: BlockResponse["toast"] = toastOf(decision),
): BlockResponse {
	const request = decision.request;
	return {
		blocks: [
			{ type: "header", text: "Approvals" },
			...(request
				? [
						{ type: "section" as const, text: request.title },
						{ type: "context" as const, text: summary(request) },
					]
				: []),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: ACTION.back,
						label: "‹ Back to the list",
						style: "primary",
					},
					...(request ? [openLink(request)] : []),
				],
			},
		],
		toast,
	};
}

/** After an approval: done, or the review again with what went wrong. */
async function afterDecision(
	ctx: PluginContext,
	config: Config,
	user: UserInfo | undefined,
	target: string,
	decision: Decision,
): Promise<BlockResponse> {
	if (decision.ok || (decision.draft && decision.request?.status !== "waiting"))
		return doneView(decision);
	if (decision.request?.status === "waiting") {
		const detail = await detailPage(ctx, config, user, target, toastOf(decision), decision);
		if (detail) return detail;
	}
	return listPage(ctx, config, user, TABS.waiting, toastOf(decision));
}

/**
 * The Approvals page and the dashboard widget. Every path stays within 9 calls: see
 * tests/sandbox-budget.test.ts for each one's count.
 */
export async function handleAdmin(
	input: unknown,
	user: UserInfo | undefined,
	m: Meter,
): Promise<BlockResponse> {
	const seen: { config?: Config | null } = {};
	const response = await adminScreen(input, user, m, seen);
	// Every screen of the page (the list, a review, a decision) ends with the help line for an
	// admin who has not hidden it, as the settings are after this request; never the widget.
	const widgetLoad = isRecord(input) && input.type === "page_load" && input.page === WIDGET_PAGE;
	if (widgetLoad || seen.config === undefined) return response;
	const admin = (user?.role ?? 0) >= ROLE.admin;
	return withHelpLine(response, admin && seen.config?.hideHelpLine !== true);
}

async function adminScreen(
	input: unknown,
	user: UserInfo | undefined,
	m: Meter,
	seen: { config?: Config | null },
): Promise<BlockResponse> {
	const ctx: PluginContext = m.ctx;
	const interaction = isRecord(input) ? input : {};
	const action = typeof interaction.action_id === "string" ? interaction.action_id : "";
	// Settings left by an earlier release are copied forward when an admin opens the page,
	// which has a call to spare.
	const opening =
		interaction.type === "page_load" &&
		interaction.page !== WIDGET_PAGE &&
		(user?.role ?? 0) >= ROLE.admin;
	const { config, entries } = await loadConfigWith(ctx, { copy: opening });
	seen.config = config;
	// On opening the page: this person's finished runs kept past their time, earlier runs'
	// lanes and an old selection are deleted (one call each, a few at most).
	if (interaction.type === "page_load" && interaction.page !== WIDGET_PAGE && user) {
		for (const stale of staleKeys(entries, user.id).slice(0, STALE_PER_LOAD)) {
			await ctx.kv.delete(stale).catch(() => false);
			entries.delete(stale);
		}
	}

	if (interaction.type === "page_load" && interaction.page === WIDGET_PAGE)
		return widget(ctx, config, user);

	if (interaction.type === "form_submit" && action === ACTION.saveSettings) {
		if ((user?.role ?? 0) < ROLE.admin) {
			return listPage(
				ctx,
				config,
				user,
				TABS.waiting,
				{
					type: "error",
					message: "Only admins can change these settings.",
				},
				undefined,
				undefined,
				entries,
			);
		}
		const values = isRecord(interaction.values) ? interaction.values : {};
		const next = normalizeConfig({
			...values,
			remind: ctx.email ? values.remind : (config ?? DEFAULT_CONFIG).remind,
			hideHelpLine: hiddenFrom(values, (config ?? DEFAULT_CONFIG).hideHelpLine),
		});
		await writeSettings(ctx, CONFIG, next);
		seen.config = next;
		const message =
			next.collections.length === 0 && !next.ai
				? "Saved. Nothing needs approval."
				: "Saved. Publishing now asks for approval where you chose.";
		return listPage(
			ctx,
			next,
			user,
			TABS.settings,
			{ type: "success", message },
			m,
			undefined,
			entries,
		);
	}

	if (config && interaction.type === "block_action" && action === ACTION.ask) {
		const target = isRecord(interaction.value) ? interaction.value : {};
		if (typeof target.collection === "string" && typeof target.id === "string") {
			const toast = await ask(ctx, config, user, target.collection, target.id);
			return doneView({ ok: toast.type !== "error", message: toast.message }, toast);
		}
	}
	if (config && interaction.type === "block_action") {
		if (action === BULK.back) {
			// Back from the confirm step: the stored selection stays ticked.
			const pick = user ? pickOf(entries, user.id) : null;
			const ticked = new Set((pick?.rows ?? []).map((row) => row.key));
			const state: BulkState = { ticked, ...(pick ? { do: pick.do, reason: pick.reason } : {}) };
			return listPage(ctx, config, user, TABS.waiting, undefined, undefined, state, entries);
		}
		if (action === BULK.go && user) {
			const value = isRecord(interaction.value) ? interaction.value : {};
			const started = await startRun(ctx, user, entries, value.pick);
			return listPage(
				ctx,
				config,
				user,
				TABS.waiting,
				{ type: started.ok ? "success" : "error", message: started.message },
				undefined,
				undefined,
				await loadConfigWith(ctx).then((r) => r.entries),
			);
		}
		if (action === RUN_ACTION.stop && user) {
			const stopped = await stopRun(ctx, user.id, entries);
			return listPage(
				ctx,
				config,
				user,
				TABS.waiting,
				{
					type: "info",
					message: stopped
						? "Stopping. What is already decided stays decided; the rest stays in Waiting."
						: "Nothing of yours is running.",
				},
				undefined,
				undefined,
				await loadConfigWith(ctx).then((r) => r.entries),
			);
		}
		if (action === RUN_ACTION.dismiss && user) {
			await dismissRun(ctx, user.id, entries);
			return listPage(ctx, config, user, TABS.waiting, undefined, undefined, undefined, new Map());
		}
	}
	if (config && interaction.type === "form_submit" && action === BULK.review) {
		const values = isRecord(interaction.values) ? interaction.values : {};
		const all = values.which === "all";
		const ticked = readItems(values.pick);
		const what = readDo(values.do);
		const reason = typeof values.reason === "string" ? values.reason.trim() : "";
		const state: BulkState = {
			ticked: new Set(ticked.map((item) => item.key)),
			which: all ? "all" : "ticked",
			do: what,
			...(reason ? { reason } : {}),
		};
		const problem =
			!all && ticked.length === 0
				? "Tick at least one page, or choose all, then press Check selection."
				: what === "send_back" && reason === ""
					? "Write what should change, then press Check selection."
					: null;
		if (problem) {
			const toast = { type: "error" as const, message: problem };
			return listPage(ctx, config, user, TABS.waiting, toast, undefined, state, entries);
		}
		const lists = await loadLists(ctx);
		const collections = (await ctx.schema?.listCollections()) ?? [];
		// "All waiting for you": every request this person may decide, as the list stands now.
		const items = all
			? lists.waiting
					.filter((r) => canDecide(config, r, user))
					.map((r) => ({ key: key(r), seen: r.fingerprint }))
			: ticked;
		// The button carries this time: it starts this selection and no later one (another tab).
		const at = new Date().toISOString();
		const confirm = confirmView({
			config,
			user,
			items,
			waiting: lists.waiting,
			names: namesOf(collections),
			do: what,
			reason,
			at,
		});
		// Stored now, so the press that follows takes nothing from the browser.
		if (user && confirm.rows.length > 0)
			await storePick(ctx, user.id, {
				do: what,
				reason,
				rows: confirm.rows,
				at,
			});
		return confirm.response;
	}
	if (config && interaction.type === "block_action") {
		const value = buttonValue(interaction.value);
		if (action === ACTION.withdraw && value) {
			// A short confirmation: the list after it would cost a Contributor more calls than are left.
			return doneView(await withdraw(ctx, user, value.key));
		}
		if (action === ACTION.review && value) {
			const detail = await detailPage(ctx, config, user, value.key);
			if (detail) return detail;
			return listPage(
				ctx,
				config,
				user,
				TABS.waiting,
				{
					type: "info",
					message: "This request has already been decided.",
				},
				undefined,
				undefined,
				entries,
			);
		}
		if ((action === ACTION.approve || action === ACTION.approvePublish) && value) {
			const decision = await approve(
				ctx,
				config,
				user,
				value.key,
				{ seen: value.seen, publish: action === ACTION.approvePublish },
				{ meter: m },
			);
			return afterDecision(ctx, config, user, value.key, decision);
		}
	}
	if (config && interaction.type === "form_submit") {
		const values = isRecord(interaction.values) ? interaction.values : {};
		const back = formKey(interaction.block_id, "sb");
		const override = formKey(interaction.block_id, "ov");
		if (action === ACTION.sendBack && back) {
			const decision = await sendBack(ctx, config, user, back, values.note, m);
			// Sending back is cheap enough to show the list again.
			if (!decision.ok && decision.request?.status === "waiting") {
				const detail = await detailPage(ctx, config, user, back, toastOf(decision), decision);
				if (detail) return detail;
			}
			return listPage(
				ctx,
				config,
				user,
				TABS.waiting,
				toastOf(decision),
				undefined,
				undefined,
				entries,
			);
		}
		if ((action === ACTION.override || action === ACTION.overridePublish) && override) {
			const reason = typeof values.reason === "string" ? values.reason : "";
			const decision = await approve(
				ctx,
				config,
				user,
				override,
				{ seen: undefined, publish: action === ACTION.overridePublish, override: reason },
				{ meter: m },
			);
			return afterDecision(ctx, config, user, override, decision);
		}
	}
	// An admin opening the page before anything is set up lands on Settings.
	const firstRun = !config && (user?.role ?? 0) >= ROLE.admin;
	const opened = interaction.type === "page_load" || action === ACTION.back;
	return listPage(
		ctx,
		config,
		user,
		firstRun ? TABS.settings : TABS.waiting,
		undefined,
		opened ? m : undefined,
		undefined,
		entries,
	);
}

export { mayApprove };
