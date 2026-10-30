// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { ago, parseAddresses, privateEmail, since } from "../src/config.js";
import { emailFailure, isQuiet } from "../src/deliver.js";
import { fromEmail, fromWebhook, humanize } from "../src/enquiry.js";
import {
	autoChoice,
	classifyHubSpot,
	hubspotBody,
	matchedCount,
	parseHubSpot,
} from "../src/hubspot.js";
import {
	enquiryEmail,
	failureAlert,
	instructions,
	quietAlert,
	repeatNote,
} from "../src/messages.js";
import { isThrowaway, THROWAWAY_COUNT } from "../src/throwaway.js";
import type { Delivery, Enquiry, KnownForm, Send } from "../src/types.js";
import { appPayload, classifyApp, sign } from "../src/webhook.js";

const CAKES: KnownForm = {
	slug: "wedding-cakes",
	name: "Wedding cakes",
	source: "definition",
	addedAt: "2026-10-01T00:00:00.000Z",
	days: [],
	fields: [
		{ key: "name", label: "Your name", type: "text" },
		{ key: "email", label: "Email address", type: "email" },
		{ key: "phone", label: "Phone", type: "tel" },
		{ key: "cake_date", label: "When do you need it?", type: "date" },
		{ key: "message", label: "Message", type: "textarea" },
		{ key: "news", label: "Send me news and offers", type: "checkbox" },
	],
};

const PAYLOAD = {
	event: "form.submission",
	formId: "wedding-cakes",
	formName: "Wedding cakes",
	submissionId: "01JABCDEF",
	data: {
		name: "Tom Reyes",
		email: "Tom.Reyes@gmail.com",
		phone: "07700 900123",
		cake_date: "2026-11-21",
		message: "Three tiers, lemon and elderflower.",
		news: true,
		_hp: "",
	},
	files: [],
	submittedAt: "2026-10-16T09:00:00.000Z",
};

function hubspot(overrides: Partial<Delivery> = {}): Delivery {
	return {
		id: "hs",
		kind: "hubspot",
		name: "HubSpot",
		forms: "all",
		on: true,
		repeat: "off",
		holdSpam: false,
		createdAt: "2026-10-01T00:00:00.000Z",
		portalId: "4410287",
		formGuid: "9f1c2b3a-1111-2222-3333-444455556666",
		...overrides,
	};
}

describe("enquiries from the forms plugin", () => {
	it("reads the webhook payload with the form's own labels", () => {
		const received = fromWebhook(PAYLOAD, CAKES);
		expect(received?.id).toBe("01JABCDEF");
		const enquiry = received!.enquiry;
		expect(enquiry).toMatchObject({
			formId: "wedding-cakes",
			name: "Tom Reyes",
			email: "tom.reyes@gmail.com",
			via: "web",
			throwaway: false,
		});
		expect(enquiry.fields.map((f) => f.label)).toEqual([
			"Your name",
			"Email address",
			"Phone",
			"When do you need it?",
			"Message",
			"Send me news and offers",
		]);
		expect(enquiry.fields.at(-1)?.value).toBe("yes");
	});

	it("names fields from their keys when the form is not known", () => {
		expect(humanize("cake_date")).toBe("Cake date");
		expect(fromWebhook(PAYLOAD, undefined)?.enquiry.fields[3]?.label).toBe("Cake date");
	});

	it("refuses anything that is not a form enquiry", () => {
		expect(fromWebhook({ hello: 1 }, undefined)).toBeNull();
		expect(fromWebhook({ ...PAYLOAD, event: "other" }, undefined)).toBeNull();
		expect(fromWebhook({ ...PAYLOAD, submissionId: "../x" }, undefined)).toBeNull();
		expect(fromWebhook("text", undefined)).toBeNull();
	});

	it("keeps the page address and UTM values when the form carries them", () => {
		const received = fromWebhook(
			{
				...PAYLOAD,
				data: {
					...PAYLOAD.data,
					page_url: "https://crumb.test/cakes",
					utm_source: "instagram",
				},
			},
			undefined,
		);
		expect(received?.enquiry.pageUrl).toBe("https://crumb.test/cakes");
		expect(received?.enquiry.utm).toEqual({ utm_source: "instagram" });
	});

	it("reads the notification email, including a message over several lines", async () => {
		const text = [
			'New submission for "Wedding cakes"',
			"",
			"Your name: Tom Reyes",
			"Email address: tom@example.com",
			"Message: Three tiers.",
			"Lemon and elderflower.",
			"",
			"Attached files:",
			"  - plan.pdf (2 KB)",
			"",
			"Submitted at: 2026-10-16T09:00:00.000Z",
		].join("\n");
		const received = await fromEmail("New submission: Wedding cakes", text, {
			[CAKES.slug]: CAKES,
		});
		expect(received?.enquiry).toMatchObject({
			formId: "wedding-cakes",
			name: "Tom Reyes",
			email: "tom@example.com",
			via: "email",
			hasFiles: true,
		});
		expect(received?.enquiry.fields.map((f) => [f.key, f.value])).toEqual([
			["name", "Tom Reyes"],
			["email", "tom@example.com"],
			["message", "Three tiers.\nLemon and elderflower."],
		]);
		// The same email gives the same ID, so a repeat is a no-op.
		const again = await fromEmail("New submission: Wedding cakes", text, {});
		expect(again?.id).toBe(received?.id);
		expect(again?.enquiry.formId).toBe("wedding-cakes");
	});

	it("ignores other emails", async () => {
		expect(await fromEmail("Your password", "x", {})).toBeNull();
	});
});

describe("HubSpot", () => {
	it("reads the portal and form from embed code, the editor address and a share link", () => {
		expect(
			parseHubSpot(
				'<script>hbspt.forms.create({ region: "eu1", portalId: "4410287", formId: "9f1c2b3a-1111-2222-3333-444455556666" });</script>',
			),
		).toEqual({ portalId: "4410287", formGuid: "9f1c2b3a-1111-2222-3333-444455556666" });
		expect(
			parseHubSpot(
				"https://app.hubspot.com/forms/4410287/editor/9f1c2b3a-1111-2222-3333-444455556666/edit/form",
			),
		).toEqual({ portalId: "4410287", formGuid: "9f1c2b3a-1111-2222-3333-444455556666" });
		// 1 + the form ID as 22 base64url characters + the portal ID.
		expect(parseHubSpot("https://share.hsforms.com/1nxwrOhERIiIzM0REVVVmZg4410287")).toEqual({
			portalId: "4410287",
			formGuid: "9f1c2b3a-1111-2222-3333-444455556666",
		});
		expect(parseHubSpot("https://example.com")).toHaveProperty("error");
	});

	it("matches fields by name and type, and leaves the rest for the owner", () => {
		expect(CAKES.fields.map(autoChoice)).toEqual([
			"fullname",
			"email",
			"phone",
			"",
			"message",
			"consent",
		]);
		expect(matchedCount(hubspot(), CAKES.slug, CAKES.fields)).toBe(5);
	});

	it("splits the name, sends only matched fields, and sends consent only when ticked", () => {
		const enquiry = fromWebhook(PAYLOAD, CAKES)!.enquiry;
		const body = hubspotBody(hubspot(), enquiry) as {
			fields: Array<{ name: string; value: string }>;
			legalConsentOptions?: { consent: { consentToProcess: boolean; text: string } };
			context?: unknown;
		};
		expect(body.fields.map((f) => [f.name, f.value])).toEqual([
			["firstname", "Tom"],
			["lastname", "Reyes"],
			["email", "Tom.Reyes@gmail.com"],
			["phone", "07700 900123"],
			["message", "Three tiers, lemon and elderflower."],
		]);
		expect(body.legalConsentOptions?.consent).toEqual({
			consentToProcess: true,
			text: "Send me news and offers",
		});
		expect(body.context).toBeUndefined();

		const unticked = { ...enquiry, fields: enquiry.fields.filter((f) => f.key !== "news") };
		expect(hubspotBody(hubspot(), unticked)).not.toHaveProperty("legalConsentOptions");
		expect(hubspotBody(hubspot({ gdpr: true }), unticked)).toHaveProperty(
			"legalConsentOptions.consent.consentToProcess",
			true,
		);
	});

	it("sends a typed field name, the throwaway mark and the page address with its UTM values", () => {
		const enquiry: Enquiry = {
			...fromWebhook(PAYLOAD, CAKES)!.enquiry,
			throwaway: true,
			pageUrl: "https://crumb.test/cakes",
			utm: { utm_source: "instagram" },
		};
		const place = hubspot({
			mapping: { "wedding-cakes": { cake_date: "other" } },
			otherNames: { "wedding-cakes": { cake_date: "event_date" } },
			throwawayField: "throwaway_email",
		});
		const body = hubspotBody(place, enquiry) as {
			fields: Array<{ name: string; value: string }>;
			context: { pageUri: string };
		};
		expect(body.fields).toContainEqual({
			objectTypeId: "0-1",
			name: "event_date",
			value: "2026-11-21",
		});
		expect(body.fields).toContainEqual({
			objectTypeId: "0-1",
			name: "throwaway_email",
			value: "true",
		});
		expect(body.context.pageUri).toBe("https://crumb.test/cakes?utm_source=instagram");
	});

	it("says what to fix when HubSpot refuses, and retries when it does not answer", () => {
		const refused = classifyHubSpot(
			400,
			JSON.stringify({
				errors: [
					{
						errorType: "FIELD_NOT_IN_FORM_DEFINITION",
						message: 'Property "event_date" does not exist on form',
					},
				],
			}),
		);
		expect(refused).toMatchObject({ kind: "fixing", field: "event_date" });
		expect(refused.plain).toContain("does not have the field event_date");
		expect(refused.raw).toContain("FIELD_NOT_IN_FORM_DEFINITION");
		expect(
			classifyHubSpot(
				400,
				JSON.stringify({ errors: [{ errorType: "FORM_HAS_RECAPTCHA_ENABLED" }] }),
			).plain,
		).toContain("Turn off CAPTCHA");
		expect(classifyHubSpot(404, "").kind).toBe("fixing");
		expect(classifyHubSpot(503, "").kind).toBe("retry");
		expect(classifyHubSpot(429, "").kind).toBe("retry");
		expect(classifyHubSpot(204, "").kind).toBe("delivered");
	});
});

describe("another app", () => {
	it("signs like the Standard Webhooks test vector", async () => {
		expect(
			await sign(
				"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
				"msg_p5jXN8AQM9LWM0D4loKWxJek",
				1614265330,
				'{"test": 2432232314}',
			),
		).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
	});

	it("sends flat JSON with labels", () => {
		const payload = appPayload("01JABCDEF", fromWebhook(PAYLOAD, CAKES)!.enquiry, false);
		expect(payload).toMatchObject({
			id: "01JABCDEF",
			form: "wedding-cakes",
			email: "tom.reyes@gmail.com",
			fields: { cake_date: "2026-11-21" },
			labels: { cake_date: "When do you need it?" },
			test: false,
		});
	});

	it("treats a deleted Zap and a sign-in redirect as needing a fix", () => {
		const place: Delivery = {
			...hubspot(),
			kind: "app",
			app: "zapier",
			url: "https://hooks.zapier.com/hooks/catch/1/a/",
		};
		expect(classifyApp(place, 404, "", "").plain).toBe(
			"That address no longer exists at Zapier: the Zap may be off or deleted. Check the address, then try again.",
		);
		expect(classifyApp(place, 200, "https://zapier.com/login", "").kind).toBe("fixing");
		expect(classifyApp(place, 200, "https://hooks.zapier.com/hooks/catch/1/a", "").kind).toBe(
			"delivered",
		);
		expect(classifyApp(place, 502, "", "").kind).toBe("retry");
	});
});

describe("emails and words", () => {
	it("writes the enquiry email with labels, the page and the site name", () => {
		const enquiry = { ...fromWebhook(PAYLOAD, CAKES)!.enquiry, pageUrl: "https://crumb.test/x" };
		const email = enquiryEmail("Crumb & Co.", enquiry, false);
		expect(email.subject).toBe("Crumb & Co.: new enquiry from Tom Reyes (Wedding cakes)");
		expect(email.text).toContain("When do you need it?: 2026-11-21");
		expect(email.text).not.toContain("cake_date");
		expect(email.text).toContain("Page: https://crumb.test/x");
		expect(email.text).toContain("Reply to this email to answer Tom.");
	});

	it("starts every alert subject with the site name", () => {
		expect(failureAlert("Crumb & Co.", []).subject).toMatch(/^Crumb & Co\.: /);
		expect(quietAlert("Crumb & Co.", ["No enquiries from Newsletter since Monday."]).subject).toBe(
			"Crumb & Co.: no enquiries from Newsletter since Monday",
		);
	});

	it("puts the service's own words in the failure alert and says Send again once", () => {
		const zap = { id: "p1", name: "Zapier", app: "zapier", url: "https://x.test" } as Delivery;
		const refused = classifyApp(zap, 400, "", "Invalid payload");
		const row = (who: string, plain?: string, raw?: string): Send => ({
			enquiryId: who,
			destination: "p1",
			formId: "wedding-cakes",
			formName: "Wedding cakes",
			who,
			status: "fixing",
			attempts: 1,
			nextAt: "",
			createdAt: "2026-10-16T09:00:00.000Z",
			notes: [],
			...(plain ? { plain } : {}),
			...(raw ? { raw } : {}),
		});
		const sendAgain = (text: string) => text.match(/Send again/g)?.length ?? 0;

		const one = failureAlert("Crumb & Co.", [
			{
				send: row(
					"Tom Reyes",
					refused.plain,
					"Zapier answered 400:   Invalid payload:\n  missing   email  ",
				),
				name: "Zapier",
			},
		]).text;
		expect(one).toContain(
			`${refused.plain}\n\nZapier answered 400: Invalid payload: missing email\n`,
		);
		expect(sendAgain(one)).toBe(1);

		// An HTML error page arrives as plain words, cut short.
		const html = `Zapier answered 400: <!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>Bad   request</p>${"x".repeat(400)}</body></html>`;
		const page = failureAlert("Crumb & Co.", [
			{ send: row("Tom", refused.plain, html), name: "Zapier" },
		]).text;
		expect(page).toContain("Zapier answered 400: Bad request xxx");
		expect(page).not.toMatch(/<|color:red/);
		expect(page).toContain("x…\n");

		// A reason that does not say Send again: the email says it once, with where it is.
		const gone = classifyApp(zap, 404, "", "").plain!;
		const missing = failureAlert("Crumb & Co.", [
			{ send: row("Ann", gone, "Zapier answered 404"), name: "Zapier" },
		]).text;
		expect(sendAgain(missing)).toBe(1);
		expect(missing).toContain("press Send again in Lead delivery → Enquiries.");

		// Two rows that each say it: once per row, no extra footer.
		const two = failureAlert("Crumb & Co.", [
			{ send: row("Tom", refused.plain), name: "Zapier" },
			{ send: row("Ann", refused.plain), name: "Zapier" },
		]).text;
		expect(sendAgain(two)).toBe(2);
		expect(two).not.toContain("in Lead delivery → Enquiries.");
	});

	it("never says the service's own words are below when it gave none", () => {
		const zap = { id: "p1", name: "Zapier", app: "zapier", url: "https://x.test" } as Delivery;
		for (const body of ["", "  \n "]) {
			const app = classifyApp(zap, 400, "", body);
			expect(app.plain).toBe(
				"Zapier refused the enquiry without saying why (it answered 400). Check the address and the app, then press Send again.",
			);
		}
		for (const body of ["", "{}", '{"errors":[{"errorType":"SOMETHING"}]}']) {
			expect(classifyHubSpot(400, body).plain).not.toContain("own words");
			expect(classifyHubSpot(400, body).plain).toContain("without saying why (it answered 400)");
		}
		expect(classifyHubSpot(400, '{"message":"Bad form"}').plain).toContain(
			"Its own words are below.",
		);
		// A timeout, a network error or an empty 500 is tried again, never refused for good.
		expect(classifyApp(zap, 500, "", "").kind).toBe("retry");

		const row = (plain: string, raw?: string): Send => ({
			enquiryId: "01A",
			destination: "p1",
			formId: "wedding-cakes",
			formName: "Wedding cakes",
			who: "Tom",
			status: "fixing",
			attempts: 1,
			nextAt: "",
			createdAt: "2026-10-16T09:00:00.000Z",
			notes: [],
			plain,
			...(raw ? { raw } : {}),
		});
		const said =
			"Zapier refused the enquiry. Its own words are below. Check the address and the app, then press Send again.";
		// A row stored before this fix, with the claim but no words (none, or only markup).
		for (const raw of [undefined, "  ", "<html><body></body></html>"]) {
			const { text } = failureAlert("Crumb", [{ send: row(said, raw), name: "Zapier" }]);
			expect(text).not.toContain("own words");
			expect(text).toContain(
				"Zapier refused the enquiry. Check the address and the app, then press Send again.",
			);
		}
		// Gave up after no answer: the reason does not claim words, the error is shown as it is.
		const gaveUp = failureAlert("Crumb", [
			{
				send: row(
					"Zapier did not answer after 8 tries over two days. Check it is working, then press Send again.",
					"No answer: TimeoutError: The operation timed out.",
				),
				name: "Zapier",
			},
		]).text;
		expect(gaveUp).not.toContain("own words");
		expect(gaveUp).toContain("No answer: TimeoutError: The operation timed out.");
	});

	it("sends the failure alert as plain text only, with the service's words as text", () => {
		const alert = failureAlert("Crumb", [
			{
				send: {
					enquiryId: "01A",
					destination: "p1",
					formId: "f",
					formName: "Wedding cakes",
					who: "Tom",
					status: "fixing",
					attempts: 1,
					nextAt: "",
					createdAt: "2026-10-16T09:00:00.000Z",
					notes: [],
					plain: "Zapier refused the enquiry. Its own words are below.",
					raw: `Zapier answered 400: <script>alert("x")</script>Tom & "Jerry's" <b>cakes</b>`,
				},
				name: "Zapier",
			},
		]);
		// No HTML body exists, so there is nothing to escape; the text body has no markup.
		expect(Object.keys(alert).sort()).toEqual(["subject", "text"]);
		expect(alert.text).toContain(`Zapier answered 400: Tom & "Jerry's" cakes`);
		expect(alert.text).not.toMatch(/<|alert\(/);
	});

	it("says how long before a repeat came, by elapsed time, not calendar day", () => {
		const label = repeatNote;
		const MIN = 60_000;
		const HOUR = 60 * MIN;
		expect(label(0)).toBe("Same address less than a minute earlier");
		expect(label(59 * 1000)).toBe("Same address less than a minute earlier");
		expect(label(MIN)).toBe("Same address 1 minute earlier");
		expect(label(5 * MIN)).toBe("Same address 5 minutes earlier");
		expect(label(59 * MIN)).toBe("Same address 59 minutes earlier");
		expect(label(60 * MIN)).toBe("Same address 1 hour earlier");
		expect(label(23 * HOUR + 59 * MIN)).toBe("Same address 23 hours earlier");
		expect(label(24 * HOUR)).toBe("Same address 1 day earlier");
		expect(label(47 * HOUR + 59 * MIN)).toBe("Same address 1 day earlier");
		expect(label(48 * HOUR)).toBe("Same address 2 days earlier");
		expect(label(6 * 24 * HOUR + 23 * HOUR)).toBe("Same address 6 days earlier");
	});

	it("writes instructions for the way that works on this site", () => {
		const key = "k".repeat(32);
		const byEmail = instructions({
			site: "Crumb",
			origin: "https://crumb.test",
			key,
			form: { slug: "contact", name: "Contact us" },
			reach: "email",
		});
		expect(byEmail).toContain(privateEmail(key));
		expect(byEmail).toContain("keeping the addresses");
		const direct = instructions({
			site: "Crumb",
			origin: "https://crumb.test",
			key,
			form: { slug: "contact", name: "Contact us" },
			reach: "self",
		});
		expect(direct).toContain(
			`"webhookUrl":"https://crumb.test/_emdash/api/plugins/lead-delivery/inbound?key=${key}"`,
		);
	});

	it("reads several addresses and refuses a wrong one", () => {
		expect(parseAddresses("Anna@crumb.test, sam@pixel.dev")).toEqual({
			list: ["anna@crumb.test", "sam@pixel.dev"],
		});
		expect(parseAddresses("anna@crumb.test, nope")).toEqual({ bad: "nope" });
	});

	it("says times in plain words", () => {
		const now = Date.parse("2026-10-16T12:00:00Z");
		expect(ago("2026-10-16T11:48:00Z", now)).toBe("12 min ago");
		expect(ago("2026-10-15T10:00:00Z", now)).toBe("yesterday");
		expect(since("2026-10-12T10:00:00Z", now)).toBe("since Monday");
	});

	it("knows the common throwaway domains", () => {
		expect(isThrowaway("x@mailinator.com")).toBe(true);
		expect(isThrowaway("x@gmail.com")).toBe(false);
		expect(THROWAWAY_COUNT).toBeGreaterThanOrEqual(140);
	});
});

describe("an email that could not be sent", () => {
	it("names the EmDash update when the sandbox could not use the site's email service", () => {
		// EmDash 1.3.x on Cloudflare: registry (sandboxed) plugins got "Email is not configured"
		// although the site had an email service; fixed in 1.4.0 (emdash-cms/emdash#4281).
		const outcome = emailFailure(new Error("Email is not configured"));
		expect(outcome.kind).toBe("fixing");
		expect(outcome.plain).toContain("EmDash 1.4.0");
		expect(outcome.plain).toContain("press Send again");
	});

	it("tries again later when the email service turned it down", () => {
		const outcome = emailFailure(new Error("Rate limit exceeded"));
		expect(outcome).toEqual({
			kind: "retry",
			raw: "The email could not be sent: Error: Rate limit exceeded",
		});
	});
});

describe("a quiet form", () => {
	const form = (lastAt: string, days: string[]): KnownForm => ({ ...CAKES, lastAt, days });
	const now = Date.parse("2026-10-16T12:00:00Z");

	it("is one that usually gets enquiries and has had none for 3 days", () => {
		expect(
			isQuiet(form("2026-10-12T09:00:00Z", ["2026-10-02", "2026-10-07", "2026-10-12"]), now),
		).toBe(true);
	});

	it("is not a form that rarely gets any, or one that sent recently", () => {
		expect(isQuiet(form("2026-10-12T09:00:00Z", ["2026-10-12"]), now)).toBe(false);
		expect(
			isQuiet(form("2026-10-15T09:00:00Z", ["2026-10-02", "2026-10-07", "2026-10-15"]), now),
		).toBe(false);
	});
});
