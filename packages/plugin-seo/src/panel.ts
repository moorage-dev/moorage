// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { excerptOf, truncateTitle } from "./checks.js";
import {
	CONFIG_KEY,
	defaultTypeForCollection,
	normalizeConfig,
	type PageSchemaType,
} from "./config.js";
import { buildGraph } from "./graph.js";
import { PAGE_TYPES, typeLabel } from "./page-types.js";
import { entryKey, entryStore, rebuildEntry } from "./record.js";
import { parseUrl } from "./url.js";

const ADMIN_ROLE = 50;
// Issues shown before "and N more".
const ISSUES_SHOWN = 3;
// Google shows roughly this much of a description.
const DESCRIPTION_CHARS = 160;
const SAME_AS_OTHERS = "default";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "example.com › services › cleaning", the way Google shows an address. */
function breadcrumbLine(url: string): string {
	const parsed = parseUrl(url);
	if (!parsed) return url;
	const parts = parsed.pathname.split("/").filter((part) => part !== "");
	return [parsed.host, ...parts].join(" › ");
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The "Google preview" panel in the entry editor. It shows saved values only:
 * EmDash gives a general-purpose plugin no way to read what is being typed.
 */
export async function handlePanel(
	input: unknown,
	entry: { collection: string; id: string } | undefined,
	role: number | undefined,
	ctx: PluginContext,
): Promise<BlockResponse> {
	if (!entry) return { blocks: [] };
	const admin = (role ?? 0) >= ADMIN_ROLE;
	const interaction = isRecord(input) ? input : {};
	const config = normalizeConfig(await ctx.kv.get(CONFIG_KEY));
	const store = entryStore(ctx);
	const key = entryKey(entry.collection, entry.id);
	let toast: BlockResponse["toast"];

	// A menu, not a form: the panel sits inside the editor's own form, and a form
	// cannot be nested in another.
	const savingType =
		admin && interaction.type === "block_action" && interaction.action_id === "set_type";

	// Always rebuilt from the saved entry, so the panel never shows stale checks.
	const [rebuilt, publicUrl] = await Promise.all([
		rebuildEntry(ctx, entry.collection, entry.id, config),
		ctx.content?.getPublicUrl?.(entry.collection, entry.id),
	]);
	let record = rebuilt?.record;
	const item = rebuilt?.entry;
	if (record && savingType) {
		const chosen = typeof interaction.value === "string" ? interaction.value : SAME_AS_OTHERS;
		const type = PAGE_TYPES.find((option) => option.value === chosen)?.value;
		const { type: _previous, ...rest } = record;
		record = type ? { ...rest, type } : rest;
		await store.put(key, record);
		toast = { type: "success", message: "Saved. Google will pick this up next time it visits." };
	}
	if (!record || !item) {
		return {
			blocks: [{ type: "context", text: "Save this page to see how it may look on Google." }],
		};
	}

	if (record.status === "skip") {
		return {
			blocks: [
				{
					type: "context",
					text: "This kind of content has no page of its own, so Google only sees it inside other pages. There is nothing to set here.",
				},
			],
		};
	}

	const siteName = config.site.name ?? ctx.site.name;
	const root = ctx.site.url.replace(/\/+$/, "");
	// Without a public address from EmDash, guess one; a page called "home" is the front page.
	const guessed = ["home", "index", ""].includes(item.slug ?? "")
		? `${root}/`
		: `${root}/${item.slug}`;
	// The front page lives at the site's root, whatever its entry is called.
	const front = ["home", "index"].includes(item.slug ?? "");
	const url = front ? `${root}/` : (publicUrl ?? guessed);
	const title = record.title || "(no title)";
	const written = item.seo?.description?.trim() ?? "";
	// As EmDash does on the page itself: no SEO description means the excerpt is used.
	const fromExcerpt = written === "" && excerptOf(item.data) !== "";
	const description = written || excerptOf(item.data);
	const collectionType: PageSchemaType =
		config.collections[entry.collection]?.type ?? defaultTypeForCollection(entry.collection);
	const type = record.type ?? collectionType;
	const hidden = record.status === "hidden";
	const issues = record.issues ?? [];

	const blocks: Block[] = [
		{
			type: "context",
			text: siteName ? `${siteName} · ${breadcrumbLine(url)}` : breadcrumbLine(url),
		},
		{ type: "header", text: truncateTitle(title) },
		{
			type: "section",
			text:
				description === ""
					? "No description yet. Google will pick some text from the page."
					: clip(description, DESCRIPTION_CHARS),
		},
		...(fromExcerpt
			? [
					{
						type: "context" as const,
						text: "This description is the page's excerpt. To write a different one for search, fill in Meta Description in the SEO panel.",
					},
				]
			: []),
		{
			type: "context",
			text: "What Google sees: the published page, with the SEO title and description as last saved. Google may rewrite them, and your site may add its name to the title.",
		},
		{
			type: "fields",
			fields: [
				{ label: "Shown to Google as", value: typeLabel(type) },
				{
					label: "In search results",
					value:
						record.status === "draft" ? "Not published yet" : hidden ? "Hidden from search" : "Yes",
				},
			],
		},
	];

	if (issues.length === 0) {
		blocks.push({ type: "context", text: "Nothing to fix on this page." });
	} else {
		const ordered = [...issues].sort(
			(a, b) => Number(b.level === "fix") - Number(a.level === "fix"),
		);
		for (const issue of ordered.slice(0, ISSUES_SHOWN)) {
			blocks.push(
				{
					type: "section",
					text: `${issue.level === "fix" ? "To fix" : "Worth a look"}: ${issue.message}`,
				},
				{ type: "context", text: issue.fix },
			);
		}
		if (ordered.length > ISSUES_SHOWN) {
			blocks.push({ type: "context", text: `And ${ordered.length - ISSUES_SHOWN} more.` });
		}
	}

	if (admin) {
		const graph = buildGraph({
			page: {
				url,
				path: parseUrl(url)?.pathname ?? "/",
				locale: item.locale,
				kind: "content",
				pageType: "website",
				title,
				pageTitle: title,
				description: description === "" ? null : description,
				canonical: item.seo?.canonical ?? null,
				image: null,
				content: { collection: entry.collection, id: entry.id, slug: item.slug },
			},
			config,
			record,
			noindex: hidden,
			site: ctx.site,
		});
		blocks.push(
			{ type: "divider" },
			{
				type: "actions",
				elements: [
					{
						type: "menu",
						action_id: "set_type",
						label: "Change page type",
						items: [
							{
								label: `Same as other pages here (${typeLabel(collectionType)})`,
								value: SAME_AS_OTHERS,
							},
							...PAGE_TYPES.map(({ value, label }) => ({ value, label })),
						],
					},
					// Google can only test a page it can reach.
					...(/^https?:\/\//.test(url)
						? [
								{
									type: "link" as const,
									label: "Test on Google",
									target: {
										kind: "external" as const,
										url: `https://search.google.com/test/rich-results?url=${encodeURIComponent(url)}`,
									},
								},
							]
						: []),
				],
			},
			{
				type: "accordion",
				label: "View the markup",
				blocks: [
					{
						type: "context",
						text: "The schema markup (JSON-LD) this page sends to search engines.",
					},
					{
						type: "code",
						language: "jsonc",
						code: JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2),
					},
				],
			},
		);
	}

	return { blocks, ...(toast ? { toast } : {}) };
}
