// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * What the server writes into every public page for the browser script. Keys
 * are short because this goes into every page.
 */

export interface ClientContent {
	/** Heading and text. */
	h: string;
	x: string;
	/** Picture: address, width, height, description. */
	img?: { u: string; w?: number; h?: number; a: string };
	/** One button: label and link (campaign tags already added). */
	b?: { l: string; u: string };
	/** A form from Forms, by short name, and the thank-you heading. */
	form?: string;
	ty?: string;
	/** The quiet way out's words; empty for "only the close button". */
	no: string;
}

export interface ClientItem {
	/** Id, handle (for `#popup-<handle>` and `data-popup`), kind, trigger. */
	i: string;
	n: string;
	/** "inline" (a box in a page) only in a preview: on a page the server draws those. */
	k: "bar" | "slide" | "modal" | "inline";
	t: "read" | "click" | "exit" | "load";
	/** Devices: 0 phones and computers, 1 computers only, 2 phones only. */
	d: 0 | 1 | 2;
	/** Days before it shows again after a close; 0 means never again. */
	a: number;
	/** May open on the first page of a visit (centred popups, computers only). */
	f?: 1;
	/** Start and end, exact moments in milliseconds. */
	s?: number;
	e?: number;
	c: ClientContent;
}

export interface ClientConfig {
	/** Base of this plugin's routes and of the forms plugin's routes, both ending in "/". */
	api: string;
	forms: string;
	/** Light, dark or follow the device; the owner's colours when chosen. */
	sc: "auto" | "light" | "dark";
	col?: { g: string; f: string; x: string; y: string };
	/** Slide-ins in the bottom left corner. */
	left?: 1;
	/** On a preview link: the previewed popup is set to show on this page. */
	here?: 1;
	items: ClientItem[];
	/** Fixed words the visitor can see. */
	t: {
		close: string;
		sending: string;
		failed: string;
		optional: string;
		required: string;
	};
}

/** The draft a signed-in editor previews, from the private preview route. */
export interface PreviewAnswer {
	item: ClientItem;
	/** The popup is turned off or not finished: a real visitor never sees it. */
	off: boolean;
	/** When it ends or starts, in the site's words ("31 Dec, 18:00"). */
	endText?: string;
	startText?: string;
}
