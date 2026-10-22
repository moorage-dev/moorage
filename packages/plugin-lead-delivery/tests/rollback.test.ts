// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { inboundUrl, migrate, normalizeConfig, privateEmail } from "../src/config.js";
import * as old from "./fixtures/v012/config.js";

// Going back to 0.1.2 must keep working: its config reader (vendored unchanged from aeb33cb in
// tests/fixtures/v012) reads what 0.2 writes.

const OLD = {
	places: [
		{
			id: "mailplace1",
			kind: "email",
			name: "Email to shop@crumb.test",
			forms: "all",
			on: true,
			noDuplicates: false,
			createdAt: "2026-10-02T00:00:00.000Z",
			to: ["shop@crumb.test"],
		},
		{
			id: "hubplace01",
			kind: "hubspot",
			name: "HubSpot",
			forms: ["contact", "quote"],
			on: true,
			noDuplicates: true,
			createdAt: "2026-10-03T00:00:00.000Z",
			portalId: "4410287",
			formGuid: "9f1c2b3a-1111-2222-3333-444455556666",
			mapping: { contact: { name: "fullname" } },
			otherNames: { contact: { x: "my_field" } },
			gdpr: true,
			throwawayField: "possibly_fake_email",
		},
		{
			id: "appplace01",
			kind: "app",
			name: "My Zap",
			forms: ["contact"],
			on: false,
			noDuplicates: false,
			createdAt: "2026-10-04T00:00:00.000Z",
			app: "zapier",
			url: "https://hooks.zapier.com/hooks/catch/1/a/",
			secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0",
		},
	],
	alertTo: ["anna@crumb.test", "sam@pixel.dev"],
	key: "K".repeat(32),
	reach: { result: "email", at: "2026-10-05T00:00:00.000Z" },
	testedAt: "2026-10-06T00:00:00.000Z",
};

let host: PluginRuntimeTestHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("going back to 0.1.2 after 0.2 has run", () => {
	it("0.1.2 reads the migrated setup as it was: places, key, repeats, matching, secrets, alerts", () => {
		const migrated = migrate(OLD, {});
		const back = old.normalizeConfig(JSON.parse(JSON.stringify(migrated)));
		expect(back).toEqual(old.normalizeConfig(OLD));
		expect(back.places).toEqual(OLD.places);
		expect(back.key).toBe(OLD.key);
		expect(back.alertTo).toEqual(OLD.alertTo);
		expect(back.testedAt).toBe(OLD.testedAt);
		// 0.2 itself ignores what it keeps for 0.1.2, and keeps it on every later read.
		expect(normalizeConfig(migrated)).toEqual(migrated);
	});

	it("0.1.2 accepts the same private address and email address after 0.2 has written", async () => {
		const migrated = migrate(OLD, {});
		const back = old.normalizeConfig(migrated);
		expect(old.inboundUrl("https://crumb.test", back.key)).toBe(
			inboundUrl("https://crumb.test", migrated.key),
		);
		expect(old.privateEmail(back.key)).toBe(privateEmail(migrated.key));
		expect(old.PRIVATE_DOMAIN).toBe("lead-delivery.invalid");
	});

	it("keeps the 0.1.2 setup through 0.2's own saves", async () => {
		host = await createPluginRuntimeTestHost({
			site: { name: "Crumb", url: "https://crumb.test", locale: "en" },
		});
		await host.fixtures.plugin.kv("config", OLD);
		const admin = await host.fixtures.user({ email: "anna@crumb.test", role: "admin" });
		await host.admin.loadPage("/enquiries", { user: admin });
		await host.admin.submit(
			"/enquiries",
			"save_alerts",
			{ alert_to: "anna@crumb.test, new@pixel.dev" },
			{ user: admin },
		);
		const saved = await host.inspect.kv.get<unknown>("config");
		const back = old.normalizeConfig(saved);
		expect(back.places).toEqual(OLD.places);
		expect(back.key).toBe(OLD.key);
		// A change made under 0.2 that 0.1.2 also has is seen by it.
		expect(back.alertTo).toEqual(["anna@crumb.test", "new@pixel.dev"]);
	});
});
