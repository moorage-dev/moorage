// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { definePlugin, getRequestContext, getSiteSetting, pluginResponse, PluginRouteError } from "emdash";
import type { PluginContext, PluginDescriptor, RouteContext } from "emdash";

import pkg from "../package.json" with { type: "json" };
import {
	ADMIN_ROLE,
	handleInteraction,
	type Interaction,
	type MediaOption,
	type PageState,
	type Problem,
	type ProblemKind,
	type Problems,
} from "./admin.js";
import { isLive, normalizeStore, PROBLEMS_KEY, STORE_KEY, type Popup, type Store } from "./config.js";
import type { PreviewAnswer } from "./client/types.js";
import { checkForm } from "./forms.js";
import { clientItem, pageFragments } from "./fragment.js";
import {
	addCount,
	DESCRIPTOR_STORAGE,
	ensurePruneScheduled,
	parseCount,
	PRUNE_TASK,
	pruneCounts,
	readRows,
	STORAGE,
	toCsv,
	totals,
} from "./stats.js";
import { describeMoment, utcDay, validZone } from "./time.js";

export type { Popup, Store } from "./config.js";

const { version } = pkg;

/** Permanent id: part of every route URL and storage key. */
export const PLUGIN_ID = "popups";
const CAPABILITIES = ["hooks.page-fragments:register", "schema:read", "media:read", "email:send"] as const;

/**
 * Add to `plugins: []` in `astro.config.mjs`. There are no options:
 * everything is set on the admin page.
 */
export function popupsPlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version,
		format: "native",
		entrypoint: "@moorage/plugin-popups",
		componentsEntry: "@moorage/plugin-popups/astro",
		options: {},
		capabilities: [...CAPABILITIES],
		storage: DESCRIPTOR_STORAGE,
	};
}

async function readStore(ctx: PluginContext): Promise<Store> {
	return normalizeStore(await ctx.kv.get(STORE_KEY));
}

async function readProblems(ctx: PluginContext): Promise<Problems> {
	const raw = await ctx.kv.get<Problems>(PROBLEMS_KEY);
	return raw && typeof raw === "object" ? raw : {};
}

async function siteZone(): Promise<string> {
	try {
		return validZone(await getSiteSetting("timezone"));
	} catch {
		return "UTC";
	}
}

async function listMedia(ctx: PluginContext): Promise<MediaOption[]> {
	if (!ctx.media) return [];
	try {
		const found = await ctx.media.list({ mimeType: "image/", limit: 100 });
		return found.items.map((item) => ({
			id: item.id,
			url: item.url,
			alt: item.alt ?? "",
			filename: item.filename,
			width: item.width ?? null,
			height: item.height ?? null,
		}));
	} catch {
		return [];
	}
}

async function listCollections(ctx: PluginContext) {
	if (!ctx.schema) return [];
	try {
		const all = await ctx.schema.listCollections();
		return all.filter((c) => !c.hidden).map((c) => ({ slug: c.slug, label: c.label }));
	} catch {
		return [];
	}
}

function originOf(ctx: RouteContext): string | undefined {
	try {
		return ctx.request ? new URL(ctx.request.url).origin : undefined;
	} catch {
		return undefined;
	}
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The email to whoever looks after the site when a popup cannot open. */
export function alertEmail(siteName: string, popup: Popup, kind: ProblemKind): { subject: string; text: string } {
	const fix =
		kind === "missing"
			? `Its form "${popup.form}" no longer exists under Forms. Open Forms, copy the short name of the form you want, and paste it in this popup under Popups > Edit > Change > What it says.`
			: kind === "paused"
				? `Its form "${popup.form}" is paused under Forms. The popup opens again by itself once the form is turned back on.`
				: `Its form "${popup.form}" uses Cloudflare Turnstile or a file upload, which only work in a box in a page for now. Choose another form for this popup, or put this form in a box in a page.`;
	return {
		subject: `${siteName || "Your site"}: the popup "${popup.name}" cannot open`,
		text: `The popup "${popup.name}" did not open for a visitor today.\n\n${fix}\n\nVisitors see nothing broken in the meantime; the popup simply stays closed. You get at most one email like this a day for this popup.\n`,
	};
}

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version,
		capabilities: [...CAPABILITIES],
		storage: STORAGE,
		admin: {
			pages: [{ path: "/", label: "Popups", icon: "megaphone", group: "Marketing" }],
			portableTextBlocks: [
				{
					type: "popups-box",
					label: "Popups box",
					icon: "megaphone",
					category: "Marketing",
					description: "A box made under Popups: a sign-up form or a button",
					fields: [
						{
							type: "select",
							action_id: "popup",
							label: "Which box (made under Marketing > Popups, kind: Box in a page)",
							options: [],
							optionsRoute: "boxes",
						},
					],
				},
			],
		},
		hooks: {
			// May run three times for one page: one read, then pure work.
			"page:fragments": async (event, ctx) => {
				const store = await readStore(ctx);
				const request = getRequestContext();
				return pageFragments(
					store,
					PLUGIN_ID,
					{
						path: event.page.path,
						url: event.page.url,
						collection: event.page.content?.collection,
						editMode: request?.editMode === true,
						preview: request?.preview !== undefined,
					},
					Date.now(),
				);
			},
			"plugin:activate": async (_event, ctx) => {
				await ensurePruneScheduled(ctx);
			},
			cron: async (event, ctx) => {
				if (event.name !== PRUNE_TASK) return;
				const removed = await pruneCounts(ctx, Date.now());
				if (removed > 0) ctx.log.info("Removed popup counts older than 400 days", { removed });
			},
		},
		routes: {
			// The admin page. Editors may change words, pictures, dates and on/off; Admins everything.
			admin: {
				permission: "plugins:read",
				handler: async (ctx) => {
					const admin = (ctx.user?.role ?? 0) >= ADMIN_ROLE;
					if (admin) await ensurePruneScheduled(ctx).catch(() => {});
					const now = Date.now();
					const [store, problems, zone, media, collections, all] = await Promise.all([
						readStore(ctx),
						readProblems(ctx),
						siteZone(),
						listMedia(ctx),
						listCollections(ctx),
						readRows(ctx, null, null).catch(() => []),
					]);
					const input = ctx.input as Interaction | undefined;
					const values = (input?.values ?? {}) as Record<string, unknown>;
					const range =
						input?.type === "form_submit" && input.action_id === "range"
							? {
									from: typeof values.from === "string" && DAY.test(values.from.slice(0, 10)) ? values.from.slice(0, 10) : "",
									to: typeof values.to === "string" && DAY.test(values.to.slice(0, 10)) ? values.to.slice(0, 10) : "",
								}
							: { from: "", to: "" };
					const origin = originOf(ctx);
					const state: PageState = {
						store,
						admin,
						zone,
						now,
						origin,
						pluginId: PLUGIN_ID,
						totals: totals(all),
						rows: all.filter((row) => (!range.from || row.day >= range.from) && (!range.to || row.day <= range.to)),
						range,
						problems,
						media,
						collections,
						emailReady: !!ctx.email,
					};
					const outcome = await handleInteraction(input, state, {
						checkForm: (form, overlay) => checkForm(origin, form, overlay),
					});
					if (outcome.save) await ctx.kv.set(STORE_KEY, outcome.save);
					if (outcome.problems) await ctx.kv.set(PROBLEMS_KEY, outcome.problems);
					return outcome.response;
				},
			},
			// Public write: one count for one popup. See `stats.ts` for the limits.
			count: {
				public: true,
				methods: ["POST"],
				request: { body: "json", maxBytes: 256 },
				handler: async (ctx) => {
					const input = parseCount(ctx.input);
					if (!input) throw PluginRouteError.badRequest("Not a count");
					const store = await readStore(ctx);
					return { counted: (await addCount(ctx, store.popups, input, Date.now())) === "counted" };
				},
			},
			// Public write: a visitor's browser could not open a popup because of its form.
			problem: {
				public: true,
				methods: ["POST"],
				request: { body: "json", maxBytes: 256 },
				handler: async (ctx) => {
					const body = ctx.input as { p?: unknown; k?: unknown } | null;
					const kinds: ProblemKind[] = ["missing", "paused", "unsupported"];
					if (!body || typeof body.p !== "string" || !kinds.includes(body.k as ProblemKind)) {
						throw PluginRouteError.badRequest("Not a problem report");
					}
					const now = Date.now();
					const store = await readStore(ctx);
					const popup = store.popups.find((p) => p.id === body.p);
					if (!popup || !isLive(popup, now) || popup.contains !== "form") return { saved: false };
					const kind = body.k as ProblemKind;
					const problems = await readProblems(ctx);
					const before = problems[popup.id];
					const today = utcDay(now);
					const entry: Problem = { k: kind, at: now, ...(before?.k === kind && before.mailed ? { mailed: before.mailed } : {}) };
					// Nothing is written more than once a minute for the same report.
					if (before && before.k === kind && now - before.at < 60_000) return { saved: false };
					if (ctx.email && store.settings.emails.length && entry.mailed !== today) {
						const message = alertEmail(ctx.site?.name ?? "", popup, kind);
						const [to, ...cc] = store.settings.emails;
						try {
							await ctx.email.send({ to: to!, ...(cc.length ? { cc } : {}), ...message });
							entry.mailed = today;
						} catch (error) {
							ctx.log.warn("Could not send the popup alert email", { error: String(error) });
						}
					}
					problems[popup.id] = entry;
					await ctx.kv.set(PROBLEMS_KEY, problems);
					return { saved: true };
				},
			},
			// The draft a signed-in editor previews on the site.
			preview: {
				permission: "plugins:read",
				methods: ["POST"],
				handler: async (ctx): Promise<PreviewAnswer> => {
					const id = (ctx.input as { id?: unknown } | null)?.id;
					const store = await readStore(ctx);
					const popup = store.popups.find((p) => p.id === id);
					if (!popup || popup.kind === "inline") throw PluginRouteError.notFound("No such popup");
					const item = clientItem(popup, originOf(ctx) ?? "");
					if (!item) throw PluginRouteError.notFound("No such popup");
					const zone = await siteZone();
					const now = Date.now();
					return {
						item,
						off: !popup.on || popup.step < 4,
						...(popup.start ? { startText: describeMoment(popup.start, zone, now) } : {}),
						...(popup.end ? { endText: describeMoment(popup.end, zone, now) } : {}),
					};
				},
			},
			// Results as a spreadsheet: one row per popup per day.
			export: {
				permission: "plugins:read",
				methods: ["GET"],
				response: "raw",
				handler: async (ctx) => {
					const params = ctx.request ? new URL(ctx.request.url).searchParams : new URLSearchParams();
					const from = DAY.test(params.get("from") ?? "") ? params.get("from") : null;
					const to = DAY.test(params.get("to") ?? "") ? params.get("to") : null;
					const store = await readStore(ctx);
					const rows = await readRows(ctx, from, to);
					const names = new Map(store.popups.map((p) => [p.id, p.name]));
					return pluginResponse({
						status: 200,
						headers: {
							"content-type": "text/csv; charset=utf-8",
							"content-disposition": `attachment; filename="popups-${from ?? "start"}-to-${to ?? utcDay(Date.now())}.csv"`,
							"cache-control": "no-store",
						},
						body: { kind: "text", value: toCsv(rows, names) },
					});
				},
			},
			// The list for the "Popups box" block in the editor.
			boxes: {
				permission: "plugins:read",
				handler: async (ctx) => {
					const store = await readStore(ctx);
					return {
						items: store.popups
							.filter((p) => p.kind === "inline")
							.map((p) => ({ id: p.id, name: p.on ? p.name : `${p.name} (off)` })),
					};
				},
			},
			// Public read for the box's own component: what one live box says.
			box: {
				public: true,
				methods: ["POST"],
				request: { body: "json", maxBytes: 128 },
				handler: async (ctx) => {
					const id = (ctx.input as { id?: unknown } | null)?.id;
					const store = await readStore(ctx);
					const popup = store.popups.find((p) => p.id === id && p.kind === "inline");
					const now = Date.now();
					if (!popup || !isLive(popup, now) || (popup.start !== null && now < popup.start)) return { box: null };
					return {
						box: {
							id: popup.id,
							heading: popup.heading,
							text: popup.text,
							picture: popup.picture ? { url: popup.picture.url, alt: popup.picture.alt, width: popup.picture.width, height: popup.picture.height } : null,
							form: popup.contains === "form" ? popup.form : "",
							button: popup.contains === "button" && popup.buttonLabel && popup.buttonUrl ? { label: popup.buttonLabel, url: popup.buttonUrl } : null,
							scheme: store.settings.scheme,
							colors: store.settings.custom ? store.settings.colors : null,
						},
					};
				},
			},
		},
	});
}

export default createPlugin;
