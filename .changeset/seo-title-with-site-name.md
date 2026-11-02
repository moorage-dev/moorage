---
"@moorage/plugin-seo": patch
---

"The end of this title may be cut off in Google" now measures the title as most pages show it: the page's title followed by the site's name. Before, a title that fitted on its own but not with ": Your site" after it was not flagged. The Google preview's headline shows the same, so the two agree. EmDash leaves the title tag to the theme and a plugin cannot read the separator a site uses, so the check assumes ": " (" | " or " — " are about as wide); a title that already contains the site's name is measured as it is.
