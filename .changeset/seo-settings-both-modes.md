---
"@moorage/plugin-seo": patch
---

Your SEO settings now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this the Settings tab came back empty after a switch, and the old values only returned when you switched back. Settings are now kept where EmDash finds them in both modes.

Nothing to do on your side: the first page view or visit to the SEO page after updating copies your settings to the new place. Update first, open the SEO page once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.1.7 still shows your latest settings. If you go back, change settings there and then update again, the update shows the settings from before you went back; save them again.
