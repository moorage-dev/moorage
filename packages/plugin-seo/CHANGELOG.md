# @moorage/plugin-seo

## 0.1.10

### Patch Changes

- 8e315f1: The EmDash registry listing gets an icon and a banner; no change to how the plugin works.

## 0.1.9

### Patch Changes

- 395c5f0: On sites that run SEO sandboxed on Cloudflare, every page view, save, background step and SEO page action now stays within the sandbox's limit of 10 calls per request. Before, some of them could fail part-way:
  
  - The first view of a page saved before the plugin was installed (on a new site, every page until the page check had run) went over the limit. That view now describes the page from the page itself, with the same structured data as before (dates, authors, picture sizes, your own JSON-LD), and stores nothing; the page's check result is stored by the page check or the page's next save.
  - A page view no longer builds records or copies settings; it writes only when the picture shared for a page changes. Settings saved by 0.1.7 or earlier are copied to their new place by a visit to the SEO page once the page check has finished, or by the next save.
  - Switching the plugin on starts the page check with fewer calls, and a check step on a site with several empty collections no longer goes over.
  - Importing redirects adds what fits in the click and the rest in the background, a few each minute. Removing an import works the same way, with a progress bar, "Remove more now" and "Stop here". The SEO page says how far it got.

## 0.1.8

### Patch Changes

- 961b4b9: Your SEO settings now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this the Settings tab came back empty after a switch, and the old values only returned when you switched back. Settings are now kept where EmDash finds them in both modes.
  
  Nothing to do on your side: the first page view or visit to the SEO page after updating copies your settings to the new place. Update first, open the SEO page once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.1.7 still shows your latest settings. If you go back, change settings there and then update again, the update shows the settings from before you went back; save them again.

- a9004ee: The warning that two pages share a title no longer disappears by itself. When a page was saved while "Check my pages" was running, or two pages with the same title were saved at the same moment, one of them could lose the warning (or keep it after a rename) until the next check. A save now reads the pages with its title after writing, and a check no longer writes over a page saved after it read that page, so the warning ends up on exactly the pages that share a title.

- A page deleted while "Check my pages" was running no longer lingers in the SEO page's counts, and no longer keeps another page flagged for sharing its title. At the end of each full check, the plugin now removes what it kept about pages the check did not find, then settles the title warnings; pages created or saved during the check are left alone. This only ever showed in the admin, never on the public site.
- The Google preview panel no longer risks hitting Cloudflare's limit of 10 operations per request when a page's title and its page type are changed together. The panel now leaves moving the "same title" warning between pages to the save itself (or the next check), as it already did in the usual case.
- The end-of-check cleanup above now asks EmDash about each page before removing what the plugin kept about it. A page that was unpublished, or whose record a page view wrote back, while the check ran keeps its record and the page type an admin picked; an unpublished one is simply counted as a draft.
- Saving a page that moves it from one shared title to another could take 11 operations on a site whose SEO settings were never saved, over Cloudflare's limit of 10 per request, so the "same title" warnings were not updated for that save. Such a save now reads both titles at once and stays at 9 at most.

## 0.1.7

### Patch Changes

- 079b9ad: Pages render faster: settings are kept for 30 seconds between page views, and a save takes effect at once.

## 0.1.6

### Patch Changes

- ba5f9ed: The Redirects tab now shows imported redirects as soon as they are added, and drops them as soon as you remove the batch, without reloading the page. The README and listing now say the importer reads CSV exports only.

## 0.1.5

### Patch Changes

- 4586179: README: on Cloudflare's Workers free plan a save or publish can now and then fail with "Worker exceeded resource limits" (about 10 ms of CPU per request, which EmDash's own saving already comes close to); trying again works, and Workers Paid does not have this problem. No code change.

## 0.1.4

### Patch Changes

- 272f2f3: The SEO page shows real numbers on a new site that runs the plugin in its own process (`plugins: [seo]`, as on the Workers free plan). There the plugin is switched on when the server starts, before setup has added any pages, and its first check found nothing; it then showed "No published pages yet" until "Check all pages again" was pressed. A first check that finds nothing is no longer kept, so the first visit to the SEO page checks the pages. Sandboxed installs were not affected.

## 0.1.3

### Patch Changes

- Now open source under the MIT License. Releases 0.1.0 to 0.1.2 were published under FSL-1.1-MIT; GoSi Tech, which holds the copyright, now also licenses them under MIT. The code is unchanged.

## 0.1.2

### Patch Changes

- One graph for everything, and checks that match what the page shows.
  
  - **Your own markup joins the graph.** Schema pasted into an entry's `json_ld` field is now part of the page's one linked graph instead of a second script, so every page has exactly one JSON-LD script. Give your object an `@id` and the page names it as its main entity (`mainEntity`). Service and profile pages keep the main entity they already have, and article pages keep the article. An object that reuses an `@id` already in the graph is left out, so give yours its own.
  - **An excerpt counts as a description.** EmDash uses an entry's excerpt as the page description when the SEO panel has none. The checks and the Google preview now do the same, so a page that shows a description is no longer listed under "No search description". The preview says when the text comes from the excerpt. Pages already checked are updated when they are next saved, or when you press "Check all pages again" on the SEO page.
  - **No page markup on pages kept out of search.** A page that is noindex (hidden in its SEO panel, in a hidden content type, or marked noindex by the theme, such as a 404 page) now gets the site's own nodes only: no WebPage, image, breadcrumb or custom nodes.
  - **One id per picture, with its size.** A picture used on several pages has the same `@id` on all of them (its address) instead of a new one per page. When the page's picture is one of the entry's own images (an image field, an image in a block or in rich text, or the same file chosen in the SEO panel), the markup now includes its `width` and `height`. A resized or transformed address gets no size, because the original's would be wrong. Pages get their sizes when they are next saved, or when you press "Check all pages again".
  - **No more "no picture" advice for pages that share one.** The advice about shared links is based on the saved entry, which cannot show a picture your theme adds. The plugin now notices when a page is actually shown with a picture and drops the advice for that page; if the page later appears without one, the advice comes back. A default sharing image set for the whole site is not visible to this plugin with the permissions it has, and the advice says so.

## 0.1.1

### Patch Changes

- Documentation only; the plugin itself is unchanged. The README and listing now say the plugin can be installed from the EmDash registry, use the current names of the Redirects buttons, explain the permissions it asks for, and answer "Is it free?" in the licence's own terms. The copyright notice now names GoSi Tech, the legal owner of Moorage; the licence terms are unchanged.

## 0.1.0

### Minor Changes

- First release.
  
  - **Schema markup.** One linked structured-data graph per page in place of EmDash's single JSON-LD object: Organization, Person or a local business with address and opening hours; WebSite; WebPage; blog posts and articles with their byline authors; services; team members; breadcrumbs; the primary image. Extra schema per entry through a `json_ld` field.
  - **Robots tag.** Hide a whole content type from search, with snippet and image-preview defaults on indexable pages. A page hidden in EmDash's SEO panel always stays hidden.
  - **SEO page** in the admin, with three tabs. Overview: pages checked, pages to fix with a link to each, the details Google still needs for your kind of site, and warnings when content is hidden. Redirects: add, change and remove redirects, and import a list exported from Redirection, Yoast SEO Premium or Rank Math. Settings: who the site is for, address and phone, opening hours, logo, profiles elsewhere and content types, each marked needed, worth adding or optional.
  - **Page checks**, run on every save and across the whole site: no title, a title that says nothing, no search description, a title shared with another page, a canonical pointing at a different page; and advice on long titles, missing social images, articles without an author, pictures without alt text and nearly empty pages.
  - **Google preview** panel in the entry editor: the address, title and description as Google may show them, the page's type, and what to fix.
  - **Dashboard widget** with the number of pages to fix.
  
  Requires EmDash 1.2.0 or newer. Asks for four permissions: read content, read bylines, read the content schema, manage redirects.
