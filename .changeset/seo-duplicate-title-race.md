---
"@moorage/plugin-seo": patch
---

The warning that two pages share a title no longer disappears by itself. When a page was saved while "Check my pages" was running, or two pages with the same title were saved at the same moment, one of them could lose the warning (or keep it after a rename) until the next check. A save now reads the pages with its title after writing, and a check no longer writes over a page saved after it read that page, so the warning ends up on exactly the pages that share a title.
