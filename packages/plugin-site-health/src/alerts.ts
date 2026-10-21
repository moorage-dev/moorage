// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { describe, foundOn } from "./model.js";
import { KEY, type Alerts, type Loaded, type RowView, type Summary } from "./state.js";
import { publicOrigin, shorten } from "./url.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const PAGE_PATH = "/health";

/** The words for one problem in an email: the same as the admin. */
export function problemLine(row: RowView): string {
	return `${describe(row, shorten(row.url))}${foundOn(row)}`;
}

/** Every page, or a page that shows an error: these are mailed at once. */
function isUrgent(row: RowView): boolean {
	return row.menu || row.reason === "page-error";
}

function adminLink(ctx: PluginContext): string | null {
	const origin = publicOrigin(ctx.site.url);
	return origin ? `${origin}/_emdash/admin/plugins/${ctx.plugin.id}${PAGE_PATH}` : null;
}

/** Check a typed list of addresses. Returns the clean list, or the first one that is wrong. */
export function parseRecipients(text: string): { list: string[] } | { wrong: string } {
	const list: string[] = [];
	for (const part of text.split(/[\s,;]+/)) {
		const address = part.trim();
		if (address === "") continue;
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { wrong: address };
		if (!list.includes(address.toLowerCase())) list.push(address.toLowerCase());
	}
	return { list: list.slice(0, 20) };
}

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * The words EmDash uses when no email service is chosen: in the site's process
 * ("No email provider is configured…") and in the sandbox ("Email is not configured…").
 */
export const NO_EMAIL_SERVICE = /no email provider|not configured/i;

/** What to remember about an email just sent, for the Checklist's Email row. */
function noteEmail(
	result: SendResult,
	recipients: string[],
	at: string,
	kind: "test" | "alert",
): NonNullable<Alerts["email"]> {
	if (result.ok) return { state: "working", at, to: recipients.length, list: recipients, kind };
	return {
		state: NO_EMAIL_SERVICE.test(result.error) ? "not-set-up" : "failed",
		at,
		to: 0,
		list: recipients,
		kind,
		error: result.error.slice(0, 200),
	};
}

/** Id of the urgent alert for a check that found the site mid-update. */
export const UPDATING_ID = "updating|";
const UPDATING_TEXT =
	"Your site showed visitors an error page instead of your pages: an update to its database has not finished. Whoever looks after your site should finish the update.";

/** One message, To the first address and Cc the rest. Never throws. */
export async function send(
	ctx: PluginContext,
	recipients: string[],
	subject: string,
	text: string,
): Promise<SendResult> {
	const [to, ...cc] = recipients;
	if (!to) return { ok: false, error: "no addresses" };
	if (!ctx.email) return { ok: false, error: "Email is not configured" };
	try {
		await ctx.email.send({ to, ...(cc.length > 0 ? { cc } : {}), subject, text });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function siteName(ctx: PluginContext): string {
	return (
		ctx.site.name.trim() || publicOrigin(ctx.site.url)?.replace(/^https?:\/\//, "") || "Your site"
	);
}

/**
 * Note new urgent problems after the summary changed. They are mailed by the
 * next run that may send one (at most one urgent email a day).
 */
export async function queueUrgent(
	ctx: PluginContext,
	data: Loaded,
	summary: Summary,
	_now: number,
): Promise<void> {
	const rows: Array<{ id: string; text: string }> = [...summary.rows.site, ...summary.rows.page]
		.filter(isUrgent)
		.map((row) => ({ id: row.id, text: problemLine(row) }));
	// One alert per check that found the site down mid-update; at most one urgent email a day.
	if (summary.live === "updating")
		rows.unshift({ id: `${UPDATING_ID}${summary.pass}`, text: UPDATING_TEXT });
	const fresh = rows.filter((row) => !data.alerts.sent.includes(row.id));
	if (fresh.length === 0) return;
	const alerts: Alerts = {
		...data.alerts,
		pending: [
			...data.alerts.pending,
			...fresh.map((row) => ({ id: row.id, text: row.text })),
		].slice(-20),
		sent: [...data.alerts.sent, ...fresh.map((row) => row.id)].slice(-200),
	};
	data.alerts = alerts;
	await ctx.kv.set(KEY.alerts, alerts);
}

/** Is there an email to send now? Costs nothing to ask. */
export function mailDue(data: Loaded, now: number): boolean {
	const recipients = data.options.recipients ?? [];
	if (recipients.length === 0 || !data.summary) return false;
	const { alerts } = data;
	if (alerts.pending.length > 0 && (!alerts.urgentAt || now - Date.parse(alerts.urgentAt) >= DAY))
		return true;
	if (!alerts.weeklyAt || now - Date.parse(alerts.weeklyAt) >= WEEK) return true;
	return false;
}

/** Send whichever email is due, and note it. Two or three host calls. */
export async function mailStep(ctx: PluginContext, data: Loaded, now: number): Promise<void> {
	const recipients = data.options.recipients ?? [];
	const alerts: Alerts = { ...data.alerts };
	const name = siteName(ctx);
	const link = adminLink(ctx);
	const stamp = new Date(now).toISOString();
	if (alerts.pending.length > 0 && (!alerts.urgentAt || now - Date.parse(alerts.urgentAt) >= DAY)) {
		const updating = alerts.pending.some((item) => item.id.startsWith(UPDATING_ID));
		const errors = alerts.pending.some((item) => /visitors see an error/.test(item.text));
		const subject = `${name}: ${updating ? "your site is showing visitors an error" : errors ? "a page on your site shows an error" : "a link in your site menu is broken"}`;
		const text = [
			"Site Health found something visitors will hit:",
			"",
			...alerts.pending.map((item) => `- ${item.text}`),
			"",
			link ? `See them and fix them: ${link}` : "See them in Site Health in your site's admin.",
			"",
			"You get this because your address is on Site Health's list. At most one of these a day. Change the list in Site Health, Checklist, Options.",
		].join("\n");
		const result = await send(ctx, recipients, subject, text);
		alerts.urgentAt = stamp;
		alerts.pending = [];
		alerts.email = noteEmail(result, recipients, stamp, "alert");
	} else if (!alerts.weeklyAt) {
		// The first week starts with the first finished check.
		alerts.weeklyAt = stamp;
	} else if (data.summary) {
		const since = alerts.weeklyAt;
		const all = [...data.summary.rows.site, ...data.summary.rows.page, ...data.summary.rows.link];
		const fresh = all.filter((row) => row.since && row.since > since);
		alerts.weeklyAt = stamp;
		if (fresh.length > 0) {
			const total = data.summary.fix.site + data.summary.fix.page + data.summary.fix.link;
			const subject = `${name}: ${fresh.length} new ${fresh.length === 1 ? "problem" : "problems"} this week`;
			const text = [
				"New since last week:",
				"",
				...fresh.map((row) => `- ${problemLine(row)}`),
				"",
				`${total} ${total === 1 ? "thing" : "things"} to fix in all. ${link ? `See them: ${link}` : "See them in Site Health in your site's admin."}`,
				"",
				"Sent once a week, only when something is new.",
			].join("\n");
			const result = await send(ctx, recipients, subject, text);
			alerts.email = noteEmail(result, recipients, stamp, "alert");
		}
	}
	data.alerts = alerts;
	await ctx.kv.set(KEY.alerts, alerts);
}

/** The Checklist's "Send a test email". */
export async function sendTest(ctx: PluginContext, data: Loaded, now: number): Promise<SendResult> {
	const recipients = data.options.recipients ?? [];
	const result = await send(
		ctx,
		recipients,
		`${siteName(ctx)}: test email from Site Health`,
		"This is a test from Site Health. If you can read it, alerts about broken links and pages that show errors will reach you.",
	);
	const stamp = new Date(now).toISOString();
	data.alerts = {
		...data.alerts,
		email: noteEmail(result, recipients, stamp, "test"),
	};
	await ctx.kv.set(KEY.alerts, data.alerts);
	return result;
}
