## Reporting a problem

Email **security@moorage.dev**, not a public issue. Say which version you use, what you found and how to reproduce it. Fixes go into the latest release; update to it to receive them. The source is public on GitHub.

## What it keeps and sends

Each enquiry is stored in the site's own database until all its deliveries are done, then its contents are deleted; log rows are kept for 30 days. Enquiries go only to the addresses, HubSpot forms and apps you enter. Each app delivery is signed with its own secret. Apps' signing secrets and Slack or Discord webhook addresses are kept in EmDash's encrypted plugin storage when the site has an EMDASH_ENCRYPTION_KEY, otherwise as plain text in the site's database; the admin page says which. Only Admins can enter or change where enquiries go, and an address on a private network (this machine, the local network, cloud-internal addresses, in any spelling such as `2130706433` or `[fd00::1]`) is refused when saved and again before every send. A public name that resolves to a private address cannot be caught this way. Connecting a form in one step uses the admin access you approve once and then throws it away; it is never stored.
