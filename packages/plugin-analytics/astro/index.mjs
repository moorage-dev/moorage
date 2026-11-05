// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Portable Text block components of Analytics & Cookies. EmDash wires these up
 * through `componentsEntry` (the `virtual:emdash/block-components` module):
 * they render EmDash's own iframe and embed blocks, holding videos and maps
 * back until the visitor allows Marketing cookies (see held.mjs). The Embeds
 * plugin's own youtube and vimeo blocks are left to it: a renderer can only
 * replace another plugin's, not wrap it. Shipped as source, because Astro
 * compiles it.
 */

import Embed from "./Embed.astro";
import Iframe from "./Iframe.astro";

export const blockComponents = {
	iframe: Iframe,
	embed: Embed,
};
