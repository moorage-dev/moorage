// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Whether an address an Admin typed (an app's or a channel's web address) points into a private
 * network: this site's own machine, its local network, or the cloud's internal services. Such an
 * address is refused when it is saved and again before every send, so a delivery saved by an
 * earlier version is never sent there either.
 *
 * Checked: names that only resolve locally (localhost and *.localhost, *.local, *.internal,
 * *.home.arpa, one-word names), IPv4 in any form the address parser accepts (one number such as
 * 2130706433, hex such as 0x7f.1, octal such as 0177.0.0.1, short forms such as 127.1), and IPv6
 * (loopback, unspecified, unique-local fc00::/7, link-local fe80::/10, multicast, and IPv4 inside
 * IPv6: mapped ::ffff:0:0/96, compatible ::/96, NAT64 64:ff9b::/96).
 *
 * Not checked, and cannot be from here: a public name whose DNS answer is a private address
 * (`intranet.example.com` -> 10.0.0.5), or one that changes its answer between this check and
 * the send (DNS rebinding). The sandbox cannot resolve names, and the request is made by the
 * host, not by this code. On Cloudflare Workers, requests to private and loopback addresses do
 * not reach a private network anyway; on a Node server they can, so keep only trusted Admins.
 * Only Admins (EmDash role 50 and up) can enter or change a delivery address; Editors cannot.
 */

const PRIVATE_V4: Array<[number, number]> = [
	[0x00000000, 8], // 0.0.0.0/8: "this network"
	[0x0a000000, 8], // 10.0.0.0/8
	[0x64400000, 10], // 100.64.0.0/10: carrier-grade NAT
	[0x7f000000, 8], // 127.0.0.0/8: loopback
	[0xa9fe0000, 16], // 169.254.0.0/16: link-local, cloud metadata
	[0xac100000, 12], // 172.16.0.0/12
	[0xc0000000, 24], // 192.0.0.0/24: protocol assignments
	[0xc0000200, 24], // 192.0.2.0/24: documentation
	[0xc0a80000, 16], // 192.168.0.0/16
	[0xc6120000, 15], // 198.18.0.0/15: benchmarking
	[0xc6336400, 24], // 198.51.100.0/24: documentation
	[0xcb007100, 24], // 203.0.113.0/24: documentation
	[0xe0000000, 4], // 224.0.0.0/4: multicast
	[0xf0000000, 4], // 240.0.0.0/4: reserved, and 255.255.255.255
];

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];

function inRange(ip: number, [base, bits]: [number, number]): boolean {
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ip & mask) >>> 0 === base;
}

function privateV4(ip: number): boolean {
	return PRIVATE_V4.some((range) => inRange(ip, range));
}

/** One part of an IPv4 address as the address parser reads it: decimal, 0x hex or 0 octal. */
function v4Part(part: string): number | null {
	if (/^0x[0-9a-f]*$/i.test(part))
		return part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
	if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
	if (/^(0|[1-9][0-9]*)$/.test(part)) return Number(part);
	return null;
}

/** The IPv4 address a host names, in any of the forms browsers accept (127.1, 2130706433, 0x7f.1). */
export function parseV4(host: string): number | null {
	const parts = host.replace(/\.$/, "").split(".");
	if (parts.length === 0 || parts.length > 4 || parts.some((p) => p === "")) return null;
	const numbers = parts.map(v4Part);
	if (numbers.some((n) => n === null)) return null;
	const values = numbers as number[];
	const last = values.pop()!;
	if (values.some((n) => n > 255)) return null;
	if (last >= 256 ** (4 - values.length)) return null;
	let ip = 0;
	for (const [i, n] of values.entries()) ip += n * 256 ** (3 - i);
	return ip + last;
}

const groupsOf = (side: string) => (side ? side.split(":") : []);

/** An IPv6 address (without brackets) as eight 16-bit groups, or null. */
function parseV6(text: string): number[] | null {
	let host = text.toLowerCase();
	const zone = host.indexOf("%");
	if (zone >= 0) host = host.slice(0, zone);
	// A dotted IPv4 tail (::ffff:127.0.0.1) as two groups.
	const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(host);
	if (dotted) {
		const v4 = parseV4(dotted[2]!);
		if (v4 === null) return null;
		host = `${dotted[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const halves = host.split("::");
	if (halves.length > 2) return null;
	const head = groupsOf(halves[0]!);
	const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	return groups.map((g) => Number.parseInt(g, 16));
}

function privateV6(g: number[]): boolean {
	const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
	const v4 = () => ((g[6]! << 16) >>> 0) + g[7]!;
	if (zeros(8)) return true; // ::
	if (zeros(7) && g[7] === 1) return true; // ::1
	if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
	if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 old site-local
	if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	if (zeros(5) && g[5] === 0xffff) return privateV4(v4()); // ::ffff:a.b.c.d mapped
	if (zeros(6)) return privateV4(v4()); // ::a.b.c.d compatible
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
		return privateV4(v4()); // 64:ff9b::/96 NAT64
	return false;
}

/** Whether a host name (as `new URL().hostname` gives it, or as typed) is on a private network. */
export function isPrivateHost(hostname: string): boolean {
	let host = hostname.trim().toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host.includes(":")) {
		const groups = parseV6(host);
		// Something with a colon that is not an IPv6 address is not a name the site can call.
		return groups === null || privateV6(groups);
	}
	host = host.replace(/\.+$/, "");
	if (!host) return true;
	const v4 = parseV4(host);
	if (v4 !== null) return privateV4(v4);
	// A name with only digits and dots that is not a valid address (999.1.1.1): refuse it.
	if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f.]*$/i.test(host)) return true;
	if (host === "localhost" || !host.includes(".")) return true;
	return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export const PRIVATE_ADDRESS =
	"That address is on a private network, so this site cannot send to it.";

/** The plain-words refusal for an address on a private network, or undefined when it is fine. */
export function privateAddressError(address: string): string | undefined {
	try {
		return isPrivateHost(new URL(address).hostname) ? PRIVATE_ADDRESS : undefined;
	} catch {
		return PRIVATE_ADDRESS;
	}
}
