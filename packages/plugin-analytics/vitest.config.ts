// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { defineConfig } from "vitest/config";

import { clientScript } from "./client-script.ts";

export default defineConfig({
	plugins: [clientScript()],
	test: {
		environmentOptions: {
			// The simulated browser (tests/client.test.ts) never fetches a tracking script;
			// a script tag being added is what the tests look at.
			happyDOM: {
				settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
			},
		},
	},
});
