# @moorage/plugin-lead-delivery

## 0.5.0

### Minor Changes

- be220d2: Send enquiries to a Slack or Discord channel, and refuse every private-network address.
  
  - **Slack or Discord channel**, a new kind of delivery: paste the channel's incoming-webhook address and each enquiry becomes one message with the form's fields, the marks and a link to Forms → Submissions. Nothing people write can ping the channel, and addresses they write show no preview. A Discord message over its 2000-character limit is shortened field by field, keeping the link to Forms. "Leave out what people wrote" sends only "New enquiry: Contact form" with the link, for a channel where not everyone should read personal details. Retries, the log and alerts work as for an app. The address is kept like an app's signing secret: the page shows only its host and last four characters, it never appears in the log, and Edit keeps it when its box is left empty.
  - **Forms' own auto-reply.** A delivery's page says whether Forms also sends its own auto-reply to the person who wrote, for forms connected in one step (read from Forms then; for forms connected another way it is not shown).
  - **Unticked checkboxes** now show as "no" in delivered emails and channel messages (for forms whose fields Lead Delivery knows), instead of being left out, and a ticked box reads "yes". A box shown only on a condition is still left out. Apps and HubSpot receive exactly what they did before: no field for an unticked box and a ticked box's value unchanged, so a Zap filtering on "field exists" still works.
  - **Safer app addresses**: Lead Delivery now refuses every address on a private network, not only the common ones. Newly refused: 172.16.0.0 to 172.31.255.255, 0.0.0.0, 100.64.0.0/10 (carrier-grade NAT), other reserved ranges, IPv6 unique-local (`fc00::/7`) and link-local (`fe80::/10`), documentation (`2001:db8::/32`) and discard (`100::/64`) addresses, local NAT64 (`64:ff9b:1::/48`), private IPv4 inside IPv6 (mapped, translated, NAT64 and 6to4 `2002::/16`), 192.88.99.0/24, names ending in `.localdomain` or `.corp`, and the same addresses written as one number, in hex or in octal (`2130706433`, `0x7f.1`). Public IPv6 addresses are now accepted. The check also runs before every send, so an app delivery saved earlier with such an address is no longer sent: it shows as needing fixing, with the way to change it under Edit. Only Admins can enter or change a delivery's address.

### Patch Changes

- 71348af: New screenshots of the screens this release changes and adds.

## 0.4.4

### Patch Changes

- f421512: New screenshots of the admin pages on EmDash 1.4.0.

## 0.4.3

### Patch Changes

- b497b9a: Install texts corrected: the admin's entry for installing plugins is **Registry**, not Plugins; running sandboxed on Cloudflare needs both the `LOADER` Worker Loader binding in `wrangler.jsonc` and `sandboxRunner: sandbox()` in `astro.config.mjs` (answering Yes in `create-emdash` adds only the binding). Content Approval: its package homepage now points to https://moorage.dev/plugins/content-approval, and the FAQ says Contributors still see "Plugin action failed" in the editor on EmDash 1.4.0.
- b497b9a: New delivery's "Another form" box now says where to find a form's short name: "Its short name (the Slug column in Forms)". It used to say Forms lists it under each form's name, which it does not.

## 0.4.2

### Patch Changes

- dd67159: Installed from the EmDash registry on Cloudflare, these plugins could not send email on EmDash 1.3: every email failed with "Email is not configured", although the site's own emails worked. EmDash 1.4.0 fixes that. Until a site updates, Lead Delivery marks such a delivery as needing a person and asks for the EmDash update instead of trying again, Site Health's Checklist says the same after a test email, and Content Approval's log names the update when approval emails fail this way.

## 0.4.1

### Patch Changes

- 6516427: Admins see a small help line at the foot of the page, with a link to the guide; it can be hidden under Settings for the whole site.
- 8370eca: New screenshots of the current admin page, with the help line at its foot.

## 0.4.0

### Minor Changes

- 684b807: Lead Delivery now works when it runs sandboxed on Cloudflare. Every page, button, arriving enquiry and scheduled run stays within the sandbox's limit of 10 calls per request, however many deliveries, enquiries or forms a site has. Before, most of them went over: an arriving enquiry could be stored without being sent, the Lead delivery page did not open, and one-click connect could fail before it threw away its one-time admin access. What you will notice:
  
  - Enquiries are delivered by the every-minute run, usually within a minute of arriving, instead of while the form is being sent. When many arrive at once, each run sends a few and the next run carries on, so nothing is sent twice and nothing is dropped.
  - One-click connect throws its one-time access away straight after changing the form, before it saves anything.
  - Send all failed again and Add the form to a delivery put the enquiries back in line for the next run, so pressing twice never sends twice.
  - Send again and Send now still send at once, then show a short screen with the result and the way back.
  - A test from Send a test is logged as before but no longer stores the enquiry's contents.
  - The once-a-day work (the quiet-form alert and cleaning up rows older than 30 days) has a run of its own, and the day counts as done only once it has finished. An alert is noted as sent only after it was sent.
  - The Lead delivery page reads the log once for all deliveries, so it opens as quickly with ten deliveries as with one.
  - Settings saved by 0.3.0 or earlier are copied to their new place when an admin opens Lead delivery. Arriving enquiries update the known forms in the new place only; 0.3.1 reads them there.

## 0.3.1

### Patch Changes

- ea5950c: Your deliveries, private address and known forms now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this Lead delivery started over after a switch: no deliveries, and a new private address that every connected form would no longer match. They are now kept where EmDash finds them in both modes.
  
  Nothing to do on your side: the first enquiry, scheduled run or visit to Lead delivery after updating copies everything to the new place, keeping the same private address. Update first, open Lead delivery once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.3.0 still shows your latest deliveries and forms. If you go back, change something there and then update again, the update shows what you had before you went back; make the change again.
  
  An arriving enquiry now makes a few fewer calls to the site's storage, because the plugin reuses what it has already read in the same run.

- Run Lead Delivery in `plugins`, not `sandboxed`, for now. On Cloudflare a sandboxed plugin may make only 10 calls to the site per request; receiving, delivering and retrying an enquiry need more, so under `sandboxed` an enquiry can be stored but not delivered straight away, and the every-minute run can stop partway. The README and install text now show `plugins`. A later version will fit the limit.

## 0.3.0

### Minor Changes

- a53a3c3: Connect a form in one step, where the site can call its own address. Connect this form shows a code and a link to EmDash's own approval page, which opens empty: the admin types the code, presses Authorize, comes back and presses Done, connect. Lead Delivery uses that access once to set the form's address, then throws it away; it keeps nothing. A form that already sends somewhere else is never changed without asking. If EmDash answers in a way Lead Delivery does not expect, the screen falls back to the written instructions, which stay available on every site. Editors never see it. If throwing the access away ever fails, the page and an email to the alert list say what to do.

## 0.2.0

### Minor Changes

- 3dece08: Lead delivery is now one page built around deliveries. A delivery is one form and where its enquiries go, named for you ("Contact form → Shop inbox"); a form can have several. Press New delivery, choose the form and where to send, and a test is sent when you save. A form's first delivery shows the instructions to connect it.
  
  - Every delivery in the list has its own Open button. A delivery's page shows whether the test arrived and whether real enquiries are arriving, with Send a test, Edit, Turn off and Delete.
  - Same email address again: send every enquiry, or not twice within 24 hours or 7 days, chosen for each delivery.
  - A new "Possibly spam" mark (many links, a known sales-pitch phrase, a message that is only a link). Marked enquiries are still sent unless you turn on "Don't send possibly spam" for that delivery.
  - Every mark (possibly fake address, same address again, possibly spam) is listed at the top of each delivered email. Apps get a `marks` list.
  - Held enquiries are listed as Not sent; Send again sends them. Enquiries from a form no delivery takes are kept, the page says so, and one press adds the form to a delivery and sends them.
  - Going back to 0.1.2 keeps working: the earlier setup is kept untouched next to the deliveries.
  - A test that gets no answer is not tried again for two days.
  - Updating needs nothing: your setup becomes deliveries with the same ids, so the log, matching, secrets and connected forms keep working. Each delivery gets a new name, and the page says so once.

## 0.1.2

### Patch Changes

- de14a03: A repeat enquiry from the same address now says how long before it the last one came, by elapsed time ("Same address 5 minutes earlier", "3 hours earlier", "2 days earlier"), instead of calling a repeat from minutes ago "yesterday". The failure alert email now includes the service's own words beneath the reason, as plain text, and says "press Send again" once instead of twice. When a service refuses an enquiry without giving a reason, the admin and the email say so instead of pointing at words that are not there.

## 0.1.1

### Patch Changes

- dde14f2: README and listing: use the forms plugin 0.2.11 or later, because earlier versions save a ticked single checkbox, such as a consent box, as unticked, so the enquiry arrives without consent. No code change.
- 4586179: README: on Cloudflare's Workers free plan a save or publish can now and then fail with "Worker exceeded resource limits" (about 10 ms of CPU per request, which EmDash's own saving already comes close to); trying again works, and Workers Paid does not have this problem. No code change.

## 0.1.0

### Minor Changes

- c82c5e7: First version of Lead Delivery. Every enquiry sent through the forms plugin goes to email, HubSpot, or another app (Zapier, Make, n8n). It keeps a delivery log, tries again 8 times over about two days, and emails everyone who looks after the site when an enquiry needs fixing or a form goes quiet, at most once a day for each kind. A form connects either straight to the plugin or, on a site that cannot call its own address, through a private email address that nobody receives. Fields are matched to HubSpot before the first enquiry when the site can look the form up. Throwaway addresses and repeats are flagged, and "Don't send the same person twice within 24 hours" can be turned on for each place.
