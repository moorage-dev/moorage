---
"@moorage/plugin-approvals": patch
---

Your approval settings now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this a switch turned approval off without a word (nothing was held until the settings were saved again), and the old settings only returned when you switched back. Settings are now kept where EmDash finds them in both modes.

Nothing to do on your side: the first publish or visit to the Approvals page after updating copies your settings to the new place. Update first, open the Approvals page once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.1.5 still uses your latest settings. If you go back, change settings there and then update again, the update shows the settings from before you went back; save them again.
