---
"@moorage/plugin-analytics": patch
---

Any link to #cookie-settings, such as a menu item, now opens the cookie choices; no code needed. In a menu, use `/#cookie-settings` (EmDash's menu editor does not accept a link that starts with `#`). The floating "Cookies" button steps aside while such a link is on screen, and the admin now says this in plain words instead of asking for an HTML attribute. `data-cookie-settings` keeps working.
