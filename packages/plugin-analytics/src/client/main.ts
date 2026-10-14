// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

import { boot } from "./boot.js";
import type { ClientConfig } from "./types.js";

/**
 * Entry of the browser bundle. The build turns this file into one minified
 * string; the server swaps this name for the site's settings as JSON before
 * the string goes into a page (see `src/fragment.ts`).
 */
declare const __CC_CONFIG__: ClientConfig;

boot(__CC_CONFIG__);
