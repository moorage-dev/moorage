// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * A request from the server to the site it is running, at the address the
 * current request came in on (`origin` is the request's own origin).
 *
 * One case needs care. A Node server started on `localhost` listens on one
 * loopback address only, ::1 or 127.0.0.1, whichever the system lists first.
 * The browser tries both and gets in, but the server's own fetch of `localhost`
 * may try only the other one (in a container with no outside IPv6 address,
 * Node asks for IPv4 alone) and be refused. So when `localhost` cannot be
 * reached at all, the same port is asked on 127.0.0.1 and then on [::1].
 *
 * Safe for the session cookie this may carry: it only ever goes to a loopback
 * address on the request's own port, the machine and server the browser just
 * reached. Any other host is asked once, exactly as given. An answer of any
 * kind (an error page too) and a timeout are final: only a refused or failed
 * connection moves on to the next address.
 */
export async function fetchOwnSite(
	origin: string,
	path: string,
	init: RequestInit,
	fetchImpl: typeof fetch = fetch,
): Promise<Response> {
	const first = new URL(path, origin);
	const addresses = [first];
	if (first.hostname === "localhost" && first.protocol === "http:") {
		for (const loopback of ["127.0.0.1", "[::1]"]) {
			const other = new URL(first);
			other.hostname = loopback;
			addresses.push(other);
		}
	}
	let failure: unknown;
	for (const address of addresses) {
		try {
			return await fetchImpl(address.href, init);
		} catch (error) {
			if (init.signal?.aborted || (error as { name?: unknown })?.name === "AbortError") throw error;
			failure = error;
		}
	}
	throw failure;
}
