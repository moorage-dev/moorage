---
"@moorage/plugin-seo": patch
"@moorage/plugin-site-health": patch
"@moorage/plugin-approvals": patch
"@moorage/plugin-lead-delivery": patch
---

README: on Cloudflare's Workers free plan a save or publish can now and then fail with "Worker exceeded resource limits" (about 10 ms of CPU per request, which EmDash's own saving already comes close to); trying again works, and Workers Paid does not have this problem. No code change.
