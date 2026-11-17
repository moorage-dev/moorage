# @moorage/plugin-approvals

## 0.6.0

### Minor Changes

- fe672c3: Content Approval: deciding from the Waiting list is simpler and quicker, and deciding several pages no longer stalls on slow sites.
  
  - Each row in Waiting now has **Approve and publish** (after EmDash's confirm dialog) next to **Review**, so one page can be approved and published without opening it. A request to schedule says **Approve**: it is approved, not published.
  - With two or more waiting, **Approve and publish all N** sits above the rows: one press, one confirm. It decides exactly the pages the list showed.
  - To decide some of them, tick them under the rows, optionally write one note, and press **Continue with the ticked pages**; the next screen offers **Approve and publish N** and, with a note, **Send back N**. The "Which pages" choice and the separate "Check selection" step are gone.
  - The press decides as many pages as fit straight away, so a few pages are live as soon as the page answers; only the rest wait for the background.
  - Fixed: in 0.5.0, deciding several pages in the background could stall on a slow site (for example on Cloudflare Workers): EmDash stops a plugin's hook after 5 seconds, so a background turn could be cut off before it recorded its progress, a page could be approved without being published, and the banner kept saying "0 done". The plugin now gives its hooks more time, each background turn stops in time and records what it decided, an approved page is published on the next turn (its writer is still told), the banner counts what was really decided, and a run that EmDash stops trying ends with "Stopped: this site was too slow to finish." instead of showing as running for ever.
  - A page you approve yourself from its review while a decision on several is going stays as you left it: the run does not publish it, and says "Approved earlier; not published by this run."
  - The banner counts only pages that went live (or, for a request to schedule, were approved) as done, and shows "approved but not live yet" apart.
  - On a site without scheduled tasks, the all button offers only as many as one press can decide, and says so.
  - With very many requests, each tab draws the most recent rows in full and says how many more are not listed, so the page stays within EmDash's size limit.

## 0.5.0

### Minor Changes

- 463d704: Requests for entries in a content type without a title field (such as a Releases type named by its version) no longer show as "Untitled": an entry is named by its content type's title field, else a field called title or name, else its address (slug), else its id, on the Approvals page, in the editor panel, in emails and in the MCP tools. Requests stored as "Untitled" by earlier versions are named when they are next shown, emailed or published again.
  
  Approvers can decide several requests at once: **Decide several at once**, under the Waiting rows, offers the ones you tick or all waiting for you, each with its name, content type, who asked and when, publish or schedule, and what it changes ("new page", or which fields). Choose **Approve and publish selected** or **Send back selected** (one note for every writer) and press **Check selection** to see the list; one press then decides them in the background, a few at a time, with the same checks as a single decision. Waiting shows how far it is, with **Stop**, and then each page's result until dismissed or for 7 days after the run ended; the ones that need a look stay ticked. A request to schedule is approved, not published, so its writer can schedule it. Each row also says what it changes.
  
  New MCP tools for a reviewer that is an AI tool: `approvals__changes` (read-only: what a request would change, field by field, before and after; a long field comes back as the part that changed and is marked truncated), `approvals__approve` (needs the `version` from `changes`) and `approvals__send_back`, and `approvals__ask_approval` (ask for approval of a draft without a publish). Approving and sending back are off until an Admin switches on the new setting **AI tools may approve**; then an AI tool may decide for the person whose key it uses, their own requests included, and the history and the writer's email say it was "an AI tool acting for" that person. The setting that holds AI publishing is now called **Hold what AI tools publish for approval**; nothing about it changed. A held publish's SEO panel values still go live at once on EmDash 1.5.0, as before.

## 0.4.0

### Minor Changes

- 2628369: **Use with an AI assistant (MCP).** Two read-only tools for AI assistants connected to your site through EmDash's MCP server: `queue` lists the pages waiting for approval (those waiting for you, and your own), and `status` shows one page's approval as its Approval panel does (whether publishing it needs approval, waiting, approved, sent back or published, by whom and when, the latest history lines). Each person gets only what the Approvals page and the panel show them; neither tool returns email addresses, and neither publishes or changes anything. The tools are off until an Admin switches them on for this plugin in EmDash. When you update from the Registry, EmDash asks you to approve the new tools first.
  
  Needs EmDash 1.5.0 or later.

## 0.3.1

### Patch Changes

- e5b4caf: Ready for EmDash's co-editing (EmDash 1.5, when a site turns it on): when several people edit a page together, EmDash saves their changes as one save in one person's name. If that save holds someone else's changes too, an approved page now needs approval again, and an approver is no longer named as the only person who changed a page waiting for approval. Without co-editing nothing changes.

## 0.3.0

### Minor Changes

- af41977: **Withdraw**: the person who asked can now take a waiting request back, from the page's Approval panel or from **Yours, waiting** on the Approvals page (Contributors use the Approvals page). Nothing is published; the approvers no longer see it, and their email is not sent if it has not gone yet. Asking again the same day does not email the approvers a second time; if their email had not gone yet, asking again does email them. When an approval and a withdraw land at the same moment, only the first counts and the other person is told the request changed.
  
  The Settings tab now names the pages already scheduled that approval will hold when their time comes, with their time, instead of a general warning (it reads the first three content types that need approval).
  
  What you will notice: every time the plugin shows, on screen and in emails, now ends in "UTC" ("16 Oct, 10:42 UTC"). They were always in UTC; EmDash does not tell plugins the site's time zone.
  
  The Settings tab, the README and the listing now say plainly that taking a page off the site (Unpublish) is not held by choice, so a wrong page can always come down at once; before, they said it could not be held.

### Patch Changes

- 71348af: New screenshots of the screens this release changes and adds.

## 0.2.4

### Patch Changes

- f421512: New screenshots of the admin pages on EmDash 1.4.0.

## 0.2.3

### Patch Changes

- b497b9a: Install texts corrected: the admin's entry for installing plugins is **Registry**, not Plugins; running sandboxed on Cloudflare needs both the `LOADER` Worker Loader binding in `wrangler.jsonc` and `sandboxRunner: sandbox()` in `astro.config.mjs` (answering Yes in `create-emdash` adds only the binding). Content Approval: its package homepage now points to https://moorage.dev/plugins/content-approval, and the FAQ says Contributors still see "Plugin action failed" in the editor on EmDash 1.4.0.

## 0.2.2

### Patch Changes

- dd67159: On EmDash 1.4.0, approving and publishing a page whose last publish is still finishing now says "The page was still finishing its last publish: press Publish on the page in a moment." instead of the general "could not be published just now".
- dd67159: Installed from the EmDash registry on Cloudflare, these plugins could not send email on EmDash 1.3: every email failed with "Email is not configured", although the site's own emails worked. EmDash 1.4.0 fixes that. Until a site updates, Lead Delivery marks such a delivery as needing a person and asks for the EmDash update instead of trying again, Site Health's Checklist says the same after a test email, and Content Approval's log names the update when approval emails fail this way.

## 0.2.1

### Patch Changes

- 6516427: Admins see a small help line at the foot of the page, with a link to the guide; it can be hidden in Settings.
- 8370eca: New screenshots of the current admin page, with the help line at its foot.

## 0.2.0

### Minor Changes

- 1b3ff0b: On sites that run Content Approval sandboxed on Cloudflare, every page, button, hook and email run now stays within the sandbox's limit of 10 calls per request, however many pages wait and however many people approve. Before, the Approvals page stopped opening once two pages waited, and most Approve, Approve and publish, Send back and Ask for approval buttons failed part-way: the decision was saved but the person saw an error, and some emails were never sent. What you will notice:
  
  - Emails to the writer and to the other approvers now go out from a background task, usually within a minute of the decision, instead of during the click. On a site with many approvers a few go out each run until everyone has theirs. An email that fails is tried twice more, five minutes apart, instead of being dropped.
  - On the Approvals page, Approve, Approve and publish, Approve without review and Ask for approval end on a short confirmation with "Back to the list", instead of the full list.
  - The "things to check" count on each waiting page is noted when the page is held or saved, so the list no longer reads every page.
  - A Contributor's "Your drafts" lists drafts from the first three content types that need approval.
  - Settings saved by 0.1.5 or earlier are copied to their new place when an admin opens the Approvals page (before, by any publish).

## 0.1.6

### Patch Changes

- 961b4b9: Your approval settings now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this a switch turned approval off without a word (nothing was held until the settings were saved again), and the old settings only returned when you switched back. Settings are now kept where EmDash finds them in both modes.
  
  Nothing to do on your side: the first publish or visit to the Approvals page after updating copies your settings to the new place. Update first, open the Approvals page once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.1.5 still uses your latest settings. If you go back, change settings there and then update again, the update shows the settings from before you went back; save them again.

## 0.1.5

### Patch Changes

- f8dd491: README and listing pictures retaken on the current versions: the Popups list with Edit and Preview on each row, and Content Approval's Waiting and Settings tabs without counts. No code change.

## 0.1.4

### Patch Changes

- 969d4c5: On a phone, all the tabs (Waiting, Sent back, History and, for admins, Settings) now fit on the screen. Before, Settings was cut off at the right edge. The tabs no longer show counts; the numbers at the top of Waiting still do.

## 0.1.3

### Patch Changes

- c76285f: Your own requests are listed apart under "Yours, waiting", with what each waits for, and no longer show Approve buttons you cannot use. An admin publishes their own request with "Publish without review" (a reason is required and emailed to the other approvers). When nobody else can approve, Settings, the Approvals page and the held Publish say approval needs a second person. Short help under each setting replaces the long explanation.

## 0.1.2

### Patch Changes

- afbde42: Dates in the approver's review and in the approved text copy now read "19 Oct 2026", or "19 Oct 2026, 14:05 UTC" with a time, instead of "2026-10-19T00:00:00.000Z"; copies saved before this show the same way and do not count as a change. README and listing: Contributors ask from Approvals > Your drafts, because EmDash 1.3.1 shows them the editor's "Ask for approval" button and Approval panel but refuses both ("Plugin action failed"); the History tab shows the latest approved text of each page, not every approved version.

## 0.1.1

### Patch Changes

- 4586179: README: on Cloudflare's Workers free plan a save or publish can now and then fail with "Worker exceeded resource limits" (about 10 ms of CPU per request, which EmDash's own saving already comes close to); trying again works, and Workers Paid does not have this problem. No code change.

## 0.1.0

### Minor Changes

- 9748082: First version of Content Approval: Publish sends a page for approval on the content types you choose; approvers approve and publish in one step, approve for later or send it back with a note, and see what changed in words; a text copy of each approved version is kept.
