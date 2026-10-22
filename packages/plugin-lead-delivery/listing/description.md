Every enquiry sent through your EmDash forms goes where you work: your inbox, HubSpot, or another app such as Zapier, Make or n8n. Each one is logged, tried again if it does not get through, and someone hears about it when it needs fixing. No account and no key.

## What it does

- **Deliveries**: a form and where its enquiries go, named for you ("Contact form → Shop inbox"). A form can have several.
- **Email** to one or more addresses, with the form's own field labels. Reply answers the person.
- **HubSpot**: each enquiry becomes a HubSpot form submission. Paste the form's share link or embed code; no key is stored.
- **Another app (Zapier, Make, n8n or your own)**: flat JSON, signed with Standard Webhooks headers.
- **A delivery log** your clients can read, with Send again.
- **Retries**: 8 tries over about two days.
- **Alerts** by email, at most once a day for each kind: an enquiry that could not be delivered, a form gone quiet for 3 days, retries not running.
- **Marks, not filters**: possibly fake addresses, the same address again and possibly spam are marked at the top of each email and still sent. Each delivery can hold repeats (24 hours or 7 days) and possibly spam.

## What it does not do

- No Mailchimp yet.
- File attachments are not sent; they stay in Forms → Submissions.
- It does not replace the Forms inbox; every enquiry stays there.

## Connecting a form

Where the site can call its own address, an admin connects a form in one step: type the code shown on EmDash's approval page, press Authorize, then Done, connect. The access is used once and thrown away. Elsewhere, someone who looks after the site's code connects each form once; New delivery shows the instructions and can email them.

## Permissions

Send web requests to the addresses you enter, and to the site itself (to connect a form in one step, with the access you approve). Send email (Email deliveries and alerts). Read the forms' notification emails to its private address, and cancel those.
