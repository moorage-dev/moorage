# @moorage/plugin-site-health

## 0.4.0

### Minor Changes

- 8a45b4f: Needs EmDash 1.5.0 or later. Two tools for an AI assistant connected to your site through EmDash's MCP server. `problems` reads what the Problems tab shows you: the counts, then each problem worst first, with its address, the same sentence the page shows, the pages it was found on, and the HTTP status and time of the last check. Editors see what the page shows Editors. `add_redirect`, for Admins only, does what the Fix menu's "Send visitors to another page" does for one problem: the same checks and refusals, and it never replaces a redirect that is already there. EmDash marks it as one that changes the site. Both tools are off until an Admin turns on Agent access for Site Health under Plugins; the assistant's API token needs the plugin tools scope. If you installed Site Health from the Registry, the update asks you to approve the new tools. Nothing else changes, and the tools never publish, unpublish or delete anything.
  
  The Fix menu's "Send visitors to another page" now says plainly that visitors can only be sent to a page on this site, starting with / (for example /pricing): EmDash 1.5 does not redirect to another site, and a full address used to fail with EmDash's own message.

## 0.3.1

### Patch Changes

- 3af50f8: The Checklist now reminds Admins that on Cloudflare, blocking AI training (Security, Settings, AI Crawler and Agent access policies) also blocks Google, with a link to Cloudflare's steps: set Training to Allow or Disallow, then check that Google Search Console can read your sitemap. It is a reminder, not a check: Cloudflare turns away only Google's own requests, so Site Health cannot see the block. It has no status and is not counted as something that needs attention.

## 0.3.0

### Minor Changes

- ea6c64f: New "Left over from WordPress" group on the Problems tab, shown only when something is found: WordPress shortcodes visitors see as plain text (such as `[contact-form-7 …]` or `[gallery]`), empty HTML blocks (what a WordPress Latest Posts block becomes), links to WordPress addresses (`/?p=12` on your site; `/wp-content/…` on another, and any link to that site, worded "looks like an address on your old WordPress site", in your pages and in the menu the home page shows), pages whose slug is in WordPress's coded form (`%cf%84…`), which open "Page not found", and pictures with no alt text (featured images and pictures inside the page). Each row says what to do; its Fix menu opens the page or Menus, or marks the row as fine. Editors see it too, and in the "Links on this page" panel. It is read from the pages the daily check already reads, and is not counted as broken; it shows after the next full check.
  
  Links to your own site written in full under another name for your own computer (`127.0.0.1` on a site set up as `localhost`, or the other way round) are now taken as links to your own pages, not to another site. On a site that is not public yet, an address on your own site that matches no page now says so in plain words: it is checked once the site has a public address (EmDash does not let plugins open addresses on your own computer or network).

## 0.2.0

### Minor Changes

- b349166: New "Links on this page" panel beside each entry in the editor: Editors see what the checks found in that page's links while they work on it, in the same plain words as the Site Health page. It is read-only, opens no website and needs no setup. A new Checklist row, "Home page in search results", warns when your home page tells search engines not to list it (a noindex tag in the page, or an X-Robots-Tag header from the server); it is read from the home page every full check already opens, so a change shows the next day. The "Search engines" row now reads robots.txt one group of crawlers at a time: keeping out Google, or every search engine, needs attention, while keeping out only AI crawlers or one folder does not. It also follows robots.txt to the list of your pages it names and accepts a list of lists (a sitemap index, which EmDash serves). These two show at the next weekly Checklist run. Under each group of problems, a folded "Details for your web person" gives each row's HTTP status and when it was checked; rows found before this update show it after their next check.

### Patch Changes

- 71348af: New screenshots of the screens this release changes and adds.

## 0.1.8

### Patch Changes

- f421512: New screenshots of the admin pages on EmDash 1.4.0.

## 0.1.7

### Patch Changes

- b497b9a: Install texts corrected: the admin's entry for installing plugins is **Registry**, not Plugins; running sandboxed on Cloudflare needs both the `LOADER` Worker Loader binding in `wrangler.jsonc` and `sandboxRunner: sandbox()` in `astro.config.mjs` (answering Yes in `create-emdash` adds only the binding). Content Approval: its package homepage now points to https://moorage.dev/plugins/content-approval, and the FAQ says Contributors still see "Plugin action failed" in the editor on EmDash 1.4.0.
- b497b9a: The first full check after a page is deleted now reports links to it as broken. Before, that check still counted the deleted page as published, so links to it showed as fine until the check after; it also opened the deleted page's address as one of the site's pages.

## 0.1.6

### Patch Changes

- dd67159: Installed from the EmDash registry on Cloudflare, these plugins could not send email on EmDash 1.3: every email failed with "Email is not configured", although the site's own emails worked. EmDash 1.4.0 fixes that. Until a site updates, Lead Delivery marks such a delivery as needing a person and asks for the EmDash update instead of trying again, Site Health's Checklist says the same after a test email, and Content Approval's log names the update when approval emails fail this way.

## 0.1.5

### Patch Changes

- 8370eca: New screenshots of the current admin page, with the help line at its foot.
- 6516427: Admins see a small help line at the foot of the page, with a link to the guide; it can be hidden under Checklist, Options.
- ee58b7f: The README and the listing's FAQ now say to restart the site after changing its address.

## 0.1.4

### Patch Changes

- 8d9ae31: Site Health now stays within the sandbox's limit of 10 calls to the site per run, with one to spare, so no step can fail halfway on Cloudflare. The last step of a full check is split in two. Settings saved by 0.1.2 are copied to their new place only when an Admin opens the Site Health page; when that happens, the check moves on at the next page load. Links to other sites that turn the first kind of request away are asked again on their next turn when a run has no calls left. Switching the plugin on schedules its background task once instead of twice.

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
