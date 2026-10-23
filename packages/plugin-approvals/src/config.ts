// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import { pickSettings, type SettingsKeys } from "./settings-store.js";

/**
 * Where the settings are kept: `ctx.settings` "config" (KV key `settings:config`),
 * the same in-process and sandboxed. Up to 0.1.5 it was the plain KV key `config`,
 * still written for rollback (see settings-store.ts).
 */
export const CONFIG: SettingsKeys = { name: "config", legacy: "config" };

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
 *
 * One call to the site whichever place the settings are in: `ctx.kv.list()` returns both
 * the settings and the plain key earlier releases used. Settings found only under the plain
 * key are copied forward (one more call) only with `copy`: the Approvals page does that, as it
 * has calls to spare; hooks, actions and emails never do.
 */
export async function loadConfig(
	ctx: PluginContext,
	{ copy = false }: { copy?: boolean } = {},
): Promise<Config | null> {
	const entries = new Map((await ctx.kv.list()).map((entry) => [entry.key, entry.value]));
	const stored = await pickSettings(ctx, entries, CONFIG, { copy });
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
