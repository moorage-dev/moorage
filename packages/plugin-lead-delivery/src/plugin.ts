// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { pluginResponse, type SandboxedPlugin } from "emdash/plugin";

import { handleAdmin } from "./admin.js";
import {
	loadConfig,
	loadForms,
	PING_KEY,
	PRIVATE_DOMAIN,
	privateEmail,
	rememberOrigin,
} from "./config.js";
import {
	alertIfStuck,
	DELIVER_TASK,
	ensureSchedule,
	MAINTENANCE_TASK,
	maintenance,
	receive,
	runDue,
} from "./deliver.js";
import { fromEmail, fromUnreadableEmail, fromWebhook, noteUnreadable } from "./enquiry.js";

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

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			await loadConfig(ctx);
			await ensureSchedule(ctx, true);
		},
		cron: async (event, ctx) => {
			if (event.name === DELIVER_TASK) await runDue(ctx);
			else if (event.name === MAINTENANCE_TASK) await maintenance(ctx);
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
				try {
					const config = await loadConfig(ctx);
					const to = message.to.trim().toLowerCase();
					if (event.source === FORMS_PLUGIN && to === privateEmail(config.key).toLowerCase()) {
						// A changed email format is still recorded, as text, and the admin says so.
						const received =
							(await fromEmail(message.subject, message.text, await loadForms(ctx))) ??
							(await fromUnreadableEmail(message.subject, message.text));
						if (received.enquiry.unreadable) await noteUnreadable(ctx, received.enquiry.formName);
						// Delivered by the every-minute run: forms waits for this email before answering
						// the visitor, and EmDash refuses a second email from inside this one. Nothing is
						// scheduled from here either: run in the site's process, a task scheduled inside
						// the email pipeline would carry it along and hit the same refusal.
						await receive(ctx, received.id, received.enquiry, { inline: false, schedule: false });
					}
				} catch (error) {
					ctx.log.error("could not record an enquiry from its email", { error: String(error) });
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
			handler: async (routeCtx, ctx) => {
				await ensureSchedule(ctx);
				await rememberOrigin(ctx, routeCtx.request.url);
				return handleAdmin(routeCtx.input, routeCtx.user, routeCtx.request.url, ctx);
			},
		},
		// The way straight from a form: the forms plugin's webhook posts each enquiry here.
		inbound: {
			public: true,
			methods: ["POST"],
			request: { body: "json" },
			response: "raw",
			handler: async (routeCtx, ctx) => {
				const config = await loadConfig(ctx);
				const key = new URL(routeCtx.request.url).searchParams.get("key") ?? "";
				if (!sameKey(key, config.key)) {
					return text(
						401,
						"This address's private key is wrong or was reset. Copy the address again: in Lead delivery open the form's delivery and press Connect this form.",
					);
				}
				const payload = routeCtx.input as { formId?: unknown } | null;
				const forms = await loadForms(ctx);
				const formId = typeof payload?.formId === "string" ? payload.formId : "";
				const received = fromWebhook(payload, forms[formId]);
				if (!received) return text(400, "This is not a form enquiry.");
				await rememberOrigin(ctx, routeCtx.request.url);
				const result = await receive(ctx, received.id, received.enquiry, { inline: true });
				await ensureSchedule(ctx);
				await alertIfStuck(ctx, config);
				return text(200, result.duplicate ? "Already received." : "Received.");
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
