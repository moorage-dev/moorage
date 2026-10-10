# @moorage/plugin-seo

SEO & Schema Markup for [EmDash](https://emdashcms.com): one linked structured data graph, noindex and snippet rules, a Google preview, on-page SEO checks and redirects import from WordPress. Runs on any EmDash site, self-hosted or on Moorage, with no account and no key.

Status: pre-release, feature-complete for 0.1: the schema graph, the robots tag, the SEO page with redirects import, page checks, and the Google preview panel.

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

## The SEO page

One page, **SEO**, in the admin sidebar, with three tabs. It works before you touch it: the site is described as an organisation named after the site, each content type is guessed from its name (posts and blog become blog posts, services become services, team becomes people), and your pages are checked by themselves.

- **Overview**: how many pages were checked, how many are ready and how many need a fix; a warning whenever a content type is hidden from Google; one question if you have not said who the site is for; then the pages to fix, each with what is missing and a link to the page.
- **Redirects**: your redirects, with Change and Remove on each; add one by typing the old address and where to send visitors; import a list exported from WordPress (Redirection, Yoast SEO Premium or Rank Math), which is checked before anything is added and can be removed again as a batch; export as a copyable list.
- **Settings**: who the site is for (company, person or local business), name, logo link, then folded sections whose titles show what is filled in: contact and address, opening hours (two ranges a day for split shifts), profiles elsewhere, optional company details, content types (what each kind of content is, and whether it is hidden from search), and advanced snippet settings. One location for now. A local business is described as an organisation until it has an address, because Google requires one.

Admins can change settings. Editors see a read-only page with the pages to fix.

In the entry editor, the **Google preview** panel shows how the published page may look on Google (address, title, description), what kind of page it is, whether it is in search results, and up to three things to fix. Admins can also change one page's type, open Google's Rich Results Test for the page, and view the markup. A dashboard widget shows the number of pages to fix.

Not yet: Product and Event types (they need price and date fields on the collection), and FAQ (Google stopped showing FAQ results in May 2026). Use the `json_ld` field for those today.

### The checks

To fix: no title; no search description; the same title as another page; a canonical address that points at a different page. Worth a look: a title that may be cut off; no image for shared links; an article with no author; pictures without alt text; a page with almost no text. Hidden pages are counted separately, and content without a page of its own (testimonials, for example) is left out. There is no score, and no keyword, readability or word-count rule: Google documents none of them as ranking factors.

Not yet: Product and Event types (they need price and date fields on the collection), and FAQ (Google stopped showing FAQ results in May 2026). Use the `json_ld` field for those today.

## FAQ

- How do I add schema markup to EmDash? Install this plugin; it adds structured data (JSON-LD) to every page.
- How do I add my own structured data to one page? Add a JSON field named `json_ld` to the collection and paste the schema.org object into the entry.
- Is there a Yoast alternative for EmDash? EmDash core covers titles, descriptions, sitemaps and canonicals; this plugin adds the schema graph, robots rules, previews and checks.
- Does it check my page while I type? No. EmDash does not let a general-purpose plugin read unsaved text. The panel and the checks describe the published page, as Google sees it: changes to the page show up once you publish, and changes in the SEO panel show up as soon as they are saved.
- Is there an SEO score or a traffic light? No, on purpose. You get a list of things to fix that can reach zero.
- Does it add FAQ rich results? No. Google stopped showing FAQ rich results in May 2026.
- How do I import redirects from WordPress? Export them from Redirection, Yoast SEO Premium or Rank Math, open SEO > Redirects > Import a list from WordPress, paste the list and press Check list. Nothing is added until you confirm.
- Why were some redirects skipped? EmDash has no regular-expression redirects. Exact addresses and "everything under a folder" are converted; other patterns are listed for you to rewrite by hand. Redirects to another website and addresses with a `?` are not supported by EmDash.
- Why does a large import take a while on Cloudflare? Sandboxed plugins may only do a few operations per request, so a long list is added a few rows at a time in the background. You can leave the page.

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
