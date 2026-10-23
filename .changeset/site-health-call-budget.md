---
"@moorage/plugin-site-health": patch
---

Site Health now stays within the sandbox's limit of 10 calls to the site per run, with one to spare, so no step can fail halfway on Cloudflare. The last step of a full check is split in two. Settings saved by 0.1.2 are copied to their new place only when an Admin opens the Site Health page; when that happens, the check moves on at the next page load. Links to other sites that turn the first kind of request away are asked again on their next turn when a run has no calls left. Switching the plugin on schedules its background task once instead of twice.
