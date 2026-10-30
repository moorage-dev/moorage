// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext, StorageCollection } from "emdash";

import { APPROVAL_PREFIX, isLiveApproval } from "./approval.js";
import {
	ALERTS_KEY,
	DAILY_KEY,
	day,
	kvOf,
	saveFormsQuietly,
	SCHEDULE_KEY,
	since,
	siteLabel,
	type State,
	type Stats,
	STATS_KEY,
	TICK_KEY,
} from "./config.js";
import { fieldsOf } from "./enquiry.js";
import { classifyHubSpot, hubspotBody, submitUrl, type Outcome } from "./hubspot.js";
import {
	enquiryEmail,
	failureAlert,
	quietAlert,
	quietLine,
	repeatNote,
	schedulerAlert,
} from "./messages.js";
import { type Meter, warnIfRoom } from "./meter.js";
import {
	type Config,
	type Delivery,
	type Enquiry,
	type KnownForm,
	NO_DELIVERY,
	type Send,
} from "./types.js";
import { appRequest, classifyApp } from "./webhook.js";

/**
 * How enquiries travel. On Cloudflare a sandboxed plugin may make only 10 calls to the site in
 * one run (meter.ts), and every send is one, so nothing is sent while an enquiry arrives: the
 * arrival stores it with a log row per delivery ("Trying again", due now) and asks for a run.
 * Runs (the every-minute task, the one-shot `deliver` task and its follow-ups) send what fits,
 * write the results, and leave the rest for a follow-up run. The queue is the log rows
 * themselves, so nothing waits anywhere else (0.3.1 delivers the same rows after a rollback).
 */
export const DELIVER_TASK = "deliver";
export const MAINTENANCE_TASK = "maintenance";
/** The once-a-day work (quiet forms, cleanup), with a run of its own. */
export const DAILY_TASK = "daily";
export { STATS_KEY };

/** Waits after each failed try: 8 tries over about 45 hours. */
export const DELAYS_MIN = [1, 5, 30, 120, 360, 720, 1440];
export const MAX_ATTEMPTS = DELAYS_MIN.length + 1;
/** Log rows read per run; how many are sent depends on the calls left. */
const BATCH = 8;
const DAY_MS = 86_400_000;
export const KEEP_DAYS = 30;
/** The every-minute task counts as stopped after this long without a run. */
const STUCK_MS = 20 * 60_000;

/** The log and retry queue. The storage keeps its 0.1 name, so the log survives the update. */
export function sends(ctx: PluginContext): StorageCollection<Send> {
	return ctx.storage.deliveries as StorageCollection<Send>;
}

export function enquiries(ctx: PluginContext): StorageCollection<Enquiry> {
	return ctx.storage.enquiries as StorageCollection<Enquiry>;
}

export function sendId(enquiryId: string, deliveryId: string): string {
	return `${enquiryId}~${deliveryId}`;
}

export function servesForm(delivery: Delivery, formId: string): boolean {
	return delivery.forms === "all" || delivery.forms.includes(formId);
}

export function deliveryName(config: Config, id: string): string {
	if (id === NO_DELIVERY) return "no delivery";
	return config.deliveries.find((d) => d.id === id)?.name ?? "a delivery that was deleted";
}

/** A one-shot run of `DELIVER_TASK` (inbound) or of a follow-up, which has a name of its own. */
export function isDeliverTask(name: string): boolean {
	return name === DELIVER_TASK || name.startsWith(`${DELIVER_TASK}-`);
}

/**
 * A form is connected once it was marked so, or once an enquiry came from it, after the private
 * address was last reset (`keySetAt`): a reset disconnects every form.
 */
export function isConnected(form: KnownForm | undefined, keySetAt?: string): boolean {
	const at = [form?.connectedAt, form?.lastAt]
		.filter((x): x is string => Boolean(x))
		.sort()
		.at(-1);
	return Boolean(at) && (!keySetAt || at! > keySetAt);
}

const REPEAT_MS = { off: 0, "24h": DAY_MS, "7d": 7 * DAY_MS } as const;
const REPEAT_WORDS = { off: "", "24h": "24 hours", "7d": "7 days" } as const;

/** The daily counts with `what` raised by `by` today, two weeks kept. */
function counted(state: State, what: "r" | "d", by: number): Stats {
	const stats: Stats = { ...kvOf<Stats>(state, STATS_KEY) };
	const today = day(new Date().toISOString());
	const entry = { ...(stats[today] ?? { r: 0, d: 0 }) };
	entry[what] += by;
	stats[today] = entry;
	const keep = Object.keys(stats).sort().slice(-14);
	return Object.fromEntries(keep.map((k) => [k, stats[k]!]));
}

async function count(ctx: PluginContext, state: State, what: "r" | "d", by = 1) {
	const stats = counted(state, what, by);
	await ctx.kv.set(STATS_KEY, stats);
	state.entries.set(STATS_KEY, stats);
}

/** Received and delivered enquiries in the last 7 days (tests excluded). */
export function weekCounts(state: State): { received: number; delivered: number } {
	const stats = kvOf<Stats>(state, STATS_KEY) ?? {};
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

/** The forms with this one remembered: its name, its fields, when it last sent, how it is connected. */
function noteForm(forms: Record<string, KnownForm>, enquiry: Enquiry): Record<string, KnownForm> {
	const now = enquiry.receivedAt;
	const known = forms[enquiry.formId];
	const fields = fieldsOf(enquiry);
	const days = [...new Set([...(known?.days ?? []), day(now)])].slice(-30);
	const way = enquiry.via === "email" ? "email" : "straight";
	return {
		...forms,
		[enquiry.formId]: known
			? {
					...known,
					name: enquiry.formName || known.name,
					...(known.source === "enquiry" || known.fields.length === 0 ? { fields } : {}),
					lastAt: now,
					days,
					connectedAt: known.connectedAt ?? now,
					// What actually arrives wins over a connection marked by hand.
					connectedWay: way,
				}
			: {
					slug: enquiry.formId,
					name: enquiry.formName,
					fields,
					source: "enquiry",
					addedAt: now,
					lastAt: now,
					days,
					connectedAt: now,
					connectedWay: way,
				},
	};
}

/** Recent log rows for one form, newest first, to spot the same person sending again. */
async function recentForForm(ctx: PluginContext, formId: string, sinceMs: number) {
	const result = await sends(ctx).query({
		where: { formId, createdAt: { gte: new Date(sinceMs).toISOString() } },
		orderBy: { createdAt: "desc" },
		limit: 100,
	});
	return result.items;
}

export interface ReceiveResult {
	duplicate: boolean;
	/** Log rows waiting for a run ("Trying again"). */
	queued: number;
}

/**
 * Store an enquiry once, with a log row for every delivery of its form: due now, or "Not sent"
 * with the reason (turned off, a held repeat, possibly spam) and Send again. An enquiry no
 * delivery takes gets a "Not sent" row too, so the owner sees it arrived. Nothing is sent here.
 *
 * At most 5 calls: the recent rows (only with an email address), the enquiry, its rows, the
 * known forms and the week's count. The enquiry and its rows go first: a run cut short after
 * them loses only the form's last-seen time and the count, never the enquiry.
 */
export async function receive(
	ctx: PluginContext,
	state: State,
	id: string,
	enquiry: Enquiry,
): Promise<ReceiveResult> {
	const now = Date.now();
	const config = state.config;
	const recent = enquiry.email ? await recentForForm(ctx, enquiry.formId, now - 7 * DAY_MS) : [];
	const previous = recent.find((r) => r.data.email === enquiry.email && !r.data.test);
	if (previous) {
		enquiry.repeatAfterMs = Math.max(0, now - Date.parse(previous.data.createdAt));
	}

	const createdAt = new Date(now).toISOString();
	const who = enquiry.name ?? enquiry.email ?? "Someone";
	const repeat = enquiry.repeatAfterMs !== undefined ? repeatNote(enquiry.repeatAfterMs) : "";
	const notes: string[] = [];
	if (enquiry.throwaway) notes.push("Possibly fake address");
	if (repeat) notes.push(repeat);
	if (enquiry.spam) notes.push("Possibly spam");
	if (enquiry.unreadable) notes.push("Sent as text: its fields could not be read");
	if (enquiry.hasFiles) notes.push("Has an attachment, see Forms → Submissions");

	const base = {
		enquiryId: id,
		formId: enquiry.formId,
		formName: enquiry.formName,
		who,
		...(enquiry.email ? { email: enquiry.email } : {}),
		attempts: 0,
		createdAt,
	};
	const rows: Array<{ id: string; data: Send }> = [];
	for (const delivery of config.deliveries.filter((d) => servesForm(d, enquiry.formId))) {
		const row: Send = {
			...base,
			destination: delivery.id,
			status: "retrying",
			nextAt: createdAt,
			notes: [...notes],
		};
		const hold = (replace: string, note: string) => {
			row.status = "skipped";
			row.nextAt = "";
			row.held = true;
			const at = replace ? row.notes.indexOf(replace) : -1;
			if (at >= 0) row.notes[at] = note;
			else row.notes.push(note);
		};
		const window = REPEAT_MS[delivery.repeat];
		const twice =
			window > 0 &&
			enquiry.email &&
			recent.some(
				(r) =>
					r.data.destination === delivery.id &&
					r.data.email === enquiry.email &&
					Date.parse(r.data.createdAt) > now - window &&
					!r.data.test,
			);
		if (!delivery.on) hold("", "Turned off; not sent");
		else if (twice) {
			const earlier = recent.find(
				(r) => r.data.destination === delivery.id && r.data.email === enquiry.email && !r.data.test,
			);
			const note = earlier ? repeatNote(now - Date.parse(earlier.data.createdAt)) : repeat;
			hold(repeat, `${note}; not sent: repeats are off for ${REPEAT_WORDS[delivery.repeat]}`);
		} else if (enquiry.spam && delivery.holdSpam) {
			hold("Possibly spam", "Possibly spam; not sent");
		}
		rows.push({ id: sendId(id, delivery.id), data: row });
	}
	if (rows.length === 0) {
		rows.push({
			id: sendId(id, NO_DELIVERY),
			data: {
				...base,
				destination: NO_DELIVERY,
				status: "skipped",
				nextAt: "",
				// Held, so its contents stay until the form is added to a delivery (adoptForm).
				held: true,
				notes: [...notes, "No delivery for this form; not sent"],
			},
		});
	}

	const created = await enquiries(ctx).compareAndSet(id, null, {
		...enquiry,
		rows: rows.map((r) => r.data.destination),
	});
	if (!created.applied) return { duplicate: true, queued: 0 };
	await sends(ctx).putMany(rows);
	state.forms = noteForm(state.forms, enquiry);
	await saveFormsQuietly(ctx, state.forms);
	await count(ctx, state, "r");
	return { duplicate: false, queued: rows.filter((r) => r.data.status === "retrying").length };
}

/**
 * Ask for a delivery run now. From an arriving enquiry, a fixed name (`DELIVER_TASK`); from a
 * run, a name of its own: EmDash deletes a one-shot task once its run ends, so a run that asked
 * for itself again would be lost. `alert`: the run starts with the failure alert this one had
 * no calls left for.
 */
export async function scheduleDelivery(
	ctx: PluginContext,
	opts: { followUp?: boolean; alert?: boolean } = {},
) {
	if (!ctx.cron) return;
	const name = opts.followUp
		? `${DELIVER_TASK}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
		: DELIVER_TASK;
	await ctx.cron.schedule(name, {
		schedule: new Date(Date.now() + 1000).toISOString(),
		...(opts.alert ? { data: { alert: true } } : {}),
	});
}

/**
 * What a failed email send means. "Email is not configured" from the sandbox, when the site has an
 * email service (ctx.email is there), is the EmDash 1.3.x bug on Cloudflare: plugins installed from
 * the registry could not use it at all (fixed in 1.4.0, emdash-cms/emdash#4281). Trying again
 * cannot help, so it needs a person. Anything else is the email service and is tried again.
 */
export function emailFailure(error: unknown): Outcome {
	const message = error instanceof Error ? error.message : String(error);
	if (/^email is not configured/i.test(message)) {
		return {
			kind: "fixing",
			plain:
				"Your site has an email service, but this plugin could not use it: on Cloudflare, plugins installed from the EmDash registry can send email from EmDash 1.4.0 on. Ask your web person to update EmDash, then press Send again.",
		};
	}
	return { kind: "retry", raw: `The email could not be sent: ${String(error)}` };
}

/** Send one enquiry through one delivery, without touching the log. One call. */
export async function sendTo(
	ctx: PluginContext,
	state: State,
	delivery: Delivery,
	id: string,
	enquiry: Enquiry,
	test: boolean,
): Promise<Outcome & { ms: number }> {
	const started = Date.now();
	const done = (outcome: Outcome) => ({ ...outcome, ms: Date.now() - started });
	if (delivery.kind === "email") {
		if (!ctx.email) {
			return done({
				kind: "fixing",
				plain:
					"This site has no way to send email yet. Ask your web person to set up email for the site, then press Send again.",
			});
		}
		const [first, ...copies] = delivery.to ?? [];
		if (!first) return done({ kind: "fixing", plain: "This delivery has no email address." });
		const message = enquiryEmail(siteLabel(ctx, state), enquiry, test);
		try {
			await ctx.email.send({
				to: first,
				...(copies.length ? { cc: copies } : {}),
				...(enquiry.email ? { replyTo: enquiry.email } : {}),
				...message,
			});
			return done({ kind: "delivered" });
		} catch (error) {
			return done(emailFailure(error));
		}
	}
	if (!ctx.http) return done({ kind: "retry", raw: "Web requests are not available." });
	const request =
		delivery.kind === "hubspot"
			? {
					url: submitUrl(delivery),
					init: {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(hubspotBody(delivery, enquiry)),
					},
				}
			: await appRequest(delivery, id, enquiry, test);
	try {
		const response = await ctx.http.fetch(request.url, request.init);
		const text = await response.text().catch(() => "");
		const outcome =
			delivery.kind === "hubspot"
				? classifyHubSpot(response.status, text, delivery.name)
				: classifyApp(delivery, response.status, response.url, text);
		const retryAfter = Number(response.headers.get("retry-after"));
		if (outcome.kind === "retry" && Number.isFinite(retryAfter) && retryAfter > 0) {
			outcome.retryAfter = Math.min(retryAfter, 86_400);
		}
		return done(outcome);
	} catch (error) {
		return done({ kind: "retry", raw: `No answer: ${String(error).slice(0, 200)}` });
	}
}

/** Whether a try for this row makes a call: its delivery and its contents are both still here. */
function sendable(config: Config, row: Send, enquiry: Enquiry | null | undefined): boolean {
	return Boolean(
		config.deliveries.some((d) => d.id === row.destination) && enquiry && !enquiry.cleared,
	);
}

/** The log row after one try: sent, needs fixing, tried again later, or given up. */
async function tryRow(
	ctx: PluginContext,
	state: State,
	row: Send,
	stored: Enquiry | null | undefined,
): Promise<Send> {
	const config = state.config;
	const delivery = config.deliveries.find((d) => d.id === row.destination);
	const enquiry = stored && !stored.cleared ? stored : null;
	const now = Date.now();
	if (!delivery || !enquiry) {
		return {
			...row,
			status: "gaveup",
			nextAt: "",
			plain: delivery
				? "The enquiry's contents are no longer here. It is still in Forms → Submissions."
				: "This delivery was deleted.",
		};
	}
	const outcome = await sendTo(ctx, state, delivery, row.enquiryId, enquiry, row.test === true);
	const attempts = row.attempts + 1;
	const { plain: _plain, raw: _raw, field: _field, held: _held, ...rest } = row;
	const base = { ...rest, attempts, ms: outcome.ms };
	if (outcome.kind === "delivered") {
		return { ...base, status: "delivered", nextAt: "", deliveredAt: new Date(now).toISOString() };
	}
	if (outcome.kind === "fixing") {
		return {
			...base,
			status: "fixing",
			nextAt: "",
			...(outcome.plain ? { plain: outcome.plain } : {}),
			...(outcome.raw ? { raw: outcome.raw } : {}),
			...(outcome.field ? { field: outcome.field } : {}),
		};
	}
	if (attempts >= MAX_ATTEMPTS) {
		return {
			...base,
			status: "gaveup",
			nextAt: "",
			plain: `"${delivery.name}" did not answer after ${MAX_ATTEMPTS} tries over two days. Check it is working, then press Send again.`,
			...(outcome.raw ? { raw: outcome.raw } : {}),
		};
	}
	const wait = Math.max(DELAYS_MIN[attempts - 1]! * 60, outcome.retryAfter ?? 0);
	return {
		...base,
		status: "retrying",
		nextAt: new Date(now + wait * 1000).toISOString(),
		plain: "No answer yet; trying again.",
		...(outcome.raw ? { raw: outcome.raw } : {}),
	};
}

/** The ids of every log row an enquiry may have, besides those listed in `with`. */
function siblingIds(config: Config, enquiryId: string, enquiry: Enquiry, also: string[]): string[] {
	const destinations = enquiry.rows ?? [...config.deliveries.map((d) => d.id), NO_DELIVERY];
	return [...new Set([...destinations.map((d) => sendId(enquiryId, d)), ...also])];
}

interface Tried {
	id: string;
	row: Send;
}

/**
 * The enquiries the tried rows may finish, and the log rows still to be read to tell. An
 * enquiry with a row known to be waiting cannot finish this run, so its other rows are not read.
 */
function finishing(
	config: Config,
	tried: Tried[],
	known: Map<string, Send>,
	stored: Map<string, Enquiry>,
): { candidates: string[]; unread: string[] } {
	const candidates: string[] = [];
	const unread = new Set<string>();
	for (const enquiryId of new Set(tried.map((t) => t.row.enquiryId))) {
		const enquiry = stored.get(enquiryId);
		if (!enquiry || enquiry.cleared) continue;
		const mine = [...known.entries()].filter(([, s]) => s.enquiryId === enquiryId);
		if (mine.some(([, s]) => s.status === "retrying")) continue;
		candidates.push(enquiryId);
		for (const id of siblingIds(
			config,
			enquiryId,
			enquiry,
			mine.map(([rowId]) => rowId),
		))
			if (!known.has(id)) unread.add(id);
	}
	return { candidates, unread: [...unread] };
}

/**
 * Write what the tries did: the log rows, then (once every delivery is done with an enquiry)
 * its contents go and it counts as delivered, then the failure alert. Each write is one call:
 * the rows, the other rows of a finishing enquiry when they are not known yet, the enquiries,
 * the count, and the alert (email, then the day it went out) or the follow-up run that sends it.
 */
async function record(
	m: Meter,
	state: State,
	tried: Tried[],
	known: Map<string, Send>,
	stored: Map<string, Enquiry>,
): Promise<{ alertLeft: boolean }> {
	const ctx = m.ctx;
	if (tried.length === 0) return { alertLeft: false };
	await sends(ctx).putMany(tried.map((t) => ({ id: t.id, data: t.row })));

	const { candidates, unread } = finishing(state.config, tried, known, stored);
	const all = new Map(known);
	if (candidates.length > 0 && unread.length > 0) {
		for (const [id, row] of await sends(ctx).getMany(unread)) all.set(id, row);
	}
	const updates: Array<{ id: string; data: Enquiry }> = [];
	let delivered = 0;
	for (const enquiryId of candidates) {
		const enquiry = stored.get(enquiryId)!;
		const mine = [...all.values()].filter((s) => s.enquiryId === enquiryId);
		if (mine.some((s) => s.status === "retrying")) continue;
		const sent = mine.filter((s) => s.status === "delivered").length;
		const settled = mine.every((s) => s.status === "delivered" || s.status === "skipped");
		let isCounted = enquiry.counted === true;
		if (!isCounted && settled && sent > 0 && enquiry.via !== "test") {
			delivered += 1;
			isCounted = true;
		}
		const done = mine.every((s) => s.status === "delivered" || (s.status === "skipped" && !s.held));
		// The contents go; a bare record stays until cleanup so a repeat is still a no-op.
		if (done) {
			updates.push({
				id: enquiryId,
				data: {
					formId: enquiry.formId,
					formName: enquiry.formName,
					receivedAt: enquiry.receivedAt,
					fields: [],
					via: enquiry.via,
					throwaway: false,
					hasFiles: false,
					cleared: true,
					...(isCounted ? { counted: true } : {}),
				},
			});
		} else if (isCounted && !enquiry.counted) {
			updates.push({ id: enquiryId, data: { ...enquiry, counted: true } });
		}
	}
	if (updates.length > 0) await enquiries(ctx).putMany(updates);
	if (delivered > 0) await count(ctx, state, "d", delivered);

	const failed = tried.filter(
		(t) => !t.row.test && (t.row.status === "fixing" || t.row.status === "gaveup"),
	);
	if (failed.length === 0 || !canAlert(ctx, state, "failure")) return { alertLeft: false };
	if (m.left() < 2) return { alertLeft: true };
	await sendAlert(
		m,
		state,
		"failure",
		failureAlert(
			siteLabel(ctx, state),
			failed.map((t) => ({ send: t.row, name: deliveryName(state.config, t.row.destination) })),
		),
	);
	return { alertLeft: false };
}

/**
 * Due tries, as many as the calls left allow, oldest first. A run that leaves work (more due
 * tries, or an alert it had no calls for) asks for a follow-up run. Every call it makes is
 * counted: reads (due rows, their enquiries), one per send, and the writes `record` needs.
 */
export async function runBatch(m: Meter, state: State): Promise<{ sent: number; more: boolean }> {
	const ctx = m.ctx;
	// The due rows, their enquiries, and a follow-up when nothing fits.
	if (m.left() < 3) return { sent: 0, more: true };
	const due = await sends(ctx).query({
		where: { status: "retrying", nextAt: { lte: new Date().toISOString() } },
		orderBy: { nextAt: "asc" },
		limit: BATCH,
	});
	if (due.items.length === 0) return { sent: 0, more: false };
	const ids = [...new Set(due.items.map((item) => item.data.enquiryId))];
	const stored = new Map<string, Enquiry>();
	for (const [id, enquiry] of await enquiries(ctx).getMany(ids)) stored.set(id, enquiry);
	const config = state.config;
	const alertable = canAlert(ctx, state, "failure");

	// Plan: add rows while their sends and every write they may need still fit.
	const batch = new Map(due.items.map((item) => [item.id, item.data]));
	const planned: typeof due.items = [];
	for (const item of due.items) {
		const next = [...planned, item];
		const calls = next.filter((p) => sendable(config, p.data, stored.get(p.data.enquiryId))).length;
		const real = next.some((p) => !p.data.test);
		// As if every planned row were done: the most rows a finishing enquiry may need read.
		const assumed = new Map(batch);
		for (const p of next) assumed.set(p.id, { ...p.data, status: "delivered" });
		const ahead = finishing(
			config,
			next.map((p) => ({ id: p.id, row: assumed.get(p.id)! })),
			assumed,
			stored,
		);
		const left = due.items.length > next.length || Boolean(due.hasMore);
		const writes =
			1 + // the rows
			(ahead.candidates.length > 0 && ahead.unread.length > 0 ? 1 : 0) + // other rows of an enquiry
			1 + // the enquiries
			(real ? 1 : 0) + // the week's count
			(left || (alertable && real) ? 1 : 0); // a follow-up (more to do, or the alert)
		if (calls + writes > m.left()) break;
		planned.push(item);
	}
	if (planned.length === 0) {
		await scheduleDelivery(ctx, { followUp: true });
		return { sent: 0, more: true };
	}

	const known = new Map(due.items.map((d) => [d.id, d.data]));
	const tried: Tried[] = [];
	let sent = 0;
	for (const item of planned) {
		const enquiry = stored.get(item.data.enquiryId);
		const row = await tryRow(ctx, state, item.data, enquiry);
		if (sendable(config, item.data, enquiry)) sent += 1;
		tried.push({ id: item.id, row });
		known.set(item.id, row);
	}
	const { alertLeft } = await record(m, state, tried, known, stored);
	const more = due.items.length > planned.length || Boolean(due.hasMore);
	if ((more || alertLeft) && m.left() >= 1) {
		await scheduleDelivery(ctx, { followUp: true, alert: alertLeft });
	}
	return { sent, more };
}

/**
 * Try one log row again now (Send again, Send now). A held "Not sent" row is sent now too.
 * At most 8 calls with the one that read the setup: the row, its enquiry, the send, and
 * `record`'s writes.
 */
export async function sendAgain(m: Meter, state: State, id: string): Promise<Send | null> {
	const ctx = m.ctx;
	const row = await sends(ctx).get(id);
	if (!row || row.status === "delivered" || row.destination === NO_DELIVERY) return row;
	if (row.status === "skipped" && !row.held) return row;
	const prepared: Send = {
		...row,
		// A held row is sent after all: its "not sent" reason no longer applies.
		notes: row.notes
			.filter((note) => note !== "Turned off; not sent")
			.map((note) => note.split("; not sent")[0]!),
		attempts: row.status === "retrying" ? row.attempts : 0,
	};
	const enquiry = await enquiries(ctx).get(row.enquiryId);
	const stored = new Map<string, Enquiry>(enquiry ? [[row.enquiryId, enquiry]] : []);
	const after = await tryRow(ctx, state, prepared, enquiry);
	const { alertLeft } = await record(
		m,
		state,
		[{ id, row: after }],
		new Map([[id, after]]),
		stored,
	);
	if (alertLeft && m.left() >= 1) await scheduleDelivery(ctx, { followUp: true, alert: true });
	return after;
}

/** An alert of this kind may go out: email works, someone is listed, and none went out today. */
export function canAlert(
	ctx: PluginContext,
	state: State,
	kind: "failure" | "quiet" | "scheduler",
): boolean {
	if (!ctx.email || state.config.alertTo.length === 0) return false;
	const sent = kvOf<Record<string, string>>(state, ALERTS_KEY) ?? {};
	return sent[kind] !== day(new Date().toISOString());
}

/**
 * Send an alert, then note the day it went out: a send that fails is tried again by the next
 * run that finds the problem. Two calls (three when it fails and a call is left to log it).
 */
export async function sendAlert(
	m: Meter,
	state: State,
	kind: "failure" | "quiet" | "scheduler",
	message: { subject: string; text: string },
): Promise<boolean> {
	const ctx = m.ctx;
	if (!ctx.email || !canAlert(ctx, state, kind)) return false;
	const [to, ...cc] = state.config.alertTo;
	try {
		await ctx.email.send({ to: to!, ...(cc.length ? { cc } : {}), ...message });
	} catch (error) {
		warnIfRoom(m, "could not send an alert", { kind, error: String(error) });
		return false;
	}
	const sent = {
		...kvOf<Record<string, string>>(state, ALERTS_KEY),
		[kind]: day(new Date().toISOString()),
	};
	await ctx.kv.set(ALERTS_KEY, sent);
	state.entries.set(ALERTS_KEY, sent);
	return true;
}

/** Real (not test) sends that need the owner: refused, or given up on. One call. */
export async function needsFixing(ctx: PluginContext, limit = 10, destination?: string) {
	const result = await sends(ctx).query({
		where: { status: { in: ["fixing", "gaveup"] }, ...(destination ? { destination } : {}) },
		orderBy: { createdAt: "desc" },
		limit: limit + 10,
	});
	return result.items.filter((item) => !item.data.test).slice(0, limit);
}

/** The failure alert a run had no calls left for. Four calls with the follow-up's first read. */
async function alertLeftOver(m: Meter, state: State) {
	if (!canAlert(m.ctx, state, "failure")) return;
	const rows = await needsFixing(m.ctx);
	if (rows.length === 0) return;
	await sendAlert(
		m,
		state,
		"failure",
		failureAlert(
			siteLabel(m.ctx, state),
			rows.map((r) => ({ send: r.data, name: deliveryName(state.config, r.data.destination) })),
		),
	);
}

/** A run of `DELIVER_TASK` or a follow-up. */
export async function deliverRun(m: Meter, state: State, data: unknown) {
	if (typeof data === "object" && data !== null && (data as { alert?: unknown }).alert === true)
		await alertLeftOver(m, state);
	await runBatch(m, state);
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

/** Whether the every-minute task ran in the last 20 minutes. */
export function tickFresh(state: State, now = Date.now()): boolean {
	const tick = kvOf<string>(state, TICK_KEY);
	return Boolean(tick) && now - Date.parse(tick!) <= STUCK_MS;
}

/** Retries are due but nothing has run them for 20 minutes, from rows already read. */
export function schedulerStuck(state: State, retrying: Send[], now = Date.now()): boolean {
	if (tickFresh(state, now)) return false;
	return retrying.some((row) => row.nextAt && Date.parse(row.nextAt) <= now - STUCK_MS);
}

/**
 * After an enquiry arrived: if the every-minute task has stopped and tries are overdue, tell the
 * alert list (nothing can deliver until it runs again). Three calls, only then.
 */
export async function alertIfStuck(m: Meter, state: State) {
	if (tickFresh(state) || !canAlert(m.ctx, state, "scheduler") || m.left() < 3) return;
	const overdue = await sends(m.ctx).count({
		status: "retrying",
		nextAt: { lte: new Date(Date.now() - STUCK_MS).toISOString() },
	});
	if (overdue > 0) await sendAlert(m, state, "scheduler", schedulerAlert(siteLabel(m.ctx, state)));
}

export const SCHEDULE = "* * * * *";

/**
 * The every-minute task that runs the queue. Made on activation, and again from an admin visit
 * or an arriving enquiry if it is missing. Never from inside the email hook (see plugin.ts).
 * Two calls when it is made.
 */
export async function ensureSchedule(ctx: PluginContext, state: State, force = false) {
	if (!ctx.cron) return;
	if (!force && kvOf<string>(state, SCHEDULE_KEY) === SCHEDULE) return;
	await ctx.cron.schedule(MAINTENANCE_TASK, { schedule: SCHEDULE });
	await ctx.kv.set(SCHEDULE_KEY, SCHEDULE);
	state.entries.set(SCHEDULE_KEY, SCHEDULE);
}

/**
 * Every minute: note that the scheduler runs, ask for the day's work once a day (it has a run
 * of its own), deliver what fits, and throw away approval codes that ran out with any calls
 * left (a code waits 15 minutes at most).
 */
export async function maintenance(m: Meter, state: State) {
	const ctx = m.ctx;
	const now = new Date().toISOString();
	await ctx.kv.set(TICK_KEY, now);
	state.entries.set(TICK_KEY, now);
	if (kvOf<string>(state, DAILY_KEY) !== day(now) && ctx.cron) {
		await ctx.cron.schedule(DAILY_TASK, { schedule: new Date(Date.now() + 1000).toISOString() });
	}
	await runBatch(m, state);
	for (const [key, value] of state.entries) {
		if (m.left() < 1) break;
		if (!key.startsWith(APPROVAL_PREFIX) || isLiveApproval(value)) continue;
		await ctx.kv.delete(key);
		state.entries.delete(key);
	}
}

/**
 * Once a day: alert about forms that went quiet, and delete log rows and leftover enquiries
 * older than 30 days (100 of each a day). The day is marked done only after all of it, so a run
 * cut short is done again by the next one. At most 9 calls.
 */
export async function daily(m: Meter, state: State) {
	const ctx = m.ctx;
	const today = day(new Date().toISOString());
	if (kvOf<string>(state, DAILY_KEY) === today) return;
	await checkQuiet(m, state);
	if (!(await cleanup(m))) return;
	if (m.left() < 1) return;
	await ctx.kv.set(DAILY_KEY, today);
}

async function checkQuiet(m: Meter, state: State) {
	const fresh = quietForms(state.forms).filter((f) => f.quietAlertedFor !== f.lastAt);
	if (fresh.length === 0 || m.left() < 3) return;
	const sent = await sendAlert(
		m,
		state,
		"quiet",
		quietAlert(
			siteLabel(m.ctx, state),
			fresh.map((f) => quietLine(f, since(f.lastAt!))),
		),
	);
	if (!sent || m.left() < 1) return;
	const forms = { ...state.forms };
	for (const form of fresh) forms[form.slug] = { ...form, quietAlertedFor: form.lastAt! };
	state.forms = forms;
	await saveFormsQuietly(m.ctx, forms);
}

/** Log rows and leftover enquiries older than 30 days go. Returns whether it got through. */
export async function cleanup(m: Meter): Promise<boolean> {
	const ctx = m.ctx;
	const before = new Date(Date.now() - KEEP_DAYS * DAY_MS).toISOString();
	if (m.left() < 2) return false;
	const old = await sends(ctx).query({ where: { createdAt: { lt: before } }, limit: 100 });
	if (old.items.length) await sends(ctx).deleteMany(old.items.map((i) => i.id));
	if (m.left() < 2) return false;
	const stale = await enquiries(ctx).query({ where: { receivedAt: { lt: before } }, limit: 100 });
	if (stale.items.length) await enquiries(ctx).deleteMany(stale.items.map((i) => i.id));
	return true;
}

const NO_DELIVERY_NOTE = "No delivery for this form; not sent";

/** Enquiries no delivery took, by form: the forms the owner may have meant. One call. */
export async function notSentForms(
	ctx: PluginContext,
): Promise<Array<{ formId: string; formName: string; count: number }>> {
	const held = await sends(ctx).query({
		where: { destination: NO_DELIVERY, status: "skipped" },
		orderBy: { createdAt: "desc" },
		limit: 200,
	});
	const byForm = new Map<string, { formId: string; formName: string; count: number }>();
	for (const item of held.items) {
		const entry = byForm.get(item.data.formId) ?? {
			formId: item.data.formId,
			formName: item.data.formName,
			count: 0,
		};
		entry.count += 1;
		byForm.set(item.data.formId, entry);
	}
	return [...byForm.values()];
}

/**
 * Move the enquiries that arrived from a form while no delivery took it to `delivery`, due now,
 * and ask for a run. A row already moved (an earlier press whose answer was lost) is never
 * moved again, so nothing is sent twice. Returns how many are on their way and the form's name.
 * Four calls, five with the run.
 */
export async function adoptHeld(
	ctx: PluginContext,
	formId: string,
	delivery: Delivery,
): Promise<{ count: number; formName?: string }> {
	const held = await sends(ctx).query({ where: { destination: NO_DELIVERY, formId }, limit: 50 });
	if (held.items.length === 0) return { count: 0 };
	const formName = held.items[0]!.data.formName;
	const targets = held.items.map((item) => sendId(item.data.enquiryId, delivery.id));
	const existing = await sends(ctx).getMany(targets);
	const now = new Date().toISOString();
	const moved = held.items
		.filter((item) => !existing.has(sendId(item.data.enquiryId, delivery.id)))
		.map((item) => {
			const { held: _held, ...rest } = item.data;
			return {
				id: sendId(item.data.enquiryId, delivery.id),
				data: {
					...rest,
					destination: delivery.id,
					status: "retrying" as const,
					nextAt: now,
					notes: rest.notes.filter((note) => note !== NO_DELIVERY_NOTE),
				},
			};
		});
	if (moved.length > 0) await sends(ctx).putMany(moved);
	await sends(ctx).deleteMany(held.items.map((item) => item.id));
	if (moved.length > 0) await scheduleDelivery(ctx);
	return { count: moved.length, formName };
}

/**
 * Send all failed again: their rows are due now and a run sends them. A row is moved only from
 * "Needs fixing" or "Gave up", so pressing twice sends nothing twice. Three calls.
 */
export async function queueFailed(ctx: PluginContext, destination?: string): Promise<number> {
	const rows = await needsFixing(ctx, 10, destination);
	if (rows.length === 0) return 0;
	const now = new Date().toISOString();
	await sends(ctx).putMany(
		rows.map((item) => {
			const { plain: _plain, raw: _raw, field: _field, held: _held, ...rest } = item.data;
			return {
				id: item.id,
				data: { ...rest, status: "retrying" as const, nextAt: now, attempts: 0 },
			};
		}),
	);
	await scheduleDelivery(ctx);
	return rows.length;
}
