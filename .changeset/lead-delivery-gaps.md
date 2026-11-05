---
"@moorage/plugin-lead-delivery": minor
---

Send enquiries to a Slack or Discord channel, and refuse every private-network address.

- **Slack or Discord channel**, a new kind of delivery: paste the channel's incoming-webhook address and each enquiry becomes one message with the form's fields, the marks and a link to Forms → Submissions. Nothing people write can ping the channel. "Leave out what people wrote" sends only "New enquiry: Contact form" with the link, for a channel where not everyone should read personal details. Retries, the log and alerts work as for an app. The address is kept like an app's signing secret: the page shows only its host and last four characters, it never appears in the log, and Edit keeps it when its box is left empty.
- **Forms' own auto-reply.** A delivery's page says whether Forms also sends its own auto-reply to the person who wrote, for forms connected in one step (read from Forms then; for forms connected another way it is not shown).
- **Unticked checkboxes** now show as "no" in emails, apps and channels (for forms whose fields Lead Delivery knows), instead of being left out. A box shown only on a condition is still left out, and HubSpot still receives nothing for an unticked box. In the email way, a ticked box reads "yes" instead of "true".
- **Safer app addresses**: Lead Delivery now refuses every address on a private network, not only the common ones. Newly refused: 172.16.0.0 to 172.31.255.255, 0.0.0.0, 100.64.0.0/10 (carrier-grade NAT), other reserved ranges, IPv6 unique-local (`fc00::/7`) and link-local (`fe80::/10`) addresses and IPv4 inside IPv6, and the same addresses written as one number, in hex or in octal (`2130706433`, `0x7f.1`). Public IPv6 addresses are now accepted. The check also runs before every send, so an app delivery saved earlier with such an address is no longer sent: it shows as needing fixing, with the way to change it under Edit. Only Admins can enter or change a delivery's address.
