# @moorage/plugin-lead-delivery

## 0.1.1

### Patch Changes

- dde14f2: README and listing: use the forms plugin 0.2.11 or later, because earlier versions save a ticked single checkbox, such as a consent box, as unticked, so the enquiry arrives without consent. No code change.
- 4586179: README: on Cloudflare's Workers free plan a save or publish can now and then fail with "Worker exceeded resource limits" (about 10 ms of CPU per request, which EmDash's own saving already comes close to); trying again works, and Workers Paid does not have this problem. No code change.

## 0.1.0

### Minor Changes

- c82c5e7: First version of Lead Delivery. Every enquiry sent through the forms plugin goes to email, HubSpot, or another app (Zapier, Make, n8n). It keeps a delivery log, tries again 8 times over about two days, and emails everyone who looks after the site when an enquiry needs fixing or a form goes quiet, at most once a day for each kind. A form connects either straight to the plugin or, on a site that cannot call its own address, through a private email address that nobody receives. Fields are matched to HubSpot before the first enquiry when the site can look the form up. Throwaway addresses and repeats are flagged, and "Don't send the same person twice within 24 hours" can be turned on for each place.
