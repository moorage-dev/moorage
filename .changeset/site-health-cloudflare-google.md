---
"@moorage/plugin-site-health": patch
---

The Checklist now reminds Admins that on Cloudflare, blocking AI training (Security, Settings, AI Crawler and Agent access policies) also blocks Google, with a link to Cloudflare's steps: set Training to Allow or Disallow, then check that Google Search Console can read your sitemap. It is a reminder, not a check: Cloudflare turns away only Google's own requests, so Site Health cannot see the block. It has no status and is not counted as something that needs attention.
