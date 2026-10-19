# @moorage/plugin-site-health

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
