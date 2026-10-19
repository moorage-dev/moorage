---
"@moorage/plugin-lead-delivery": patch
"@moorage/plugin-popups": patch
"@moorage/plugin-site-health": patch
---

README and listing: Lead Delivery and Popups need the forms plugin 0.2.11 or later for checkboxes, because earlier versions save a ticked single checkbox, such as a consent box, as unticked. Site Health's answer to "My site is not public yet. Does it work?" now says exactly what is checked before the site can open its own pages. No code change.
