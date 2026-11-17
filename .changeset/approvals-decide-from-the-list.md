---
"@moorage/plugin-approvals": minor
---

Content Approval: deciding from the Waiting list is simpler and quicker, and deciding several pages no longer stalls on slow sites.

- Each row in Waiting now has **Approve and publish** (after EmDash's confirm dialog) next to **Review**, so one page can be approved and published without opening it. A request to schedule says **Approve**: it is approved, not published.
- With two or more waiting, **Approve and publish all N** sits above the rows: one press, one confirm. It decides exactly the pages the list showed.
- To decide some of them, tick them under the rows, optionally write one note, and press **Continue with the ticked pages**; the next screen offers **Approve and publish N** and, with a note, **Send back N**. The "Which pages" choice and the separate "Check selection" step are gone.
- The press decides as many pages as fit straight away, so a few pages are live as soon as the page answers; only the rest wait for the background.
- Fixed: in 0.5.0, deciding several pages in the background could stall on a slow site (for example on Cloudflare Workers): EmDash stops a plugin's hook after 5 seconds, so a background turn could be cut off before it recorded its progress, a page could be approved without being published, and the banner kept saying "0 done". The plugin now gives its hooks more time, each background turn stops in time and records what it decided, an approved page is published on the next turn (its writer is still told), the banner counts what was really decided, and a run that EmDash stops trying ends with "Stopped: this site was too slow to finish." instead of showing as running for ever.
- A page you approve yourself from its review while a decision on several is going stays as you left it: the run does not publish it, and says "Approved earlier; not published by this run."
- The banner counts only pages that went live (or, for a request to schedule, were approved) as done, and shows "approved but not live yet" apart.
- On a site without scheduled tasks, the all button offers only as many as one press can decide, and says so.
- With very many requests, each tab draws the most recent rows in full and says how many more are not listed, so the page stays within EmDash's size limit.
