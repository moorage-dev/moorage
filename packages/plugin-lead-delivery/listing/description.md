Every enquiry sent through your EmDash forms goes where you work: your inbox, HubSpot, or another app such as Zapier, Make or n8n. Each one is logged, tried again if it does not get through, and someone hears about it when it needs fixing. No account and no key.

## What it does

- **Email** each enquiry to one or more addresses, with the form's own field labels. Pressing Reply answers the person.
- **HubSpot**: each enquiry becomes a HubSpot form submission, so your HubSpot workflows and notifications run. Paste the HubSpot form's share link or embed code; no HubSpot key is stored.
- **Another app (Zapier, Make, n8n or your own)**: each enquiry is sent as flat JSON, signed with Standard Webhooks headers.
- **A delivery log** your clients can read: who, which form, where it went, and whether it arrived. Send again with one press.
- **Retries**: 8 tries over about two days when a service does not answer.
- **Alerts** by email to everyone who looks after the site, at most once a day for each kind: an enquiry that could not be delivered, a form that usually gets enquiries and has gone quiet for 3 days, retries that are not running.
- **Flags**: throwaway addresses and the same person sending again are marked, never dropped. Optionally, don't send the same person twice within 24 hours.

## What it does not do

- No Mailchimp yet (next release).
- File attachments are not sent; the log says so and they stay in Forms → Submissions.
- It does not replace the Forms inbox; every enquiry stays there.

## Connecting a form

EmDash's form editor cannot yet be pointed at another plugin, so someone who looks after the site's code connects each form once. The plugin writes the instructions and can email them.

## Permissions

Send web requests to the addresses you enter (HubSpot and your apps). Send email (the Email place and alerts). Read the forms' notification emails to its private address, and cancel those, so nothing is sent there.
