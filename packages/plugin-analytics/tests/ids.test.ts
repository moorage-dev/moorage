// Copyright 2026 GoSi Tech. Licensed under FSL-1.1-MIT; see LICENSE.

import { describe, expect, it } from "vitest";

import { checkId, type ToolId } from "../src/ids.js";

function value(tool: ToolId, raw: string): string {
	const result = checkId(tool, raw);
	if (!result.ok) throw new Error(result.message);
	return result.value;
}

function message(tool: ToolId, raw: string): string {
	const result = checkId(tool, raw);
	if (result.ok) throw new Error(`expected "${raw}" to be refused, got "${result.value}"`);
	return result.message;
}

describe("tracking IDs", () => {
	it("accepts a correct ID for each tool and tidies its case", () => {
		expect(value("ga4", " g-ab12cd34ef ")).toBe("G-AB12CD34EF");
		expect(value("gtm", "gtm-ab12cd3")).toBe("GTM-AB12CD3");
		expect(value("ads", "AW-123456789")).toBe("AW-123456789");
		expect(value("meta", "123456789012345")).toBe("123456789012345");
		expect(value("clarity", "AB12CD34EF")).toBe("ab12cd34ef");
		expect(value("hubspot", "12345678")).toBe("12345678");
		expect(value("cloudflare", "0123456789ABCDEF0123456789abcdef")).toBe(
			"0123456789abcdef0123456789abcdef",
		);
	});

	it("treats an empty box as off", () => {
		expect(checkId("ga4", "")).toEqual({ ok: true, value: "" });
		expect(checkId("ga4", "   ")).toEqual({ ok: true, value: "" });
		expect(checkId("ga4", undefined)).toEqual({ ok: true, value: "" });
	});

	it("names an old Universal Analytics ID", () => {
		expect(message("ga4", "UA-12345678-1")).toMatch(
			/^Google Analytics: That is an old Universal Analytics ID \(UA-\).*starts with G-/,
		);
	});

	it("says which box a Google ID belongs in", () => {
		expect(message("ga4", "GTM-AB12CD3")).toBe(
			"Google Analytics: That is a Google Tag Manager ID (GTM-). Put it in the Google Tag Manager box instead.",
		);
		expect(message("gtm", "G-AB12CD34EF")).toMatch(/Put it in the Google Analytics box instead/);
		expect(message("ga4", "AW-123456789")).toMatch(/Put it in the Google Ads box instead/);
		expect(message("ads", "G-AB12CD34EF")).toMatch(/Put it in the Google Analytics box instead/);
	});

	it("explains a bare number in a Google box", () => {
		expect(message("ga4", "123456789")).toMatch(/property or account number/);
		expect(message("ads", "123456789")).toMatch(/Add AW- in front of the number: AW-123456789/);
	});

	it("finds the ID inside a pasted snippet", () => {
		const gtag = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF"></script>
<script>window.dataLayer = window.dataLayer || []; gtag('config', 'G-AB12CD34EF');</script>`;
		expect(value("ga4", gtag)).toBe("G-AB12CD34EF");

		const gtm = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];})(window,document,'script','dataLayer','GTM-AB12CD3');</script>`;
		expect(value("gtm", gtm)).toBe("GTM-AB12CD3");

		const pixel = `<script>!function(f,b,e,v,n,t,s){}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '123456789012345'); fbq('track', 'PageView');</script>`;
		expect(value("meta", pixel)).toBe("123456789012345");

		const clarity = `<script type="text/javascript">(function(c,l,a,r,i,t,y){})(window, document, "clarity", "script", "ab12cd34ef");</script>`;
		expect(value("clarity", clarity)).toBe("ab12cd34ef");

		const hubspot = `<script type="text/javascript" id="hs-script-loader" async defer src="//js-eu1.hs-scripts.com/12345678.js"></script>`;
		expect(value("hubspot", hubspot)).toBe("12345678");

		const cloudflare = `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "0123456789abcdef0123456789abcdef"}'></script>`;
		expect(value("cloudflare", cloudflare)).toBe("0123456789abcdef0123456789abcdef");
	});

	it("says when a pasted snippet is for another Google tool", () => {
		const gtm = `<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-AB12CD3');</script>`;
		expect(message("ga4", gtm)).toBe(
			"Google Analytics: That code is for Google Tag Manager. Paste it in the Google Tag Manager box instead.",
		);
	});

	it("refuses anything that is not an ID, with an example", () => {
		expect(message("meta", "my pixel")).toMatch(/Could not find the ID/);
		expect(message("clarity", "not-an-id!")).toMatch(/about 10 lowercase letters and numbers/);
		expect(message("cloudflare", "abc")).toMatch(/32 letters and numbers/);
		expect(message("hubspot", "abc")).toMatch(/A HubSpot Hub ID is a number/);
		expect(message("gtm", "container")).toMatch(/starts with GTM-.*GTM-AB12CD3/);
	});

	it("never lets script or markup through", () => {
		for (const tool of ["ga4", "gtm", "ads", "meta", "clarity", "hubspot", "cloudflare"] as const) {
			for (const attack of [`"</script><script>alert(1)</script>`, `';alert(1);//`, "G-1\n2"]) {
				const result = checkId(tool, attack);
				if (result.ok) expect(result.value).toMatch(/^[A-Za-z0-9-]*$/);
			}
		}
		expect(checkId("ga4", `G-ABCD1234"onload="x`).ok && value("ga4", `G-ABCD1234"onload="x`)).toBe(
			"G-ABCD1234",
		);
	});
});
