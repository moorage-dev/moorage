// Copyright 2026 GoSiTech. Licensed under FSL-1.1-MIT; see LICENSE.

import { parseUrl } from "./url.js";

/** Redirect statuses EmDash accepts. 410 and 451 have no destination. */
const STATUSES = [301, 302, 307, 308, 410, 451] as const;
export type RedirectCode = (typeof STATUSES)[number];

/** Most rows one import can carry; keeps the stored plan small. */
export const MAX_ROWS = 2000;

export type ListFormat = "redirection" | "yoast" | "rankmath" | "plain";

export interface ReadyRow {
	source: string;
	destination: string;
	type: RedirectCode;
}

export interface SkippedRow {
	/** 1-based line in the pasted text. */
	line: number;
	source: string;
	reason: string;
}

export interface ImportPlan {
	format: ListFormat;
	ready: ReadyRow[];
	skipped: SkippedRow[];
}

/** An existing redirect, as far as planning needs to know. */
export interface ExistingRedirect {
	source: string;
	destination: string;
}

const REASON = {
	empty: "No old address",
	query: "Addresses with a ? are not supported",
	external: "Points to another website",
	noTarget: "No new address",
	same: "Old and new address are the same",
	code: "Unknown redirect type",
	pattern: "Uses a pattern. Add it by hand under Manage > Redirects",
	inactive: "Switched off in the export",
	repeated: "Listed twice",
	exists: "Already exists",
	conflict: "Conflicts with an existing redirect",
	loop: "Would send visitors in a circle",
	tooMany: `Only the first ${MAX_ROWS} rows are imported at once`,
} as const;

/** Split one CSV or tab-separated line, honouring double-quoted cells. */
function splitLine(line: string, delimiter: string): string[] {
	const cells: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (quoted) {
			if (char === '"' && line[index + 1] === '"') {
				cell += '"';
				index += 1;
			} else if (char === '"') quoted = false;
			else cell += char;
		} else if (char === '"') quoted = true;
		else if (char === delimiter) {
			cells.push(cell.trim());
			cell = "";
		} else cell += char;
	}
	cells.push(cell.trim());
	// "/old-page /new-page": people also separate the two addresses with a space.
	const only = cells[0] ?? "";
	if (cells.length === 1 && /\S\s+\S/.test(only)) return only.split(/\s+/);
	return cells;
}

// Header names used by the three WordPress exports, mapped to what they mean.
const HEADER_ALIASES: Record<string, string> = {
	source: "source",
	origin: "source",
	from: "source",
	"old url": "source",
	old: "source",
	sources: "source",
	target: "target",
	destination: "target",
	to: "target",
	"new url": "target",
	new: "target",
	url_to: "target",
	regex: "regex",
	code: "code",
	"http code": "code",
	type: "code",
	header_code: "code",
	format: "format",
	matching: "matching",
	status: "status",
	ignore: "ignore",
	id: "id",
};

interface Columns {
	format: ListFormat;
	hasHeader: boolean;
	index: Partial<Record<string, number>>;
}

function detectColumns(first: string[], rows: string[][]): Columns {
	const names = first.map((cell) => HEADER_ALIASES[cell.toLowerCase()]);
	const hasHeader = names.includes("source") && names.includes("target");
	if (hasHeader) {
		const index: Partial<Record<string, number>> = {};
		names.forEach((name, position) => {
			if (name && index[name] === undefined) index[name] = position;
		});
		const format: ListFormat =
			index.matching !== undefined
				? "rankmath"
				: index.format !== undefined
					? "yoast"
					: index.regex !== undefined
						? "redirection"
						: "plain";
		return { format, hasHeader, index };
	}

	// No header: infer the layout from the shape of the first rows.
	const sample = rows.slice(0, 20);
	const third = sample.map((row) => row[2] ?? "");
	const fourth = sample.map((row) => (row[3] ?? "").toLowerCase());
	if (fourth.length > 0 && fourth.every((cell) => cell === "plain" || cell === "regex")) {
		return { format: "yoast", hasHeader, index: { source: 0, target: 1, code: 2, format: 3 } };
	}
	if (third.length > 0 && third.every((cell) => cell === "0" || cell === "1")) {
		return { format: "redirection", hasHeader, index: { source: 0, target: 1, regex: 2, code: 3 } };
	}
	return { format: "plain", hasHeader, index: { source: 0, target: 1, code: 2 } };
}

/** A site path without a trailing slash; null when it is not on this site. */
function toPath(value: string): { path: string } | { reason: string } {
	let path = value.trim();
	if (path === "") return { reason: REASON.empty };
	if (/^https?:\/\//i.test(path)) {
		const url = parseUrl(path);
		if (!url) return { reason: REASON.empty };
		path = `${url.pathname}${url.search}`;
	}
	if (path.includes("?")) return { reason: REASON.query };
	if (!path.startsWith("/")) path = `/${path}`;
	if (path.length > 1) path = path.replace(/\/+$/, "");
	return { path: path === "" ? "/" : path };
}

const REGEX_META = /[\\^$.*+?()[\]{}|]/;

/**
 * Turn a WordPress regex redirect into an EmDash pattern, only for the two
 * shapes that are safe to translate: an exact path, and "everything under a
 * folder". Anything else is left for a person.
 */
function translateRegex(source: string, target: string): { source: string; target: string } | null {
	let body = source.trim();
	if (body.startsWith("^")) body = body.slice(1);
	if (body.endsWith("$")) body = body.slice(0, -1);
	if (body.endsWith("/?")) body = body.slice(0, -2);

	if (!REGEX_META.test(body)) return { source: body, target };

	const folder = /^(\/[^\\^$.*+?()[\]{}|]*\/)\(\.\*\)$/.exec(body);
	if (folder && !/\$[2-9]/.test(target)) {
		return { source: `${folder[1]}[...rest]`, target: target.replace(/\$1/g, "[...rest]") };
	}
	return null;
}

function parseCode(value: string | undefined): RedirectCode | null {
	if (value === undefined || value.trim() === "") return 301;
	const code = Number(value.trim());
	return (STATUSES as readonly number[]).includes(code) ? (code as RedirectCode) : null;
}

/**
 * Read a pasted list exported from Redirection, Yoast Premium or Rank Math,
 * or a plain "old address, new address" list, and decide for every row
 * whether it can be added. Nothing is written here.
 */
export function planImport(text: string, existing: ExistingRedirect[]): ImportPlan {
	const lines = text.split(/\r?\n/);
	const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : ",";
	const table = lines
		.map((line, position) => ({ line: position + 1, cells: splitLine(line, delimiter) }))
		.filter((row) => row.cells.some((cell) => cell !== ""));

	const first = table[0];
	if (!first) return { format: "plain", ready: [], skipped: [] };

	const columns = detectColumns(
		first.cells,
		table.map((row) => row.cells),
	);
	const rows = columns.hasHeader ? table.slice(1) : table;
	const cell = (cells: string[], name: string) => {
		const position = columns.index[name];
		return position === undefined ? undefined : cells[position];
	};

	const ready: Array<ReadyRow & { line: number }> = [];
	const skipped: SkippedRow[] = [];
	const existingBySource = new Map(existing.map((rule) => [rule.source, rule.destination]));
	const seen = new Set<string>();

	for (const { line, cells } of rows) {
		const rawSource = cell(cells, "source") ?? "";
		const skip = (reason: string) => skipped.push({ line, source: rawSource, reason });

		if (ready.length >= MAX_ROWS) {
			skip(REASON.tooMany);
			continue;
		}
		if (["inactive", "disabled"].includes((cell(cells, "status") ?? "active").toLowerCase())) {
			skip(REASON.inactive);
			continue;
		}
		const type = parseCode(cell(cells, "code"));
		if (type === null) {
			skip(REASON.code);
			continue;
		}

		let sourceText = rawSource;
		let targetText = cell(cells, "target") ?? "";
		const matching = (cell(cells, "matching") ?? "exact").toLowerCase();
		const isRegex =
			cell(cells, "regex") === "1" ||
			(cell(cells, "format") ?? "").toLowerCase() === "regex" ||
			matching === "regex";

		if (isRegex) {
			const translated = translateRegex(sourceText, targetText);
			if (!translated) {
				skip(REASON.pattern);
				continue;
			}
			sourceText = translated.source;
			targetText = translated.target;
		} else if (matching === "start" && sourceText.trim().endsWith("/")) {
			sourceText = `${sourceText.trim()}[...rest]`;
		} else if (matching !== "exact") {
			skip(REASON.pattern);
			continue;
		}

		const source = toPath(sourceText);
		if ("reason" in source) {
			skip(source.reason);
			continue;
		}

		const terminal = type === 410 || type === 451;
		let destination = "";
		if (!terminal) {
			if (targetText.trim() === "") {
				skip(REASON.noTarget);
				continue;
			}
			// A full address on another site cannot be a destination in EmDash.
			const absolute = /^https?:\/\//i.test(targetText.trim());
			const sourceHost = /^https?:\/\//i.test(rawSource.trim())
				? parseUrl(rawSource.trim())?.host
				: undefined;
			if (absolute && sourceHost !== parseUrl(targetText.trim())?.host) {
				skip(REASON.external);
				continue;
			}
			const target = toPath(targetText);
			if ("reason" in target) {
				skip(target.reason === REASON.empty ? REASON.noTarget : target.reason);
				continue;
			}
			destination = target.path;
			if (destination === source.path) {
				skip(REASON.same);
				continue;
			}
		}

		if (seen.has(source.path)) {
			skip(REASON.repeated);
			continue;
		}
		const current = existingBySource.get(source.path);
		if (current !== undefined) {
			skip(current === destination ? REASON.exists : REASON.conflict);
			continue;
		}
		seen.add(source.path);
		ready.push({ line, source: source.path, destination, type });
	}

	// A row loops when following its destination through the other rules leads back to it.
	const next = new Map(existingBySource);
	for (const row of ready) next.set(row.source, row.destination);
	const safe: ReadyRow[] = [];
	for (const row of ready) {
		let hop = row.destination;
		let loops = false;
		for (let step = 0; step < 20 && hop !== "" && next.has(hop); step += 1) {
			hop = next.get(hop) ?? "";
			if (hop === row.source) {
				loops = true;
				break;
			}
		}
		if (loops) {
			// Every row in the circle is skipped: which one to keep is not ours to guess.
			skipped.push({ line: row.line, source: row.source, reason: REASON.loop });
		} else safe.push({ source: row.source, destination: row.destination, type: row.type });
	}

	return { format: columns.format, ready: safe, skipped };
}

/** The site's redirects as a list that pastes back into this importer or a spreadsheet. */
export function exportList(
	rules: Array<{ source: string; destination: string; type: number }>,
): string {
	const quote = (value: string) =>
		/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
	return [
		"source,target,code",
		...rules.map((rule) => `${quote(rule.source)},${quote(rule.destination)},${rule.type}`),
	].join("\n");
}
