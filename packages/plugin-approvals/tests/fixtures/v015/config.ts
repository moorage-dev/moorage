// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

export const CONFIG_KEY = "config";

export const ROLE = { contributor: 20, author: 30, editor: 40, admin: 50 } as const;

/** "others": everyone below Admin is held and Admins approve. "me": everyone is held; Editors and Admins approve. */
export type Preset = "others" | "me";
export type Checks = "remind" | "require" | "off";

export interface Config {
	/** Content types (collection slugs) that need approval. */
	collections: string[];
	preset: Preset;
	/** Anything an AI tool publishes is held, on every content type. */
	ai: boolean;
	checks: Checks;
	/** Remind approvers once after two days. */
	remind: boolean;
}

export const DEFAULT_CONFIG: Config = {
	collections: [],
	preset: "others",
	ai: true,
	checks: "remind",
	remind: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeConfig(value: unknown): Config {
	const raw = isRecord(value) ? value : {};
	const collections = Array.isArray(raw.collections)
		? [...new Set(raw.collections.filter((c): c is string => typeof c === "string" && c !== ""))]
		: [];
	return {
		collections,
		preset: raw.preset === "me" ? "me" : "others",
		ai: raw.ai !== false,
		checks: raw.checks === "require" || raw.checks === "off" ? raw.checks : "remind",
		remind: raw.remind !== false,
	};
}

/**
 * The saved settings, or null until an Admin saves them once: nothing is held before that.
 * Throws when the store cannot be read; the publish hook refuses in that case.
 */
export async function loadConfig(ctx: PluginContext): Promise<Config | null> {
	const stored = await ctx.kv.get(CONFIG_KEY);
	return stored === null || stored === undefined ? null : normalizeConfig(stored);
}

/** The lowest role that approves under a preset. */
export function approverRole(preset: Preset): number {
	return preset === "me" ? ROLE.editor : ROLE.admin;
}

/** Whether a person of this role is held under the preset (AI tools aside). */
export function isHeldRole(preset: Preset, role: number | undefined): boolean {
	return preset === "me" || (role ?? 0) < ROLE.admin;
}
