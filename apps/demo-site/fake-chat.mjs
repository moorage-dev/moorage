// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Test fixture, off unless DEMO_SITE_FAKE_CHAT=1 (Lead Delivery's screenshots only).
//
// Lead Delivery's "Slack or Discord channel" accepts only Slack's and Discord's own webhook
// addresses. With this set, this process answers every request to them (and the SSRF check's
// DNS lookup for their names) the way Slack and Discord accept a message, so the pictures show
// a working channel and nothing ever reaches Slack or Discord.

const PUBLIC_IP = "93.184.215.14";
const HOSTS = new Set(["hooks.slack.com", "discord.com", "discordapp.com"]);

/** @param {string | undefined} flag */
export function fakeChat(flag) {
	if (flag !== "1") return;
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.origin === "https://cloudflare-dns.com" &&
			HOSTS.has(url.searchParams.get("name") ?? "")
		) {
			const type = url.searchParams.get("type") === "AAAA" ? 28 : 1;
			const name = url.searchParams.get("name");
			return Response.json({
				Status: 0,
				Answer: type === 1 ? [{ name, type, TTL: 300, data: PUBLIC_IP }] : [],
			});
		}
		if (HOSTS.has(url.hostname)) {
			// Slack answers "ok"; Discord answers 204 with no body.
			return url.hostname === "hooks.slack.com"
				? new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
				: new Response(null, { status: 204 });
		}
		return original(input, init);
	};
}
