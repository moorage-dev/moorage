// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { publishFailedMessage } from "./actions.js";
import { ROLE, type Config } from "./config.js";
import { CALLS_PER_RUN_1_5, type Meter } from "./meter.js";
import { personFromUser, queueMail, writerJob, type MailJob } from "./notify.js";
import {
	addHistory,
	copyOf,
	mayApprove,
	nameNow,
	readDraft,
	requests,
	seoGaps,
	titleOf,
	UNNAMED,
	versions,
	type ApprovalRequest,
	type ApprovedVersion,
	type CollectionInfo,
	type UserInfo,
} from "./requests.js";

/**
 * Deciding many waiting requests in one run, cheaply: the requests are read together (one call)
 * and the content types once (one call); each request then costs only what touches its page.
 *
 * Approve and publish, per request: the page with its revision token and its draft (2), the
 * request written only if it is still the waiting version that was read (updateIf, guarded on
 * its status and its last change: 1), the publish (1). The text copies are written together at
 * the end (1), and the emails for approvals that are not published are queued together (1).
 * Send back, per request: the guarded write (1); the writers' emails queued together (1).
 *
 * The same rules as one decision on the Approvals page (approve() and sendBack() in actions.ts):
 * the person must approve on this site and not have asked for it themselves (an AI tool's
 * request aside), the request must still wait, and the page must be the version the list
 * showed. The guarded write makes each decision happen once, however many runs or people try.
 * "Published by" and the writer's email after a publish follow in content:afterPublish, as for
 * one decision.
 */

export type RowDo = "publish" | "send_back";

/** One request to decide: its key and the version the list showed. */
export interface Row {
	key: string;
	seen: string;
	/** The name the confirm step showed, for results about a row that was never read. */
	title?: string;
}

export interface RowResult {
	key: string;
	title: string;
	/** done: decided as asked; approved: approved but not live; failed: not decided. */
	state: "done" | "approved" | "failed";
	text: string;
}

/** Calls every run makes besides its rows: the requests, the content types, the copies, the emails. */
export const ROWS_FIXED = 4;

/** Worst case per request. */
export function rowCost(what: RowDo, config: Config): number {
	return what === "send_back" ? 1 : config.checks === "require" ? 5 : 4;
}

const CHANGED = "This page changed while you were looking. Check the new version, then decide.";
const CHANGED_MEANWHILE = "This request changed just now, so nothing was changed. Look again.";

function infoOf(
	type: NonNullable<
		Awaited<ReturnType<NonNullable<PluginContext["schema"]>["listCollections"]>>
	>[number],
): CollectionInfo {
	const fields = [...type.fields]
		.sort((a, b) => a.sortOrder - b.sortOrder)
		.map((f) => ({ slug: f.slug, label: f.label, type: f.type }));
	const titleSlug = type.titleField ?? (fields.some((f) => f.slug === "title") ? "title" : null);
	const titleField = fields.find((f) => f.slug === titleSlug);
	return {
		label: type.label,
		fields,
		title: titleSlug ? { slug: titleSlug, label: titleField?.label ?? "Title" } : null,
		keepsDrafts: type.supports.includes("revisions"),
		hasSeo: type.hasSeo,
	};
}

/**
 * Decide `rows` in order while a whole request still fits under the run's 25 calls, keeping
 * `reserve` calls for the caller. Returns each request's outcome and the rows left for later.
 */
export async function decideRows(
	m: Meter,
	config: Config,
	user: UserInfo,
	what: RowDo,
	reason: string,
	rows: Row[],
	reserve: number,
	/** When the run started: only a decision this person made since then counts as this run's. */
	since: string,
): Promise<{ results: RowResult[]; rest: Row[] }> {
	const ctx = m.ctx;
	const results: RowResult[] = [];
	if (rows.length === 0) return { results, rest: [] };
	const store = requests(ctx);
	// Only the rows this turn can reach: the cheapest possible decision each, after the reads.
	const room = m.left(CALLS_PER_RUN_1_5) - 2 - 2 - reserve;
	const reach = Math.max(1, Math.floor(room / (what === "send_back" ? 1 : 3)));
	const stored = await store.getMany(rows.slice(0, reach).map((r) => r.key));
	const types = new Map(
		((await ctx.schema?.listCollections()) ?? []).map((t) => [t.slug, infoOf(t)]),
	);
	const by = personFromUser(user);
	const copies: Array<{ id: string; data: ApprovedVersion }> = [];
	const mails: MailJob[] = [];
	// The copies and the emails, written once at the end.
	const tail = 2;
	let next = 0;
	for (; next < Math.min(rows.length, reach); next++) {
		const row = rows[next]!;
		const request = stored.get(row.key);
		const cost = what === "send_back" && request?.title === UNNAMED ? 2 : rowCost(what, config);
		if (m.left(CALLS_PER_RUN_1_5) < cost + tail + reserve) break;
		try {
			const fail = (text: string, title = request?.title ?? row.key) =>
				results.push({ key: row.key, title, state: "failed", text });
			if (!request) {
				fail("This request no longer exists.");
				continue;
			}
			if (request.status !== "waiting") {
				// Run again after a run that stopped part-way (EmDash retries a failed task): what this
				// person already decided at this version counts as done, and an approval whose publish
				// did not happen is published now.
				const mine =
					what === "send_back"
						? request.status === "sent_back" &&
							request.sentBack?.by.id === user.id &&
							request.sentBack.at >= since
						: (request.status === "approved" || request.status === "published") &&
							request.approval?.by.id === user.id &&
							request.approval.fingerprint === row.seen &&
							request.approval.at >= since;
				if (!mine) {
					fail("This request has already been decided.");
					continue;
				}
				if (
					what === "publish" &&
					request.status === "approved" &&
					request.wants !== "schedule" &&
					ctx.content?.publish
				) {
					const draft = await readDraft(ctx, request.collection, request.entryId, {
						forPublish: true,
					});
					try {
						if (!draft?.rev || draft.fingerprint !== row.seen) throw new Error("changed");
						await ctx.content.publish(request.collection, request.entryId, { _rev: draft.rev });
					} catch {
						results.push({
							key: row.key,
							title: request.title,
							state: "approved",
							text: "Approved, not live yet: press Publish on the page.",
						});
						continue;
					}
				}
				results.push({
					key: row.key,
					title: request.title,
					state: "done",
					text:
						what === "send_back"
							? "Sent back with your note."
							: request.wants === "schedule"
								? "Approved. Its writer can schedule it now."
								: "Approved and published. It's live now.",
				});
				continue;
			}
			if (!mayApprove(config, request, user)) {
				fail(
					request.requestedBy?.id === user.id
						? "You asked for this approval, so someone else needs to approve it."
						: "You can't approve on this site.",
				);
				continue;
			}
			if (request.fingerprint !== row.seen) {
				fail(CHANGED);
				continue;
			}
			const now = new Date().toISOString();
			const guard = { status: "waiting", updatedAt: request.updatedAt };
			const writer = request.requestedBy && !request.ai ? request.requestedBy.name : null;
			const first = writer ? writer.split(" ")[0] : null;

			if (what === "send_back") {
				// An earlier release's "Untitled", named for the writer's email (one read, those rows only).
				if (request.title === UNNAMED) {
					const field = types.get(request.collection)?.title?.slug ?? null;
					request.title = await nameNow(ctx, request, field);
				}
				const sent: ApprovalRequest = {
					...request,
					status: "sent_back",
					sentBack: { by, at: now, note: reason.slice(0, 2000) },
				};
				addHistory(sent, now, `${by.name} sent it back: "${reason.slice(0, 120)}"`);
				const written = await store.updateIf(row.key, {
					where: guard,
					set: {
						title: sent.title,
						status: sent.status,
						sentBack: sent.sentBack,
						history: sent.history,
						updatedAt: sent.updatedAt,
					},
				});
				if (!written.applied) {
					fail(CHANGED_MEANWHILE);
					continue;
				}
				const job = writerJob(ctx, sent, "sent_back");
				if (job) mails.push(job);
				results.push({
					key: row.key,
					title: request.title,
					state: "done",
					text: first ? `Sent back to ${first} with your note.` : "Sent back with your note.",
				});
				continue;
			}

			const info = types.get(request.collection);
			if (!info) {
				fail("This content type no longer exists.");
				continue;
			}
			// A request to schedule is approved for its writer to schedule; the rest are published.
			const publishing =
				request.wants !== "schedule" && user.role >= ROLE.editor && Boolean(ctx.content?.publish);
			const draft = await readDraft(ctx, request.collection, request.entryId, {
				forPublish: publishing,
			});
			if (!draft) {
				fail("This page no longer exists.");
				continue;
			}
			if (draft.fingerprint !== row.seen) {
				fail(CHANGED);
				continue;
			}
			if (config.checks === "require") {
				const seo = publishing
					? (await ctx.content?.get(request.collection, request.entryId))?.seo
					: draft.item.seo;
				const missing = seoGaps(info.hasSeo ? seo : null, draft.data);
				if (missing.description || missing.picture) {
					fail(
						`Add ${[missing.description ? "a search description" : "", missing.picture ? "a sharing picture" : ""].filter(Boolean).join(" and ")} in the SEO panel first. This site requires them before approval.`,
					);
					continue;
				}
			}
			const title = titleOf(info, draft.data, draft.slug, request.entryId);
			const versionId = `${row.key}#${now}`;
			const approved: ApprovalRequest = {
				...request,
				title,
				status: "approved",
				fingerprint: draft.fingerprint,
				approval: { by, at: now, fingerprint: draft.fingerprint, versionId },
			};
			addHistory(approved, now, `${by.name} approved`);
			const set: Partial<ApprovalRequest> = {
				title,
				status: "approved",
				fingerprint: approved.fingerprint,
				approval: approved.approval!,
				history: approved.history,
				updatedAt: approved.updatedAt,
			};
			// After the publish, content:afterPublish records "Published by" and sends these.
			if (publishing) {
				const jobs = ctx.email
					? [writerJob(ctx, approved, "published")].filter((j): j is MailJob => j !== null)
					: [];
				set.publishing = { by, at: now, jobs };
			}
			const written = await store.updateIf(row.key, { where: guard, set });
			if (!written.applied) {
				fail(CHANGED_MEANWHILE, title);
				continue;
			}
			copies.push({
				id: versionId,
				data: {
					requestKey: row.key,
					at: now,
					by: by.name,
					title,
					fields: copyOf(info, draft.data),
				},
			});
			if (!publishing) {
				const job = writerJob(ctx, approved, "approved");
				if (job) mails.push(job);
				results.push({
					key: row.key,
					title,
					state: "done",
					text: `Approved. ${first ? `${first} can` : "Its writer can"} schedule it now.`,
				});
				continue;
			}
			try {
				if (!draft.rev || !ctx.content?.publish) throw new Error("publishing is not available");
				await ctx.content.publish(request.collection, request.entryId, { _rev: draft.rev });
				results.push({
					key: row.key,
					title,
					state: "done",
					text: `Approved and published. It's live now.${first ? ` ${first} has been told.` : ""}`,
				});
			} catch (error) {
				const message = publishFailedMessage(error);
				results.push({
					key: row.key,
					title,
					state: "approved",
					text: message.startsWith("Approved. The page was still finishing")
						? message
						: "Approved, not live yet: press Publish on the page.",
				});
			}
		} catch {
			// A read or write that failed just now: this one stays in Waiting, the rest go on.
			results.push({
				key: row.key,
				title: request?.title ?? row.title ?? row.key,
				state: "failed",
				text: "Could not be decided just now. Try it again from the list.",
			});
		}
	}
	if (copies.length > 0) {
		try {
			await versions(ctx).putMany(copies);
		} catch {
			// The approvals stand; only History's text copy is missing.
		}
	}
	if (mails.length > 0) {
		try {
			await queueMail(ctx, mails);
		} catch {
			// The decisions stand; the writers see them on the page.
		}
	}
	return { results, rest: rows.slice(next) };
}
