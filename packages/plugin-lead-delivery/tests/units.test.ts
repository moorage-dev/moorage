// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { isPrivateHost, privateAddressError } from "../src/address.js";
import { chatBody, classifyChat, maskChatUrl, parseChatUrl } from "../src/chat.js";
import { ago, parseAddresses, privateEmail, since } from "../src/config.js";
import { emailFailure, isQuiet } from "../src/deliver.js";
import { fromEmail, fromWebhook, humanize } from "../src/enquiry.js";
import { withListed } from "../src/forms.js";
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
			// The form has a news box; Forms left it out, so it was not ticked.
			["news", "no"],
		]);
		// The same email gives the same ID, so a repeat is a no-op.
		const again = await fromEmail("New submission: Wedding cakes", text, {});
		expect(again?.id).toBe(received?.id);
		expect(again?.enquiry.formId).toBe("wedding-cakes");
	});

	it("lists an unticked checkbox as no, where the form says it has one", async () => {
		const { news: _news, ...data } = PAYLOAD.data;
		const enquiry = fromWebhook({ ...PAYLOAD, data }, CAKES)!.enquiry;
		expect(enquiry.fields.at(-1)).toMatchObject({ key: "news", value: "no" });
		// Not for a form that is not known, nor for a box shown only on a condition.
		expect(
			fromWebhook({ ...PAYLOAD, data }, undefined)!.enquiry.fields.map((f) => f.key),
		).not.toContain("news");
		const conditional: KnownForm = {
			...CAKES,
			fields: CAKES.fields.map((f) => (f.key === "news" ? { ...f, conditional: true } : f)),
		};
		expect(
			fromWebhook({ ...PAYLOAD, data }, conditional)!.enquiry.fields.map((f) => f.key),
		).not.toContain("news");
		// Placed where the form has it, not at the end.
		const release: KnownForm = {
			...CAKES,
			fields: [
				{ key: "email", label: "Email", type: "email" },
				{ key: "release", label: "Tell me about releases", type: "checkbox" },
				{ key: "message", label: "Message", type: "textarea" },
			],
		};
		const both = fromWebhook(
			{ ...PAYLOAD, data: { email: "tom@example.com", message: "Hi" } },
			release,
		)!.enquiry;
		expect(both.fields.map((f) => [f.key, f.value])).toEqual([
			["email", "tom@example.com"],
			["release", "no"],
			["message", "Hi"],
		]);
		// The email way: Forms leaves an unticked box out and writes a ticked one as true.
		const ticked = await fromEmail(
			"New submission: Wedding cakes",
			"Your name: Tom\nSend me news and offers: true\n\nSubmitted at: 2026-10-16T09:00:00.000Z",
			{ [CAKES.slug]: CAKES },
		);
		expect(ticked!.enquiry.fields.find((f) => f.key === "news")?.value).toBe("true");
		expect(enquiryEmail("Crumb", ticked!.enquiry, false).text).toContain(
			"Send me news and offers: yes",
		);
		const unticked = await fromEmail(
			"New submission: Wedding cakes",
			"Your name: Tom\n\nSubmitted at: 2026-10-16T09:00:00.000Z",
			{ [CAKES.slug]: CAKES },
		);
		expect(unticked!.enquiry.fields.find((f) => f.key === "news")?.value).toBe("no");
		// HubSpot still receives nothing for an unticked box, as before.
		const body = hubspotBody(
			hubspot({
				mapping: { "wedding-cakes": { news: "other" } },
				otherNames: { "wedding-cakes": { news: "newsletter" } },
			}),
			enquiry,
		) as {
			fields: Array<{ name: string }>;
			legalConsentOptions?: unknown;
		};
		expect(body.fields.map((f) => f.name)).not.toContain("newsletter");
		expect(body).not.toHaveProperty("legalConsentOptions");
	});

	it("ignores other emails", async () => {
		expect(await fromEmail("Your password", "x", {})).toBeNull();
	});
});

describe("who a reply goes to", () => {
	// A business's public address (optional) before the person's own (required), as Forms 0.2.13
	// lays out a quote form. Forms replies to the first required email field with a value, then to
	// any filled email field; Lead Delivery's Reply-To follows the same rule.
	const pages = [
		{
			fields: [
				{ id: "1", name: "company", label: "Company", type: "text", required: false },
				{ id: "2", name: "company_email", label: "Company email", type: "email", required: false },
				{ id: "3", name: "name", label: "Your name", type: "text", required: true },
				{ id: "4", name: "email", label: "Your email", type: "email", required: true },
			],
		},
	];
	const QUOTE = withListed({}, [{ slug: "quote", name: "Quote", pages }]).quote!;
	const quote = (data: Record<string, string>) =>
		fromWebhook({ ...PAYLOAD, formId: "quote", formName: "Quote", data }, QUOTE)!.enquiry;

	it("reads which fields the form requires from its definition", () => {
		expect(QUOTE.fields.map((f) => [f.key, f.required ?? false])).toEqual([
			["company", false],
			["company_email", false],
			["name", true],
			["email", true],
		]);
	});

	it("is the first required email field with a value, not an optional one before it", async () => {
		const both = { company_email: "hello@acme.test", name: "Ana", email: "ana@example.com" };
		expect(quote(both).email).toBe("ana@example.com");
		const text = [
			'New submission for "Quote"',
			"",
			"Company email: hello@acme.test",
			"Your name: Ana",
			"Your email: ana@example.com",
			"",
			"Submitted at: 2026-10-16T09:00:00.000Z",
		].join("\n");
		const mail = await fromEmail("New submission: Quote", text, { quote: QUOTE });
		expect(mail?.enquiry.email).toBe("ana@example.com");
	});

	it("is the first filled email field when no required one has a value", () => {
		expect(quote({ company_email: "hello@acme.test", name: "Ana" }).email).toBe("hello@acme.test");
	});

	it("is the first filled email field for a form known from before the plugin read `required`", () => {
		const old: KnownForm = {
			...QUOTE,
			fields: QUOTE.fields.map(({ required: _required, ...f }) => f),
		};
		const data = { company_email: "hello@acme.test", name: "Ana", email: "ana@example.com" };
		const enquiry = fromWebhook({ ...PAYLOAD, formId: "quote", data }, old)!.enquiry;
		expect(enquiry.email).toBe("hello@acme.test");
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

	it("sends apps exactly what 0.4.4 sent for ticked and unticked boxes", async () => {
		// Two boxes, one ticked: apps get no key for the unticked one, and the ticked one's value
		// as Forms gave it ("yes" from the webhook, "true" from the email), so a Zap filtering on
		// "field exists" still passes only for people who ticked.
		const BOXES: KnownForm = {
			...CAKES,
			fields: [
				{ key: "email", label: "Email", type: "email" },
				{ key: "news", label: "Send me news", type: "checkbox" },
				{ key: "terms", label: "I agree", type: "checkbox" },
			],
		};
		const at = "2026-10-16T09:00:00.000Z";
		const web = fromWebhook(
			{ ...PAYLOAD, data: { email: "tom@example.com", news: true } },
			BOXES,
		)!.enquiry;
		expect(JSON.stringify(appPayload("01JABCDEF", { ...web, receivedAt: at }, false))).toBe(
			'{"id":"01JABCDEF","event":"enquiry","form":"wedding-cakes","formName":"Wedding cakes","receivedAt":"2026-10-16T09:00:00.000Z","name":null,"email":"tom@example.com","fields":{"email":"tom@example.com","news":"yes"},"labels":{"email":"Email","news":"Send me news"},"pageUrl":null,"utm":{},"marks":[],"throwaway":false,"test":false}',
		);
		const mail = (await fromEmail(
			"New submission: Wedding cakes",
			`Email: tom@example.com\nSend me news: true\n\nSubmitted at: ${at}`,
			{ [BOXES.slug]: BOXES },
		))!.enquiry;
		expect(JSON.stringify(appPayload("m1", { ...mail, receivedAt: at }, false))).toBe(
			'{"id":"m1","event":"enquiry","form":"wedding-cakes","formName":"Wedding cakes","receivedAt":"2026-10-16T09:00:00.000Z","name":null,"email":"tom@example.com","fields":{"email":"tom@example.com","news":"true"},"labels":{"email":"Email","news":"Send me news"},"pageUrl":null,"utm":{},"marks":[],"throwaway":false,"test":false}',
		);
		// People reading it see both boxes, in words.
		const text = enquiryEmail("Crumb", mail, false).text;
		expect(text).toContain("Send me news: yes");
		expect(text).toContain("I agree: no");
		const slack = chatBody(
			{ ...hubspot(), kind: "chat", chat: "slack", url: "https://hooks.slack.com/services/T/B/x" },
			mail,
			false,
			"",
		) as { text: string };
		expect(slack.text).toContain("*Send me news:* yes");
		expect(slack.text).toContain("*I agree:* no");
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

describe("an address on a private network", () => {
	const host = (address: string) => new URL(address).hostname;

	it("is refused for every private, local and reserved IPv4 range", () => {
		for (const address of [
			"https://localhost/hook",
			"https://LOCALHOST./hook",
			"https://app.localhost/hook",
			"https://printer.local/hook",
			"https://router.internal/hook",
			"https://nas.home.arpa/hook",
			"https://127.0.0.1/hook",
			"https://127.8.9.1/hook",
			"https://10.1.2.3/hook",
			"https://172.16.0.1/hook",
			"https://172.31.255.255/hook",
			"https://192.168.1.1/hook",
			"https://169.254.169.254/latest/meta-data",
			"https://0.0.0.0/hook",
			"https://0.1.2.3/hook",
			"https://100.64.0.1/hook",
			"https://100.127.255.254/hook",
			"https://192.0.0.8/hook",
			"https://198.18.0.1/hook",
			"https://224.0.0.1/hook",
			"https://240.0.0.1/hook",
			"https://255.255.255.255/hook",
			"https://192.88.99.1/hook",
			"https://files.localdomain/hook",
			"https://crm.corp/hook",
		]) {
			expect(isPrivateHost(host(address)), address).toBe(true);
		}
	});

	it("is refused when IPv4 is written as one number, in hex or in octal", () => {
		// The address parser turns each of these into 127.0.0.1 or 10.0.0.1; raw text is checked too.
		for (const raw of ["2130706433", "0x7f.1", "0x7f000001", "0177.0.0.1", "127.1", "012.0.0.1"]) {
			expect(isPrivateHost(raw), raw).toBe(true);
			expect(isPrivateHost(host(`https://${raw}/hook`)), raw).toBe(true);
		}
	});

	it("is refused for IPv6 loopback, unique-local, link-local and mapped private IPv4", () => {
		for (const address of [
			"https://[::1]/hook",
			"https://[::]/hook",
			"https://[fc00::1]/hook",
			"https://[fd12:3456:789a::1]/hook",
			"https://[fe80::1]/hook",
			"https://[febf::1]/hook",
			"https://[ff02::1]/hook",
			"https://[::ffff:127.0.0.1]/hook",
			"https://[::ffff:10.0.0.1]/hook",
			"https://[::ffff:7f00:1]/hook",
			"https://[64:ff9b::a00:1]/hook",
			"https://[64:ff9b:1::808:808]/hook",
			"https://[2002:a00:1::1]/hook",
			"https://[2002:7f00:1::]/hook",
			"https://[::ffff:0:10.0.0.1]/hook",
			"https://[::ffff:0:7f00:1]/hook",
			"https://[100::1]/hook",
			"https://[2001:db8::1]/hook",
			"https://[2001:db8:ffff::1]/hook",
		]) {
			expect(isPrivateHost(host(address)), address).toBe(true);
		}
	});

	it("lets public names and public addresses through", () => {
		for (const address of [
			"https://hooks.zapier.com/hooks/catch/1/a/",
			"https://hook.eu1.make.com/abc",
			"https://n8n.crumbandco.uk/webhook/1",
			"https://hooks.slack.com/services/T0/B0/x",
			"https://discord.com/api/webhooks/1/abc",
			"https://172.32.0.1/hook",
			"https://172.15.255.255/hook",
			"https://100.128.0.1/hook",
			"https://8.8.8.8/hook",
			"https://[2606:4700:4700::1111]/hook",
			"https://[2002:808:808::1]/hook",
			"https://[::ffff:0:8.8.8.8]/hook",
			"https://[100:0:0:1::1]/hook",
			"https://[2001:db9::1]/hook",
			"https://192.88.100.1/hook",
			"https://corp.example.com/hook",
			"https://localhost.example.com/hook",
		]) {
			expect(isPrivateHost(host(address)), address).toBe(false);
		}
	});

	it("says so in plain words, and only for a private address", () => {
		expect(privateAddressError("https://172.20.0.5/hook")).toBe(
			"That address is on a private network, so this site cannot send to it.",
		);
		expect(privateAddressError("https://hooks.zapier.com/hooks/catch/1/a/")).toBeUndefined();
	});
});

describe("a Slack or Discord channel's message", () => {
	const SLACK = "https://hooks.slack.com/services/T0ABC/B0DEF/slackSECRETtoken1234";
	const DISCORD = "https://discord.com/api/webhooks/123456789/discordSECRETtokenABCD";
	const chat = (url: string, extra: Partial<Delivery> = {}): Delivery => ({
		id: "chat1",
		kind: "chat",
		name: "Contact us → Slack",
		forms: "all",
		on: true,
		repeat: "off",
		holdSpam: false,
		createdAt: "2026-10-01T00:00:00.000Z",
		url,
		...extra,
	});

	it("knows Slack and Discord webhook addresses, and nothing else", () => {
		expect(parseChatUrl(SLACK)).toEqual({ platform: "slack", url: SLACK });
		expect(parseChatUrl(DISCORD)).toEqual({ platform: "discord", url: DISCORD });
		expect(parseChatUrl("https://discordapp.com/api/webhooks/1/x")).toMatchObject({
			platform: "discord",
		});
		expect(parseChatUrl("https://hooks.zapier.com/hooks/catch/1/a/")).toHaveProperty("error");
		expect(parseChatUrl("http://hooks.slack.com/services/T/B/x")).toHaveProperty("error");
		expect(parseChatUrl("https://hooks.slack.com/")).toHaveProperty("error");
		expect(parseChatUrl("not an address")).toHaveProperty("error");
	});

	it("shows an address without its secret part", () => {
		expect(maskChatUrl(SLACK)).not.toContain("slackSECRET");
		expect(maskChatUrl(SLACK)).toContain("hooks.slack.com");
		expect(maskChatUrl(DISCORD)).not.toContain("discordSECRET");
	});

	it("lists the fields with the marks, and escapes what people wrote", () => {
		const enquiry: Enquiry = {
			...fromWebhook(PAYLOAD, CAKES)!.enquiry,
			spam: true,
			fields: [
				{ key: "name", label: "Your name", value: "Tom <@U123> Reyes" },
				{ key: "message", label: "Message", value: "*bold* & <!here>" },
			],
		};
		const slack = chatBody(
			chat(SLACK, { chat: "slack" }),
			enquiry,
			false,
			"https://crumb.test",
		) as {
			text: string;
		};
		expect(slack.text).toContain("New enquiry: Wedding cakes");
		expect(slack.text).toContain("Possibly spam");
		expect(slack.text).toContain("Tom &lt;@U123&gt; Reyes");
		expect(slack.text).toContain("&amp; &lt;!here&gt;");
		expect(slack.text).toContain(
			"<https://crumb.test/_emdash/admin/plugins/emdash-forms/submissions?formId=wedding-cakes|",
		);
		const discord = chatBody(chat(DISCORD, { chat: "discord" }), enquiry, true, "") as {
			content: string;
			allowed_mentions: unknown;
		};
		expect(discord.allowed_mentions).toEqual({ parse: [] });
		expect(discord.content).toContain("Test enquiry: Wedding cakes");
		expect(discord.content).toContain("\\*bold\\*");
		const long = {
			...enquiry,
			fields: [{ key: "message", label: "Message", value: "x".repeat(5000) }],
		};
		expect(
			(chatBody(chat(DISCORD, { chat: "discord" }), long, false, "") as { content: string }).content
				.length,
		).toBeLessThanOrEqual(2000);
		// No link previews for addresses people typed; a long message keeps its link to Forms.
		expect(discord).toHaveProperty("flags", 4);
		const many = {
			...enquiry,
			fields: Array.from({ length: 8 }, (_, i) => ({
				key: `f${i}`,
				label: `Field ${i}`,
				value: `https://example.com/${"y".repeat(590)}`,
			})),
		};
		const cutDown = (
			chatBody(chat(DISCORD, { chat: "discord" }), many, false, "https://crumb.test") as {
				content: string;
			}
		).content;
		expect(cutDown.length).toBeLessThanOrEqual(2000);
		expect(cutDown).toMatch(
			/\[Open in Forms\]\(<https:\/\/crumb\.test\/_emdash\/admin\/plugins\/emdash-forms\/submissions\?formId=wedding-cakes>\)$/,
		);
		expect(cutDown).toContain("Field 7");
		const quiet = chatBody(chat(SLACK, { chat: "slack", leaveOut: true }), enquiry, false, "") as {
			text: string;
		};
		expect(quiet.text).not.toContain("Tom");
		expect(quiet.text).not.toContain("bold");
		expect(quiet.text).not.toContain(enquiry.email!);
	});

	it("reads Slack's and Discord's answers in plain words", () => {
		const slack = chat(SLACK, { chat: "slack" });
		expect(classifyChat(slack, 200, SLACK, "ok")).toEqual({ kind: "delivered" });
		expect(classifyChat(slack, 429, SLACK, "")).toMatchObject({ kind: "retry" });
		expect(classifyChat(slack, 503, SLACK, "")).toMatchObject({ kind: "retry" });
		const gone = classifyChat(slack, 404, SLACK, "no_service");
		expect(gone).toMatchObject({ kind: "fixing", raw: "Slack answered 404: no_service" });
		expect(gone.plain).toContain("no longer exists");
		expect(classifyChat(slack, 403, SLACK, "action_prohibited")).toMatchObject({ kind: "fixing" });
		expect(JSON.stringify(classifyChat(slack, 200, "https://slack.com/signin", ""))).not.toContain(
			"SECRET",
		);
	});
});

describe("Forms' own auto-reply", () => {
	it("is noted for each form one-click connect lists", () => {
		const forms = withListed({}, [
			{
				slug: "contact",
				name: "Contact",
				settings: { autoresponder: { subject: "Thanks", body: "Hi" } },
			},
			{ slug: "quote", name: "Quote", settings: {} },
			{ slug: "old", name: "Old" },
		]);
		expect(forms.contact?.autoReply?.on).toBe(true);
		expect(forms.quote?.autoReply?.on).toBe(false);
		expect(forms.old?.autoReply).toBeUndefined();
	});
});
