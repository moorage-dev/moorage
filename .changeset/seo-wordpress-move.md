---
"@moorage/plugin-seo": patch
---

Moved from WordPress with the EmDash Exporter: the Yoast or Rank Math title and description of each post arrive in two fields, SEO Title and SEO Description, that the page does not use. The pages to fix no longer say "No search description" for such a page; they say "A description came from WordPress but the page doesn't use it yet" and how to fix it: copy it into Meta Description in the page's SEO panel. A WordPress search title the page does not use is listed under Worth a look, with a reminder to leave the " | Site name" ending off when you copy it, as your site adds its own name.

The Google preview no longer says the excerpt is what the page shows when there is no Meta Description: your theme may use another field (a standfirst or summary), which a plugin cannot see, so the preview shows the excerpt and says so.

After the update, the first visit to the SEO page (or the dashboard) checks every page once more, which takes about a minute.
