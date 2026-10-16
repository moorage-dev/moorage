// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

import {
	ALERTS_KEY,
	day,
	loadConfig,
	loadForms,
	saveForms,
	siteName,
	since,
	TICK_KEY,
} from "./config.js";
import { fieldsOf } from "./enquiry.js";
import { classifyHubSpot, hubspotBody, submitUrl, type Outcome } from "./hubspot.js";
import { enquiryEmail, failureAlert, quietAlert, quietLine, schedulerAlert } from "./messages.js";
import type { Config, Delivery, Enquiry, KnownForm, Place } from "./types.js";
import { appRequest, classifyApp } from "./webhook.js";

export const DELIVER_TASK = "deliver";
export const MAINTENANCE_TASK = "maintenance";
export const STATS_KEY = "stats";
const DAILY_KEY = "daily";

/** Waits after each failed try: 8 tries over about 45 hours. */
export const DELAYS_MIN = [1, 5, 30, 120, 360, 720, 1440];
export const MAX_ATTEMPTS = DELAYS_MIN.length + 1;
/** Deliveries per scheduled run and per arriving enquiry. */
export const PER_RUN = 3;
const DAY_MS = 86_400_000;
export const KEEP_DAYS = 30;

export function deliveries(ctx: PluginContext): StorageCollection<Delivery> {
	return ctx.storage.deliveries as StorageCollection<Delivery>;
}

export function enquiries(ctx: PluginContext): StorageCollection<Enquiry> {
	return ctx.storage.enquiries as StorageCollection<Enquiry>;
}

export function deliveryId(enquiryId: string, placeId: string): string {
	return `${enquiryId}~${placeId}`;
}

export function servesForm(place: Place, formId: string): boolean {
	return place.forms === "all" || place.forms.includes(formId);
}

export function placeName(config: Config, id: string): string {
	return config.places.find((p) => p.id === id)?.name ?? "a place that was deleted";
}

/** Daily counts for the stats: received and delivered enquiries (tests excluded). */
async function count(ctx: PluginContext, what: "r" | "d") {
	const stats = (await ctx.kv.get<Record<string, { r: number; d: number }>>(STATS_KEY)) ?? {};
	const today = day(new Date().toISOString());
	const entry = stats[today] ?? { r: 0, d: 0 };
	entry[what] += 1;
	stats[today] = entry;
	const keep = Object.keys(stats).sort().slice(-14);
	await ctx.kv.set(STATS_KEY, Object.fromEntries(keep.map((k) => [k, stats[k]!])));
}

export async function weekCounts(
	ctx: PluginContext,
): Promise<{ received: number; delivered: number }> {
	const stats = (await ctx.kv.get<Record<string, { r: number; d: number }>>(STATS_KEY)) ?? {};
	const from = day(new Date(Date.now() - 6 * DAY_MS).toISOString());
	let received = 0;
	let delivered = 0;
	for (const [key, value] of Object.entries(stats)) {
		if (key < from) continue;
		received += value.r;
		delivered += value.d;
	}
	return { received, delivered };
}

/** Remember the form: its name, its fields (when not known from its definition), when it last sent. */
async function noteForm(ctx: PluginContext, enquiry: Enquiry) {
	if (enquiry.via === "test") return;
	const forms = await loadForms(ctx);
	const now = enquiry.receivedAt;
	const known = forms[enquiry.formId];
	const fields = fieldsOf(enquiry);
	const days = [...new Set([...(known?.days ?? []), day(now)])].slice(-30);
	forms[enquiry.formId] = known
		? {
				...known,
				name: enquiry.formName || known.name,
				...(known.source === "enquiry" || known.fields.length === 0 ? { fields } : {}),
				lastAt: now,
				days,
			}
		: {
				slug: enquiry.formId,
				name: enquiry.formName,
				fields,
				source: "enquiry",
				addedAt: now,
				lastAt: now,
				days,
			};
	await saveForms(ctx, forms);
}

/** Recent log rows for one form, newest first, to spot the same person sending again. */
async function recentForForm(ctx: PluginContext, formId: string, sinceMs: number) {
	const result = await deliveries(ctx).query({
		where: { formId, createdAt: { gte: new Date(sinceMs).toISOString() } },
		orderBy: { createdAt: "desc" },
		limit: 100,
	});
	return result.items;
}

export interface ReceiveResult {
	duplicate: boolean;
	queued: number;
	delivered: number;
}

/**
 * Store an enquiry once and start delivering it. `inline` tries up to three places at once
 * (the forms plugin calls after the visitor has their answer); otherwise a scheduled run does.
 */
export async function receive(
	ctx: PluginContext,
	id: string,
	enquiry: Enquiry,
	opts: { inline: boolean; only?: Place; schedule?: boolean },
): Promise<ReceiveResult> {
	const now = Date.now();
	const config = await loadConfig(ctx);
	const recent = enquiry.email ? await recentForForm(ctx, enquiry.formId, now - 7 * DAY_MS) : [];
	const previous = recent.find((r) => r.data.email === enquiry.email && !r.data.test);
	if (previous) {
		enquiry.repeatDays = Math.max(
			1,
			Math.round((now - Date.parse(previous.data.createdAt)) / DAY_MS),
		);
	}

	const created = await enquiries(ctx).compareAndSet(id, null, enquiry);
	if (!created.applied) return { duplicate: true, queued: 0, delivered: 0 };
	await noteForm(ctx, enquiry);
	if (enquiry.via !== "test") await count(ctx, "r");

	const createdAt = new Date(now).toISOString();
	const who = enquiry.name ?? enquiry.email ?? "Someone";
	const notes: string[] = [];
	if (enquiry.throwaway) notes.push("Throwaway address");
	if (enquiry.repeatDays) {
		notes.push(
			`Same address ${enquiry.repeatDays === 1 ? "yesterday" : `${enquiry.repeatDays} days ago`}`,
		);
	}
	if (enquiry.via === "test") notes.push("Test");
	if (enquiry.hasFiles) notes.push("Has an attachment, see Forms → Submissions");

	const rows: Array<{ id: string; data: Delivery }> = [];
	const targets = opts.only
		? [opts.only]
		: config.places.filter((place) => place.on && servesForm(place, enquiry.formId));
	for (const place of targets) {
		const row: Delivery = {
			enquiryId: id,
			destination: place.id,
			formId: enquiry.formId,
			formName: enquiry.formName,
			who,
			...(enquiry.email ? { email: enquiry.email } : {}),
			status: "retrying",
			attempts: 0,
			nextAt: createdAt,
			createdAt,
			notes: [...notes],
			...(enquiry.via === "test" ? { test: true } : {}),
		};
		const twice =
			place.noDuplicates &&
			enquiry.email &&
			enquiry.via !== "test" &&
			recent.some(
				(r) =>
					r.data.destination === place.id &&
					r.data.email === enquiry.email &&
					Date.parse(r.data.createdAt) > now - DAY_MS &&
					!r.data.test,
			);
		if (twice) {
			row.status = "skipped";
			row.nextAt = "";
			row.notes.push("Same person within 24 hours");
		}
		rows.push({ id: deliveryId(id, place.id), data: row });
	}
	if (rows.length > 0) await deliveries(ctx).putMany(rows);

	const due = rows.filter((r) => r.data.status === "retrying");
	let delivered = 0;
	if (opts.inline) {
		for (const row of due.slice(0, PER_RUN)) {
			const after = await attempt(ctx, config, row.id, row.data);
			if (after.status === "delivered") delivered += 1;
		}
	}
	await finishEnquiry(ctx, id);
	if (opts.schedule !== false && (!opts.inline || due.length > PER_RUN)) await scheduleNext(ctx);
	return { duplicate: false, queued: due.length, delivered };
}

/** Send one enquiry to one place, without touching the log. */
export async function sendTo(
	ctx: PluginContext,
	place: Place,
	id: string,
	enquiry: Enquiry,
	test: boolean,
): Promise<Outcome & { ms: number }> {
	const started = Date.now();
	const done = (outcome: Outcome) => ({ ...outcome, ms: Date.now() - started });
	if (place.kind === "email") {
		if (!ctx.email) {
			return done({
				kind: "fixing",
				plain:
					"This site has no way to send email yet. Ask your web person to set up email for the site, then press Send again.",
			});
		}
		const [first, ...copies] = place.to ?? [];
		if (!first) return done({ kind: "fixing", plain: "This place has no email address." });
		const message = enquiryEmail(siteName(ctx), enquiry, test);
		try {
			await ctx.email.send({
				to: first,
				...(copies.length ? { cc: copies } : {}),
				...(enquiry.email ? { replyTo: enquiry.email } : {}),
				...message,
			});
			return done({ kind: "delivered" });
		} catch (error) {
			return done({ kind: "retry", raw: `The email could not be sent: ${String(error)}` });
		}
	}
	if (!ctx.http) return done({ kind: "retry", raw: "Web requests are not available." });
	const request =
		place.kind === "hubspot"
			? {
					url: submitUrl(place),
					init: {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(hubspotBody(place, enquiry)),
					},
				}
			: await appRequest(place, id, enquiry, test);
	try {
		const response = await ctx.http.fetch(request.url, request.init);
		const text = await response.text().catch(() => "");
		const outcome =
			place.kind === "hubspot"
				? classifyHubSpot(response.status, text)
				: classifyApp(place, response.status, response.url, text);
		const retryAfter = Number(response.headers.get("retry-after"));
		if (outcome.kind === "retry" && Number.isFinite(retryAfter) && retryAfter > 0) {
			outcome.retryAfter = Math.min(retryAfter, 86_400);
		}
		return done(outcome);
	} catch (error) {
		return done({ kind: "retry", raw: `No answer: ${String(error).slice(0, 200)}` });
	}
}

/** One try for one log row; updates the row, schedules the next try, alerts on failure. */
export async function attempt(
	ctx: PluginContext,
	config: Config,
	id: string,
	row: Delivery,
): Promise<Delivery> {
	const place = config.places.find((p) => p.id === row.destination);
	const stored = await enquiries(ctx).get(row.enquiryId);
	const enquiry = stored?.cleared ? null : stored;
	const now = Date.now();
	let next: Delivery;
	if (!place || !enquiry) {
		next = {
			...row,
			status: "gaveup",
			nextAt: "",
			plain: place
				? "The enquiry's contents are no longer here. It is still in Forms → Submissions."
				: "This place was deleted.",
		};
	} else {
		const outcome = await sendTo(ctx, place, row.enquiryId, enquiry, row.test === true);
		const attempts = row.attempts + 1;
		const { plain: _plain, raw: _raw, field: _field, ...rest } = row;
		const base = { ...rest, attempts, ms: outcome.ms };
		if (outcome.kind === "delivered") {
			next = { ...base, status: "delivered", nextAt: "", deliveredAt: new Date(now).toISOString() };
			if (row.test) await saveTested(ctx);
		} else if (outcome.kind === "fixing") {
			next = {
				...base,
				status: "fixing",
				nextAt: "",
				...(outcome.plain ? { plain: outcome.plain } : {}),
				...(outcome.raw ? { raw: outcome.raw } : {}),
				...(outcome.field ? { field: outcome.field } : {}),
			};
		} else if (attempts >= MAX_ATTEMPTS) {
			next = {
				...base,
				status: "gaveup",
				nextAt: "",
				plain: `${place.name} did not answer after ${MAX_ATTEMPTS} tries over two days. Check it is working, then press Send again.`,
				...(outcome.raw ? { raw: outcome.raw } : {}),
			};
		} else {
			const wait = Math.max(DELAYS_MIN[attempts - 1]! * 60, outcome.retryAfter ?? 0);
			next = {
				...base,
				status: "retrying",
				nextAt: new Date(now + wait * 1000).toISOString(),
				plain: "No answer yet; trying again.",
				...(outcome.raw ? { raw: outcome.raw } : {}),
			};
		}
	}
	await deliveries(ctx).put(id, next);
	if (next.status === "delivered" && !row.test) await finishEnquiry(ctx, row.enquiryId);
	if ((next.status === "fixing" || next.status === "gaveup") && !row.test) {
		await alertFailures(ctx, config);
	}
	return next;
}

async function saveTested(ctx: PluginContext) {
	const config = await loadConfig(ctx);
	if (config.testedAt) return;
	await ctx.kv.set("config", { ...config, testedAt: new Date().toISOString() });
}

/** Once every place has an enquiry, its contents go; the Forms inbox keeps the original. */
export async function finishEnquiry(ctx: PluginContext, enquiryId: string) {
	const enquiry = await enquiries(ctx).get(enquiryId);
	if (!enquiry || enquiry.cleared) return;
	const config = await loadConfig(ctx);
	const ids = config.places.map((p) => deliveryId(enquiryId, p.id));
	const mine = [...(await deliveries(ctx).getMany(ids)).values()];
	if (mine.some((d) => d.status === "retrying")) return;
	const allThere = mine.every((d) => d.status === "delivered" || d.status === "skipped");
	if (allThere && mine.length > 0 && enquiry.via !== "test") await count(ctx, "d");
	// The contents go; a bare record stays until cleanup so a repeat is still a no-op.
	if (allThere) {
		await enquiries(ctx).put(enquiryId, {
			formId: enquiry.formId,
			formName: enquiry.formName,
			receivedAt: enquiry.receivedAt,
			fields: [],
			via: enquiry.via,
			throwaway: false,
			hasFiles: false,
			cleared: true,
		});
	}
}

/** Due tries, three at a time, then the next one-shot run. */
export async function runDue(ctx: PluginContext): Promise<number> {
	const config = await loadConfig(ctx);
	const due = await deliveries(ctx).query({
		where: { status: "retrying", nextAt: { lte: new Date().toISOString() } },
		orderBy: { nextAt: "asc" },
		limit: PER_RUN,
	});
	for (const item of due.items) await attempt(ctx, config, item.id, item.data);
	await scheduleNext(ctx);
	return due.items.length;
}

/** A one-shot run at the earliest due try (at once if one is overdue). */
export async function scheduleNext(ctx: PluginContext) {
	if (!ctx.cron) return;
	const next = await deliveries(ctx).query({
		where: { status: "retrying" },
		orderBy: { nextAt: "asc" },
		limit: 1,
	});
	const first = next.items[0]?.data.nextAt;
	if (!first) return;
	const at = Math.max(Date.parse(first), Date.now() + 1000);
	await ctx.cron.schedule(DELIVER_TASK, { schedule: new Date(at).toISOString() });
}

/** Send an alert of this kind unless one went out today. Returns whether it was sent. */
export async function alertOnce(
	ctx: PluginContext,
	config: Config,
	kind: "failure" | "quiet" | "scheduler",
	message: { subject: string; text: string },
): Promise<boolean> {
	if (!ctx.email || config.alertTo.length === 0) return false;
	const sent = (await ctx.kv.get<Record<string, string>>(ALERTS_KEY)) ?? {};
	const today = day(new Date().toISOString());
	if (sent[kind] === today) return false;
	await ctx.kv.set(ALERTS_KEY, { ...sent, [kind]: today });
	const [to, ...cc] = config.alertTo;
	try {
		await ctx.email.send({ to: to!, ...(cc.length ? { cc } : {}), ...message });
		return true;
	} catch (error) {
		ctx.log.warn("could not send an alert", { kind, error: String(error) });
		return false;
	}
}

export async function needsFixing(ctx: PluginContext, limit = 10) {
	const [fixing, gaveup] = await Promise.all([
		deliveries(ctx).query({ where: { status: "fixing" }, orderBy: { createdAt: "desc" }, limit }),
		deliveries(ctx).query({ where: { status: "gaveup" }, orderBy: { createdAt: "desc" }, limit }),
	]);
	return [...fixing.items, ...gaveup.items].filter((item) => !item.data.test);
}

async function alertFailures(ctx: PluginContext, config: Config) {
	const rows = await needsFixing(ctx);
	if (rows.length === 0) return;
	await alertOnce(
		ctx,
		config,
		"failure",
		failureAlert(
			siteName(ctx),
			rows.map((r) => ({ delivery: r.data, place: placeName(config, r.data.destination) })),
		),
	);
}

/** A form that usually gets enquiries and has had none for 3 days. */
export function isQuiet(form: KnownForm, now = Date.now()): boolean {
	if (!form.lastAt) return false;
	if (now - Date.parse(form.lastAt) < 3 * DAY_MS) return false;
	const lastDay = day(form.lastAt);
	const from = day(new Date(Date.parse(form.lastAt) - 14 * DAY_MS).toISOString());
	return form.days.filter((d) => d >= from && d <= lastDay).length >= 3;
}

export function quietForms(forms: Record<string, KnownForm>, now = Date.now()): KnownForm[] {
	return Object.values(forms).filter((form) => isQuiet(form, now));
}

export async function checkQuiet(ctx: PluginContext, config: Config) {
	const forms = await loadForms(ctx);
	const fresh = quietForms(forms).filter((f) => f.quietAlertedFor !== f.lastAt);
	if (fresh.length === 0) return;
	const sent = await alertOnce(
		ctx,
		config,
		"quiet",
		quietAlert(
			siteName(ctx),
			fresh.map((f) => quietLine(f, since(f.lastAt!))),
		),
	);
	if (!sent) return;
	for (const form of fresh) forms[form.slug] = { ...form, quietAlertedFor: form.lastAt! };
	await saveForms(ctx, forms);
}

/** Retries are due but nothing has run them for 20 minutes. */
export async function schedulerStuck(ctx: PluginContext): Promise<boolean> {
	const overdue = await deliveries(ctx).count({
		status: "retrying",
		nextAt: { lte: new Date(Date.now() - 20 * 60_000).toISOString() },
	});
	if (overdue === 0) return false;
	const tick = await ctx.kv.get<string>(TICK_KEY);
	return !tick || Date.now() - Date.parse(tick) > 20 * 60_000;
}

export async function alertIfStuck(ctx: PluginContext, config: Config) {
	if (await schedulerStuck(ctx))
		await alertOnce(ctx, config, "scheduler", schedulerAlert(siteName(ctx)));
}

const SCHEDULE_KEY = "schedule";
const SCHEDULE = "* * * * *";

/**
 * The every-minute task that catches up. Made on activation, and again from an admin visit or
 * an arriving enquiry if it is missing. Never from inside the email hook (see plugin.ts).
 */
export async function ensureSchedule(ctx: PluginContext, force = false) {
	if (!ctx.cron) return;
	if (!force && (await ctx.kv.get<string>(SCHEDULE_KEY)) === SCHEDULE) return;
	await ctx.cron.schedule(MAINTENANCE_TASK, { schedule: SCHEDULE });
	await ctx.kv.set(SCHEDULE_KEY, SCHEDULE);
}

/** Every minute: catch up, and once a day check for quiet forms and clean up. */
export async function maintenance(ctx: PluginContext) {
	await ctx.kv.set(TICK_KEY, new Date().toISOString());
	await runDue(ctx);
	const today = day(new Date().toISOString());
	if ((await ctx.kv.get<string>(DAILY_KEY)) === today) return;
	await ctx.kv.set(DAILY_KEY, today);
	const config = await loadConfig(ctx);
	await checkQuiet(ctx, config);
	await cleanup(ctx);
}

/** Log rows and leftover enquiries older than 30 days go. */
export async function cleanup(ctx: PluginContext) {
	const before = new Date(Date.now() - KEEP_DAYS * DAY_MS).toISOString();
	const old = await deliveries(ctx).query({ where: { createdAt: { lt: before } }, limit: 100 });
	if (old.items.length) await deliveries(ctx).deleteMany(old.items.map((i) => i.id));
	const stale = await enquiries(ctx).query({ where: { receivedAt: { lt: before } }, limit: 100 });
	if (stale.items.length) await enquiries(ctx).deleteMany(stale.items.map((i) => i.id));
}

/** Try one log row again now (Send again / Send now). */
export async function sendAgain(ctx: PluginContext, id: string): Promise<Delivery | null> {
	const row = await deliveries(ctx).get(id);
	if (!row || row.status === "delivered" || row.status === "skipped") return row;
	const config = await loadConfig(ctx);
	return attempt(ctx, config, id, {
		...row,
		attempts: row.status === "retrying" ? row.attempts : 0,
	});
}
