// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Parse a URL, or return null. `URL.canParse` is missing from the sandbox
 * runtime EmDash uses in development, so this is the only parser used here.
 */
export function parseUrl(value: string, base?: string): URL | null {
	try {
		return new URL(value, base);
	} catch {
		return null;
	}
}
