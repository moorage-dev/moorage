// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { Block, BlockResponse } from "@emdash-cms/blocks";

/**
 * The one quiet line at the foot of this plugin's page: the guide, the other free plugins and
 * who made it. Admins only, and an Admin can hide it in Settings; Editors, widgets, editor
 * panels and emails never get it. Block Kit 1.3.1 has no links inside a context line, so it is
 * one row of three plain links. It needs nothing from the site: no call to the host.
 */
export const HELP_LINE = "help_line";
export const GUIDE_URL = "https://moorage.dev/guides/find-and-fix-broken-links-on-emdash";
export const PLUGINS_URL = "https://moorage.dev/plugins";
export const MAKER_URL = "https://moorage.dev";

/** The switch that hides the line, worded the same in every plugin. */
export const HIDE_LABEL = "Hide the help line at the foot of this page";
export const HIDE_DESCRIPTION = "Only admins see it: links to the guide and to more free plugins.";

/** The form field of the switch, for a plugin's own settings form. */
export const HIDE_FIELD = "hide_help_line";
/** The action of the small form below, where a plugin has no settings form to put it in. */
export const HIDE_ACTION = "save_help_line";

/** The switch as a form field; on means hidden. */
export function hideField(hidden: boolean) {
	return {
		type: "toggle" as const,
		action_id: HIDE_FIELD,
		label: HIDE_LABEL,
		description: HIDE_DESCRIPTION,
		initial_value: hidden,
	};
}

/** The switch as its own small form with a Save button. */
export function hideForm(hidden: boolean): Block {
	return {
		type: "form",
		// Changes with the saved value, so the form shows it after a save.
		block_id: `${HELP_LINE}_switch_${hidden ? "on" : "off"}`,
		fields: [hideField(hidden)],
		submit: { label: "Save", action_id: HIDE_ACTION },
	};
}

/** Whether the line is hidden after a form was sent: an untouched switch keeps what is saved. */
export function hiddenFrom(values: Record<string, unknown>, saved: boolean): boolean {
	const sent = values[HIDE_FIELD];
	return typeof sent === "boolean" ? sent : saved;
}

/** The line as Block Kit, or nothing when it is not to be shown. */
export function helpLine(show: boolean): Block[] {
	if (!show) return [];
	const link = (label: string, url: string) => ({
		type: "link" as const,
		label,
		target: { kind: "external" as const, url },
	});
	return [
		// A rule above it, so it reads as the foot of the page, not part of the last tab.
		{ type: "divider", block_id: `${HELP_LINE}_rule` },
		{
			type: "actions",
			block_id: HELP_LINE,
			elements: [
				link("Help", GUIDE_URL),
				link("More free plugins", PLUGINS_URL),
				link("by Moorage", MAKER_URL),
			],
		},
	];
}

/** The response with the line added at its foot. */
export function withHelpLine(response: BlockResponse, show: boolean): BlockResponse {
	return show ? { ...response, blocks: [...response.blocks, ...helpLine(true)] } : response;
}
