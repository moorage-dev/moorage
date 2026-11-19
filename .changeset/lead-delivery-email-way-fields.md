---
"@moorage/plugin-lead-delivery": patch
---

A form connected the email way (through Forms' notification email, which a site behind a sign-in wall has to use) could lose fields from its enquiries. Forms leaves empty fields out of its email, and the plugin took the fields of the latest enquiry as the form's whole list, so after one short enquiry, later emails kept only the lines it had seen; a line before the first known one was dropped. Fields learned from enquiries now only grow, and a line under a label the plugin has not seen yet is kept as a field of its own. Forms connected in one step are not affected, and Forms > Submissions always had every field.
