---
"@moorage/plugin-seo": minor
---

Moved from WordPress with the EmDash Exporter: the Yoast or Rank Math title and description of each post arrive in two fields, SEO Title and SEO Description, that the page does not use. The pages to fix no longer say "No search description" for such a page; they say "A description came from WordPress but the page doesn't use it yet", and a WordPress search title the page does not use is listed under Worth a look.

New for admins on the Overview, shown only when such pages exist: Copy imported WordPress SEO values. "See what will change" counts the pages, titles and descriptions and shows the first ten, changing nothing; "Copy into N pages" copies them into each page's SEO panel. A panel field that already has a value keeps it, and the site's name is left off the end of each title ("Our story | Harbour Bakery" becomes "Our story"), as the site adds its own. The pages use the values at once, with no draft and nothing to publish again. A large site is copied a few pages per click and the rest in the background; then every page is checked again.

This update asks for one new permission, change content. Only Copy imported WordPress SEO values uses it, to fill empty SEO panel fields when an admin presses Copy. On EmDash 1.4.0 only a plugin run in the site's process (`plugins: [seo]`) can write the SEO panel; run sandboxed, the SEO page shows what would change and says it cannot copy, and changes nothing.

The Google preview no longer says the excerpt is what the page shows when there is no Meta Description: the theme may use another field (a standfirst or summary), which a plugin cannot see, so the preview shows the excerpt and says so.

After the update, the first visit to the SEO page (or the dashboard) checks every page once more, which takes about a minute.
