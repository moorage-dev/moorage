EmDash already handles titles, descriptions, sitemaps, canonicals and social tags. This plugin adds structured data, page checks and redirects import. No account and no key.

## What it does

- **Schema markup (structured data, JSON-LD).** One linked graph per page in place of EmDash's single object: Organization, Person or a local business with address and opening hours; WebSite; WebPage; blog posts and articles with their authors; services; team members; breadcrumbs.
- **A page type for every collection**, guessed from its name and changeable per collection or per page.
- **Pages to fix.** A list of pages with a missing description, a shared title or a canonical pointing elsewhere, each with a link to the page. No score and no traffic light: a list that can reach zero.
- **Google preview** in the entry editor: the address, title and description as Google may show them, with up to three things to fix.
- **Hide from search (noindex)** per collection, with a warning on the SEO page whenever something is hidden.
- **Redirects.** Add, change and remove redirects, or paste a list exported from Redirection, Yoast SEO Premium or Rank Math.

## What it does not do

- It does not write the page title, the sitemap or robots.txt; EmDash core and your theme do.
- No keyword density or readability score: Google uses neither.
- No FAQ, Product or Event schema yet; use a `json_ld` field for those.
- The checks describe the published page, not what you are typing.

## Limits

One business location. EmDash has no regular-expression redirects: exact addresses and "everything under a folder" are converted, other patterns are listed for you to rewrite.

## Permissions

Read content, bylines and the content schema, to check pages and build the markup. Manage redirects, only for an import you confirm; existing redirects are never changed.
