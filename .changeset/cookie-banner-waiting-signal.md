---
"@moorage/plugin-analytics": patch
---

Tell other scripts on the page whether the cookie banner is still waiting for an answer: on sites where the banner can appear, `<html>` carries `data-cookie-consent="pending"`, then `"asking"` while the banner waits and `"settled"` once the visitor has answered or is not asked, and `cookie-consent:settled` fires on `document`. Popups use it to stay closed until the visitor has answered.
