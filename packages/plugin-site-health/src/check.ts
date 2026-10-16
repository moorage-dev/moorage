// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { HTML_LIMIT } from "./extract.js";
import { groupOf, type LinkRow, type Reason } from "./model.js";
import { parseUrl, shorten } from "./url.js";

export const TIMEOUT_MS = 8000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Outcome {
	status?: number;
	/** Where a redirect answer points, made absolute. */
	location?: string;
	/** Where the request ended up after redirects the host followed. */
	finalUrl?: string;
	headers?: Headers;
	body?: string;
	timedOut?: boolean;
	error?: string;
}

function userAgent(siteUrl: string): string {
	return `EmDash-SiteHealth/0.1 (+${siteUrl || "unknown site"})`;
}

/**
 * One request with our own time limit. The sandbox drops `signal`, so the
 * race only stops waiting; the request itself ends with the run.
 */
export async function request(
	ctx: PluginContext,
	url: string,
	options: { method?: "GET" | "HEAD"; body?: boolean; follow?: boolean } = {},
): Promise<Outcome> {
	const http = ctx.http;
	if (!http) return { error: "no network" };
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Outcome>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), TIMEOUT_MS);
	});
	const attempt = (async (): Promise<Outcome> => {
		try {
			const response = await http.fetch(url, {
				method: options.method ?? "GET",
				redirect: options.follow === false ? "manual" : "follow",
				headers: { "User-Agent": userAgent(ctx.site.url), Accept: "text/html,*/*;q=0.5" },
			});
			const location = response.headers.get("location");
			const outcome: Outcome = {
				status: response.status,
				headers: response.headers,
				...(location ? { location: parseUrl(location, url)?.href ?? location } : {}),
				...(response.redirected && response.url ? { finalUrl: response.url } : {}),
			};
			if (options.body) {
				const text = await response.text();
				outcome.body = text.length > HTML_LIMIT ? text.slice(0, HTML_LIMIT) : text;
			}
			return outcome;
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	})();
	try {
		return await Promise.race([attempt, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** EmDash refuses plugin requests to localhost and private addresses. */
export function isRefusedHost(outcome: Outcome): boolean {
	return /internal host|not allowed to fetch|private|localhost/i.test(outcome.error ?? "");
}

const DEAD_DOMAIN = /ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|name not resolved|could not resolve/i;

export type Verdict =
	| { kind: "ok" }
	| { kind: "moved"; to: string }
	| { kind: "gone" }
	| { kind: "dead" }
	| { kind: "server" }
	| { kind: "unknown"; reason: Reason }
	/** HEAD was refused; ask again with GET. */
	| { kind: "retry" };

function sameAddress(a: string, b: string): boolean {
	const clean = (value: string) =>
		value
			.replace(/^https?:\/\//i, "")
			.replace(/^www\./i, "")
			.replace(/\/$/, "");
	return clean(a) === clean(b);
}

/** What one answer from a site means. */
export function verdict(url: string, outcome: Outcome, method: "GET" | "HEAD"): Verdict {
	if (outcome.timedOut) return { kind: "unknown", reason: "timeout" };
	if (outcome.error !== undefined) {
		if (DEAD_DOMAIN.test(outcome.error)) return { kind: "dead" };
		return { kind: "unknown", reason: "error" };
	}
	const status = outcome.status ?? 0;
	if (status >= 300 && status < 400 && outcome.location) {
		return sameAddress(url, outcome.location)
			? { kind: "ok" }
			: { kind: "moved", to: outcome.location };
	}
	if (status >= 200 && status < 300) {
		if (outcome.finalUrl && !sameAddress(url, outcome.finalUrl)) {
			return { kind: "moved", to: outcome.finalUrl };
		}
		return { kind: "ok" };
	}
	if (method === "HEAD" && [400, 403, 404, 405, 501].includes(status)) return { kind: "retry" };
	if (status === 404 || status === 410) return { kind: "gone" };
	if (status === 429) return { kind: "unknown", reason: "slow" };
	// LinkedIn answers 999 to every checker: a refusal, not an error.
	if (status >= 500 && status < 600) return { kind: "server" };
	if ([401, 403, 407, 451, 999].includes(status) || status >= 400) {
		return { kind: "unknown", reason: "refuses" };
	}
	return { kind: "unknown", reason: "error" };
}

function later(now: number, ms: number): string {
	return new Date(now + ms).toISOString();
}

function becomeBroken(row: LinkRow, reason: Reason, now: number): LinkRow {
	const next: LinkRow = {
		...row,
		state: "broken",
		reason,
		since: row.state === "broken" && row.since ? row.since : new Date(now).toISOString(),
	};
	next.group = groupOf(next);
	return next;
}

function clear(row: LinkRow): LinkRow {
	const {
		fails: _f,
		firstFailAt: _ff,
		since: _s,
		group: _g,
		detail: _d,
		reason: _r,
		...rest
	} = row;
	return rest as LinkRow;
}

/**
 * The next state of a link to another site after one check. Broken only on
 * "removed" or "no such site" seen twice at least a day apart; anything that
 * turns checkers away is "could not check" and never counted. A single good
 * answer clears it.
 */
export function afterExternal(row: LinkRow, result: Verdict, now: number): LinkRow {
	const checkedAt = new Date(now).toISOString();
	const base = { ...row, checkedAt };
	switch (result.kind) {
		case "ok":
			return { ...clear(base), state: "ok", due: later(now, 7 * DAY) };
		case "moved":
			return {
				...clear(base),
				state: "look",
				reason: "moved",
				detail: shorten(result.to),
				due: later(now, 7 * DAY),
			};
		case "gone":
		case "dead": {
			const reason: Reason = result.kind === "gone" ? "gone" : "no-site";
			const first = row.firstFailAt ? Date.parse(row.firstFailAt) : NaN;
			if ((row.fails ?? 0) >= 1 && now - first >= DAY - HOUR) {
				return {
					...becomeBroken(base, reason, now),
					fails: (row.fails ?? 0) + 1,
					due: later(now, 7 * DAY),
				};
			}
			return {
				...base,
				// A row already broken stays broken; a new failure waits for its second look.
				state: row.state === "broken" ? "broken" : "pending",
				fails: (row.fails ?? 0) + 1,
				firstFailAt: row.firstFailAt ?? checkedAt,
				due: later(now, DAY),
			};
		}
		case "server": {
			const first = row.firstFailAt ? Date.parse(row.firstFailAt) : NaN;
			if ((row.fails ?? 0) >= 2 && now - first >= 7 * DAY - HOUR) {
				return {
					...becomeBroken(base, "server", now),
					fails: (row.fails ?? 0) + 1,
					due: later(now, 7 * DAY),
				};
			}
			return {
				...base,
				state: row.state === "broken" ? "broken" : "unknown",
				reason: row.state === "broken" ? row.reason : "trouble",
				fails: (row.fails ?? 0) + 1,
				firstFailAt: row.firstFailAt ?? checkedAt,
				due: later(now, 3 * DAY),
			};
		}
		case "unknown":
		case "retry": {
			const reason: Reason = result.kind === "unknown" ? result.reason : "refuses";
			if (row.state === "broken") return { ...base, due: later(now, DAY) };
			return {
				...base,
				state: "unknown",
				reason,
				due: later(now, reason === "slow" || reason === "timeout" ? DAY : 7 * DAY),
			};
		}
	}
}

/**
 * The next state of an address on this site that matched no page, after the
 * site was asked for it. Missing is broken at once; it is this site's own answer.
 */
export function afterOwnPath(row: LinkRow, result: Verdict, now: number): LinkRow {
	const checkedAt = new Date(now).toISOString();
	const base = { ...row, checkedAt, due: "9999" };
	switch (result.kind) {
		case "ok":
			return { ...clear(base), state: "ok" };
		case "moved": {
			const to = parseUrl(result.to);
			return {
				...clear(base),
				state: "look",
				reason: "redirect",
				detail: shorten(to ? to.pathname : result.to),
			};
		}
		case "gone":
		case "retry":
			return becomeBroken(base, "missing", now);
		default:
			return { ...clear(base), state: "unknown", reason: "no-live" };
	}
}

/** A page of this site that answered with an error: broken on the second error a minute later. */
export function afterOwnPage(row: LinkRow, outcome: Outcome, now: number): LinkRow {
	const checkedAt = new Date(now).toISOString();
	const status = outcome.status ?? 0;
	if (status >= 500) {
		const first = row.firstFailAt ? Date.parse(row.firstFailAt) : NaN;
		if ((row.fails ?? 0) >= 1 && now - first >= 50_000) {
			return {
				...becomeBroken({ ...row, checkedAt }, "page-error", now),
				fails: (row.fails ?? 0) + 1,
				due: later(now, DAY),
			};
		}
		return {
			...row,
			checkedAt,
			state: row.state === "broken" ? "broken" : "pending",
			fails: (row.fails ?? 0) + 1,
			firstFailAt: row.firstFailAt ?? checkedAt,
			due: later(now, 60_000),
		};
	}
	if (outcome.status !== undefined && status < 400) {
		return { ...clear({ ...row, checkedAt }), state: "ok", due: "9999" };
	}
	return { ...clear({ ...row, checkedAt }), state: "unknown", reason: "no-live", due: "9999" };
}
