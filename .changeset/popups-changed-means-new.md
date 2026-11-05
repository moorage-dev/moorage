---
"@moorage/plugin-popups": patch
---

A changed top bar, popup or slide-in now shows again to visitors who closed it. Until now a close was remembered for good (or for the week or month you chose), so a bar you edited, say from your usual opening hours to your holiday hours, never reached anyone who had closed the old one. Now, when you change what it says, its picture, its button or link, its form or its dates, it shows once more to people who closed it or clicked its button. Someone who signed up through its form is still never asked again.

Changing only where, on what devices or how often it shows, its name or its colours does not bring it back. Nothing comes back because of the update itself: a close made before this version counts for what the popup says now, and the next change you make shows it again. Nothing to do on your side.

The README now says plainly why Popups is not on the plugin registry: registry plugins run sandboxed, and a sandboxed plugin cannot add scripts or HTML to a page. Being native is what puts a top bar into the page as it loads, with no snippet to paste and nothing moving on the page.
