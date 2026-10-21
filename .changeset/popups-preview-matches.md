---
"@moorage/plugin-popups": patch
---

Preview shows each popup exactly where a visitor will see it: a top bar at the top of the page (it showed as a slide-in in the corner before), a slide-in in its corner, a popup centred on a computer and as a sheet at the bottom of a phone (unless it opens on a click), and narrowing the window past a phone's width redraws it. A box in a page now has a preview too, at the top of the page's content.

The preview's tag now always tells the truth about a real visitor: a popup that opens on a click no longer says "this is the first page of the visit", a popup for a collection or kept off a page says "it does not show on this page", a popup for when visitors are about to leave says phones never see it, a centred popup says it waits for the second page, and it says when another top bar or popup shows first.
