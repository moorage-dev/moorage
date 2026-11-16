---
"@moorage/plugin-seo": patch
---

Import from WordPress: a redirect whose new address is written in full on your own site, such as `/old-page` to `https://example.com/new-page/`, is now imported as a path instead of being skipped as "Points to another website". Your site's own address counts with or without `www.`, and with `http` or `https`. Redirects to other websites are still skipped, with the same message.

Import from WordPress, Add a redirect and Change now write the new address the way your site writes its own addresses. On a site whose addresses end with a slash, `/new-page` is saved as `/new-page/`, so visitors arrive in one step instead of being redirected twice. On other sites the closing slash is left off, as before. The home page, files such as `/menu.pdf`, addresses with a `#` and patterns such as `/news/[...rest]` never get one. A full new address keeps its `#` part, and one that would lead off your site, such as `https://example.com//other.example/`, is skipped as "Points to another website". Redirects already added are not changed; change them with Change on the Redirects tab.
