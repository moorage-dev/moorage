// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/** Types for held.mjs, for the plugin's own tests. */

export interface Held {
	kind: "video" | "map";
	name: string;
	link: string;
	player?: string;
}

export function heldKind(value: unknown): Held | undefined;
export const WORDS: Record<
	"en" | "de" | "fr" | "es" | "it" | "nl" | "pt",
	{ video: string; map: string; loadVideo: string; loadMap: string; open: string }
>;
export function placeholderWords(
	lang: string | undefined,
	held: Held,
): { text: string; load: string; open: string };
export function reveal(d: Document, w: Window & { cookieConsent?: { marketing: boolean } }): void;
