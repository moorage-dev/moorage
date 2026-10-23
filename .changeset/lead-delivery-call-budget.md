---
"@moorage/plugin-lead-delivery": minor
---

Lead Delivery now works when it runs sandboxed on Cloudflare. Every page, button, arriving enquiry and scheduled run stays within the sandbox's limit of 10 calls per request, however many deliveries, enquiries or forms a site has. Before, most of them went over: an arriving enquiry could be stored without being sent, the Lead delivery page did not open, and one-click connect could fail before it threw away its one-time admin access. What you will notice:

- Enquiries are delivered by the every-minute run, usually within a minute of arriving, instead of while the form is being sent. When many arrive at once, each run sends a few and the next run carries on, so nothing is sent twice and nothing is dropped.
- One-click connect throws its one-time access away straight after changing the form, before it saves anything.
- Send all failed again and Add the form to a delivery put the enquiries back in line for the next run, so pressing twice never sends twice.
- Send again and Send now still send at once, then show a short screen with the result and the way back.
- A test from Send a test is logged as before but no longer stores the enquiry's contents.
- The once-a-day work (the quiet-form alert and cleaning up rows older than 30 days) has a run of its own, and the day counts as done only once it has finished. An alert is noted as sent only after it was sent.
- The Lead delivery page reads the log once for all deliveries, so it opens as quickly with ten deliveries as with one.
- Settings saved by 0.3.0 or earlier are copied to their new place when an admin opens Lead delivery. Arriving enquiries update the known forms in the new place only; 0.3.1 reads them there.
