---
"@moorage/plugin-seo": patch
---

One graph for everything, and checks that match what the page shows.

- **Your own markup joins the graph.** Schema pasted into an entry's `json_ld` field is now part of the page's one linked graph instead of a second script, so every page has exactly one JSON-LD script. Give your object an `@id` and the page names it as its main entity (`mainEntity`). Service and profile pages keep the main entity they already have, and article pages keep the article. An object that reuses an `@id` already in the graph is left out, so give yours its own.
- **An excerpt counts as a description.** EmDash uses an entry's excerpt as the page description when the SEO panel has none. The checks and the Google preview now do the same, so a page that shows a description is no longer listed under "No search description". The preview says when the text comes from the excerpt. Pages already checked are updated when they are next saved, or when you press "Check all pages again" on the SEO page.
- **No page markup on pages kept out of search.** A page that is noindex (hidden in its SEO panel, in a hidden content type, or marked noindex by the theme, such as a 404 page) now gets the site's own nodes only: no WebPage, image, breadcrumb or custom nodes.
- **One id per picture.** A picture used on several pages has the same `@id` on all of them (its address) instead of a new one per page.
