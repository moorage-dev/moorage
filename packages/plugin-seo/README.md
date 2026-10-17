# SEO & Schema Markup for EmDash

SEO & Schema Markup for [EmDash](https://emdashcms.com): one linked structured data graph, noindex and snippet rules, a Google preview, on-page SEO checks and redirects import from WordPress. Runs on any EmDash site, with no account and no key.

## What it does today

- Replaces EmDash's single JSON-LD object with one linked graph per page: Organization (or Person, or a LocalBusiness type), WebSite, WebPage, BreadcrumbList, the primary image (with its width and height when it is one of the entry's own images), and BlogPosting with byline authors and dates on article pages.
- Writes the robots tag: `noindex` per collection, and `max-snippet`, `max-image-preview` and `max-video-preview` limits on indexable pages. A noindex set in an entry's SEO panel is always kept.
- Uses the theme's breadcrumb trail when it passes one, otherwise derives Home and one crumb per URL segment.
- Adds your own schema from an entry to the same graph: add a JSON field named `json_ld` to a collection and paste any schema.org object (for example an Event or a Product). Give it an `@id` and the page names it as its main entity. An object whose `@id` is already used in the graph is left out.
- On a page kept out of search (noindex), describes the site only: no WebPage, image or breadcrumb markup.

It does not write the page title, the sitemap or robots.txt; EmDash core and your theme do.

## Install

From **Plugins** in your EmDash admin (it is listed in the [EmDash registry](https://plugins.emdashcms.com/plugins/@moorage.dev/seo)), or from npm, registered in your site's code:

```sh
pnpm add @moorage/plugin-seo
```

```js
// astro.config.mjs
import seo from "@moorage/plugin-seo";
import emdash from "emdash/astro";

export default defineConfig({
	integrations: [emdash({ sandboxed: [seo] })],
});
```

`sandboxed` needs a sandbox runner: on Cloudflare it is the Worker Loader binding from `@emdash-cms/cloudflare`; on Node add `@emdash-cms/sandbox-workerd` and set `sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox"`. Without a runner, list the plugin under `plugins: [seo]` instead, which runs it in-process. Requires EmDash 1.2.0 or newer.

**On Cloudflare's Workers free plan** each request gets about 10 ms of CPU. EmDash's own saving and publishing already comes close to that, and every plugin run in the site's process adds a little, so a save or publish can now and then fail with "Worker exceeded resource limits"; trying again works. Workers Paid (30 seconds per request) does not have this problem.

It asks for four permissions: read content, read bylines, read the content schema, and manage redirects. The registry lists a fifth, read redirects, which managing them includes. It makes no requests to any outside service.

## The SEO page

One page, **SEO**, in the admin sidebar, with three tabs. It works before you touch it: the site is described as an organisation named after the site, each content type is guessed from its name (posts and blog become blog posts, services become services, team becomes people), and your pages are checked by themselves.

- **Overview**: how many pages were checked, how many have nothing to fix and how many do; a warning whenever a content type is hidden from Google; one question if you have not said who the site is for; then **Your details**, the few things Google still needs for your kind of site (an address, opening hours and a phone number for a local business; a logo and profiles for a company); then the pages to fix, each with what is missing and a link to the page; and, folded, pages that are fine but could be better.
- **Redirects**: your redirects, with Change and Remove on each, and three buttons above the list. **Add a redirect**: the old address, where to send visitors, and the kind (permanent unless you choose otherwise). **Import from WordPress**: paste a list exported from Redirection, Yoast SEO Premium or Rank Math; it is checked before anything is added and can be removed again as a batch. **Export**: a copyable list. EmDash already redirects a page's old address when you change it.
- **Settings**: who the site is for (a local business, a company or a person) and what you do, then folded sections ordered by how much they matter for that kind of site. Each title says whether the section is needed, worth adding or optional, and what is already filled in: address and phone, opening hours (two ranges a day for split shifts), logo, profiles elsewhere, more about you, and content types (what each kind of content is, and whether it is hidden from Google, which asks before it saves). One location for now. A local business is described as an organisation until it has an address, because Google requires one.

Admins can change settings. Editors see a read-only page with the pages to fix.

In the entry editor, the **Google preview** panel shows how the published page may look on Google (address, title, description), what kind of page it is, whether it is in search results, and up to three things to fix. Admins can also change one page's type, open Google's Rich Results Test for the page, and view the markup. A dashboard widget shows the number of pages to fix.

### The checks

To fix: no title; a title that says nothing, such as "Home"; no search description (an entry's `excerpt` counts as one, as it does in EmDash); the same title as another page; a canonical address that points at a different page. Worth a look: a title that may be cut off; no picture for shared links (dropped once the page has been shown with a picture your theme adds); an article with no author; pictures without alt text; a page with almost no text. Hidden pages are counted separately, and content without a page of its own (testimonials, for example) is left out. There is no score, and no keyword, readability or word-count rule: Google documents none of them as ranking factors.

Not yet: Product and Event types (they need price and date fields on the collection), and FAQ (Google stopped showing FAQ results in May 2026). Use the `json_ld` field for those today.

## FAQ

- Is it free? Yes, on any number of sites, your own or your clients', with no account and no key. It is open source under the MIT License: you may use, change, copy and share the code, in paid work too, as long as the copyright notice stays with it.
- How do I add schema markup to EmDash? Install this plugin; it adds structured data (JSON-LD) to every page.
- How do I add my own structured data to one page? Add a JSON field named `json_ld` to the collection and paste the schema.org object into the entry. It joins the page's one graph; the page still has a single JSON-LD script.
- Is there a Yoast alternative for EmDash? EmDash core covers titles, descriptions, sitemaps and canonicals; this plugin adds the schema graph, robots rules, previews and checks.
- Does it check my page while I type? No. EmDash does not let a general-purpose plugin read unsaved text. The panel and the checks describe the published page, as Google sees it: changes to the page show up once you publish, and changes in the SEO panel show up as soon as they are saved.
- Is there an SEO score or a traffic light? No, on purpose. You get a list of things to fix that can reach zero.
- Does it add FAQ rich results? No. Google stopped showing FAQ rich results in May 2026.
- How do I import redirects from WordPress? Export them from Redirection, Yoast SEO Premium or Rank Math, open SEO > Redirects > Import from WordPress, paste the list and press Check list. Nothing is added until you confirm.
- Why were some redirects skipped? EmDash has no regular-expression redirects. Exact addresses and "everything under a folder" are converted; other patterns are listed for you to rewrite by hand. Redirects to another website and addresses with a `?` are not supported by EmDash.
- Why does a large import take a while on Cloudflare? Sandboxed plugins may only do a few operations per request, so a long list is added a few rows at a time in the background. You can leave the page.

## Changelog

See [CHANGELOG.md](CHANGELOG.md); unreleased changes are in the repository's `.changeset` folder.

## Develop

```sh
pnpm --filter @moorage/plugin-seo build      # emdash-plugin build
pnpm --filter @moorage/plugin-seo test       # validate + vitest through the sandbox harness
pnpm --filter @moorage/plugin-seo validate
```

## Licence

[MIT](LICENSE). Releases 0.1.0 to 0.1.2 were published under FSL-1.1-MIT; GoSi Tech, which holds the copyright, now also licenses them under MIT. Moorage is a product of GoSi Tech.
