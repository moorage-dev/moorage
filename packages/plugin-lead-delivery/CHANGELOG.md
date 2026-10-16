# @moorage/plugin-lead-delivery

## 0.1.0

### Minor Changes

- c82c5e7: First version of Lead Delivery. Every enquiry sent through the forms plugin goes to email, HubSpot, or another app (Zapier, Make, n8n). It keeps a delivery log, tries again 8 times over about two days, and emails everyone who looks after the site when an enquiry needs fixing or a form goes quiet, at most once a day for each kind. A form connects either straight to the plugin or, on a site that cannot call its own address, through a private email address that nobody receives. Fields are matched to HubSpot before the first enquiry when the site can look the form up. Throwaway addresses and repeats are flagged, and "Don't send the same person twice within 24 hours" can be turned on for each place.
