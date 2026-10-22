// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from "vitest";

import { migrate, normalizeConfig } from "../src/config.js";
import { finish } from "../src/enquiry.js";
import { enquiryEmail, failureAlert, instructions } from "../src/messages.js";
import { destinationLabel, formsLabel, generatedName, rowLabel } from "../src/names.js";
import { isPossiblySpam, SPAM_PHRASES } from "../src/spam.js";
import type { Delivery, Enquiry, KnownForm } from "../src/types.js";
import { appPayload } from "../src/webhook.js";

const form = (slug: string, name: string, extra: Partial<KnownForm> = {}): KnownForm => ({
	slug,
	name,
	fields: [],
	source: "enquiry",
	addedAt: "2026-10-01T00:00:00.000Z",
	days: [],
	...extra,
});

const FORMS: Record<string, KnownForm> = {
	contact: form("contact", "Contact form", { lastAt: "2026-10-20T09:00:00.000Z" }),
	quote: form("quote", "Quote"),
	"wedding-cakes": form("wedding-cakes", "Wedding cakes"),
};

/** A 0.1 config: three places, as an owner set them up. */
const OLD = {
	places: [
		{
			id: "mail1abcde",
			kind: "email",
			name: "Email to shop@crumbandco.uk",
			forms: "all",
			on: true,
			noDuplicates: false,
			createdAt: "2026-10-02T00:00:00.000Z",
			to: ["shop@crumbandco.uk"],
		},
		{
			id: "hubs2abcde",
			kind: "hubspot",
			name: "HubSpot",
			forms: ["contact", "quote"],
			on: true,
			noDuplicates: true,
			createdAt: "2026-10-03T00:00:00.000Z",
			portalId: "4410287",
			formGuid: "9f1c2b3a-1111-2222-3333-444455556666",
			mapping: { contact: { name: "fullname" }, quote: { email: "email", when: "skip" } },
			otherNames: { contact: { x: "my_field" } },
			gdpr: true,
			throwawayField: "possibly_fake_email",
		},
		{
			id: "app3abcdef",
			kind: "app",
			name: "My Zap",
			forms: ["contact", "quote", "wedding-cakes"],
			on: false,
			noDuplicates: false,
			createdAt: "2026-10-04T00:00:00.000Z",
			app: "zapier",
			url: "https://hooks.zapier.com/hooks/catch/1/a/",
			secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0",
		},
	],
	alertTo: ["anna@crumbandco.uk"],
	key: "K".repeat(32),
	reach: { result: "email", at: "2026-10-05T00:00:00.000Z" },
	testedAt: "2026-10-06T00:00:00.000Z",
};

describe("moving a 0.1 setup to deliveries", () => {
	it("keeps every id, address, secret, matching and setting, and names each delivery", () => {
		const config = migrate(OLD, FORMS);
		expect(config.version).toBe(2);
		expect(config.key).toBe(OLD.key);
		expect(config.alertTo).toEqual(OLD.alertTo);
		expect(config.reach).toEqual(OLD.reach);
		expect(config.notice).toBe(true);
		expect(config.testedAt).toBe(OLD.testedAt); // kept for a rollback to 0.1.2
		expect(config.places).toEqual(OLD.places);
		expect(config.deliveries.map((d) => d.id)).toEqual(["mail1abcde", "hubs2abcde", "app3abcdef"]);

		const [mail, hub, app] = config.deliveries as [Delivery, Delivery, Delivery];
		expect(mail).toEqual({
			id: "mail1abcde",
			kind: "email",
			name: "All forms → Shop inbox",
			oldName: "Email to shop@crumbandco.uk",
			forms: "all",
			on: true,
			repeat: "off",
			holdSpam: false,
			createdAt: "2026-10-02T00:00:00.000Z",
			to: ["shop@crumbandco.uk"],
		});
		expect(hub).toMatchObject({
			name: "Contact form and Quote → HubSpot",
			oldName: "HubSpot",
			forms: ["contact", "quote"],
			repeat: "24h",
			holdSpam: false,
			portalId: "4410287",
			formGuid: "9f1c2b3a-1111-2222-3333-444455556666",
			mapping: OLD.places[1]!.mapping,
			otherNames: OLD.places[1]!.otherNames,
			gdpr: true,
			throwawayField: "possibly_fake_email",
		});
		expect(app).toMatchObject({
			name: "Contact form and 2 more → Zapier",
			on: false,
			repeat: "off",
			app: "zapier",
			url: OLD.places[2]!.url,
			secret: OLD.places[2]!.secret,
		});
	});

	it("does nothing the second time", () => {
		const once = migrate(OLD, FORMS);
		expect(migrate(once, FORMS)).toEqual(once);
		expect(normalizeConfig(once)).toEqual(once);
	});

	it("never throws on a damaged setup", () => {
		expect(() => migrate({ places: [null, 3, { id: 5 }] }, {})).not.toThrow();
		expect(migrate({ places: [null, 3, { id: 5 }] }, {}).deliveries).toEqual([]);
		expect(migrate(undefined, {}).deliveries).toEqual([]);
		expect(migrate(undefined, {}).notice).toBeUndefined();
	});
});

describe("delivery names", () => {
	it("says which forms", () => {
		expect(formsLabel("all", FORMS)).toBe("All forms");
		expect(formsLabel(["contact"], FORMS)).toBe("Contact form");
		expect(formsLabel(["contact", "quote"], FORMS)).toBe("Contact form and Quote");
		expect(formsLabel(["contact", "quote", "wedding-cakes"], FORMS)).toBe(
			"Contact form and 2 more",
		);
		expect(formsLabel(["unknown-form"], FORMS)).toBe("unknown-form");
	});

	it("says where, from the address or the app", () => {
		const email = (to: string[]) => destinationLabel({ kind: "email", to });
		expect(email(["shop@crumbandco.uk"])).toBe("Shop inbox");
		expect(email(["info@crumbandco.uk"])).toBe("Info inbox");
		expect(email(["enquiries@crumbandco.uk"])).toBe("Enquiries inbox");
		expect(email(["anna@crumbandco.uk"])).toBe("anna@crumbandco.uk");
		expect(email(["shop@crumbandco.uk", "anna@crumbandco.uk"])).toBe("2 inboxes");
		expect(destinationLabel({ kind: "hubspot" })).toBe("HubSpot");
		expect(destinationLabel({ kind: "app", app: "make" })).toBe("Make");
		expect(destinationLabel({ kind: "app", app: "other" })).toBe("your app");
		expect(generatedName(["contact"], { kind: "email", to: ["shop@crumbandco.uk"] }, FORMS)).toBe(
			"Contact form → Shop inbox",
		);
	});

	it("adds the type to a row only when the name does not say it", () => {
		const d = (name: string, kind: Delivery["kind"], app?: Delivery["app"]) =>
			({ name, kind, ...(app ? { app } : {}) }) as Delivery;
		expect(rowLabel(d("Contact form → Shop inbox", "email"))).toBe(
			"Contact form → Shop inbox · Email",
		);
		expect(rowLabel(d("Contact form → HubSpot", "hubspot"))).toBe("Contact form → HubSpot");
		expect(rowLabel(d("Wedding cakes → Zapier", "app", "zapier"))).toBe("Wedding cakes → Zapier");
		expect(rowLabel(d("Bakery leads", "app", "n8n"))).toBe("Bakery leads · n8n");
	});
});

describe("possibly spam", () => {
	const fields = (data: Record<string, string>) =>
		Object.entries(data).map(([key, value]) => ({
			key,
			label: key,
			value,
			...(key === "email" ? { type: "email" } : {}),
			...(key === "message" ? { type: "textarea" } : {}),
		}));

	it("is a guess from simple signals", () => {
		expect(
			isPossiblySpam(
				fields({ message: "Grow your traffic fast! See example.com, example.net and example.org" }),
			),
		).toBe(true);
		expect(isPossiblySpam(fields({ message: "We offer SEO services at a low price." }))).toBe(true);
		expect(isPossiblySpam(fields({ message: "https://spam.example/offer" }))).toBe(true);
		expect(isPossiblySpam(fields({ name: "Win big http://x.example", message: "hi" }))).toBe(true);
	});

	it("leaves ordinary enquiries alone, whatever their addresses and pages", () => {
		expect(
			isPossiblySpam(
				fields({
					name: "Tom Reyes",
					email: "tom@example.com",
					message: "Three tiers, lemon. Our venue is at venue.co.uk.",
					page_url: "https://crumb.test/contact?utm_source=a.com",
					utm_source: "news.example.com",
				}),
			),
		).toBe(false);
	});

	it("keeps a short built-in list", () => {
		expect(SPAM_PHRASES.length).toBeGreaterThanOrEqual(15);
		expect(SPAM_PHRASES.length).toBeLessThanOrEqual(25);
	});

	it("is worked out on receipt", () => {
		const enquiry = finish({
			formId: "contact",
			formName: "Contact form",
			receivedAt: "2026-10-22T09:00:00.000Z",
			fields: fields({ name: "Jo", email: "jo@example.com", message: "Need backlinks?" }),
			via: "web",
			hasFiles: false,
		});
		expect(enquiry.spam).toBe(true);
	});
});

describe("form names in sentences", () => {
	it("never says 'form form' for a form whose name ends in form", () => {
		const enquiry: Enquiry = {
			formId: "contact",
			formName: "Contact form",
			receivedAt: "2026-10-22T09:00:00.000Z",
			fields: [{ key: "name", label: "Your name", value: "Tom" }],
			name: "Tom",
			via: "web",
			throwaway: false,
			hasFiles: false,
		};
		expect(enquiryEmail("Crumb", enquiry, false).text).toContain(
			"Tom sent the Contact form on your website.",
		);
		expect(enquiryEmail("Crumb", { ...enquiry, formName: "Quote" }, false).text).toContain(
			"sent the Quote form",
		);
		const text = instructions({
			site: "Crumb",
			origin: "https://crumb.test",
			key: "k".repeat(32),
			form: { slug: "contact", name: "Contact form" },
			reach: "self",
		});
		expect(text).toContain("Connecting the Contact form on Crumb");
		const alert = failureAlert("Crumb", [
			{
				send: {
					enquiryId: "1",
					destination: "d",
					formId: "contact",
					formName: "Contact form",
					who: "Tom",
					status: "fixing",
					attempts: 1,
					nextAt: "",
					createdAt: "2026-10-22T09:00:00.000Z",
					notes: [],
				},
				name: "Contact form → HubSpot",
			},
		]);
		for (const t of [text, alert.text]) expect(t).not.toMatch(/form form/i);
	});
});

describe("marks on what is delivered", () => {
	const base: Enquiry = {
		formId: "contact",
		formName: "Contact form",
		receivedAt: "2026-10-22T09:00:00.000Z",
		fields: [
			{ key: "name", label: "Your name", value: "Ben Ortiz" },
			{ key: "email", label: "Email address", type: "email", value: "ben@mailinator.com" },
		],
		email: "ben@mailinator.com",
		name: "Ben Ortiz",
		via: "web",
		throwaway: false,
		hasFiles: false,
	};

	it("lists every mark at the top of the email, and leaves an unmarked email as it was", () => {
		const marked = enquiryEmail(
			"Crumb & Co.",
			{ ...base, throwaway: true, spam: true, repeatAfterMs: 3 * 3_600_000 },
			false,
		);
		expect(marked.text.split("\n").slice(0, 3)).toEqual([
			"Marked: possibly fake address · same address 3 hours earlier · possibly spam",
			"These marks are a guess. Lead delivery still sends marked enquiries.",
			"",
		]);
		expect(marked.subject).toBe("Crumb & Co.: new enquiry from Ben Ortiz (Contact form)");
		const plain = enquiryEmail("Crumb & Co.", base, false);
		expect(plain.text.startsWith("Ben Ortiz (ben@mailinator.com) sent the Contact form")).toBe(
			true,
		);
	});

	it("gives apps a marks list and how long before a repeat came", () => {
		expect(appPayload("1", base, false)).toMatchObject({ marks: [], throwaway: false });
		expect("repeatAfterMinutes" in appPayload("1", base, false)).toBe(false);
		expect(
			appPayload("1", { ...base, throwaway: true, spam: true, repeatAfterMs: 180 * 60_000 }, false),
		).toMatchObject({ marks: ["throwaway", "repeat", "spam"], repeatAfterMinutes: 180 });
	});
});
