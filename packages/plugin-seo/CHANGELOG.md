# @moorage/plugin-seo

## 0.1.1

### Patch Changes

- Documentation only; the plugin itself is unchanged. The README and listing now say the plugin can be installed from the EmDash registry, use the current names of the Redirects buttons, explain the permissions it asks for, and answer "Is it free?" in the licence's own terms. The copyright notice now names GoSi Tech, the legal owner of Moorage; the licence terms are unchanged.

## 0.1.0

### Minor Changes

-First release.
  
  - **Schema markup.** One linked structured-data graph per page in place of EmDash's single JSON-LD object: Organization, Person or a local business with address and opening hours; WebSite; WebPage; blog posts and articles with their byline authors; services; team members; breadcrumbs; the primary image. Extra schema per entry through a `json_ld` field.
  - **Robots tag.** Hide a whole content type from search, with snippet and image-preview defaults on indexable pages. A page hidden in EmDash's SEO panel always stays hidden.
  - **SEO page** in the admin, with three tabs. Overview: pages checked, pages to fix with a link to each, the details Google still needs for your kind of site, and warnings when content is hidden. Redirects: add, change and remove redirects, and import a list exported from Redirection, Yoast SEO Premium or Rank Math. Settings: who the site is for, address and phone, opening hours, logo, profiles elsewhere and content types, each marked needed, worth adding or optional.
  - **Page checks**, run on every save and across the whole site: no title, a title that says nothing, no search description, a title shared with another page, a canonical pointing at a different page; and advice on long titles, missing social images, articles without an author, pictures without alt text and nearly empty pages.
  - **Google preview** panel in the entry editor: the address, title and description as Google may show them, the page's type, and what to fix.
  - **Dashboard widget** with the number of pages to fix.
  
  Requires EmDash 1.2.0 or newer. Asks for four permissions: read content, read bylines, read the content schema, manage redirects.
