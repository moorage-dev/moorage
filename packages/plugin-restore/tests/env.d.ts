// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

// The test worker's bindings (set up by emdashPluginTest()): DB is the test site's database.
declare module "cloudflare:workers" {
	interface D1Statement {
		bind(...values: unknown[]): D1Statement;
		all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
		run(): Promise<unknown>;
	}
	export const env: { DB: { prepare(sql: string): D1Statement } };
}
