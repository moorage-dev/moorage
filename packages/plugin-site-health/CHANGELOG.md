# @moorage/plugin-site-health

## 0.1.3

### Patch Changes

- 961b4b9: Who gets emails, and whether links to other websites are checked, now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this a switch emptied the email list (the first Admin to open the page then became the only person on it) and turned the outside-link check back on. These options are now kept where EmDash finds them in both modes.
  
  Nothing to do on your side: the next check or visit to the Site Health page after updating copies them to the new place. Update first, open the page once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.1.2 still uses your latest options. The check results themselves are rebuilt by the next full check after a switch.

## 0.1.2

### Patch Changes

- 1bba02f: - **Checklist, Email row:** worked out fresh every time the Checklist opens, instead of repeating the last email sent. It now says "Not set up" only when it knows (no email service chosen, on a site where Site Health runs in the site's own process), needs attention when nobody is on the list, and otherwise says when it last checked and how that went, with "press Send a test email to check now". The Email line, directly under the Checklist table, shows its status, who gets the emails and the "Send a test email" button together. Options opens by itself when nobody is on the list.
  - **A site in the middle of an update:** when the home page answers with EmDash's "database update not finished" page, Site Health no longer says the site turns checkers away. It shows "Your site is in the middle of an update" on the Problems tab, a "Site up" line on the Checklist, and emails at once (still at most one urgent email a day). Bot protection is reported as before.
  - **Scheduled tasks not running:** the instructions for your web person now start with one plain sentence before the commands.

## 0.1.1

### Patch Changes

- dde14f2: Listing FAQ: "My site is not public yet. Does it work?" now says exactly what is checked before the site can open its own pages (links to your pages and posts at once; other addresses on your site, menus, page errors and the Checklist once it has a public address). No code change.
- 4586179: README: on Cloudflare's Workers free plan a save or publish can now and then fail with "Worker exceeded resource limits" (about 10 ms of CPU per request, which EmDash's own saving already comes close to); trying again works, and Workers Paid does not have this problem. No code change.

## 0.1.0

### Minor Changes

- 93ae7d5: First version of Site Health & Broken Links:
  
  - **Broken links,** grouped by how bad (every page, one page, one link), with a Fix menu on every row: send visitors to a page picked from a list, edit the page, check again, or mark as fine.
  - **Links to other sites,** checked politely and confirmed a day apart before they count.
  - **Email** at once for page errors and broken menu links, plus a weekly list of what is new.
  - **A setup checklist** and a dashboard widget.
