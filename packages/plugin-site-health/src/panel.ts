// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";

import { describe, shortFor, type LinkRow, type PageRow } from "./model.js";
import { links, pages } from "./scan.js";
import { KEY, type ScanState } from "./state.js";

/** Problems listed by name in the panel; the rest are counted. */
const PANEL_ROWS = 10;

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

function note(text: string): BlockResponse {
	return { blocks: [{ type: "context", text }] };
}

/**
 * The "Links on this page" panel beside an entry: what the last check and the
 * last save found in this entry's links, read from what is stored. Read-only, no
 * request to any site, two calls at most: the entry's row, then its links (or,
 * when it has no row, the check's state).
 */
export async function handleLinksPanel(
	entry: { collection: string; id: string } | undefined,
	ctx: PluginContext,
): Promise<BlockResponse> {
	if (!entry) return note("Save this page first. Its links are checked once it is published.");
	const found = await pages(ctx).query({
		where: { collection: entry.collection, id: entry.id },
		limit: 5,
	});
	// After a slug change the row at the old address stays until the next sweep;
	// the newest is the entry's (rows from before 0.2.0 have no time and count as oldest).
	let page: PageRow | undefined;
	for (const { data } of found.items) if (!page || (data.at ?? "") > (page.at ?? "")) page = data;
	if (!page) {
		const scan = await ctx.kv.get<ScanState>(KEY.scan);
		if (!scan)
			return note("Links on this page are checked with the first full check of your site.");
		const info = scan.collections.find((c) => c.slug === entry.collection);
		if (info && !info.routable) {
			return note(
				"This has no page of its own on your site, so its links are not listed here. They are checked too.",
			);
		}
		return note("Links on this page are checked with the next full check.");
	}
	if (page.status !== "published")
		return note("Links on this page are checked once it is published.");
	const ids = page.links ?? [];
	if (ids.length === 0) return note("There are no links on this page.");
	const stored = await links(ctx).getMany(ids);
	const listed = ids
		.map((id) => stored.get(id))
		.filter((row): row is LinkRow => row !== undefined && row.editor && row.state !== "fine");
	const left = listed.filter((row) => row.kind === "leftover" && row.state === "left");
	const rows = listed.filter((row) => row.kind !== "leftover");
	const broken = rows.filter((row) => row.state === "broken");
	const look = rows.filter((row) => row.state === "look");
	const unknown = rows.filter((row) => row.state === "unknown");
	const pending = rows.filter((row) => row.state === "pending");
	const ok = rows.filter((row) => row.state === "ok");
	const blocks: Block[] = [];
	const list = (title: string, items: LinkRow[]) => {
		blocks.push({ type: "section", text: `${title} (${items.length})` });
		for (const row of items.slice(0, PANEL_ROWS)) {
			blocks.push({ type: "context", text: describe(row, shortFor(row)) });
		}
		if (items.length > PANEL_ROWS) {
			blocks.push({
				type: "context",
				text: `And ${items.length - PANEL_ROWS} more on the Site Health page.`,
			});
		}
	};
	if (broken.length > 0) list("To fix", broken);
	if (look.length > 0) list("Worth a look", look);
	if (left.length > 0) list("Left over from WordPress", left);
	const counts: string[] = [];
	if (unknown.length > 0) {
		counts.push(
			`${plural(unknown.length, "link")} could not be checked; some sites turn away automatic checkers.`,
		);
	}
	if (pending.length > 0) {
		const elsewhere = pending.every((row) => row.kind === "external");
		counts.push(
			`${plural(pending.length, "link")}${elsewhere ? " to other sites" : ""} ${pending.length === 1 ? "is" : "are"} not checked yet.`,
		);
	}
	if (ok.length > 0) {
		const all = ok.length === rows.length;
		counts.push(
			all
				? ok.length === 1
					? "The 1 link on this page works."
					: `All ${ok.length} links on this page work.`
				: `${plural(ok.length, "link")} ${ok.length === 1 ? "works" : "work"}.`,
		);
	}
	if (counts.length > 0) blocks.push({ type: "context", text: counts.join(" ") });
	blocks.push({
		type: "context",
		text: "These are the links on the published page, updated each time it is published. Links to other sites are checked every week.",
	});
	return { blocks };
}
