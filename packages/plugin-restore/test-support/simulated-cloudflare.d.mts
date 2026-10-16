// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

export interface SimulatorOptions {
	exec: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
	accountName?: string;
	siteDatabase?: string;
	otherDatabases?: string[];
	now?: () => number;
}

export interface SimulatedCloudflare {
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	state: {
		calls: Array<{ method: string; path: string; body?: unknown }>;
		restores: Array<{ bookmark: string; at: number }>;
		failNextRestore: null | "error" | "timeout";
		expiresOn: string | null;
	};
	account: { id: string; name: string };
	site: { uuid: string; name: string };
	others: Array<{ uuid: string; name: string }>;
	bookmarkFor(ms: number): string;
	timeOf(bookmark: string): number;
}

export function createSimulatedCloudflare(options: SimulatorOptions): SimulatedCloudflare;
export function interceptCloudflare(options: SimulatorOptions): SimulatedCloudflare;
