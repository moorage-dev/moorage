# @moorage/plugin-seo

SEO & Schema Markup for [EmDash](https://emdashcms.com): one linked structured data graph, noindex and snippet rules, a Google preview, on-page SEO checks and redirects import from WordPress. Runs on any EmDash site, self-hosted or on Moorage, with no account and no key.

Status: pre-release. Working today: the schema graph, the robots tag and the SEO settings page (below). Next: redirects import, the Google preview panel and page checks.

## What it does today

- Replaces EmDash's single JSON-LD object with one linked graph per page: Organization (or Person, or a LocalBusiness type), WebSite, WebPage, BreadcrumbList, the primary image, and BlogPosting with byline authors and dates on article pages.
- Writes the robots tag: `noindex` per collection, and `max-snippet`, `max-image-preview` and `max-video-preview` limits on indexable pages. A noindex set in an entry's SEO panel is always kept.
- Uses the theme's breadcrumb trail when it passes one, otherwise derives Home and one crumb per URL segment.
- Emits extra schema from an entry: add a JSON field named `json_ld` to a collection and paste any schema.org object (for example a Service or an Event).

It does not write the page title, the sitemap or robots.txt; EmDash core and your theme do.

## Install

Registry (after the first release): search "SEO" in your EmDash admin under Plugins.

npm, pinned in code:

```sh
pnpm add @moorage/plugin-seo
```

```js
import seo from "@moorage/plugin-seo";
// astro.config.mjs
import emdash from "emdash/astro";

export default defineConfig({
	integrations: [emdash({ sandboxed: [seo] })],
});
```

## Settings

One page, **SEO**, in the admin sidebar. It works before you touch it: the site is described as an organisation named after the site, and each page type is guessed from its name (posts and blog become blog posts, services become services, team becomes people).

- **Overview**: setup progress, and a warning whenever a page type is hidden from Google.
- **Who you are**: company, person or local business; name, logo (paste its public link; in Media use Copy URL), contact details, opening hours (two ranges a day for split shifts), profiles elsewhere and areas served. One location for now. A local business is described as an organisation until it has an address, because Google requires one.
- **Page types**: what each kind of page is (web page, about, contact, blog post, article, service, person) and whether it is hidden from search results. Under Advanced: breadcrumbs and how much Google may quote.

Admins can change settings. Editors see a read-only page.

Not yet: Product and Event types (they need price and date fields on the collection), and FAQ (Google stopped showing FAQ results in May 2026). Use the `json_ld` field for those today.

## FAQ

- How do I add schema markup to EmDash? Install this plugin; it adds structured data (JSON-LD) to every page.
- How do I add my own structured data to one page? Add a JSON field named `json_ld` to the collection and paste the schema.org object into the entry.
- Is there a Yoast alternative for EmDash? EmDash core covers titles, descriptions, sitemaps and canonicals; this plugin adds the schema graph, robots rules, previews and checks.
- Does it add FAQ rich results? No. Google stopped showing FAQ rich results in May 2026.
- How do I import redirects from WordPress? Coming with the SEO page: export the Redirection plugin's CSV and import it there.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) once the first version is released; unreleased changes are in the repository's `.changeset` folder.

## Develop

```sh
pnpm --filter @moorage/plugin-seo build      # emdash-plugin build
pnpm --filter @moorage/plugin-seo test       # validate + vitest through the sandbox harness
pnpm --filter @moorage/plugin-seo validate
```

## Licence

FSL-1.1-MIT; see LICENSE.
