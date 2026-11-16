---
"@moorage/plugin-analytics": patch
---

HubSpot accounts in the US West (NA2), Canada (NA3) and Australia (AP1) data centres now load HubSpot from their own address, such as `js-na2.hs-scripts.com`, instead of HubSpot's usual one. Paste the code HubSpot gives you (or just its script address) in the HubSpot box: the data centre is read from it, and the Tools tab says which one it found. An EU address in the pasted code switches on "My HubSpot account is in the EU data centre". Sites that typed just the Hub ID load exactly what they loaded before. If your site sends a Content Security Policy, allow `*.hs-scripts.com`.
