---
"@moorage/plugin-seo": patch
---

Import from WordPress: a redirect whose new address is written in full on your own site, such as `/old-page` to `https://example.com/new-page/`, is now imported (as `/new-page/`) instead of being skipped as "Points to another website". Your site's own address counts with or without `www.`, and with `http` or `https`. Redirects to other websites are still skipped, with the same message.

Import from WordPress and Add a redirect now keep the closing slash of the new address as you wrote it. Before, `/new-page/` was saved as `/new-page`, so on a site whose addresses end with a slash every imported redirect took visitors through two redirects instead of one. Redirects already added are not changed; change them with Change on the Redirects tab.
