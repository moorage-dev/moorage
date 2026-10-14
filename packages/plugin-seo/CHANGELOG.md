# @moorage/plugin-seo

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
