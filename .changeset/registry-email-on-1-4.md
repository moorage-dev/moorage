---
"@moorage/plugin-lead-delivery": patch
"@moorage/plugin-site-health": patch
"@moorage/plugin-approvals": patch
---

Installed from the EmDash registry on Cloudflare, these plugins could not send email on EmDash 1.3: every email failed with "Email is not configured", although the site's own emails worked. EmDash 1.4.0 fixes that. Until a site updates, Lead Delivery marks such a delivery as needing a person and asks for the EmDash update instead of trying again, Site Health's Checklist says the same after a test email, and Content Approval's log names the update when approval emails fail this way.
