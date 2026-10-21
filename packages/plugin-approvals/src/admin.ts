// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { approve, ask, sendBack, type Outcome } from "./actions.js";
import {
	approverRole,
	CONFIG_KEY,
	DEFAULT_CONFIG,
	isHeldRole,
	loadConfig,
	normalizeConfig,
	ROLE,
	type Config,
} from "./config.js";
import type { UserInfo } from "./requests.js";
import {
	ago,
	approvers,
	collectionInfo,
	mayApprove,
	personName,
	readDraft,
	requests,
	versions,
	when,
	type ApprovalRequest,
} from "./requests.js";
import { nameList, readableDates } from "./text.js";
import {
	ACTION,
	askedLine,
	buttonValue,
	canDecide,
	checksBanner,
	decisionBlocks,
	formKey,
	historyBlock,
	liveChanges,
	peopleList,
} from "./views.js";

export const WIDGET_PAGE = "widget:approvals";
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

async function loadLists(ctx: PluginContext): Promise<Lists> {
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

function isApprover(config: Config | null, user: UserInfo | undefined): boolean {
	return Boolean(config && user && user.role >= approverRole(config.preset));
}

/** Only an approver sees everyone's requests; writers see their own. */
function visible(
	config: Config | null,
	user: UserInfo | undefined,
	list: ApprovalRequest[],
): ApprovalRequest[] {
	if (isApprover(config, user)) return list;
	return list.filter((r) => user && r.requestedBy?.id === user.id);
}

async function labels(ctx: PluginContext): Promise<Map<string, string>> {
	const collections = (await ctx.schema?.listCollections()) ?? [];
	return new Map(collections.map((c) => [c.slug, c.label]));
}

function openLink(request: ApprovalRequest) {
	return {
		type: "link" as const,
		label: "Open",
		target: { kind: "content" as const, collection: request.collection, id: request.entryId },
	};
}

/** Requests this person may decide on. */
function forYouRows(
	list: ApprovalRequest[],
	names: Map<string, string>,
	checksByKey: Map<string, number>,
): Block[] {
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
		const checks = checksByKey.get(key(request)) ?? 0;
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
					names.get(request.collection) ?? request.collection,
					asker,
					ago(request.requestedAt),
					...(checks > 0 ? [`${checks} ${checks === 1 ? "thing" : "things"} to check`] : []),
				].join(" · "),
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
				text: `${names.get(request.collection) ?? request.collection} · sent back by ${request.sentBack?.by.name ?? "an approver"}, ${ago(request.sentBack?.at ?? request.updatedAt)}: "${request.sentBack?.note ?? ""}"`,
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
			? `approved without review by ${a.by.name}, ${when(a.at)}: "${a.override}"`
			: `approved by ${a.by.name}${edited.length > 0 ? `, edited by ${nameList([...new Set(edited)])} before approving` : ""}`
		: "";
	switch (request.status) {
		case "published":
			return `Published ${when(request.publishedAt ?? request.updatedAt)}${approvedBy ? ` · ${approvedBy}` : ""}`;
		case "approved":
			return a?.override !== undefined
				? approvedBy.charAt(0).toUpperCase() + approvedBy.slice(1)
				: `Approved by ${a?.by.name ?? "?"}, ${when(a?.at ?? request.updatedAt)}`;
		case "sent_back":
			return `Sent back by ${request.sentBack?.by.name ?? "an approver"}, ${when(request.sentBack?.at ?? request.updatedAt)}: "${request.sentBack?.note ?? ""}"`;
		case "closed":
			return request.history[0]?.text ?? "Closed";
		default:
			return askedLine(request);
	}
}

async function historyRows(ctx: PluginContext, list: ApprovalRequest[]): Promise<Block[]> {
	const rows = list.slice(0, HISTORY_ROWS);
	if (rows.length === 0)
		return [
			{
				type: "empty",
				title: "No decisions yet",
				description: "Approvals and pages sent back appear here.",
			},
		];
	const ids = rows
		.map((r) => r.approval?.versionId)
		.filter((id): id is string => typeof id === "string");
	const copies = ids.length > 0 ? await versions(ctx).getMany(ids) : new Map();
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

async function settingsBlocks(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
	all: ApprovalRequest[],
): Promise<Block[]> {
	const current = config ?? DEFAULT_CONFIG;
	const collections = ((await ctx.schema?.listCollections()) ?? []).filter((c) => !c.hidden);
	const holdable = collections.filter((c) => c.supports.includes("revisions"));
	const notHoldable = collections.filter((c) => !c.supports.includes("revisions"));
	const people = await approvers(ctx, current, null);
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
	const scheduleWarning = "Pages already scheduled will need approval before they go live.";
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
				label: "AI tools connected to your site always need a person's OK",
				description:
					"Holds anything an AI tool publishes, on every content type, even those not ticked above. The person whose key the tool uses may approve it.",
				initial_value: current.ai,
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
			text: "Nobody approves their own request. A change after approval needs approval again.",
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
		{ type: "context", text: "Taking a page off the site (Unpublish)." },
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

async function checkCounts(
	ctx: PluginContext,
	config: Config | null,
	list: ApprovalRequest[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	if (!config || config.checks === "off") return counts;
	for (const request of list.slice(0, 20)) {
		try {
			const draft = await readDraft(ctx, request.collection, request.entryId);
			const info = await collectionInfo(ctx, request.collection);
			if (!draft) continue;
			const banner = checksBanner(config, draft, info, true);
			const first = banner[0];
			if (first?.type === "banner")
				counts.set(
					key(request),
					(first.description ?? "").split(".").filter((s) => s.trim()).length,
				);
		} catch {
			// A row without its count is better than no list.
		}
	}
	return counts;
}

const DRAFTS_PER_TYPE = 50;

/**
 * Contributors' drafts, each with "Ask for approval". EmDash shows plugin panels and
 * toolbar buttons only to people who may edit and publish their own work (Authors and
 * up), so this list is a Contributor's way to ask.
 */
async function draftRows(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
	all: ApprovalRequest[],
): Promise<Block[]> {
	if (!config || !user || user.role >= ROLE.author || !ctx.content) return [];
	const open = new Set(all.filter((r) => r.status === "waiting").map((r) => key(r)));
	const rows: Block[] = [];
	for (const collection of config.collections) {
		const info = await collectionInfo(ctx, collection);
		const result = await ctx.content.list(collection, {
			limit: DRAFTS_PER_TYPE,
			orderBy: { updatedAt: "desc" },
		});
		for (const item of result.items) {
			if (item.authorId !== user.id || item.status === "published") continue;
			if (open.has(`${collection}:${item.id}`)) continue;
			const title =
				typeof item.data?.title === "string" && item.data.title.trim()
					? item.data.title.trim()
					: "Untitled";
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
				{ type: "context", text: `${info.label} · saved ${ago(item.updatedAt)}` },
				{ type: "divider" },
			);
		}
	}
	if (rows.length === 0) return [];
	return [
		{ type: "header", text: "Your drafts" },
		{ type: "context", text: "Ask for approval when a draft is ready. An approver publishes it." },
		...rows,
	];
}

const TABS = { waiting: 0, sentBack: 1, history: 2, settings: 3 } as const;

async function listPage(
	ctx: PluginContext,
	config: Config | null,
	user: UserInfo | undefined,
	tab: number,
	toast?: BlockResponse["toast"],
): Promise<BlockResponse> {
	const lists = await loadLists(ctx);
	const names = await labels(ctx);
	const approver = isApprover(config, user);
	const waiting = visible(config, user, lists.waiting);
	const sentBack = visible(config, user, lists.sentBack);
	const done = visible(config, user, lists.done);
	// Nobody decides on their own request: an approver's own requests are listed apart.
	const forYou = config ? waiting.filter((r) => canDecide(config, r, user)) : [];
	const yours = waiting.filter((r) => !forYou.includes(r));
	const counts = await checkCounts(ctx, config, forYou);
	const admin = (user?.role ?? 0) >= ROLE.admin;
	const others = config && user ? await approvers(ctx, config, user.id) : [];
	// Under "I need someone else's OK" an approver's own work is held too.
	const onlyApprover =
		approver && config !== null && isHeldRole(config.preset, user?.role) && others.length === 0;

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
	if (approver) {
		waitingBlocks.push(
			{ type: "header", text: "For you to approve" },
			...forYouRows(forYou, names, counts),
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

	const panels = [
		{
			label: `Waiting (${waiting.length})`,
			blocks: [...waitingBlocks, ...(await draftRows(ctx, config, user, lists.all))],
		},
		{ label: `Sent back (${sentBack.length})`, blocks: sentBackRows(sentBack, names) },
		{ label: "History", blocks: await historyRows(ctx, done) },
		...(admin
			? [{ label: "Settings", blocks: await settingsBlocks(ctx, config, user, lists.all) }]
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

async function detailPage(
	ctx: PluginContext,
	config: Config,
	user: UserInfo | undefined,
	requestKey: string,
	toast?: BlockResponse["toast"],
): Promise<BlockResponse | null> {
	const request = await requests(ctx).get(requestKey);
	if (!request || !canReview(config, request, user)) return null;
	const draft = await readDraft(ctx, request.collection, request.entryId);
	if (!draft) return null;
	const info = await collectionInfo(ctx, request.collection);
	const others = await approvers(ctx, config, request.ai ? null : request.requestedBy?.id);
	const blocks: Block[] = [
		{ type: "header", text: "Approvals" },
		{
			type: "actions",
			elements: [{ type: "button", action_id: ACTION.back, label: "‹ Back to the list" }],
		},
		{ type: "header", text: request.title },
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
	for (const request of mine.slice(0, 5)) {
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

/** The Approvals page and the dashboard widget. */
export async function handleAdmin(
	input: unknown,
	user: UserInfo | undefined,
	ctx: PluginContext,
): Promise<BlockResponse> {
	const interaction = isRecord(input) ? input : {};
	const config = await loadConfig(ctx);
	const action = typeof interaction.action_id === "string" ? interaction.action_id : "";

	if (interaction.type === "page_load" && interaction.page === WIDGET_PAGE)
		return widget(ctx, config, user);

	if (interaction.type === "form_submit" && action === ACTION.saveSettings) {
		if ((user?.role ?? 0) < ROLE.admin) {
			return listPage(ctx, config, user, TABS.waiting, {
				type: "error",
				message: "Only admins can change these settings.",
			});
		}
		const values = isRecord(interaction.values) ? interaction.values : {};
		const next = normalizeConfig({
			...values,
			remind: ctx.email ? values.remind : (config ?? DEFAULT_CONFIG).remind,
		});
		await ctx.kv.set(CONFIG_KEY, next);
		const message =
			next.collections.length === 0 && !next.ai
				? "Saved. Nothing needs approval."
				: "Saved. Publishing now asks for approval where you chose.";
		return listPage(ctx, next, user, TABS.settings, { type: "success", message });
	}

	if (config && interaction.type === "block_action" && action === ACTION.ask) {
		const target = isRecord(interaction.value) ? interaction.value : {};
		if (typeof target.collection === "string" && typeof target.id === "string") {
			const toast = await ask(ctx, config, user, target.collection, target.id);
			return listPage(ctx, config, user, TABS.waiting, toast);
		}
	}
	if (config && interaction.type === "block_action") {
		const value = buttonValue(interaction.value);
		if (action === ACTION.review && value) {
			const detail = await detailPage(ctx, config, user, value.key);
			if (detail) return detail;
			return listPage(ctx, config, user, TABS.waiting, {
				type: "info",
				message: "This request has already been decided.",
			});
		}
		if ((action === ACTION.approve || action === ACTION.approvePublish) && value) {
			const outcome = await approve(ctx, config, user, value.key, {
				seen: value.seen,
				publish: action === ACTION.approvePublish,
			});
			if (!outcome.ok) {
				const detail = await detailPage(ctx, config, user, value.key, toastOf(outcome));
				if (detail) return detail;
			}
			return listPage(ctx, config, user, TABS.waiting, toastOf(outcome));
		}
	}
	if (config && interaction.type === "form_submit") {
		const values = isRecord(interaction.values) ? interaction.values : {};
		const back = formKey(interaction.block_id, "sb");
		const override = formKey(interaction.block_id, "ov");
		let outcome: Outcome | null = null;
		let target: string | null = null;
		if (action === ACTION.sendBack && back) {
			outcome = await sendBack(ctx, config, user, back, values.note);
			target = back;
		}
		if ((action === ACTION.override || action === ACTION.overridePublish) && override) {
			const reason = typeof values.reason === "string" ? values.reason : "";
			outcome = await approve(ctx, config, user, override, {
				seen: undefined,
				publish: action === ACTION.overridePublish,
				override: reason,
			});
			target = override;
		}
		if (outcome && target) {
			if (!outcome.ok) {
				const detail = await detailPage(ctx, config, user, target, toastOf(outcome));
				if (detail) return detail;
			}
			return listPage(ctx, config, user, TABS.waiting, toastOf(outcome));
		}
	}
	// An admin opening the page before anything is set up lands on Settings.
	const firstRun = !config && (user?.role ?? 0) >= ROLE.admin;
	return listPage(ctx, config, user, firstRun ? TABS.settings : TABS.waiting);
}

export { mayApprove };
