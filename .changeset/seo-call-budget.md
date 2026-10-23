---
"@moorage/plugin-seo": patch
---

On sites that run SEO sandboxed on Cloudflare, every page view, save, background step and SEO page action now stays within the sandbox's limit of 10 calls per request. Before, some of them could fail part-way:

- The first view of a page saved before the plugin was installed (on a new site, every page until the page check had run) went over the limit. That view now describes the page from the page itself, with the same structured data as before (dates, authors, picture sizes, your own JSON-LD), and stores nothing; the page's check result is stored by the page check or the page's next save.
- A page view no longer builds records or copies settings; it writes only when the picture shared for a page changes. Settings saved by 0.1.7 or earlier are copied to their new place by a visit to the SEO page once the page check has finished, or by the next save.
- Switching the plugin on starts the page check with fewer calls, and a check step on a site with several empty collections no longer goes over.
- Importing redirects adds what fits in the click and the rest in the background, a few each minute. Removing an import works the same way, with a progress bar, "Remove more now" and "Stop here". The SEO page says how far it got.
