---
"@moorage/plugin-lead-delivery": minor
---

HubSpot can now link an enquiry to the visitor's earlier visits (original source, pages viewed). Add a hidden field named `hutk` to a form in Forms, and the short script in the README that fills it from HubSpot's `hubspotutk` cookie as the form is sent, only with the visitor's consent to marketing cookies. Lead Delivery sends that token to HubSpot as `context.hutk` and to nothing else: never in an email, a Slack or Discord message, another app's payload, the field matching or the log. Only a value shaped like HubSpot's token is sent; if HubSpot refuses it, that delivery tries again without it rather than failing. The token is kept only with an enquiry a HubSpot delivery takes, and goes with the enquiry's contents. Forms without the field work exactly as before, and the plugin still never reads cookies or sends the visitor's IP address.
