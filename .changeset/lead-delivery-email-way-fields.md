---
"@moorage/plugin-lead-delivery": patch
---

A form connected the email way (through Forms' notification email, which a site behind a sign-in wall has to use) could lose fields from its enquiries. Forms leaves empty fields out of its email, and the plugin took the fields of the latest enquiry as the form's whole list, so after one short enquiry, later emails kept only the lines it had seen, and a line before the first known one was dropped. Fields learned from emailed enquiries now only grow (up to 100). A line under a label the plugin has not seen yet is kept as a field of its own when it comes first or follows a short value such as a name, an email address or a number; after a message it stays part of the message, as before. An email that could not be read no longer changes what the plugin knows about the form. Forms connected in one step are not affected, and Forms > Submissions always had every field.
