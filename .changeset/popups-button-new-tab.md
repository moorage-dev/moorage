---
"@moorage/plugin-popups": patch
---

A popup's button, a top bar's link and a box in a page can now open their link in a new tab: switch on "Open the link in a new tab" under the button's link. It is off by default, so nothing changes for popups you already have. The link gets `rel="noopener"`, email and phone links always open as usual, and a popup or top bar closes on the page the visitor was on. Switching it on or off does not show a popup again to people who already closed it.
