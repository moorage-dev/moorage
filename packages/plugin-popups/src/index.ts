// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import {
	definePlugin,
	getRequestContext,
	getSiteSetting,
	pluginResponse,
	PluginRouteError,
} from "emdash";
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
import type { PreviewAnswer } from "./client/types.js";
import {
	isLive,
	normalizeStore,
	PROBLEMS_KEY,
	STORE_KEY,
	type Popup,
	type Store,
} from "./config.js";
import { checkExport, signExport } from "./export-link.js";
import { checkForm, type FormCheck } from "./forms.js";
import { isPopupPreview, pageFragments, previewItem } from "./fragment.js";
import { forgetSettings, memoSettings } from "./settings-memo.js";
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
const CAPABILITIES = [
	"hooks.page-fragments:register",
	"schema:read",
	"media:read",
	"email:send",
] as const;

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

/** Always a fresh read. Page views use `memoSettings` around it; the admin and the writes do not. */
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

/**
 * The public address of a picture. A plugin's media list only gives a signed-in
 * address (`/_emdash/api/media/asset/...`), which visitors cannot load, so the
 * admin asks the site's own media API, as the signed-in person, for the public
 * file address. Only same-site addresses are accepted.
 */
export async function publicMediaUrl(
	ctx: Pick<RouteContext, "request">,
	origin: string | undefined,
	mediaId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	if (!origin || !/^[A-Za-z0-9_-]{1,60}$/.test(mediaId)) return null;
	try {
		const response = await fetchImpl(`${origin}/_emdash/api/media/${mediaId}`, {
			headers: { cookie: ctx.request?.headers.get("cookie") ?? "", accept: "application/json" },
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as {
			data?: { item?: { url?: unknown; storageKey?: unknown } };
		};
		const item = body.data?.item;
		const url =
			typeof item?.url === "string" && item.url.startsWith("/_emdash/api/media/file/")
				? item.url
				: typeof item?.storageKey === "string"
					? `/_emdash/api/media/file/${item.storageKey}`
					: null;
		return url && /^\/_emdash\/api\/media\/file\/[A-Za-z0-9._/-]+$/.test(url) ? url : null;
	} catch {
		return null;
	}
}

/**
 * A page the site's owner is looking at to check their work: edit mode, an
 * EmDash preview link, or a link from "Preview on your site". Its popups are
 * read fresh (see settings-memo.ts).
 */
export function isOwnerView(
	url: string,
	request: { editMode?: boolean; preview?: unknown } | undefined,
): boolean {
	if (request?.editMode === true || request?.preview !== undefined) return true;
	return /[?&]_preview=/.test(url) || isPopupPreview(url);
}

/** The email to whoever looks after the site when a popup cannot open. */
export function alertEmail(
	siteName: string,
	popup: Popup,
	kind: ProblemKind,
): { subject: string; text: string } {
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

/** The kind of problem the server itself found, or null when the form works (or could not be checked). */
export function confirmed(check: FormCheck): ProblemKind | null {
	if (check.result === "missing" || check.result === "paused") return check.result;
	if (check.result === "turnstile" || check.result === "files") return "unsupported";
	return null;
}

/** Look again at stored problems, so a form that was fixed clears its warning. */
async function recheck(ctx: RouteContext, store: Store, problems: Problems): Promise<Problems> {
	const ids = Object.keys(problems);
	if (!ids.length) return problems;
	const next: Problems = {};
	await Promise.all(
		ids.map(async (id) => {
			const popup = store.popups.find((p) => p.id === id);
			if (!popup || popup.contains !== "form") return;
			const check = await checkForm(originOf(ctx), popup.form, popup.kind !== "inline");
			const kind = confirmed(check);
			// Could not check: keep what was known.
			if (kind || check.result === "unchecked")
				next[id] = kind ? { ...problems[id]!, k: kind } : problems[id]!;
		}),
	);
	if (Object.keys(next).length !== ids.length) await ctx.kv.set(PROBLEMS_KEY, next);
	return next;
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
			// May run three times for one page. The popups are kept in memory between
			// page views (settings-memo.ts), so a warm page view reads nothing.
			"page:fragments": async (event, ctx) => {
				const request = getRequestContext();
				const store = await memoSettings(ctx, () => readStore(ctx), {
					fresh: isOwnerView(event.page.url, request),
				});
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
					const [store, stored, zone, media, collections, all] = await Promise.all([
						readStore(ctx),
						readProblems(ctx),
						siteZone(),
						listMedia(ctx),
						listCollections(ctx),
						readRows(ctx, null, null).catch(() => []),
					]);
					const input = ctx.input as Interaction | undefined;
					// Only when the page opens: a fixed form clears its red warning.
					const problems = input?.type === "page_load" ? await recheck(ctx, store, stored) : stored;
					const values = (input?.values ?? {}) as Record<string, unknown>;
					const range =
						input?.type === "form_submit" && input.action_id === "range"
							? {
									from:
										typeof values.from === "string" && DAY.test(values.from.slice(0, 10))
											? values.from.slice(0, 10)
											: "",
									to:
										typeof values.to === "string" && DAY.test(values.to.slice(0, 10))
											? values.to.slice(0, 10)
											: "",
								}
							: { from: "", to: "" };
					const origin = originOf(ctx);
					const state: PageState = {
						store,
						admin,
						zone,
						now,
						origin,
						// A plain link cannot send EmDash's request header, so the download is signed.
						exportQuery: origin ? await signExport(ctx.kv, range, now) : undefined,
						pluginId: PLUGIN_ID,
						totals: totals(all),
						rows: all.filter(
							(row) => (!range.from || row.day >= range.from) && (!range.to || row.day <= range.to),
						),
						range,
						problems,
						media,
						collections,
						emailReady: !!ctx.email,
					};
					const outcome = await handleInteraction(input, state, {
						checkForm: (form, overlay) => checkForm(origin, form, overlay),
						publicUrl: (mediaId) => publicMediaUrl(ctx, origin, mediaId),
					});
					if (outcome.save) {
						await ctx.kv.set(STORE_KEY, outcome.save);
						// After the write, so a page view in between cannot keep the old popups.
						forgetSettings(PLUGIN_ID);
					}
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
					const problems = await readProblems(ctx);
					const before = problems[popup.id];
					// At most one look a minute per popup, whatever is reported.
					if (before && now - before.at < 60_000) return { saved: false };
					// Anyone can send a report, so the server looks for itself before anything turns red.
					const kind = confirmed(
						await checkForm(originOf(ctx), popup.form, popup.kind !== "inline"),
					);
					if (!kind) {
						if (before) {
							delete problems[popup.id];
							await ctx.kv.set(PROBLEMS_KEY, problems);
						}
						return { saved: false };
					}
					const today = utcDay(now);
					// One email a day per popup, whatever the kind of problem.
					const entry: Problem = {
						k: kind,
						at: now,
						...(before?.mailed ? { mailed: before.mailed } : {}),
					};
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
					if (!popup) throw PluginRouteError.notFound("No such popup");
					const item = previewItem(popup, originOf(ctx) ?? "");
					const zone = await siteZone();
					const now = Date.now();
					return {
						item,
						off: !popup.on || popup.step < 4,
						...(popup.step < 4 ? { unfinished: true } : {}),
						...(popup.start ? { startText: describeMoment(popup.start, zone, now) } : {}),
						...(popup.end ? { endText: describeMoment(popup.end, zone, now) } : {}),
					};
				},
			},
			// Results as a spreadsheet: one row per popup per day. A plain link in the
			// admin cannot send EmDash's request header, so this route is public and
			// serves only a link the admin page signed in the last ten minutes for
			// exactly these dates (see export-link.ts). Counts and names, no visitor data.
			export: {
				public: true,
				methods: ["GET"],
				response: "raw",
				handler: async (ctx) => {
					const params = ctx.request
						? new URL(ctx.request.url).searchParams
						: new URLSearchParams();
					const range = await checkExport(ctx.kv, params, Date.now());
					// A sentence, not an error object: this opens in a browser tab.
					if (!range)
						return pluginResponse({
							status: 403,
							headers: { "content-type": "text/plain; charset=utf-8" },
							body: {
								kind: "text",
								value:
									"This download link has expired (it works for ten minutes) or is not valid. Open Marketing > Popups again and download from the Numbers tab.",
							},
						});
					const from = range.from || null;
					const to = range.to || null;
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
					// Asked for by the box's component while the page renders: kept like the
					// page hook's. The route runs inside the page's request, so its context
					// says whether this is a preview or edit mode.
					const store = await memoSettings(ctx, () => readStore(ctx), {
						fresh: isOwnerView("", getRequestContext()),
					});
					const popup = store.popups.find((p) => p.id === id && p.kind === "inline");
					const now = Date.now();
					if (!popup || !isLive(popup, now) || (popup.start !== null && now < popup.start))
						return { box: null };
					return {
						box: {
							id: popup.id,
							heading: popup.heading,
							text: popup.text,
							picture: popup.picture
								? {
										url: popup.picture.url,
										alt: popup.picture.alt,
										width: popup.picture.width,
										height: popup.picture.height,
									}
								: null,
							form: popup.contains === "form" ? popup.form : "",
							button:
								popup.contains === "button" && popup.buttonLabel && popup.buttonUrl
									? { label: popup.buttonLabel, url: popup.buttonUrl }
									: null,
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
