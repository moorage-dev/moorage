---
"@moorage/plugin-lead-delivery": minor
---

HubSpot can now link an enquiry to the visitor's earlier visits (original source, pages viewed). This is a job for the site's web person: add a hidden field named `hutk` to a form in Forms, and the short script in the README that copies HubSpot's `hubspotutk` cookie into it as the form is sent. With Analytics & Cookies the script sends the token only when the visitor allowed Marketing. Without it, the script checks no consent: it sends the token whenever HubSpot's cookie is there, except for browsers that send Global Privacy Control. If another tool asks your visitors for consent, change the script's `allowed` line before using it.

Lead Delivery sends that token to HubSpot as `context.hutk` and to nothing else: never in an email, a Slack or Discord message, another app's payload, the field matching or the log. Only a value shaped like HubSpot's token is sent; if HubSpot refuses it, that delivery tries again without it rather than failing. The token is kept only with an enquiry a HubSpot delivery takes, and goes with the enquiry's contents; Forms keeps it with the submission like any field.

A field named `hutk` is matched in any case (`Hutk`, `HUTK`). A form that already had a field of that name no longer shows it in emails, channel messages, other apps' JSON or HubSpot field matching: it is treated as the visitor's token, and sent to HubSpot only if it looks like one. Forms without such a field work exactly as before, and the plugin still never reads cookies or sends the visitor's IP address.
