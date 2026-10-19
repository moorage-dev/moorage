---
"@moorage/plugin-popups": patch
---

The "Download as a spreadsheet (CSV)" link on the Numbers tab works again: EmDash 1.3.1 refused it because a plain link cannot send EmDash's request header. The admin page now signs the link for the dates on screen, and it works for ten minutes. The instructions for the web person now give `/#popup-<name>`, which EmDash's menu accepts as a custom link, and the README says that "Save and finish" turns a new popup on and that a paused form shows a yellow warning.
