---
"@moorage/plugin-lead-delivery": patch
---

- If something goes wrong the first time the site starts the plugin (EmDash 1.5 starts plugins as the site starts), it now stays switched on. Its private address and the every-minute delivery task are made when an administrator next opens the Lead delivery page.
- Replies to an enquiry now go to the same address Forms uses: the first required email field with a value, then any filled email field. A form with an optional business email before the visitor's own required email now sends replies to the visitor. Lead delivery learns which fields a form requires the next time it reads the form from Forms (for example when you connect it); until then replies go to the first filled email field, as before.
