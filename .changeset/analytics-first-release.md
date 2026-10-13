---
"@moorage/plugin-analytics": minor
---

First release of Analytics & Cookie Consent, a native plugin for EmDash 1.2.0 and later.

- Add Google Analytics, Google Tag Manager, Google Ads, Meta Pixel, Microsoft Clarity, HubSpot and Cloudflare Web Analytics by pasting one ID each. Pasting the whole snippet works too, and a wrong ID is explained in plain words.
- A cookie banner that comes with the tools, so nothing from a tracking company is requested before the visitor agrees. Accept all, Reject all and Choose are styled the same; the second layer lists Necessary, Analytics and Marketing with the tools under each. Keyboard-operable, light and dark, system fonts, no layout shift.
- Google Consent Mode v2 in basic mode, Clarity and HubSpot consent settings, and Global Privacy Control (Marketing stays off).
- Shown to visitors in Europe and the UK by default, to everyone, or to no one. The choice is remembered for 6 months and asked again when the list of tools changes. A "Cookie settings" button, or any element with `data-cookie-settings`, reopens the panel; taking consent back deletes the tools' cookies and reloads the page.
- Enquiries counted automatically: phone and email link clicks, and forms sent through the official forms plugin.
- The admin, preview links, the visual editor, signed-in staff and any pages you list are never tracked.
- A consent record with no IP address or personal details, kept for 12 months, with 30-day counts on the Status tab.
- One admin page, Analytics, under Marketing. No theme edit: the theme only needs `EmDashHead`.

Not a Google-certified consent platform and no IAB TCF; sites that show Google ads on their own pages need one.
