// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Checking the one ID each tracking tool needs.
 *
 * People paste the wrong thing in three ways: an ID that belongs to another
 * tool, an old kind of ID, or the whole snippet the tool told them to copy.
 * Each case gets a message that names the mistake, and a pasted snippet is
 * searched for the ID so the paste simply works.
 *
 * Everything saved here is later written into a script on the public page, so
 * the patterns are strict: letters, digits and a dash, nothing else.
 */

export type ToolId = "ga4" | "gtm" | "ads" | "meta" | "clarity" | "hubspot" | "cloudflare";

export const TOOL_NAMES: Record<ToolId, string> = {
	ga4: "Google Analytics",
	gtm: "Google Tag Manager",
	ads: "Google Ads",
	meta: "Meta Pixel",
	clarity: "Microsoft Clarity",
	hubspot: "HubSpot",
	cloudflare: "Cloudflare Web Analytics",
};

/** What a correct ID looks like, shown in the field and in messages. */
export const TOOL_EXAMPLES: Record<ToolId, string> = {
	ga4: "G-AB12CD34EF",
	gtm: "GTM-AB12CD3",
	ads: "AW-123456789",
	meta: "123456789012345",
	clarity: "ab12cd34ef",
	hubspot: "12345678",
	cloudflare: "0123456789abcdef0123456789abcdef",
};

const VALID: Record<ToolId, RegExp> = {
	ga4: /^G-[A-Z0-9]{4,20}$/,
	gtm: /^GTM-[A-Z0-9]{4,12}$/,
	ads: /^AW-[0-9]{6,15}$/,
	meta: /^[0-9]{10,20}$/,
	clarity: /^[a-z0-9]{8,14}$/,
	hubspot: /^[0-9]{5,12}$/,
	cloudflare: /^[a-f0-9]{32}$/,
};

/** Where the ID sits inside the snippet each tool asks people to copy. */
const IN_SNIPPET: Record<ToolId, RegExp[]> = {
	ga4: [/\bG-[A-Z0-9]{4,20}\b/i],
	gtm: [/\bGTM-[A-Z0-9]{4,12}\b/i],
	ads: [/\bAW-[0-9]{6,15}\b/i],
	meta: [/fbq\(\s*["']init["']\s*,\s*["']([0-9]{10,20})["']/, /[?&]id=([0-9]{10,20})\b/],
	clarity: [
		/clarity\.ms\/tag\/([a-z0-9]{8,14})\b/i,
		/["']script["']\s*,\s*["']([a-z0-9]{8,14})["']/i,
	],
	hubspot: [/hs-scripts\.com\/([0-9]{5,12})\.js/i],
	cloudflare: [/["']?token["']?\s*:\s*["']([a-f0-9]{32})["']/i],
};

const UPPERCASE: ReadonlySet<ToolId> = new Set(["ga4", "gtm", "ads"]);

export type IdResult = { ok: true; value: string } | { ok: false; message: string };

function tidy(tool: ToolId, value: string): string {
	return UPPERCASE.has(tool) ? value.toUpperCase() : value.toLowerCase();
}

function looksLikeSnippet(text: string): boolean {
	return /[<>(){};=\s]/.test(text) || text.includes("://");
}

/** The box a Google ID belongs in, when it was typed into a different one. */
function googleMixUp(tool: ToolId, text: string): string | undefined {
	const upper = text.toUpperCase();
	if (/^UA-[0-9]+(-[0-9]+)?$/.test(upper)) {
		return tool === "ga4"
			? "That is an old Universal Analytics ID (UA-). Google switched those off in 2023. In Google Analytics, open Admin > Data streams and copy the Measurement ID, which starts with G-."
			: `That is an old Google Analytics ID (UA-), not a ${TOOL_NAMES[tool]} ID.`;
	}
	const kinds: Array<[string, ToolId]> = [
		["GTM-", "gtm"],
		["AW-", "ads"],
		["G-", "ga4"],
	];
	for (const [prefix, owner] of kinds) {
		if (upper.startsWith(prefix) && owner !== tool) {
			return `That is a ${TOOL_NAMES[owner]} ID (${prefix}). Put it in the ${TOOL_NAMES[owner]} box instead.`;
		}
	}
	return undefined;
}

function wrongShape(tool: ToolId, text: string): string {
	const example = `It looks like ${TOOL_EXAMPLES[tool]}.`;
	switch (tool) {
		case "ga4":
			return /^[0-9]+$/.test(text)
				? `That is a property or account number. The Measurement ID starts with G-. ${example}`
				: `A Google Analytics Measurement ID starts with G-. ${example}`;
		case "gtm":
			return `A Google Tag Manager container ID starts with GTM-. ${example}`;
		case "ads":
			return /^[0-9]{6,15}$/.test(text)
				? `Add AW- in front of the number: AW-${text}.`
				: `A Google Ads ID starts with AW- followed by numbers. ${example}`;
		case "meta":
			return `A Meta Pixel ID is a number, about 15 digits long. ${example}`;
		case "clarity":
			return `A Clarity project ID is about 10 lowercase letters and numbers. ${example}`;
		case "hubspot":
			return `A HubSpot Hub ID is a number. ${example}`;
		case "cloudflare":
			return `A Cloudflare Web Analytics token is 32 letters and numbers. ${example}`;
	}
}

/**
 * Check what was typed into one tool's box. Empty is fine and means "off".
 * A pasted snippet is accepted when the right kind of ID is inside it.
 */
export function checkId(tool: ToolId, raw: unknown): IdResult {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (text === "") return { ok: true, value: "" };
	if (text.length > 5000) {
		return { ok: false, message: `${TOOL_NAMES[tool]}: that is too long to be an ID.` };
	}

	const direct = tidy(tool, text);
	if (VALID[tool].test(direct) && !googleMixUp(tool, text)) return { ok: true, value: direct };

	const fail = (message: string): IdResult => ({
		ok: false,
		message: `${TOOL_NAMES[tool]}: ${message}`,
	});

	if (!looksLikeSnippet(text)) {
		return fail(googleMixUp(tool, text) ?? wrongShape(tool, text));
	}

	for (const pattern of IN_SNIPPET[tool]) {
		const match = pattern.exec(text);
		const found = match?.[1] ?? match?.[0];
		if (found) {
			const value = tidy(tool, found);
			if (VALID[tool].test(value)) return { ok: true, value };
		}
	}
	// A snippet for a different Google product is the usual cause.
	for (const other of ["gtm", "ga4", "ads"] as const) {
		if (other === tool || !UPPERCASE.has(tool)) continue;
		if (IN_SNIPPET[other][0]?.test(text)) {
			return fail(
				`That code is for ${TOOL_NAMES[other]}. Paste it in the ${TOOL_NAMES[other]} box instead.`,
			);
		}
	}
	if (tool === "ga4" && /\bUA-[0-9]+-[0-9]+\b/i.test(text)) {
		return fail(googleMixUp(tool, "UA-1-1") ?? "");
	}
	return fail(
		`Could not find the ID in what you pasted. Type just the ID. ${`It looks like ${TOOL_EXAMPLES[tool]}.`}`,
	);
}
