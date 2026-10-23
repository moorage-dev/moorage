// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import type { PluginContext } from "emdash";

import {
	type AdminCall,
	cancelApproval,
	type Intent,
	type Known,
	peekApproval,
	type Shown,
	startApproval,
	withApproval,
} from "./approval.js";
import { routeUrl, saveConfig, saveForms, siteLabel, type State } from "./config.js";
import { withConnected, withListed } from "./forms.js";
import { accessAlert } from "./messages.js";
import type { Meter } from "./meter.js";

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
	known?: Known,
): Promise<Offer> {
	if (!fresh) {
		const live = await peekApproval(ctx, key, known);
		if (live && sameIntent(live.intent, intent)) return { kind: "code", shown: live };
	}
	const started = await startApproval(ctx, origin, key, intent);
	if (started.kind !== "started") return started;
	const { kind: _kind, ...shown } = started;
	return { kind: "code", shown };
}

export { cancelApproval, peekApproval };

export type ConnectOutcome =
	| { kind: "pending" | "busy" | "denied" | "expired" | "missing" }
	| { kind: "unavailable"; revoked?: boolean }
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
	| { kind: "connected"; name: string; already: boolean; listed: Listed[] }
	| { kind: "conflict"; host: string; hash: string; listed: Listed[] };

/**
 * "Done, connect": exchange the approved code once, set the form's webhook to `inbound`, and
 * throw the access away. A different address already on the form is never overwritten unless
 * the admin agreed to replace that very address (`intent.replace`).
 *
 * The access is revoked before anything is saved (see withApproval). Then, while calls are left:
 * the access left behind is reported (it could not be revoked), every listed form is remembered
 * and the form marked connected, in one save. With the run at its 10-call limit on Cloudflare
 * the order matters: the revoke comes first, whatever follows.
 */
export async function finishConnect(
	m: Meter,
	state: State,
	origin: string,
	key: string,
	inbound: string,
	stored: unknown,
	/** The form's short name, as the screen knows it (the code carries it too). */
	formSlug: string,
	/** Calls to keep for the screen that follows: it depends on whether the access was revoked. */
	reserve: (revoked: boolean) => number,
): Promise<ConnectOutcome> {
	const ctx = m.ctx;
	let slug = formSlug;
	let listed: Listed[] = [];
	let connects = false;
	/** The forms with what one-click learned, once it is known. */
	const learned = () => {
		let forms = withListed(state.forms, listed);
		if (connects) forms = withConnected(forms, slug, state.config.keySetAt, "straight");
		return forms;
	};
	const changes = () => JSON.stringify(learned()) !== JSON.stringify(state.forms);
	const result = await withApproval<Work>(
		ctx,
		origin,
		key,
		async (call, intent) => {
			slug = intent.form;
			const items = await listForms(call);
			listed = items;
			const form = items.find((item) => item.slug === intent.form);
			if (!form) {
				throw new Error(
					`There is no form called "${intent.form}" any more. Check its short name in Forms.`,
				);
			}
			const previous =
				typeof form.settings?.webhookUrl === "string" ? form.settings.webhookUrl : "";
			if (previous === inbound) {
				connects = true;
				return { kind: "connected", name: form.name, already: true, listed: items };
			}
			if (previous && !isOurs(previous, origin)) {
				const hash = await addressHash(previous);
				const agreed = intent.replace?.hash === hash;
				if (!agreed) return { kind: "conflict", host: hostOf(previous), hash, listed: items };
			}
			const updated = await call(UPDATE, {
				body: { id: form.id, settings: { webhookUrl: inbound } },
			});
			if (!updated.ok) {
				throw new Error(`EmDash's forms did not accept the change (${updated.status}).`);
			}
			connects = true;
			return { kind: "connected", name: form.name, already: false, listed: items };
		},
		{
			stored,
			// The used code goes only when the writes below still fit: the report of an access left
			// behind (the setup, the email), then the forms.
			canForget: (revoked) => m.left() > reserve(revoked) + (revoked ? 0 : 2) + (changes() ? 1 : 0),
		},
	);
	// Used, refused or gone: never shown again, even when there was no call left to delete it.
	if (result.kind !== "pending" && result.kind !== "busy") state.entries.delete(`approval:${key}`);
	const revoked = "revoked" in result && result.revoked === false ? false : true;
	const keep = reserve(revoked);
	const forms = learned();
	const formsChanged = changes();
	if (!revoked) {
		await reportAccessLeft(m, state, formNameOf(state, slug), keep + (formsChanged ? 1 : 0));
	}
	if (formsChanged && m.left() > keep) {
		state.forms = forms;
		await saveForms(ctx, forms, { mirror: m.left() > keep + 1 });
	}
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
	return {
		kind: "connected",
		form: slug,
		name: work.name,
		already: work.already,
		revoked: result.revoked,
	};
}

function formNameOf(state: State, slug: string): string {
	return state.forms[slug]?.name ?? slug;
}

/**
 * The access could not be thrown away: say so on the page until dismissed (one call, two with
 * the copy for 0.3.0 when there is room), and email the alert list (one call), keeping `reserve`
 * calls for what follows. Not limited to once a day: each one is a separate access.
 */
export async function reportAccessLeft(m: Meter, state: State, formName: string, reserve = 0) {
	const ctx = m.ctx;
	state.config = { ...state.config, accessLeft: { at: new Date().toISOString(), form: formName } };
	const email = Boolean(ctx.email) && state.config.alertTo.length > 0;
	if (m.left() < 1) return;
	await saveConfig(ctx, state.config, { mirror: m.left() > reserve + (email ? 2 : 1) });
	if (!ctx.email || !email || m.left() <= reserve) return;
	const [to, ...cc] = state.config.alertTo;
	try {
		await ctx.email.send({
			to: to!,
			...(cc.length ? { cc } : {}),
			...accessAlert(siteLabel(ctx, state), formName),
		});
	} catch (error) {
		if (m.left() > reserve)
			ctx.log.warn("could not send the access alert", { error: String(error) });
	}
}
