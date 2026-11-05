---
"@moorage/plugin-seo": minor
---

Copy settings to another site: at the end of SEO > Settings, the settings are shown as text to copy, with a box to paste another site's. A paste is checked first and shows a table of what would change; nothing is saved until you press Apply these settings. It holds who the site is for, its details, opening hours, profiles and content types, and no passwords or keys. A content type the paste hides from Google is called out, and still asks this site's admin to confirm it on the Overview. Redirects are not included; copy them with the Redirects tab's Export and Import from WordPress.

Only bylines without a role label are published as the article's author. Before, every credited byline was, so "Photos by" or "Reviewed by" credits were published as authors too. When every credit on a post has a role label, the post is described as one with no byline is, and "This article has no author" is listed under Worth a look. After the update, the first visit to the SEO page (or the dashboard) checks every page once more, which takes about a minute, so pages saved before the update are corrected too.

The three numbers on the Overview now add up: "Pages checked" no longer includes pages hidden from search, which are listed below the pages to fix instead. On a site with hidden pages, "Pages checked" is lower than before.

The Google preview panel has a second link for admins, Check all markup, which opens the schema.org Validator for the page. It reads every type, including the organisation and local business details Google's Rich Results Test skips.

README and registry texts: use one schema plugin at a time (EmDash keeps only the first page markup it receives); the Cloudflare install example now shows `sandboxRunner: sandbox()` and the `LOADER` Worker Loader binding; for IndexNow (Bing), search the registry for an IndexNow plugin.
