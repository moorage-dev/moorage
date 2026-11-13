---
"@moorage/plugin-site-health": minor
---

Needs EmDash 1.5.0 or later. Two tools for an AI assistant connected to your site through EmDash's MCP server. `problems` reads what the Problems tab shows you: the counts, then each problem worst first, with its address, the same sentence the page shows, the pages it was found on, and the HTTP status and time of the last check. Editors see what the page shows Editors. `add_redirect`, for Admins only, does what the Fix menu's "Send visitors to another page" does for one problem: the same checks and refusals, and it never replaces a redirect that is already there. EmDash marks it as one that changes the site. Both tools are off until an Admin turns on Agent access for Site Health under Plugins; the assistant's API token needs the plugin tools scope. If you installed Site Health from the Registry, the update asks you to approve the new tools. Nothing else changes, and the tools never publish, unpublish or delete anything.

The Fix menu's "Send visitors to another page" now says plainly that visitors can only be sent to a page on this site, starting with / (for example /pricing): EmDash 1.5 does not redirect to another site, and a full address used to fail with EmDash's own message.
