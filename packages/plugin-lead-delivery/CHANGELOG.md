# @moorage/plugin-lead-delivery

## 0.3.1

### Patch Changes

- ea5950c: Your deliveries, private address and known forms now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this Lead delivery started over after a switch: no deliveries, and a new private address that every connected form would no longer match. They are now kept where EmDash finds them in both modes.
  
  Nothing to do on your side: the first enquiry, scheduled run or visit to Lead delivery after updating copies everything to the new place, keeping the same private address. Update first, open Lead delivery once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.3.0 still shows your latest deliveries and forms. If you go back, change something there and then update again, the update shows what you had before you went back; make the change again.
  
  An arriving enquiry now makes a few fewer calls to the site's storage, because the plugin reuses what it has already read in the same run.

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
