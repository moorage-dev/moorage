---
"@moorage/plugin-seo": patch
---

Importing redirects (from Redirection, Yoast, Rank Math or a plain list) now skips rows whose old address ends in a file type, such as `/sitemap_index.xml` or `/wp-content/uploads/photo.jpg`, with the reason "Addresses ending in a file type, like .xml or .jpg, are not redirected by EmDash". EmDash treats such addresses as file requests and never runs a redirect for them, so these rows were added but never worked. Adding one redirect by hand gives the same reason.
