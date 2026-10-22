// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import {
	type AdminCall,
	cancelApproval,
	type Intent,
	peekApproval,
	type Shown,
	startApproval,
	withApproval,
} from "./approval.js";
import { loadConfig, routeUrl, saveConfig, siteLabel } from "./config.js";
import { markConnected, rememberListed } from "./forms.js";
import { accessAlert } from "./messages.js";

/**
 * One-click connect: connect a form the webhook way with a one-time admin access the admin
 * approves in EmDash (see approval.ts). Offered only when the site can call its own address,
 * and only to admins (EmDash refuses an Editor's approval anyway).
 */

const LIST = "/_emdash/api/plugins/emdash-forms/forms/list";
const UPDATE = "/_emdash/api/plugins/emdash-forms/forms/update";

/** One code per delivery and admin. */
export function approvalKey(deliveryId: string, userId: string): string {
	return `${deliveryId}:${userId}`;
}

export type Offer = { kind: "code"; shown: Shown } | { kind: "busy" } | { kind: "unavailable" };

function sameIntent(a: Intent, b: Intent): boolean {
	return a.form === b.form && a.replace?.hash === b.replace?.hash;
}

/**
 * The code to show: the live one for this delivery and admin when it is for the same thing, so a
 * screen drawn again never swaps the code the admin is typing; otherwise a new one.
 */
export async function offerApproval(
	ctx: PluginContext,
	origin: string,
	key: string,
	intent: Intent,
	fresh = false,
): Promise<Offer> {
	if (!fresh) {
		const live = await peekApproval(ctx, key);
		if (live && sameIntent(live.intent, intent)) return { kind: "code", shown: live };
	}
	const started = await startApproval(ctx, origin, key, intent);
	if (started.kind !== "started") return started;
	const { kind: _kind, ...shown } = started;
	return { kind: "code", shown };
}

export { cancelApproval, peekApproval };

export type ConnectOutcome =
	| { kind: "pending" | "busy" | "denied" | "expired" | "missing" | "unavailable" }
	| { kind: "connected"; form: string; name: string; already: boolean; revoked: boolean }
	/** The form already sends to another address: nothing was changed. */
	| { kind: "conflict"; form: string; host: string; hash: string; revoked: boolean }
	| { kind: "failed"; reason: string; revoked: boolean };

/** SHA-256 of an address, so a replace can be agreed without keeping the address itself. */
export async function addressHash(address: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hostOf(address: string): string {
	try {
		return new URL(address).host;
	} catch {
		return "another address";
	}
}

/** An older Lead delivery address on this site (before the private address was reset). */
function isOurs(address: string, origin: string): boolean {
	try {
		const url = new URL(address);
		const inbound = new URL(routeUrl(origin, "inbound"));
		return url.host === inbound.host && url.pathname === inbound.pathname;
	} catch {
		return false;
	}
}

interface Listed {
	id: string;
	slug: string;
	name: string;
	pages?: unknown;
	settings?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listForms(call: AdminCall): Promise<Listed[]> {
	const response = await call(LIST);
	if (!response.ok) throw new Error(`EmDash's forms did not list the forms (${response.status}).`);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const items = isRecord(body) && isRecord(body.data) ? body.data.items : undefined;
	if (!Array.isArray(items)) {
		throw new Error("EmDash's forms answered in a way Lead delivery does not know.");
	}
	return items.filter(
		(item): item is Listed =>
			isRecord(item) &&
			typeof item.id === "string" &&
			typeof item.slug === "string" &&
			typeof item.name === "string",
	);
}

type Work =
	| { kind: "connected"; name: string; already: boolean }
	| { kind: "conflict"; host: string; hash: string };

/**
 * "Done, connect": exchange the approved code once, set the form's webhook to `inbound`, and
 * throw the access away. A different address already on the form is never overwritten unless
 * the admin agreed to replace that very address (`intent.replace`).
 */
export async function finishConnect(
	ctx: PluginContext,
	origin: string,
	key: string,
	inbound: string,
	keySetAt: string | undefined,
): Promise<ConnectOutcome> {
	let slug = "";
	const result = await withApproval<Work>(ctx, origin, key, async (call, intent) => {
		slug = intent.form;
		const items = await listForms(call);
		// Remember every form while the list is here, so "Which form?" lists them from now on.
		await rememberListed(ctx, items);
		const form = items.find((item) => item.slug === intent.form);
		if (!form) {
			throw new Error(
				`There is no form called "${intent.form}" any more. Check its short name in Forms.`,
			);
		}
		const previous = typeof form.settings?.webhookUrl === "string" ? form.settings.webhookUrl : "";
		if (previous === inbound) return { kind: "connected", name: form.name, already: true };
		if (previous && !isOurs(previous, origin)) {
			const hash = await addressHash(previous);
			const agreed = intent.replace?.hash === hash;
			if (!agreed) return { kind: "conflict", host: hostOf(previous), hash };
		}
		const updated = await call(UPDATE, {
			body: { id: form.id, settings: { webhookUrl: inbound } },
		});
		if (!updated.ok) {
			throw new Error(`EmDash's forms did not accept the change (${updated.status}).`);
		}
		return { kind: "connected", name: form.name, already: false };
	});
	if (result.kind !== "done") return result;
	const work = result.value;
	if (work.kind === "conflict") {
		return {
			kind: "conflict",
			form: slug,
			host: work.host,
			hash: work.hash,
			revoked: result.revoked,
		};
	}
	await markConnected(ctx, slug, keySetAt, "straight");
	return {
		kind: "connected",
		form: slug,
		name: work.name,
		already: work.already,
		revoked: result.revoked,
	};
}

/**
 * The access could not be thrown away: say so on the page until dismissed, and email the
 * alert list. Not limited to once a day: each one is a separate access.
 */
export async function reportAccessLeft(ctx: PluginContext, formName: string) {
	const config = await loadConfig(ctx);
	await saveConfig(ctx, {
		...config,
		accessLeft: { at: new Date().toISOString(), form: formName },
	});
	if (!ctx.email || config.alertTo.length === 0) return;
	const [to, ...cc] = config.alertTo;
	try {
		await ctx.email.send({
			to: to!,
			...(cc.length ? { cc } : {}),
			...accessAlert(await siteLabel(ctx), formName),
		});
	} catch (error) {
		ctx.log.warn("could not send the access alert", { error: String(error) });
	}
}
