---
"@moorage/plugin-popups": patch
---

Colours for popups are now a choice, not hex codes. In Settings, pick your theme's colours (recommended, as before), one of five ready-made sets (Warm cream with brown buttons, Clean white with blue buttons, Soft grey with green buttons, Pale pink with plum buttons, Dark with gold buttons), or My own colours, which shows the colour boxes as before. Each set has a matching dark version and follows "Light or dark", every one is easy to read, and the cookie banner in Analytics & Cookies offers the same sets, so the two can match.

Nothing to do on your side: if "Choose my own colours" was on, it now shows as My own colours and looks exactly the same. Choosing a set keeps the colours you typed, so going back to My own colours shows them again; an earlier version shows your theme's colours instead of a set.

A correction to 0.2.0: a popup's hidden campaign fields (`utm_campaign` and the others) show when you open a sign-up under Forms and in what Lead Delivery passes on. Forms leaves hidden fields out of its emails, daily digest and CSV download, so they do not show there; the README now says so.
