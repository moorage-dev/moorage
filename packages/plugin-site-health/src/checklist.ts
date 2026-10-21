// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { request } from "./check.js";
import {
	KEY,
	type CheckStatus,
	type ChecklistState,
	type Loaded,
	type ScanState,
} from "./state.js";
import { parseUrl, publicOrigin } from "./url.js";

const WEEK = 7 * 86_400_000;
/** One fixed made-up address, so the "page not found" log is not flooded. */
export const MISSING_PATH = "/site-health-check-a-page-that-does-not-exist";

type Row = { status: CheckStatus; text: string };

/** The Checklist rows that need the site to be opened. Once a week, up to five requests. */
export async function runChecklist(
	ctx: PluginContext,
	scan: ScanState,
	data: Loaded,
	now: number,
): Promise<void> {
	const last = data.checklist.checkedAt ? Date.parse(data.checklist.checkedAt) : 0;
	if (scan.live === "ok" && now - last < WEEK) return;
	const rows: Record<string, Row> = {};
	const site = parseUrl(ctx.site.url);
	const origin = publicOrigin(ctx.site.url);
	const couldNot: Row = {
		status: "unknown",
		text:
			scan.live === "updating"
				? "Your site was showing visitors an error while an update finished, so we could not find out."
				: "We could not open your site to find out.",
	};
	rows.caching =
		scan.caching === "ok"
			? {
					status: "working",
					text: "Pages can be kept ready for visitors instead of built on every visit.",
				}
			: scan.caching === "no"
				? {
						status: "attention",
						text: "Every visit builds the page again, which makes it slower. Not urgent; your web person can let pages be kept ready.",
					}
				: couldNot;
	if (!origin || !site || scan.live !== "ok") {
		Object.assign(rows, { secure: couldNot, www: couldNot, missing: couldNot, search: couldNot });
	} else {
		const host = site.hostname;
		const other = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
		const [insecure, alias, missing, robots, list] = await Promise.all([
			site.protocol === "https:"
				? request(ctx, `http://${host}/`, { follow: false })
				: Promise.resolve(null),
			request(ctx, `${site.protocol}//${other}/`, { follow: false }),
			request(ctx, `${origin}${MISSING_PATH}`),
			request(ctx, `${origin}/robots.txt`, { body: true }),
			request(ctx, `${origin}/sitemap.xml`, { method: "HEAD" }),
		]);
		if (!insecure) {
			rows.secure = {
				status: "attention",
				text: "Your site address is not secure. Ask your web person to switch it to https.",
			};
		} else if (
			(insecure.status ?? 0) >= 300 &&
			(insecure.status ?? 0) < 400 &&
			insecure.location?.startsWith("https:")
		) {
			rows.secure = {
				status: "working",
				text: "The insecure address sends visitors to the secure one.",
			};
		} else if (insecure.status !== undefined) {
			rows.secure = {
				status: "attention",
				text: "The insecure address shows your site without sending visitors to the secure one.",
			};
		} else rows.secure = couldNot;

		const aliasTo = alias.location ? parseUrl(alias.location)?.hostname : undefined;
		if (
			alias.status !== undefined &&
			alias.status >= 300 &&
			alias.status < 400 &&
			aliasTo === host
		) {
			rows.www = { status: "working", text: `${other} sends visitors on to your address.` };
		} else if (alias.status !== undefined && alias.status < 300) {
			rows.www = {
				status: "attention",
				text: `${other} shows your site too. Visitors and search engines should be sent to one address; your web person can set this.`,
			};
		} else {
			rows.www = {
				status: "attention",
				text: `${host.startsWith("www.") ? "The address without www" : "The address with www"} does not answer. Point it at your site so it sends visitors on.`,
			};
		}

		if (missing.status === 404 || missing.status === 410) {
			rows.missing = {
				status: "working",
				text: 'An address that does not exist shows your "page not found" page and tells search engines it is missing.',
			};
		} else if (missing.status !== undefined && missing.status < 300) {
			rows.missing = {
				status: "attention",
				text: "An address that does not exist shows a normal page, so search engines may list pages that are not there.",
			};
		} else rows.missing = couldNot;

		const blocked =
			/user-agent:\s*\*\s*(?:\r?\n(?!user-agent)[^\n]*)*?\r?\ndisallow:\s*\/\s*(\r?\n|$)/i.test(
				robots.status === 200 ? (robots.body ?? "") : "",
			);
		const listed = list.status !== undefined && list.status < 300;
		rows.search = blocked
			? {
					status: "attention",
					text: "Your site tells search engines to stay away, so it will not appear in search results.",
				}
			: {
					status: "working",
					text: listed
						? "They are allowed in, and the list of your pages for them answers."
						: "They are allowed in. There is no list of your pages for them yet.",
				};
	}
	const checklist: ChecklistState = {
		...(scan.live === "ok" ? { checkedAt: new Date(now).toISOString() } : {}),
		rows,
	};
	data.checklist = checklist;
	await ctx.kv.set(KEY.checklist, checklist);
}
