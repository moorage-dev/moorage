---
"@moorage/plugin-approvals": minor
---

On sites that run Content Approval sandboxed on Cloudflare, every page, button, hook and email run now stays within the sandbox's limit of 10 calls per request, however many pages wait and however many people approve. Before, the Approvals page stopped opening once two pages waited, and most Approve, Approve and publish, Send back and Ask for approval buttons failed part-way: the decision was saved but the person saw an error, and some emails were never sent. What you will notice:

- Emails to the writer and to the other approvers now go out from a background task, usually within a minute of the decision, instead of during the click. On a site with many approvers a few go out each run until everyone has theirs. An email that fails is tried twice more, five minutes apart, instead of being dropped.
- On the Approvals page, Approve, Approve and publish, Approve without review and Ask for approval end on a short confirmation with "Back to the list", instead of the full list.
- The "things to check" count on each waiting page is noted when the page is held or saved, so the list no longer reads every page.
- A Contributor's "Your drafts" lists drafts from the first three content types that need approval.
- Settings saved by 0.1.5 or earlier are copied to their new place when an admin opens the Approvals page (before, by any publish).
