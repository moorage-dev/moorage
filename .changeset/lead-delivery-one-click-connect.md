---
"@moorage/plugin-lead-delivery": minor
---

Connect a form in one step, where the site can call its own address. Connect this form shows a code and a link to EmDash's own approval page, which opens empty: the admin types the code, presses Authorize, comes back and presses Done, connect. Lead Delivery uses that access once to set the form's address, then throws it away; it keeps nothing. A form that already sends somewhere else is never changed without asking. If EmDash answers in a way Lead Delivery does not expect, the screen falls back to the written instructions, which stay available on every site. Editors never see it. If throwing the access away ever fails, the page and an email to the alert list say what to do.
