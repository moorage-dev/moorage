// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import type { Config, Delivery } from "./types.js";

/**
 * The deliveries' secrets (an app's signing secret, a Slack or Discord channel's webhook
 * address) in EmDash's encrypted plugin storage: one setting, `secrets`, declared `type: "secret"`
 * in the manifest, so EmDash encrypts it with the site's EMDASH_ENCRYPTION_KEY. It holds a JSON
 * text `{"v":1,"d":{"<delivery id>":{"secret"?,"url"?}}}`; a delivery whose secret is there is
 * marked `sealed` in the setup and carries no copy of it.
 *
 * - Read: the setting arrives decrypted with the one `ctx.kv.list()` every path makes (config.ts),
 *   so reading costs no call.
 * - Write: only from the admin page, when a secret is made or changed, on the first visit after
 *   updating, and from "Encrypt them now". EmDash refuses to write it without a key; the secrets
 *   then stay in the setup as plain text, as up to 0.4.4, and the page says so.
 * - Upgrade: secrets saved as plain text by 0.4.4 and earlier are read as before, then moved here
 *   on the next admin visit when the site has a key.
 * - Key lost or changed: EmDash cannot decrypt the setting, and its list of the plugin's keys
 *   fails as a whole. loadState then reads the setup and the forms on their own, so enquiries are
 *   still stored and every other delivery still sends; the page asks for the key back or offers
 *   to forget the secrets. Nothing is written to the setting meanwhile, so putting the old key
 *   back restores them.
 */
export const SECRETS_SETTING = "secrets";

export interface Sealed {
	secret?: string;
	url?: string;
}

export type SecretMap = Record<string, Sealed>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The secrets from the setting's text; anything Lead delivery did not write reads as none. */
export function parseSecrets(value: unknown): SecretMap {
	if (typeof value !== "string") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return {};
	}
	if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.d)) return {};
	const out: SecretMap = {};
	for (const [id, entry] of Object.entries(parsed.d)) {
		if (!isRecord(entry)) continue;
		const item: Sealed = {};
		if (typeof entry.secret === "string" && entry.secret) item.secret = entry.secret;
		if (typeof entry.url === "string" && entry.url) item.url = entry.url;
		if (item.secret || item.url) out[id] = item;
	}
	return out;
}

/** Whether an error is EmDash failing to encrypt or decrypt a secret setting. */
export function isSecretError(error: unknown): boolean {
	return /PluginSettingEncryption|encryption key|secret setting|EMDASH_ENCRYPTION_KEY/i.test(
		String(error),
	);
}

/** The delivery's secret part, wherever it is kept: an app's secret, a channel's address. */
function plainPart(d: Delivery): Sealed | null {
	if (d.kind === "app" && d.secret) return { secret: d.secret };
	if (d.kind === "chat" && d.url) return { url: d.url };
	return null;
}

/** Whether this delivery's secret is still kept as plain text in the setup. */
export function hasPlainSecret(d: Delivery): boolean {
	return !d.sealed && plainPart(d) !== null;
}

/** Whether this delivery has a secret at all (kept either way). */
export function hasSecret(d: Delivery): boolean {
	return d.sealed === true || plainPart(d) !== null;
}

/**
 * The delivery as sending needs it: with its secret and channel address read from the encrypted
 * storage when it is kept there. `missing` when it is kept there but cannot be found.
 */
export function unsealed(
	d: Delivery,
	secrets: SecretMap,
): { delivery: Delivery; missing: boolean } {
	if (!d.sealed) return { delivery: d, missing: false };
	const kept = secrets[d.id];
	const delivery: Delivery = { ...d };
	if (d.kind === "app" && kept?.secret) delivery.secret = kept.secret;
	if (d.kind === "chat" && kept?.url) delivery.url = kept.url;
	const missing = d.kind === "app" ? !kept?.secret : d.kind === "chat" ? !kept?.url : false;
	return { delivery, missing };
}

/** The delivery as the setup keeps it once its secret is in the encrypted storage. */
function stripped(d: Delivery): Delivery {
	const { secret: _secret, ...rest } = d;
	if (d.kind === "chat") {
		const { url: _url, ...noUrl } = rest;
		return { ...noUrl, sealed: true };
	}
	return { ...rest, sealed: true };
}

/** The 0.1 setup kept for rollback, without the app secrets it carried. */
function strippedPlaces(places: unknown[] | undefined): unknown[] | undefined {
	if (!places) return places;
	return places.map((place) => {
		if (!isRecord(place) || !("secret" in place)) return place;
		const { secret: _secret, ...rest } = place;
		return rest;
	});
}

export interface SealResult {
	config: Config;
	/** The secrets now kept, for the rest of the run. */
	secrets: SecretMap;
	/** One call was made (the write), whether or not it worked. */
	tried: boolean;
	sealed: boolean;
}

/**
 * Move every secret still kept as plain text into the encrypted storage: one call when there is
 * one to move, none otherwise. On success the setup comes back without them (the caller saves
 * it); without a key EmDash refuses, and the setup comes back as it was, noting when.
 * `unreadable`: the stored secrets cannot be read now (key lost), so nothing is written over them.
 */
export async function sealSecrets(
	ctx: Pick<PluginContext, "settings">,
	config: Config,
	secrets: SecretMap,
	unreadable = false,
): Promise<SealResult> {
	const plain = config.deliveries.filter(hasPlainSecret);
	if (plain.length === 0 || unreadable) return { config, secrets, tried: false, sealed: false };
	const next: SecretMap = {};
	for (const d of config.deliveries) {
		if (d.sealed && secrets[d.id]) next[d.id] = secrets[d.id]!;
		const part = hasPlainSecret(d) ? plainPart(d) : null;
		if (part) next[d.id] = part;
	}
	try {
		await ctx.settings.set(SECRETS_SETTING, JSON.stringify({ v: 1, d: next }));
	} catch {
		return {
			config: { ...config, secretsPlainAt: new Date().toISOString() },
			secrets,
			tried: true,
			sealed: false,
		};
	}
	const { secretsPlainAt: _at, places, ...rest } = config;
	const kept = strippedPlaces(places);
	return {
		config: {
			...rest,
			...(kept ? { places: kept } : {}),
			deliveries: config.deliveries.map((d) => (hasPlainSecret(d) ? stripped(d) : d)),
		},
		secrets: next,
		tried: true,
		sealed: true,
	};
}

/** Where the deliveries' secrets are kept, for the page to say. */
export type SecretStore = "none" | "encrypted" | "plain" | "unreadable";

export function secretStore(config: Config, unreadable: boolean): SecretStore {
	if (unreadable) return "unreadable";
	if (config.deliveries.some(hasPlainSecret)) return "plain";
	if (config.deliveries.some((d) => d.sealed)) return "encrypted";
	return "none";
}
