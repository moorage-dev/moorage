---
"@moorage/plugin-seo": patch
---

The SEO page shows real numbers on a new site that runs the plugin in its own process (`plugins: [seo]`, as on the Workers free plan). There the plugin is switched on when the server starts, before setup has added any pages, and its first check found nothing; it then showed "No published pages yet" until "Check all pages again" was pressed. A first check that finds nothing is no longer kept, so the first visit to the SEO page checks the pages. Sandboxed installs were not affected.
