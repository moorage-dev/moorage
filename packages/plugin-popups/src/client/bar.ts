// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { CLOSE } from "./icons.js";
import type { ClientItem } from "./types.js";

const esc = (text: string) => text.replace(/[&<>"']/g, (ch) => "&#" + ch.charCodeAt(0) + ";");

/**
 * A top bar's own markup, inside its shadow root. One renderer for both
 * places a bar appears: the server writes it into the page for visitors
 * (`barHtml` in fragment.ts), and the browser script draws it for a preview,
 * so the preview looks and sits exactly as a visitor sees it.
 */
export function barInner(item: ClientItem, close: string, tag?: string): string {
	const link = item.c.b
		? ' <a href="' + esc(item.c.b.u) + '" data-pp-go>' + esc(item.c.b.l) + "</a>"
		: "";
	return (
		'<div class="pp bar" role="region" aria-label="Announcement"><div class="i">' +
		// A preview's label is a row of its own above the bar's words.
		(tag ? '<span class="pv">' + esc(tag) + "</span>" : "") +
		esc(item.c.h) +
		(item.c.x ? " " + esc(item.c.x) : "") +
		link +
		'</div><button type="button" class="x" data-pp-close aria-label="' +
		esc(close) +
		'">' +
		CLOSE +
		"</button></div>"
	);
}
