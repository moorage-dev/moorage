// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { queueUrgent } from "./alerts.js";
import {
	afterExternal,
	afterOwnPage,
	afterOwnPath,
	isRefusedHost,
	request,
	verdict,
} from "./check.js";
import { runChecklist } from "./checklist.js";
import { entryPath, linksInData, scanHtml, type Found } from "./extract.js";
import { groupOf, MAX_SOURCES, NEVER, type LinkRow, type PageRow, type Source } from "./model.js";
import {
	applyChange,
	KEY,
	ROWS_PER_GROUP,
	view,
	type CollectionInfo,
	type Loaded,
	type ScanState,
	type Summary,
} from "./state.js";
import { idFor, normalizePath, publicOrigin, shorten } from "./url.js";

export const TASK = "site-health";
const WALK_BATCH = 50;
const LIVE_BATCH = 2;
const DAY = 86_400_000;

export function links(ctx: PluginContext) {
	return ctx.storage.links as unknown as import("emdash").StorageCollection<LinkRow>;
}
export function pages(ctx: PluginContext) {
	return ctx.storage.pages as unknown as import("emdash").StorageCollection<PageRow>;
}

function iso(now: number): string {
	return new Date(now).toISOString();
}

/** Start a full check. Costs two calls: the content types, and the saved state. */
export async function startPass(
	ctx: PluginContext,
	data: Loaded,
	now = Date.now(),
): Promise<ScanState> {
	const collections = (await ctx.schema?.listCollections()) ?? [];
	const scan: ScanState = {
		pass: (data.scan?.pass ?? 0) + 1,
		status: "running",
		phase: "redirects",
		collections: collections
			.filter((c) => !c.hidden)
			.map((c): CollectionInfo => ({
				slug: c.slug,
				label: c.label,
				pattern: c.urlPattern,
				routable: c.routable,
				titleField: c.titleField,
			})),
		ci: 0,
		walked: 0,
		liveDone: 0,
		startedAt: iso(now),
		lastStepAt: iso(now),
	};
	await Promise.all([ctx.kv.set(KEY.scan, scan), ensureTask(ctx)]);
	return scan;
}

/** The cron task: every minute while there is work, which is most of the time. */
export async function ensureTask(ctx: PluginContext): Promise<void> {
	try {
		await ctx.cron?.schedule(TASK, { schedule: "* * * * *" });
	} catch (error) {
		ctx.log.warn("could not schedule the background check", { error: String(error) });
	}
}

function titleOf(
	entry: { data: Record<string, unknown>; slug: string | null },
	field: string | null,
): string {
	const value = entry.data[field ?? "title"] ?? entry.data.title ?? entry.data.name;
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	return entry.slug ?? "(no title)";
}

/** What kind of row a found address makes, or null when it is not checked. */
function rowFor(
	found: Found,
): { id: string; kind: LinkRow["kind"]; url: string; host: string } | null {
	if (found.use === "link") {
		const kind = found.internal ? "internal" : "external";
		return { id: idFor(kind, found.url), kind, url: found.url, host: found.host };
	}
	// Embeds and pictures matter only when they come over an insecure connection.
	if (!found.insecure || found.internal) return null;
	return { id: idFor("insecure", found.url), kind: "insecure", url: found.url, host: found.host };
}

/**
 * Add one place an address was found. The first sighting in a new full
 * check resets the list of places, so links taken out of a page drop away.
 */
function addSource(
	existing: LinkRow | undefined,
	base: { kind: LinkRow["kind"]; url: string; host: string },
	source: Source,
	pass: number,
	now: number,
	extra: Partial<LinkRow> = {},
): LinkRow {
	const fromContent = !source.menu;
	const fresh = !existing || existing.pass !== pass;
	const sources = fresh ? [] : [...existing.sources];
	const known = sources.some(
		(s) => s.p === source.p && s.menu === source.menu && s.id === source.id,
	);
	if (!known && sources.length < MAX_SOURCES) sources.push(source);
	const row: LinkRow = existing
		? {
				...existing,
				sources,
				count: fresh ? 1 : existing.count + (known ? 0 : 1),
				menu: (fresh ? false : existing.menu) || source.menu === true,
				content: (fresh ? false : existing.content) || fromContent,
				pass,
			}
		: {
				kind: base.kind,
				url: base.url,
				host: base.host,
				sources,
				count: 1,
				menu: source.menu === true,
				content: fromContent,
				editor: false,
				pass,
				state: "pending",
				due: base.kind === "external" ? iso(now) : NEVER,
			};
	Object.assign(row, extra);
	row.editor =
		row.kind === "internal" || row.kind === "external" || (row.kind === "insecure" && row.content);
	if (row.state === "broken") row.group = groupOf(row);
	return row;
}

function insecureState(use: Found["use"]): Partial<LinkRow> {
	return use === "image"
		? { state: "look", reason: "insecure-image" }
		: { state: "broken", reason: "insecure-active" };
}

async function redirectsStep(ctx: PluginContext, scan: ScanState): Promise<void> {
	const page = await ctx.redirects?.list({
		limit: 100,
		...(scan.cursor ? { cursor: scan.cursor } : {}),
	});
	const rows = (page?.items ?? [])
		.filter((r) => r.enabled !== false && r.source.startsWith("/") && !/[*[(:]/.test(r.source))
		.map((r) => {
			const path = normalizePath(r.source);
			return {
				id: path,
				data: {
					status: "redirect",
					path,
					title: path,
					dest: r.destination || "",
					pass: scan.pass,
				} as PageRow,
			};
		});
	if (rows.length > 0) await pages(ctx).putMany(rows);
	if (page?.hasMore && page.cursor) scan.cursor = page.cursor;
	else {
		scan.cursor = undefined;
		scan.phase = "walk";
	}
}

async function walkStep(ctx: PluginContext, scan: ScanState, now: number): Promise<void> {
	const col = scan.collections[scan.ci];
	if (!col) {
		scan.phase = "resolve";
		scan.cursor = undefined;
		return;
	}
	const list = await ctx.content?.list(col.slug, {
		limit: WALK_BATCH,
		...(scan.cursor ? { cursor: scan.cursor } : {}),
	});
	const entries = list?.items ?? [];
	const pageRows: Array<{ id: string; data: PageRow }> = [];
	const found = new Map<
		string,
		{ base: NonNullable<ReturnType<typeof rowFor>>; use: Found["use"]; sources: Source[] }
	>();
	for (const entry of entries) {
		const path = col.routable ? entryPath(col.pattern, col.slug, entry) : null;
		const title = titleOf(entry, col.titleField);
		const ids: string[] = [];
		if (entry.status === "published") {
			const source: Source = { c: col.slug, id: entry.id, t: title, p: path ?? "" };
			for (const item of linksInData(entry.data, ctx.site.url)) {
				const base = rowFor(item);
				if (!base || (base.kind === "internal" && base.url === path)) continue;
				ids.push(base.id);
				const seen = found.get(base.id);
				if (seen) seen.sources.push(source);
				else found.set(base.id, { base, use: item.use, sources: [source] });
			}
		}
		if (path) {
			pageRows.push({
				id: path,
				data: {
					status: entry.status,
					path,
					title,
					collection: col.slug,
					id: entry.id,
					pass: scan.pass,
					links: ids.slice(0, 200),
				},
			});
		}
	}
	scan.walked += entries.length;
	if (pageRows.length > 0) await pages(ctx).putMany(pageRows);
	if (found.size > 0) {
		const ids = [...found.keys()];
		const existing = await links(ctx).getMany(ids);
		const writes = ids.map((id) => {
			const item = found.get(id)!;
			let row = existing.get(id);
			for (const source of item.sources) {
				row = addSource(
					row,
					item.base,
					source,
					scan.pass,
					now,
					item.base.kind === "insecure" ? insecureState(item.use) : {},
				);
			}
			if (row?.kind === "insecure" && row.state === "broken" && !row.since) row.since = iso(now);
			return { id, data: row! };
		});
		await links(ctx).putMany(writes);
	}
	if (list?.hasMore && list.cursor) scan.cursor = list.cursor;
	else {
		scan.cursor = undefined;
		scan.ci += 1;
	}
}

/** The verdict for a link to this site, from the saved pages and redirects alone. */
export function resolveLocal(row: LinkRow, page: PageRow | undefined, now: number): LinkRow {
	const clean = (r: LinkRow): LinkRow => {
		const {
			reason: _r,
			detail: _d,
			since: _s,
			group: _g,
			fails: _f,
			firstFailAt: _ff,
			...rest
		} = r;
		return rest as LinkRow;
	};
	if (row.state === "fine") return row;
	if (row.url === "/") return { ...clean(row), state: "ok" };
	if (!page) return { ...clean(row), state: "pending", due: NEVER };
	if (page.status === "redirect") {
		return {
			...clean(row),
			state: "look",
			reason: "redirect",
			detail: page.dest ? shorten(page.dest) : "another page",
		};
	}
	if (page.status === "published") return { ...clean(row), state: "ok" };
	const broken: LinkRow = {
		...clean(row),
		state: "broken",
		reason: "draft",
		since: row.state === "broken" && row.reason === "draft" && row.since ? row.since : iso(now),
	};
	broken.group = groupOf(broken);
	return broken;
}

async function resolveStep(ctx: PluginContext, scan: ScanState, now: number): Promise<void> {
	const batch = await links(ctx).query({
		where: { pass: scan.pass },
		limit: 100,
		...(scan.cursor ? { cursor: scan.cursor } : {}),
	});
	const internal = batch.items.filter((item) => item.data.kind === "internal");
	if (internal.length > 0) {
		const found = await pages(ctx).getMany([...new Set(internal.map((item) => item.data.url))]);
		await links(ctx).putMany(
			internal.map((item) => ({
				id: item.id,
				data: resolveLocal(item.data, found.get(item.data.url), now),
			})),
		);
	}
	if (batch.hasMore && batch.cursor) scan.cursor = batch.cursor;
	else {
		scan.cursor = undefined;
		scan.phase = "live-home";
		scan.liveTotal = await pages(ctx).count({ status: "published", pass: scan.pass });
	}
}

/** Insecure items and menu links seen on one rendered page, merged into the rows. */
async function mergeLive(
	ctx: PluginContext,
	scan: ScanState,
	now: number,
	page: { path: string; title: string },
	found: { menu: Found[]; active: string[]; passive: string[] },
	errors: Array<{ path: string; title: string; status: number }>,
): Promise<void> {
	type Item = {
		id: string;
		base: { kind: LinkRow["kind"]; url: string; host: string };
		source: Source;
		extra: Partial<LinkRow>;
	};
	const items: Item[] = [];
	for (const link of found.menu) {
		const base = rowFor(link);
		if (base)
			items.push({ id: base.id, base, source: { t: "Site menu", p: "", menu: true }, extra: {} });
	}
	for (const [list, use] of [
		[found.active, "embed"],
		[found.passive, "image"],
	] as const) {
		for (const url of list) {
			items.push({
				id: idFor("insecure", url),
				base: { kind: "insecure", url, host: "" },
				source: { t: page.title, p: page.path },
				extra: insecureState(use),
			});
		}
	}
	for (const error of errors) {
		items.push({
			id: idFor("page", error.path),
			base: { kind: "page", url: error.path, host: "" },
			source: { t: error.title, p: error.path },
			extra: {},
		});
	}
	if (items.length === 0) return;
	const ids = [...new Set(items.map((item) => item.id))];
	const existing = await links(ctx).getMany(ids);
	const menuPaths = items
		.filter((item) => item.base.kind === "internal")
		.map((item) => item.base.url);
	const known =
		menuPaths.length > 0
			? await pages(ctx).getMany([...new Set(menuPaths)])
			: new Map<string, PageRow>();
	const merged = new Map<string, LinkRow>();
	for (const item of items) {
		let row = addSource(
			merged.get(item.id) ?? existing.get(item.id),
			item.base,
			item.source,
			scan.pass,
			now,
			item.extra,
		);
		if (row.kind === "internal") {
			row = resolveLocal(row, known.get(row.url), now);
			if (row.state === "broken") row.group = groupOf(row);
		}
		if (row.kind === "page") {
			const error = errors.find((e) => e.path === row.url);
			if (error) row = afterOwnPage(existing.get(item.id) ?? row, { status: error.status }, now);
			row.pass = scan.pass;
		}
		if (row.state === "broken" && !row.since) row.since = iso(now);
		merged.set(item.id, row);
	}
	await links(ctx).putMany([...merged].map(([id, data]) => ({ id, data })));
}

/** The home page answered as itself: 2xx, HTML, not a hosting error page. */
export function isOwnPage(outcome: { status?: number; headers?: Headers; body?: string }): boolean {
	const status = outcome.status ?? 0;
	if (status < 200 || status >= 300) return false;
	const type = outcome.headers?.get("content-type") ?? "";
	if (type !== "" && !/html/i.test(type)) return false;
	const head = (outcome.body ?? "").slice(0, 2000);
	if (/error code: ?\d{3,4}|cf-error-details|Worker threw exception|cloudflare-nginx/i.test(head))
		return false;
	return true;
}

async function liveHomeStep(ctx: PluginContext, scan: ScanState, now: number): Promise<void> {
	const origin = publicOrigin(ctx.site.url);
	if (!origin) {
		scan.live = "not-public";
		scan.phase = "live-paths";
		return;
	}
	const outcome = await request(ctx, `${origin}/`, { body: true });
	const status = outcome.status ?? 0;
	if (outcome.status === undefined) {
		scan.live = isRefusedHost(outcome) ? "not-public" : "failed";
		scan.phase = "live-paths";
		return;
	}
	if (status === 403 || status === 429 || status === 503 || status === 401) {
		scan.live = "blocked";
		scan.phase = "live-paths";
		return;
	}
	// Only a real page counts as "the site answered". A failed fetch of a site's own
	// address can come back as an error page (any status, a Cloudflare error body);
	// taking that as the site's own answer would call every page broken.
	if (!isOwnPage(outcome)) {
		scan.live = "failed";
		scan.phase = "live-paths";
		return;
	}
	scan.live = "ok";
	const control = (outcome.headers?.get("cache-control") ?? "").toLowerCase();
	scan.caching =
		/no-store|private/.test(control) || outcome.headers?.has("set-cookie") ? "no" : "ok";
	const html = scanHtml(outcome.body ?? "", ctx.site.url);
	await mergeLive(
		ctx,
		scan,
		now,
		{ path: "/", title: "Home" },
		{
			menu: html.menu.map((t) => ({ ...t, use: "link" as const })),
			active: html.active,
			passive: html.passive,
		},
		status >= 500 ? [{ path: "/", title: "Home", status }] : [],
	);
	scan.phase = "live-pages";
	scan.cursor = undefined;
}

async function livePagesStep(ctx: PluginContext, scan: ScanState, now: number): Promise<void> {
	const origin = publicOrigin(ctx.site.url);
	const batch = await pages(ctx).query({
		where: { status: "published" },
		limit: LIVE_BATCH,
		...(scan.cursor ? { cursor: scan.cursor } : {}),
	});
	if (origin && batch.items.length > 0) {
		const results = await Promise.all(
			batch.items.map(async (item) => ({
				page: item.data,
				outcome: await request(ctx, `${origin}${item.data.path}`, { body: true }),
			})),
		);
		const active: string[] = [];
		const passive: string[] = [];
		const errors: Array<{ path: string; title: string; status: number }> = [];
		let first: { path: string; title: string } | null = null;
		for (const { page, outcome } of results) {
			if ((outcome.status ?? 0) >= 500)
				errors.push({ path: page.path, title: page.title, status: outcome.status ?? 500 });
			if (outcome.body) {
				const html = scanHtml(outcome.body, ctx.site.url);
				active.push(...html.active);
				passive.push(...html.passive);
				// Insecure items are credited to the first page of the pair that shows them.
				if ((html.active.length || html.passive.length) && !first) first = page;
			}
		}
		await mergeLive(
			ctx,
			scan,
			now,
			first ?? { path: "", title: "" },
			{ menu: [], active, passive },
			errors,
		);
		scan.liveDone += batch.items.length;
	}
	if (batch.hasMore && batch.cursor) scan.cursor = batch.cursor;
	else {
		scan.cursor = undefined;
		scan.phase = "live-paths";
	}
}

/** Addresses on this site that match no page: asked of the site itself, or "could not check". */
async function livePathsStep(ctx: PluginContext, scan: ScanState, now: number): Promise<void> {
	const origin = publicOrigin(ctx.site.url);
	const canOpen = scan.live === "ok" && origin !== null;
	const batch = await links(ctx).query({
		where: { kind: "internal", state: "pending" },
		limit: canOpen ? LIVE_BATCH : 100,
	});
	if (batch.items.length === 0) {
		scan.phase = "checklist";
		return;
	}
	const writes = await Promise.all(
		batch.items.map(async (item) => {
			if (!canOpen) {
				return {
					id: item.id,
					data: { ...item.data, state: "unknown", reason: "no-live", due: NEVER } as LinkRow,
				};
			}
			const outcome = await request(ctx, `${origin}${item.data.url}`);
			return {
				id: item.id,
				data: afterOwnPath(item.data, verdict(item.data.url, outcome, "GET"), now),
			};
		}),
	);
	await links(ctx).putMany(writes);
}

async function sweepStep(ctx: PluginContext, scan: ScanState): Promise<void> {
	const [staleLinks, stalePages] = await Promise.all([
		links(ctx).query({ where: { pass: { lt: scan.pass } }, limit: 100 }),
		pages(ctx).query({ where: { pass: { lt: scan.pass } }, limit: 100 }),
	]);
	await Promise.all([
		staleLinks.items.length > 0 ? links(ctx).deleteMany(staleLinks.items.map((i) => i.id)) : 0,
		stalePages.items.length > 0 ? pages(ctx).deleteMany(stalePages.items.map((i) => i.id)) : 0,
	]);
	if (!staleLinks.hasMore && !stalePages.hasMore) scan.phase = "count";
}

async function countStep(ctx: PluginContext, scan: ScanState): Promise<void> {
	const store = links(ctx);
	const [published, all, site, page, link, editorFix] = await Promise.all([
		pages(ctx).count({ status: "published" }),
		store.count({ kind: { in: ["internal", "external"] } }),
		store.count({ state: "broken", group: "site" }),
		store.count({ state: "broken", group: "page" }),
		store.count({ state: "broken", group: "link" }),
		store.count({ state: "broken", editor: true }),
	]);
	scan.counts = {
		pages: published,
		links: all,
		fix: { site, page, link },
		editorFix,
		look: 0,
		unknown: 0,
	};
	scan.phase = "freeze";
}

async function freezeStep(
	ctx: PluginContext,
	scan: ScanState,
	data: Loaded,
	now: number,
): Promise<Summary | null> {
	const store = links(ctx);
	const [broken, look, unknown, lookCount, unknownCount] = await Promise.all([
		store.query({ where: { state: "broken" }, orderBy: { count: "desc" }, limit: 100 }),
		store.query({ where: { state: "look" }, limit: ROWS_PER_GROUP }),
		store.query({ where: { state: "unknown" }, limit: ROWS_PER_GROUP }),
		store.count({ state: "look" }),
		store.count({ state: "unknown" }),
	]);
	const rows: Summary["rows"] = { site: [], page: [], link: [] };
	for (const { id, data: row } of broken.items) {
		const group = row.group ?? groupOf(row);
		if (rows[group].length < ROWS_PER_GROUP) rows[group].push(view(id, { ...row, group }));
	}
	const counts = scan.counts ?? {
		pages: 0,
		links: 0,
		fix: { site: 0, page: 0, link: 0 },
		editorFix: 0,
		look: 0,
		unknown: 0,
	};
	const summary: Summary = {
		...counts,
		look: lookCount,
		unknown: unknownCount,
		pass: scan.pass,
		finishedAt: iso(now),
		...(data.summary ? { prevFinishedAt: data.summary.finishedAt } : {}),
		rows,
		lookRows: look.items.map(({ id, data: row }) => view(id, row)),
		unknownRows: unknown.items.map(({ id, data: row }) => view(id, row)),
		live: scan.live ?? "failed",
	};
	scan.status = "done";
	scan.finishedAt = iso(now);
	// A first check that found no pages (the plugin was switched on before setup
	// added any) is not kept; another starts in ten minutes.
	const empty = counts.pages === 0 && !data.summary;
	scan.nextAt = iso(now + (empty ? 600_000 : DAY));
	scan.counts = undefined;
	scan.phase = "redirects";
	return empty ? null : summary;
}

/**
 * Do one step of a running full check and save where it got to. Uses at
 * most eight host calls on top of the one read the caller already made.
 */
export async function passStep(
	ctx: PluginContext,
	data: Loaded,
	counter: { ops: number },
	now = Date.now(),
): Promise<ScanState> {
	const current = data.scan;
	if (!current || current.status !== "running") return current as ScanState;
	const scan: ScanState = { ...current, lastStepAt: iso(now) };
	let summary: Summary | null = null;
	switch (scan.phase) {
		case "redirects":
			await redirectsStep(ctx, scan);
			break;
		case "walk":
			await walkStep(ctx, scan, now);
			break;
		case "resolve":
			await resolveStep(ctx, scan, now);
			break;
		case "live-home":
			await liveHomeStep(ctx, scan, now);
			break;
		case "live-pages":
			await livePagesStep(ctx, scan, now);
			break;
		case "live-paths":
			await livePathsStep(ctx, scan, now);
			break;
		case "checklist":
			await runChecklist(ctx, scan, data, now);
			scan.phase = "sweep";
			break;
		case "sweep":
			await sweepStep(ctx, scan);
			break;
		case "count":
			await countStep(ctx, scan);
			break;
		case "freeze":
			summary = await freezeStep(ctx, scan, data, now);
			break;
	}
	if (summary) {
		await ctx.kv.set(KEY.summary, summary);
		data.summary = summary;
		await queueUrgent(ctx, data, summary, now);
	}
	scan.ops = counter.ops + 1;
	await ctx.kv.set(KEY.scan, scan);
	data.scan = scan;
	return scan;
}

/** The longest any host is left alone between two requests. */
const HOST_GAP = 60_000;
const FETCH_BUDGET = 4;

/**
 * Check what is due: links to other sites (three hosts at a time, never one
 * host more than once a minute) and pages of this site that showed an error.
 */
export async function dueStep(
	ctx: PluginContext,
	data: Loaded,
	counter: { ops: number },
	now = Date.now(),
): Promise<number> {
	const due = await links(ctx).query({
		where: { due: { lte: iso(now) } },
		orderBy: { due: "asc" },
		limit: 20,
	});
	const origin = publicOrigin(ctx.site.url);
	const hosts = { ...data.queue.hosts };
	const picked: Array<{ id: string; row: LinkRow }> = [];
	const taken = new Set<string>();
	for (const item of due.items) {
		if (picked.length >= 3) break;
		const row = item.data;
		if (row.state === "fine") continue;
		if (row.kind === "external") {
			if (!data.options.outbound) continue;
			const host = hosts[row.host];
			if (
				taken.has(row.host) ||
				(host && now - host.at < HOST_GAP * (host.slow && host.slow >= 2 ? 60 * 24 : 1))
			)
				continue;
			taken.add(row.host);
		} else if (row.kind !== "page" || !origin || data.summary?.live !== "ok") continue;
		picked.push({ id: item.id, row });
	}
	let fetches = 0;
	const results = await Promise.all(
		picked.map(async ({ id, row }) => {
			if (row.kind === "page") {
				fetches += 1;
				return {
					id,
					before: row,
					after: afterOwnPage(row, await request(ctx, `${origin}${row.url}`), now),
				};
			}
			fetches += 1;
			// A site that refused HEAD before is asked with GET straight away.
			const method = row.get ? "GET" : "HEAD";
			const outcome = await request(ctx, row.url, { method });
			const result = verdict(row.url, outcome, method);
			hosts[row.host] = {
				at: now,
				...(hosts[row.host]?.slow ? { slow: hosts[row.host]!.slow } : {}),
			};
			return { id, before: row, after: null as LinkRow | null, result, outcome };
		}),
	);
	// Sites that refuse HEAD are asked again with GET while the budget lasts.
	for (const item of results) {
		if (item.after || !("result" in item) || !item.result) continue;
		let result = item.result;
		if (result.kind === "retry" && fetches < FETCH_BUDGET) {
			fetches += 1;
			result = verdict(
				item.before.url,
				await request(ctx, item.before.url, { method: "GET" }),
				"GET",
			);
		}
		if (result.kind === "retry" && fetches >= FETCH_BUDGET) {
			item.after = { ...item.before, due: iso(now + HOST_GAP), get: true };
			continue;
		}
		if (result.kind === "unknown" && result.reason === "slow") {
			const host = hosts[item.before.host] ?? { at: now };
			hosts[item.before.host] = { ...host, slow: (host.slow ?? 0) + 1 };
		}
		item.after = afterExternal(item.before, result, now);
		if (item.result.kind === "retry") item.after.get = true;
	}
	// Forget hosts not asked for a day, so the record stays small.
	for (const [host, entry] of Object.entries(hosts))
		if (now - entry.at > DAY && !entry.slow) delete hosts[host];
	if (results.length > 0) {
		await links(ctx).putMany(results.map((item) => ({ id: item.id, data: item.after! })));
	}
	let summary = data.summary;
	if (summary) {
		for (const item of results) {
			const changed = applyChange(summary, item.id, item.before, item.after);
			if (changed) summary = changed;
		}
		if (summary !== data.summary) {
			await ctx.kv.set(KEY.summary, summary);
			data.summary = summary;
			await queueUrgent(ctx, data, summary, now);
		}
	}
	data.queue = { hosts, cronAt: iso(now), ops: counter.ops + 1 };
	await ctx.kv.set(KEY.queue, data.queue);
	return results.length;
}

/** The time a first check takes, in plain words, from the number of pages. */
export function estimate(pagesCount: number, live: boolean): string {
	const minutes =
		Math.ceil(pagesCount / WALK_BATCH) + (live ? Math.ceil(pagesCount / LIVE_BATCH) : 0) + 3;
	if (minutes < 60) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
	const hours = Math.round(minutes / 60);
	return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

/** Re-read one entry's links after it was saved or published. */
export async function refreshEntry(
	ctx: PluginContext,
	collection: string,
	entry: {
		id: string;
		slug: string | null;
		status: string;
		data: Record<string, unknown>;
		publishedAt?: string | null;
	},
	data: Loaded,
	now = Date.now(),
): Promise<void> {
	if (!data.scan) return;
	const info = data.scan.collections.find((c) => c.slug === collection);
	if (!info) return;
	const path = info.routable ? entryPath(info.pattern, collection, entry) : null;
	const title = titleOf(entry, info.titleField);
	const found = entry.status === "published" ? linksInData(entry.data, ctx.site.url) : [];
	const source: Source = { c: collection, id: entry.id, t: title, p: path ?? "" };
	const items = new Map<
		string,
		{ base: NonNullable<ReturnType<typeof rowFor>>; use: Found["use"] }
	>();
	for (const item of found) {
		const base = rowFor(item);
		if (base && !(base.kind === "internal" && base.url === path))
			items.set(base.id, { base, use: item.use });
	}
	const before = path ? await pages(ctx).get(path) : null;
	const ids = [...new Set([...items.keys(), ...(before?.links ?? [])])].slice(0, 400);
	const existing = ids.length > 0 ? await links(ctx).getMany(ids) : new Map<string, LinkRow>();
	const internal = [...items.values()]
		.filter((i) => i.base.kind === "internal")
		.map((i) => i.base.url);
	const known =
		internal.length > 0
			? await pages(ctx).getMany([...new Set(internal)])
			: new Map<string, PageRow>();
	const writes: Array<{ id: string; data: LinkRow }> = [];
	let summary = data.summary;
	for (const id of ids) {
		const row = existing.get(id);
		const item = items.get(id);
		let next: LinkRow | null = null;
		if (item) {
			// Keep the row's other places; add or refresh this page.
			const kept = row ? row.sources.filter((s) => s.id !== entry.id) : [];
			const seed = row
				? {
						...row,
						sources: kept,
						count: Math.max(kept.length, row.count - (row.sources.length - kept.length)),
					}
				: undefined;
			next = addSource(
				seed,
				item.base,
				source,
				row?.pass ?? data.scan.pass,
				now,
				item.base.kind === "insecure" ? insecureState(item.use) : {},
			);
			if (seed)
				next = {
					...next,
					sources: [...kept, source].slice(0, MAX_SOURCES),
					count: seed.count + 1,
					pass: row!.pass,
				};
			if (next.kind === "internal") next = resolveLocal(next, known.get(next.url), now);
			if (next.kind === "internal" && next.state === "pending" && row?.state !== "pending") {
				next = {
					...next,
					state: row?.state === "broken" && row.reason === "missing" ? "broken" : "unknown",
					reason: row?.reason ?? "no-live",
				};
				if (next.state === "broken") next.group = groupOf(next);
			}
		} else if (row) {
			// The link was taken out of this page.
			const kept = row.sources.filter((s) => s.id !== entry.id);
			next =
				kept.length === 0 && !row.menu
					? null
					: { ...row, sources: kept, count: Math.max(kept.length, row.count - 1) };
		}
		if (next && next.state === "broken" && !next.since) next.since = iso(now);
		if (next) writes.push({ id, data: next });
		if (summary) summary = applyChange(summary, id, row, next) ?? summary;
	}
	const removed = ids.filter((id) => !items.has(id) && !writes.some((w) => w.id === id));
	await Promise.all([
		writes.length > 0 ? links(ctx).putMany(writes) : undefined,
		removed.length > 0 ? links(ctx).deleteMany(removed) : undefined,
		path
			? pages(ctx).put(path, {
					status: entry.status,
					path,
					title,
					collection,
					id: entry.id,
					pass: before?.pass ?? data.scan.pass,
					links: [...items.keys()].slice(0, 200),
				})
			: undefined,
	]);
	if (summary && summary !== data.summary) await ctx.kv.set(KEY.summary, summary);
}
