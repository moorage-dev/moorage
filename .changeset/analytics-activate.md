---
"@moorage/plugin-analytics": patch
---

If something goes wrong the first time the site starts the plugin (EmDash 1.5 starts plugins as the site starts), it now stays switched on. The daily clean-up of old consent records is then scheduled when an administrator next opens the plugin's page.
