---
"@moorage/plugin-site-health": patch
---

The first full check after a page is deleted now reports links to it as broken. Before, that check still counted the deleted page as published, so links to it showed as fine until the check after; it also opened the deleted page's address as one of the site's pages.
