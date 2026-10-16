// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Turns field values into plain text, and two texts into a few words about what changed.

/** Keys inside rich text that hold no words a reader sees. */
const SKIP_KEYS = new Set([
	"id",
	"style",
	"listItem",
	"level",
	"markDefs",
	"marks",
	"href",
	"url",
	"src",
]);

const PICTURE_TYPES = new Set(["image", "file", "media", "gallery"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain text of one field's value: rich text and blocks become paragraphs. */
export function textOf(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		return value
			.map((item) => textOf(item))
			.filter((text) => text !== "")
			.join("\n");
	}
	if (isRecord(value)) {
		// A Portable Text block: its words are the children's text, joined without breaks.
		if (Array.isArray(value.children)) {
			return value.children
				.map((child) =>
					isRecord(child) && typeof child.text === "string" ? child.text : textOf(child),
				)
				.join("")
				.trim();
		}
		const parts: string[] = [];
		for (const [key, inner] of Object.entries(value)) {
			if (key.startsWith("_") || SKIP_KEYS.has(key)) continue;
			const text = textOf(inner);
			if (text !== "") parts.push(text);
		}
		return parts.join("\n");
	}
	return "";
}

export interface FieldInfo {
	slug: string;
	label: string;
	type: string;
}

export interface FieldText {
	slug: string;
	label: string;
	text: string;
	/** Pictures and files: compared by value, described as "changed". */
	picture?: boolean;
	/** For pictures: a stable string of the value, to tell whether it changed. */
	value?: string;
}

/** The text copy of a version: one entry per field, in the schema's order. */
export function textCopy(
	fields: FieldInfo[],
	data: Record<string, unknown>,
	title: { slug: string; label: string } | null,
): FieldText[] {
	const known =
		fields.length > 0
			? fields
			: Object.keys(data).map((slug) => ({ slug, label: slug, type: "string" }));
	const copy: FieldText[] = [];
	for (const field of known) {
		if (field.slug.startsWith("_")) continue;
		const value = data[field.slug];
		if (PICTURE_TYPES.has(field.type)) {
			copy.push({
				slug: field.slug,
				label: field.label,
				text: value ? "(picture)" : "",
				picture: true,
				value: value === undefined || value === null ? "" : JSON.stringify(value),
			});
		} else {
			copy.push({ slug: field.slug, label: field.label, text: textOf(value) });
		}
	}
	if (title && !copy.some((f) => f.slug === title.slug)) {
		copy.unshift({ slug: title.slug, label: title.label, text: textOf(data[title.slug]) });
	}
	return copy;
}

const CHANGES_SHOWN = 5;
const PHRASE_CHARS = 60;
// Above this many word pairs the comparison is not attempted word by word.
const MAX_CELLS = 400_000;

function clip(text: string): string {
	return text.length <= PHRASE_CHARS ? text : `${text.slice(0, PHRASE_CHARS - 1).trimEnd()}…`;
}

function words(text: string): string[] {
	return text.split(/\s+/).filter((w) => w !== "");
}

type Tense = "future" | "past";

interface Hunk {
	removed: string[];
	added: string[];
}

/** Runs of removed and added words, from a longest-common-subsequence walk. */
function hunks(before: string[], after: string[]): Hunk[] | null {
	const n = before.length;
	const m = after.length;
	if (n * m > MAX_CELLS) return null;
	// lcs[i][j]: length of the common subsequence of before[i..] and after[j..].
	const lcs: Uint32Array[] = [];
	for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		const row = lcs[i]!;
		const next = lcs[i + 1]!;
		for (let j = m - 1; j >= 0; j--) {
			row[j] = before[i] === after[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
		}
	}
	const result: Hunk[] = [];
	let current: Hunk = { removed: [], added: [] };
	const flush = () => {
		if (current.removed.length > 0 || current.added.length > 0) result.push(current);
		current = { removed: [], added: [] };
	};
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && before[i] === after[j]) {
			flush();
			i++;
			j++;
		} else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
			current.added.push(after[j]!);
			j++;
		} else {
			current.removed.push(before[i]!);
			i++;
		}
	}
	flush();
	return result;
}

function phrase(hunk: Hunk, tense: Tense): string {
	const removed = clip(hunk.removed.join(" "));
	const added = clip(hunk.added.join(" "));
	if (removed && added)
		return `"${removed}" ${tense === "future" ? "becomes" : "became"} "${added}"`;
	if (added) return `${tense === "future" ? "adds" : "added"} "${added}"`;
	return `${tense === "future" ? "removes" : "removed"} "${removed}"`;
}

/** What changed in one text, in a few words: `"£3.20" becomes "£3.40"; adds "pavlova"`. */
export function describeTextChange(before: string, after: string, tense: Tense): string {
	const found = hunks(words(before), words(after));
	if (found === null)
		return tense === "future" ? "rewritten throughout" : "was rewritten throughout";
	const shown = found.slice(0, CHANGES_SHOWN).map((h) => phrase(h, tense));
	const more = found.length - shown.length;
	const sentence = shown.join("; ");
	return more > 0 ? `${sentence}; and ${more} more ${more === 1 ? "change" : "changes"}` : sentence;
}

export interface FieldChange {
	label: string;
	text: string;
}

/** Every field whose text differs between two copies, described in words. */
export function describeChanges(
	before: FieldText[],
	after: FieldText[],
	tense: Tense,
): FieldChange[] {
	const old = new Map(before.map((f) => [f.slug, f]));
	const changes: FieldChange[] = [];
	for (const field of after) {
		const previous = old.get(field.slug);
		old.delete(field.slug);
		if (field.picture) {
			if ((previous?.value ?? "") !== (field.value ?? "")) {
				changes.push({ label: field.label, text: "changed" });
			}
			continue;
		}
		const was = previous?.text ?? "";
		if (was === field.text) continue;
		changes.push({ label: field.label, text: `${describeTextChange(was, field.text, tense)}.` });
	}
	for (const gone of old.values()) {
		if (gone.text !== "")
			changes.push({ label: gone.label, text: tense === "future" ? "removed." : "was removed." });
	}
	return changes;
}

/** Stable JSON: object keys sorted, so equal values always give equal strings. */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value)
			.filter((k) => value[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

/** Identifies one version of a page: its content and address. */
export async function fingerprint(
	data: Record<string, unknown>,
	slug: string | null,
): Promise<string> {
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) if (!key.startsWith("_")) clean[key] = value;
	const bytes = new TextEncoder().encode(stableStringify({ data: clean, slug: slug ?? null }));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Code points only, no control characters, at most `max`: what EmDash accepts as a reason. */
export function cleanReason(text: string, max = 500): string {
	let out = "";
	let count = 0;
	for (const ch of text.trim()) {
		const code = ch.codePointAt(0)!;
		if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) continue;
		if (count === max - 1) {
			out += "…";
			count++;
			break;
		}
		out += ch;
		count++;
	}
	return out.trim() || "Sent for approval. Not live yet.";
}

/** A short hash of each field's value, to name the fields a save changed. Not for security. */
export function fieldHashes(data: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(data)) {
		if (key.startsWith("_")) continue;
		let h = 0x811c9dc5;
		const text = stableStringify(value);
		for (let i = 0; i < text.length; i++) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		out[key] = h.toString(16);
	}
	return out;
}

/** The fields whose values differ between two sets of hashes. */
export function changedFields(
	before: Record<string, string>,
	after: Record<string, string>,
): string[] {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter((k) => before[k] !== after[k]);
}

/** "Ellen Marsh", "Ellen Marsh and Tom Achebe", "A, B and C". */
export function nameList(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
