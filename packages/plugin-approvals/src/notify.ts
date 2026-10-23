// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { approverRole, type Config } from "./config.js";
import type { Meter } from "./meter.js";
import { approverPageFor, personName, type ApprovalRequest, when } from "./requests.js";

/** A request email is sent at most once a day per page, however often Publish is pressed. */
export const EMAIL_EVERY_MS = 24 * 60 * 60 * 1000;
export const REMIND_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/** The cron task that sends queued emails. */
export const SEND_TASK = "send";
/** A failed email is tried this many times in all, this far apart. */
export const MAIL_TRIES = 3;
export const RETRY_AFTER_MS = 5 * 60 * 1000;
/** Pages of people read for one email, at most (100 each). */
const MAX_PAGES = 20;

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The site's name for subjects. EmDash reads it when the site starts, so a site named
 * during setup has no name here until its next restart; its address stands in.
 */
export function siteName(ctx: PluginContext): string {
	const name = ctx.site.name?.trim();
	if (name) return name;
	try {
		return new URL(ctx.site.url).host || "Your site";
	} catch {
		return "Your site";
	}
}

function siteRoot(ctx: PluginContext): string | null {
	const url = ctx.site.url?.replace(/\/+$/, "") ?? "";
	return /^https?:\/\//.test(url) ? url : null;
}

export function approvalsUrl(ctx: PluginContext): string | null {
	const root = siteRoot(ctx);
	return root ? `${root}/_emdash/admin/plugins/${ctx.plugin.id}/overview` : null;
}

export function pageUrl(ctx: PluginContext, collection: string, id: string): string | null {
	const root = siteRoot(ctx);
	return root
		? `${root}/_emdash/admin/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`
		: null;
}

interface Mail {
	subject: string;
	heading: string;
	lines: string[];
	button?: { label: string; url: string | null };
	footer?: string;
}

/** One email, ready to send. */
export interface Message {
	subject: string;
	text: string;
	html: string;
}

/**
 * An email waiting to be sent, kept in the data of a cron task until every person has it.
 * Who gets it: `to`, plus a person to look up (`user`) or the approvers (`approvers`), read a
 * page at a time.
 */
export interface MailJob {
	message: Message;
	to: string[];
	user?: string;
	approvers?: { min: number; except: string | null; cursor?: string; pages: number };
	/** Sends tried so far for the people in `to` (failed ones are tried again later). */
	tries: number;
}

function render(ctx: PluginContext, mail: Mail): Message {
	const site = siteName(ctx);
	const link = mail.button?.url
		? `${mail.button.label}: ${mail.button.url}`
		: "Open Approvals in your site admin.";
	const text = [
		mail.heading,
		"",
		...mail.lines,
		"",
		link,
		...(mail.footer ? ["", mail.footer] : []),
	].join("\n");
	const html = [
		`<h2 style="font-size:18px;margin:0 0 10px">${escapeHtml(mail.heading)}</h2>`,
		...mail.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
		mail.button?.url
			? `<p><a href="${escapeHtml(mail.button.url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:9px 14px;border-radius:7px;text-decoration:none">${escapeHtml(mail.button.label)}</a></p>`
			: "<p>Open Approvals in your site admin.</p>",
		...(mail.footer
			? [`<p style="color:#737373;font-size:13px">${escapeHtml(mail.footer)}</p>`]
			: []),
	].join("\n");
	return { subject: `${site}: ${mail.subject}`, text, html };
}

function toApprovers(
	config: Pick<Config, "preset">,
	except: string | null | undefined,
): MailJob["approvers"] {
	return { min: approverRole(config.preset), except: except ?? null, pages: 0 };
}

/** To the approvers: someone asked. */
export function askedJob(
	ctx: PluginContext,
	config: Pick<Config, "preset">,
	request: ApprovalRequest,
): MailJob {
	const asker = request.ai ? "An AI tool" : (request.requestedBy?.name ?? "Someone");
	const firstName = request.requestedBy?.name.split(" ")[0] ?? "The writer";
	return {
		message: render(ctx, {
			subject: `${asker} asked you to approve "${request.title}"`,
			heading: `Please approve "${request.title}"`,
			lines: [
				`${asker} asked on ${when(request.requestedAt)}. It is not live yet.`,
				...(request.note ? [`${firstName}'s note: "${request.note}"`] : []),
			],
			button: { label: "Review and approve", url: approvalsUrl(ctx) },
			footer: `You get this email because you approve pages on ${siteName(ctx)}.`,
		}),
		to: [],
		approvers: toApprovers(config, request.ai ? null : request.requestedBy?.id),
		tries: 0,
	};
}

export function reminderJob(
	ctx: PluginContext,
	config: Pick<Config, "preset">,
	request: ApprovalRequest,
): MailJob {
	return {
		message: render(ctx, {
			subject: `Still waiting: "${request.title}"`,
			heading: `"${request.title}" is still waiting for approval`,
			lines: [
				`${request.requestedBy?.name ?? "Someone"} asked on ${when(request.requestedAt)}. It is not live yet.`,
			],
			button: { label: "Review and approve", url: approvalsUrl(ctx) },
		}),
		to: [],
		approvers: toApprovers(config, request.ai ? null : request.requestedBy?.id),
		tries: 0,
	};
}

/** To the writer: approved, published or sent back. Null when nobody asked. */
export function writerJob(
	ctx: PluginContext,
	request: ApprovalRequest,
	kind: "approved" | "published" | "sent_back",
): MailJob | null {
	if (!request.requestedBy) return null;
	const page = pageUrl(ctx, request.collection, request.entryId);
	const job = (mail: Mail): MailJob => ({
		message: render(ctx, mail),
		to: [],
		user: request.requestedBy!.id,
		tries: 0,
	});
	if (kind === "sent_back") {
		if (!request.sentBack) return null;
		const first = request.sentBack.by.name.split(" ")[0];
		return job({
			subject: `${request.sentBack.by.name} sent back "${request.title}"`,
			heading: `"${request.title}" needs changes`,
			lines: [
				`${first}'s note: "${request.sentBack.note}"`,
				"Make the changes, save, and press Publish again.",
			],
			button: { label: "Open the page", url: page },
		});
	}
	const by = request.approval?.by.name ?? "An approver";
	return job({
		subject:
			kind === "published"
				? `Approved and published: "${request.title}"`
				: `Approved: "${request.title}"`,
		heading: kind === "published" ? `"${request.title}" is live` : `"${request.title}" is approved`,
		lines:
			kind === "published"
				? [`${by} approved and published it on ${when(request.approval?.at ?? request.updatedAt)}.`]
				: [`${by} approved it. Press Publish when you're ready, or schedule it.`],
		button: { label: "Open the page", url: page },
	});
}

/** To the other approvers: someone approved or published without review. */
export function overrideJob(
	ctx: PluginContext,
	config: Pick<Config, "preset">,
	request: ApprovalRequest,
	published: boolean,
): MailJob | null {
	const by = request.approval?.by;
	if (!by) return null;
	const done = published ? "published" : "approved";
	return {
		message: render(ctx, {
			subject: `${by.name} ${done} "${request.title}" without review`,
			heading: `"${request.title}" was ${done} without review`,
			lines: [`${by.name} gave this reason: "${request.approval?.override ?? ""}"`],
			button: { label: "See it in Approvals", url: approvalsUrl(ctx) },
		}),
		to: [],
		approvers: toApprovers(config, by.id),
		tries: 0,
	};
}

let sequence = 0;

/** A cron task name of its own: a task that names itself again while running is lost. */
function sendTaskName(at: number): string {
	sequence = (sequence + 1) % 1_000_000;
	const random = Math.random().toString(36).slice(2, 8);
	return `${SEND_TASK}-${at.toString(36)}-${sequence.toString(36)}-${random}`;
}

/**
 * Queue emails: one cron task carries them, so sending never costs the action that asked
 * for it more than this one call. They go out within a minute or so. Throws when they could
 * not be queued.
 */
export async function queueMail(
	ctx: PluginContext,
	jobs: Array<MailJob | null | undefined>,
	delayMs = 0,
): Promise<boolean> {
	const real = jobs.filter((job): job is MailJob => Boolean(job));
	if (real.length === 0 || !ctx.email || !ctx.cron) return false;
	const at = Date.now() + delayMs;
	await ctx.cron.schedule(sendTaskName(at), {
		schedule: new Date(at).toISOString(),
		data: { jobs: real },
	});
	return true;
}

/** Read a queued job back from cron data; anything malformed is dropped. */
export function readJobs(value: unknown): MailJob[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(job): job is MailJob =>
			typeof job === "object" &&
			job !== null &&
			typeof (job as MailJob).message?.subject === "string" &&
			Array.isArray((job as MailJob).to),
	);
}

function needsLookup(job: MailJob): boolean {
	return job.user !== undefined || job.approvers !== undefined;
}

/**
 * Send queued emails within one run's calls, and queue whatever is left for the next run.
 *
 * Order matters: the rest is queued before anything is sent, so a run that fails before
 * sending is simply tried again by EmDash, and nothing is sent twice; nothing throws after
 * the first email. Failed emails are tried again later (MAIL_TRIES in all). Uses at most
 * CALLS_PER_RUN calls, counting what the run used before (`m`).
 */
export async function deliver(m: Meter, input: MailJob[]): Promise<void> {
	const ctx = m.ctx;
	const email = ctx.email;
	if (!email) return;
	const jobs = input.map((job) => ({
		...job,
		to: [...job.to],
		...(job.approvers ? { approvers: { ...job.approvers } } : {}),
	}));
	// Kept back for the end: queueing failed emails again, and one log line.
	const RESERVE = 2;

	// Look people up while a lookup still leaves room for queueing the rest and one email.
	for (const job of jobs) {
		while (needsLookup(job) && m.left() >= RESERVE + 3) {
			if (job.user !== undefined) {
				const person = await ctx.users?.get(job.user).catch(() => null);
				if (person?.email) job.to.push(person.email);
				delete job.user;
				continue;
			}
			const look = job.approvers!;
			const page = await approverPageFor(ctx, look.min, look.except, look.cursor);
			job.to.push(...page.people.map((p) => p.email).filter(Boolean));
			look.pages++;
			if (page.next && look.pages < MAX_PAGES) look.cursor = page.next;
			else delete job.approvers;
			// One page per job per run: the emails it found go first.
			break;
		}
	}

	// Plan this run's emails; the rest go to a new task, queued before sending.
	let room = m.left() - RESERVE;
	const waiting = jobs.reduce((n, job) => n + job.to.length, 0);
	const unresolved = jobs.some(needsLookup);
	const later = unresolved || waiting > room;
	if (later) room -= 1;
	const batch: Array<{ job: MailJob; to: string }> = [];
	const rest: MailJob[] = [];
	for (const job of jobs) {
		const take = Math.max(0, Math.min(room - batch.length, job.to.length));
		for (const to of job.to.slice(0, take)) batch.push({ job, to });
		const left = job.to.slice(take);
		if (left.length > 0 || needsLookup(job)) rest.push({ ...job, to: left });
	}
	if (later && rest.length > 0) {
		// Throws when it cannot be queued: nothing has been sent yet, so EmDash tries again.
		await queueMail(ctx, rest);
	}

	const failed = new Map<MailJob, string[]>();
	for (const { job, to } of batch) {
		try {
			await email.send({ to, ...job.message });
		} catch {
			failed.set(job, [...(failed.get(job) ?? []), to]);
		}
	}
	if (failed.size === 0) return;
	const again: MailJob[] = [];
	let lost = 0;
	for (const [job, to] of failed) {
		if (job.tries + 1 < MAIL_TRIES) again.push({ message: job.message, to, tries: job.tries + 1 });
		else lost += to.length;
	}
	let notQueued = 0;
	if (again.length > 0) {
		try {
			await queueMail(ctx, again, RETRY_AFTER_MS);
		} catch {
			notQueued = again.reduce((n, job) => n + job.to.length, 0);
		}
	}
	const sent = batch.length - [...failed.values()].reduce((n, to) => n + to.length, 0);
	if (m.left() >= 1) {
		const retrying = again.reduce((n, job) => n + job.to.length, 0) - notQueued;
		void Promise.resolve(
			ctx.log.warn("could not send some approval emails", {
				sent,
				retrying,
				givenUp: lost + notQueued,
			}),
		).catch(() => {});
	}
}

export function personFromUser(user: { id: string; name: string | null; email: string }) {
	return { id: user.id, name: personName(user) };
}
