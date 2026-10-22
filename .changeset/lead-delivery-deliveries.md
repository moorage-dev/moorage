---
"@moorage/plugin-lead-delivery": minor
---

Lead delivery is now one page built around deliveries. A delivery is one form and where its enquiries go, named for you ("Contact form → Shop inbox"); a form can have several. Press New delivery, choose the form and where to send, and a test is sent when you save. A form's first delivery shows the instructions to connect it.

- Every delivery in the list has its own Open and Enquiries buttons. A delivery's page shows whether the test arrived and whether real enquiries are arriving, with Send a test, Edit, Turn off and Delete.
- Same email address again: send every enquiry, or not twice within 24 hours or 7 days, chosen for each delivery.
- A new "Possibly spam" mark (many links, a known sales-pitch phrase, a message that is only a link). Marked enquiries are still sent unless you turn on "Don't send possibly spam" for that delivery.
- Every mark (possibly fake address, same address again, possibly spam) is listed at the top of each delivered email. Apps get a `marks` list.
- Held enquiries, and enquiries from a form with no delivery, are listed as Not sent; Send again sends a held one.
- A test that gets no answer is not tried again for two days.
- Updating needs nothing: your setup becomes deliveries with the same ids, so the log, matching, secrets and connected forms keep working. Each delivery gets a new name, and the page says so once.
