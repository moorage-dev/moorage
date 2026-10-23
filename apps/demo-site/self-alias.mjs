// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// Test fixture, off unless DEMO_SITE_SELF_ALIAS is set ("demo-site-self.test=http://localhost:4490").
//
// Lead Delivery's one-click connect is offered only where the site can call its own address.
// On localhost it never can: EmDash refuses a plugin's request to localhost (its SSRF check).
// With this set, the demo site is served under a made-up public name instead: the browser maps
// the name to 127.0.0.1 (playwright.config.ts), and this process answers the SSRF check's DNS
// lookup for the name with a public address, then sends the request on to localhost.
//
// It stands in for the network and proves nothing about whether a real deployment can call
// itself (on Cloudflare that is the compatibility flag global_fetch_strictly_public).

const PUBLIC_IP = "93.184.215.14";

/** @param {string | undefined} spec "host=target" */
export function parseSelfAlias(spec) {
	if (!spec) return undefined;
	const [host, target] = spec.split("=");
	if (!host || !target) return undefined;
	return { host, target };
}

/** @param {string | undefined} spec "host=target" */
export function selfAlias(spec) {
	const alias = parseSelfAlias(spec);
	if (!alias) return;
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.origin === "https://cloudflare-dns.com" &&
			url.searchParams.get("name") === alias.host
		) {
			const type = url.searchParams.get("type") === "AAAA" ? 28 : 1;
			return Response.json({
				Status: 0,
				Answer: type === 1 ? [{ name: alias.host, type, TTL: 300, data: PUBLIC_IP }] : [],
			});
		}
		if (url.hostname === alias.host) {
			const real = new URL(url.pathname + url.search, alias.target);
			if (input instanceof Request) return original(new Request(real, input), init);
			return original(real, init);
		}
		return original(input, init);
	};
}
