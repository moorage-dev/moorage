// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { isEmail } from "./config.js";
import { isThrowaway } from "./throwaway.js";
import type { Enquiry, FieldInfo, KnownForm } from "./types.js";

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
const PAGE_KEYS = new Set(["page_url", "pageUrl", "page"]);

/** "cake_date" → "Cake date". Used only when the form's own label is unknown. */
export function humanize(key: string): string {
	const words = key
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.toLowerCase();
	return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/** A form name as a key, for forms only ever seen by name (the email way). */
export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "form"
	);
}

function display(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.map(display).join(", ");
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface Received {
	id: string;
	enquiry: Enquiry;
}

/** Fill in who sent it, attribution and the throwaway flag from the fields. */
export function finish(
	base: Omit<Enquiry, "email" | "name" | "throwaway" | "pageUrl" | "utm"> & {
		pageUrl?: string;
	},
): Enquiry {
	const fields = base.fields;
	const byKey = (test: (f: Enquiry["fields"][number]) => boolean) =>
		fields.find((f) => test(f) && f.value);
	const emailField =
		byKey((f) => f.type === "email" && isEmail(f.value)) ??
		byKey((f) => /e-?mail/i.test(`${f.key} ${f.label}`) && isEmail(f.value)) ??
		byKey((f) => isEmail(f.value));
	const first = byKey((f) => /^(first[_ -]?name|firstname|given[_ -]?name)$/i.test(f.key));
	const last = byKey((f) => /^(last[_ -]?name|lastname|surname|family[_ -]?name)$/i.test(f.key));
	const full =
		byKey((f) => /^(name|full[_ -]?name|your[_ -]?name)$/i.test(f.key)) ??
		byKey((f) => /\bname\b/i.test(f.label) && !/company|business/i.test(f.label));
	const name = full?.value ?? ([first?.value, last?.value].filter(Boolean).join(" ") || undefined);

	const utm: Record<string, string> = {};
	for (const key of UTM_KEYS) {
		const value = fields.find((f) => f.key === key)?.value;
		if (value) utm[key] = value;
	}
	let pageUrl = base.pageUrl;
	if (!pageUrl) {
		const value = fields.find((f) => PAGE_KEYS.has(f.key))?.value;
		if (value && /^https?:\/\//i.test(value)) pageUrl = value;
	}

	const email = emailField?.value.toLowerCase();
	return {
		...base,
		...(email ? { email } : {}),
		...(name ? { name } : {}),
		...(pageUrl ? { pageUrl } : {}),
		...(Object.keys(utm).length > 0 ? { utm } : {}),
		throwaway: isThrowaway(email),
	};
}

/**
 * The forms plugin's webhook payload:
 * `{event:"form.submission", formId(slug), formName, submissionId, data, files, submittedAt}`.
 * Returns null for anything else.
 */
export function fromWebhook(payload: unknown, known: KnownForm | undefined): Received | null {
	if (!isRecord(payload)) return null;
	const { formId, formName, submissionId, data } = payload;
	if (payload.event !== undefined && payload.event !== "form.submission") return null;
	if (typeof formId !== "string" || !formId || formId.length > 120) return null;
	if (typeof submissionId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(submissionId)) return null;
	if (!isRecord(data)) return null;

	const labels = new Map((known?.fields ?? []).map((f) => [f.key, f]));
	const fields: Enquiry["fields"] = [];
	for (const [key, value] of Object.entries(data)) {
		if (key === "_hp" || key === "cf-turnstile-response") continue;
		const text = display(value).slice(0, 10_000);
		if (!text) continue;
		const info = labels.get(key);
		fields.push({
			key,
			label: info?.label ?? humanize(key),
			...(info?.type ? { type: info.type } : {}),
			value: text,
		});
		if (fields.length >= 100) break;
	}
	const files = Array.isArray(payload.files) ? payload.files : [];
	const pageUrl = typeof payload.pageUrl === "string" ? payload.pageUrl : undefined;
	return {
		id: submissionId,
		enquiry: finish({
			formId,
			formName: typeof formName === "string" && formName ? formName.slice(0, 200) : formId,
			receivedAt: new Date().toISOString(),
			fields,
			via: "web",
			hasFiles: files.length > 0,
			...(pageUrl && /^https?:\/\//i.test(pageUrl) ? { pageUrl } : {}),
		}),
	};
}

const SUBJECT_PREFIX = "New submission: ";

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The forms plugin's notification email (the email way):
 * subject `New submission: <form name>`, then `Label: value` lines and `Submitted at: <ISO>`.
 * The ID is a hash of the text, which includes the submission time, so a repeat is a no-op.
 */
export async function fromEmail(
	subject: string,
	text: string,
	forms: Record<string, KnownForm>,
): Promise<Received | null> {
	if (!subject.startsWith(SUBJECT_PREFIX)) return null;
	const formName = subject.slice(SUBJECT_PREFIX.length).trim();
	if (!formName) return null;
	const known = Object.values(forms).find((f) => f.name === formName);
	const knownLabels = new Map((known?.fields ?? []).map((f) => [f.label, f]));

	const lines = text.split(/\r?\n/);
	const fields: Enquiry["fields"] = [];
	let hasFiles = false;
	let inFiles = false;
	for (const [index, line] of lines.entries()) {
		if (index === 0 && line.startsWith("New submission for ")) continue;
		if (line.startsWith("Submitted at: ")) break;
		if (line === "Attached files:") {
			inFiles = true;
			hasFiles = true;
			continue;
		}
		if (inFiles) continue;
		if (line.trim() === "") {
			const last = fields.at(-1);
			if (last && lines[index + 1] && !/^[^:]{1,120}: /.test(lines[index + 1]!)) last.value += "\n";
			continue;
		}
		// A new field starts with a known label, or (form unknown) with "Label: ".
		const knownLabel = [...knownLabels.keys()].find((label) => line.startsWith(`${label}: `));
		const match = knownLabel
			? [line, knownLabel, line.slice(knownLabel.length + 2)]
			: known
				? null
				: /^([^:]{1,120}): (.*)$/.exec(line);
		if (match) {
			const label = match[1]!;
			const info = knownLabels.get(label);
			fields.push({
				key: info?.key ?? label,
				label,
				...(info?.type ? { type: info.type } : {}),
				value: match[2]!.trim(),
			});
		} else if (fields.length > 0) {
			const last = fields.at(-1)!;
			last.value = `${last.value}${last.value.endsWith("\n") ? "" : "\n"}${line}`;
		}
	}
	for (const field of fields) field.value = field.value.trim();
	if (fields.length === 0) return null;

	return {
		id: `m${(await sha256(`${subject}\n${text}`)).slice(0, 40)}`,
		enquiry: finish({
			formId: known?.slug ?? slugify(formName),
			formName,
			receivedAt: new Date().toISOString(),
			fields: fields.filter((f) => f.value),
			via: "email",
			hasFiles,
		}),
	};
}

/** Fields of a form as the plugin knows them, for matching and tests. */
export function fieldsOf(enquiry: Enquiry): FieldInfo[] {
	return enquiry.fields.map(({ key, label, type }) => ({ key, label, ...(type ? { type } : {}) }));
}

export const UNREADABLE_KEY = "unreadable";

/**
 * An email to the private address that does not read as the forms plugin's notification (its
 * format changed, or something else sent it). Kept as one block of text so nothing is lost.
 */
export async function fromUnreadableEmail(subject: string, text: string): Promise<Received> {
	const formName =
		(subject.startsWith(SUBJECT_PREFIX) ? subject.slice(SUBJECT_PREFIX.length) : subject).trim() ||
		"A form";
	const email = /[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[A-Za-z]{2,}/.exec(text)?.[0];
	return {
		id: `m${(await sha256(`${subject}\n${text}`)).slice(0, 40)}`,
		enquiry: {
			...finish({
				formId: slugify(formName),
				formName,
				receivedAt: new Date().toISOString(),
				fields: [
					{ key: "text", label: "Enquiry", type: "textarea", value: text.trim().slice(0, 10_000) },
					...(email ? [{ key: "email", label: "Email", type: "email", value: email }] : []),
				],
				via: "email",
				hasFiles: false,
			}),
			unreadable: true,
		},
	};
}

/** Remember that a form's email could not be read field by field, for the admin's banner. */
export async function noteUnreadable(ctx: PluginContext, formName: string) {
	await ctx.kv.set(UNREADABLE_KEY, { formName, at: new Date().toISOString() });
}
