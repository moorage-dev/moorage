// Copyright 2026 GoSi Tech. Licensed under the MIT License; see LICENSE.

/**
 * Portable Text block components of the Popups plugin. EmDash wires these up
 * through `componentsEntry` (the `virtual:emdash/block-components` module).
 * Shipped as source, like the forms plugin's, because Astro compiles it.
 */

import PopupsBox from "./PopupsBox.astro";

export const blockComponents = {
	"popups-box": PopupsBox,
};
