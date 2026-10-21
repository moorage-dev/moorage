// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import type { Config } from "./config.js";
import { approvers, personName, type ApprovalRequest, when } from "./requests.js";

/** A request email is sent at most once a day per page, however often Publish is pressed. */
export const EMAIL_EVERY_MS = 24 * 60 * 60 * 1000;
export const REMIND_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

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
	to: string[];
	subject: string;
	heading: string;
	lines: string[];
	button?: { label: string; url: string | null };
	footer?: string;
}

async function send(ctx: PluginContext, mail: Mail): Promise<number> {
	if (!ctx.email || mail.to.length === 0) return 0;
	const site = siteName(ctx);
	const subject = `${site}: ${mail.subject}`;
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
	let sent = 0;
	// One message per person, so nobody sees the others' addresses.
	for (const to of mail.to) {
		try {
			await ctx.email.send({ to, subject, text, html });
			sent++;
		} catch (error) {
			ctx.log.warn("could not send an approval email", { error: String(error) });
		}
	}
	return sent;
}

/** To the approvers: someone asked. */
export async function emailAsked(
	ctx: PluginContext,
	config: Config,
	request: ApprovalRequest,
): Promise<number> {
	const people = await approvers(ctx, config, request.ai ? null : request.requestedBy?.id);
	const asker = request.ai ? "An AI tool" : (request.requestedBy?.name ?? "Someone");
	const firstName = request.requestedBy?.name.split(" ")[0] ?? "The writer";
	return send(ctx, {
		to: people.map((p) => p.email),
		subject: `${asker} asked you to approve "${request.title}"`,
		heading: `Please approve "${request.title}"`,
		lines: [
			`${asker} asked on ${when(request.requestedAt)}. It is not live yet.`,
			...(request.note ? [`${firstName}'s note: "${request.note}"`] : []),
		],
		button: { label: "Review and approve", url: approvalsUrl(ctx) },
		footer: `You get this email because you approve pages on ${siteName(ctx)}.`,
	});
}

export async function emailReminder(
	ctx: PluginContext,
	config: Config,
	request: ApprovalRequest,
): Promise<number> {
	const people = await approvers(ctx, config, request.ai ? null : request.requestedBy?.id);
	return send(ctx, {
		to: people.map((p) => p.email),
		subject: `Still waiting: "${request.title}"`,
		heading: `"${request.title}" is still waiting for approval`,
		lines: [
			`${request.requestedBy?.name ?? "Someone"} asked on ${when(request.requestedAt)}. It is not live yet.`,
		],
		button: { label: "Review and approve", url: approvalsUrl(ctx) },
	});
}

/** To the writer: approved, published or sent back. */
export async function emailWriter(
	ctx: PluginContext,
	request: ApprovalRequest,
	kind: "approved" | "published" | "sent_back",
): Promise<number> {
	if (!request.requestedBy || !ctx.users) return 0;
	const writer = await ctx.users.get(request.requestedBy.id);
	if (!writer) return 0;
	const page = pageUrl(ctx, request.collection, request.entryId);
	if (kind === "sent_back" && request.sentBack) {
		const first = request.sentBack.by.name.split(" ")[0];
		return send(ctx, {
			to: [writer.email],
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
	return send(ctx, {
		to: [writer.email],
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
export async function emailOverride(
	ctx: PluginContext,
	config: Config,
	request: ApprovalRequest,
): Promise<number> {
	const by = request.approval?.by;
	if (!by) return 0;
	const people = await approvers(ctx, config, by.id);
	const done = request.approval?.published ? "published" : "approved";
	return send(ctx, {
		to: people.map((p) => p.email),
		subject: `${by.name} ${done} "${request.title}" without review`,
		heading: `"${request.title}" was ${done} without review`,
		lines: [`${by.name} gave this reason: "${request.approval?.override ?? ""}"`],
		button: { label: "See it in Approvals", url: approvalsUrl(ctx) },
	});
}

export function personFromUser(user: { id: string; name: string | null; email: string }) {
	return { id: user.id, name: personName(user) };
}
