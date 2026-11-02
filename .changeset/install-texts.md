---
"@moorage/plugin-seo": patch
"@moorage/plugin-site-health": patch
"@moorage/plugin-approvals": patch
"@moorage/plugin-lead-delivery": patch
---

Install texts corrected: the admin's entry for installing plugins is **Registry**, not Plugins; running sandboxed on Cloudflare needs both the `LOADER` Worker Loader binding in `wrangler.jsonc` and `sandboxRunner: sandbox()` in `astro.config.mjs` (answering Yes in `create-emdash` adds only the binding). Content Approval: its package homepage now points to https://moorage.dev/plugins/content-approval, and the FAQ says Contributors still see "Plugin action failed" in the editor on EmDash 1.4.0.
