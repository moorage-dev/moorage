---
"@moorage/plugin-site-health": patch
---

Who gets emails, and whether links to other websites are checked, now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this a switch emptied the email list (the first Admin to open the page then became the only person on it) and turned the outside-link check back on. These options are now kept where EmDash finds them in both modes.

Nothing to do on your side: the next check or visit to the Site Health page after updating copies them to the new place. Update first, open the page once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.1.2 still uses your latest options. The check results themselves are rebuilt by the next full check after a switch.
