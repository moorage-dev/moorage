## How do I send EmDash form submissions to HubSpot?

Install this plugin, open Lead delivery, press New delivery, choose your form and HubSpot, and paste the HubSpot form's share link or embed code. Each enquiry becomes a HubSpot form submission. The HubSpot form must have the fields you send, at least Email, and CAPTCHA must be off on it.

## How do I connect EmDash forms to Zapier, Make or n8n?

In New delivery choose "Another app" and paste the address the app gave you: in Zapier "Webhooks by Zapier" (a paid Zapier plan), in Make a Custom webhook, in n8n a Webhook node. Each request is signed, so the app can check it came from your site.

## Does connecting a form need a web person?

Not where the site can call its own address (on Cloudflare: the compatibility flag `global_fetch_strictly_public`): an admin connects it in one step by typing a code on EmDash's approval page. Lead Delivery uses that access once and throws it away. Elsewhere EmDash's form editor has no box for it yet, so someone who can call the site's API sets it once per form; New delivery shows the instructions for that form and can email them.

## What if HubSpot or Zapier is down?

The enquiry is tried again 8 times over about two days. If it still does not arrive, the people on the alert list get one email, and you can press Send again.

## Does it lose enquiries?

Not from the moment an enquiry reaches it: each is stored once and kept until all its deliveries are done. Every enquiry is also in Forms → Submissions. If a form stops sending altogether, the quiet-form alert tells you after 3 days.

## Can my clients see it?

Editors see the log and can press Send again. Only admins add or change deliveries.

## Is it free?

Yes, on any number of sites, with no account and no key. It is open source under the MIT License.
