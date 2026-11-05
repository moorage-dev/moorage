// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { pluginResponse, type SandboxedPlugin } from "emdash/plugin";

import { handleAdmin } from "./admin.js";
import {
	ensureConfig,
	loadState,
	PING_KEY,
	PRIVATE_DOMAIN,
	privateEmail,
	rememberOrigin,
} from "./config.js";
import {
	alertIfStuck,
	DAILY_TASK,
	daily,
	deliverRun,
	ensureSchedule,
	isDeliverTask,
	MAINTENANCE_TASK,
	maintenance,
	receive,
	scheduleDelivery,
	tickFresh,
} from "./deliver.js";
import { fromEmail, fromUnreadableEmail, fromWebhook, noteUnreadable } from "./enquiry.js";
import { meter } from "./meter.js";

const FORMS_PLUGIN = "emdash-forms";

function text(status: number, body: string) {
	return pluginResponse({
		status,
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		body: { kind: "text", value: body },
	});
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameKey(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

/**
 * Every hook and route counts its calls to the site (meter.ts): sandboxed on Cloudflare a run may
 * make only 10. Each reads the plugin's KV and settings once, with `ctx.kv.list()`.
 */
const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			const state = await loadState(ctx, { copy: true });
			await ensureConfig(ctx, state);
			await ensureSchedule(ctx, state, true);
		},
		cron: async (event, ctx) => {
			const isOurs =
				isDeliverTask(event.name) || event.name === MAINTENANCE_TASK || event.name === DAILY_TASK;
			if (!isOurs) return;
			const m = meter(ctx);
			const state = await loadState(m.ctx);
			if (isDeliverTask(event.name)) await deliverRun(m, state, event.data);
			else if (event.name === MAINTENANCE_TASK) await maintenance(m, state);
			else await daily(m, state);
		},
		// The email way: a form's notification email to the private address carries the
		// enquiry. It is recorded here and that one email is cancelled; nothing is sent there.
		"email:beforeSend": {
			// Fail closed: if this hook throws or runs out of time, EmDash stops that send
			// ("abort"), so an email to the private address can never fall through to a provider.
			errorPolicy: "abort",
			handler: async (event, ctx) => {
				const message = event.message;
				const isPrivate = (address: string) =>
					address.trim().toLowerCase().endsWith(`@${PRIVATE_DOMAIN}`);
				if (!isPrivate(message.to)) {
					// Never copy anyone at the private domain, whoever sends it.
					if (!message.cc?.some(isPrivate)) return message;
					return { ...message, cc: message.cc.filter((address) => !isPrivate(address)) };
				}
				const m = meter(ctx);
				try {
					if (event.source !== FORMS_PLUGIN) return false;
					const state = await loadState(m.ctx);
					const to = message.to.trim().toLowerCase();
					if (state.config.key && to === privateEmail(state.config.key).toLowerCase()) {
						// A changed email format is still recorded, as text, and the admin says so.
						const received =
							(await fromEmail(message.subject, message.text, state.forms)) ??
							(await fromUnreadableEmail(message.subject, message.text));
						if (received.enquiry.unreadable) await noteUnreadable(m.ctx, received.enquiry.formName);
						// Stored with its log rows (at most 7 calls); the every-minute run delivers it.
						// Nothing is scheduled from here: forms waits for this email before answering the
						// visitor, EmDash refuses a second email from inside this one, and run in the site's
						// process, a task scheduled inside the email pipeline would carry it along and hit
						// the same refusal.
						await receive(m.ctx, state, received.id, received.enquiry);
					}
				} catch (error) {
					if (m.left() > 0)
						m.ctx.log.error("could not record an enquiry from its email", { error: String(error) });
				}
				// Every email to the private domain is cancelled: an old address, another sender, anything.
				return false;
			},
		},
	},
	routes: {
		// The Lead delivery page and its dashboard widget. Editors see the log; only admins change anything.
		admin: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) =>
				handleAdmin(routeCtx.input, routeCtx.user, routeCtx.request.url, ctx),
		},
		// The way straight from a form: the forms plugin's webhook posts each enquiry here.
		inbound: {
			public: true,
			methods: ["POST"],
			request: { body: "json" },
			response: "raw",
			handler: async (routeCtx, ctx) => {
				const m = meter(ctx);
				const state = await loadState(m.ctx);
				const key = new URL(routeCtx.request.url).searchParams.get("key") ?? "";
				if (!state.config.key || !sameKey(key, state.config.key)) {
					return text(
						401,
						"This address's private key is wrong or was reset. Copy the address again: in Lead delivery open the form's delivery and press Connect this form.",
					);
				}
				const payload = routeCtx.input as { formId?: unknown } | null;
				const formId = typeof payload?.formId === "string" ? payload.formId : "";
				const received = fromWebhook(payload, state.forms[formId]);
				if (!received) return text(400, "This is not a form enquiry.");
				// Stored with its log rows first (at most 6 calls with the read above); then, with the
				// calls left, what keeps it moving: the every-minute task if it is missing, a delivery
				// run now, or (when the every-minute task has stopped) the alert that says so.
				const result = await receive(m.ctx, state, received.id, received.enquiry);
				if (result.duplicate) return text(200, "Already received.");
				if (m.left() >= 2) await ensureSchedule(m.ctx, state);
				if (tickFresh(state)) {
					if (result.queued > 0 && m.left() >= 1) await scheduleDelivery(m.ctx);
				} else {
					await alertIfStuck(m, state);
				}
				if (m.left() >= 1) await rememberOrigin(m.ctx, state, routeCtx.request.url);
				return text(200, "Received.");
			},
		},
		// "Check this site": answers with the one-time code only this site knows.
		ping: {
			public: true,
			methods: ["GET"],
			response: "raw",
			handler: async (routeCtx, ctx) => {
				const code = new URL(routeCtx.request.url).searchParams.get("code") ?? "";
				const expected = await ctx.kv.get<string>(PING_KEY);
				const ok = typeof expected === "string" && expected.length > 0 && sameKey(code, expected);
				return text(ok ? 200 : 404, ok ? `lead-delivery:${code}` : "Not found.");
			},
		},
	},
};

export default plugin;
