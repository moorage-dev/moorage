---
"@moorage/plugin-analytics": patch
---

With HubSpot switched on, a form that has a hidden field named `hutk` now gets HubSpot's visitor token (from the `hubspotutk` cookie) in that field as the form is sent, only while the visitor allows Marketing; otherwise the field is sent empty, so a value left in it never goes out. Lead Delivery passes the token to HubSpot, which then adds the enquiry to the visitor's earlier visits. There is no new setting, no request and nothing stored, and nothing changes for sites without HubSpot or for forms without that field. Forms inside a popup, and forms that post with their own script, are not covered.
