---
"@moorage/plugin-popups": patch
---

Admins see the list of forms to choose from again on a site that runs on Node, where `localhost` points to both an IPv6 and an IPv4 address and the server listens on only one. Before, the lookup could miss the server and show a box to type the form's short name instead. The same goes for the form check on save and for finding a picture's public address. The signed-in session still only goes to the site's own server.
