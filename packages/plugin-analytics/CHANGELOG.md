# @moorage/plugin-analytics

## 0.3.0

### Minor Changes

- fc971ef: The page is now headed Analytics & Cookies, and its Status tab is two checklists. Tracking ticks each tool and says what it waits for, with a link to each tool's own numbers (Clarity straight to your project) and, for Google's tools, a link to Tag Assistant with a tip to check Realtime. Cookie consent says who is asked, links your privacy policy, says when the last answer came in, shows the last 30 days as a chart, and lets an admin download the consent log as a spreadsheet (CSV): one line per answer from the last 12 months, with exactly what is stored. New: Check what loads, which looks at your home page and up to four more for tracking code pasted in outside the plugin (such as a second Google tag) and for videos, maps, booking boxes and social posts that set cookies before visitors answer, with a plain fix for each. On the Cookie banner tab the colours now fold away under Colours, with their own Save.


- 233c00d: Any link to #cookie-settings, such as a menu item, now opens the cookie choices; no code needed. In a menu, use `/#cookie-settings` (EmDash's menu editor does not accept a link that starts with `#`). The floating "Cookies" button steps aside while such a link is on screen, and the admin now says this in plain words instead of asking for an HTML attribute. `data-cookie-settings` keeps working.

## 0.2.7

### Patch Changes

- 6516427: Admins see a small help line at the foot of the page, with a link to the guide; it can be hidden under Advanced.

## 0.2.6

### Patch Changes

- b13aeac: After you save, the page says a change can take a few minutes to reach visitors only when visitors will see it. With no tracking tool on, or for a change that does nothing on your pages (such as an option for a tool that is off), it just says "Saved."

## 0.2.5

### Patch Changes

- 079b9ad: Pages render faster: settings are kept for 30 seconds between page views, and a save takes effect at once.

## 0.2.4

### Patch Changes

- 655bb7d: The banner preview names the Tracking tools tab correctly, the Status tab no longer says tools load "straight away" for visitors who are not asked (they load when the browser is idle), and the README quotes the wrong-ID message exactly.

## 0.2.3

### Patch Changes

- 3ba7f88: Fixes "Those places, plus India" under "Who sees the cookie banner": with it chosen, no visitor was asked, so the tools loaded without consent everywhere, Europe and India included, while the Status tab said visitors there were asked. Visitors in the EU, the EEA, the UK, Switzerland and India are now asked first, and nothing loads before they answer, as with the Europe choice. Sites that use the Europe choice or ask everyone were not affected.

## 0.2.2

### Patch Changes

- b48798f: Tell other scripts on the page whether the cookie banner is still waiting for an answer: on sites where the banner can appear, `<html>` carries `data-cookie-consent="pending"`, then `"asking"` while the banner waits and `"settled"` once the visitor has answered or is not asked, and `cookie-consent:settled` fires on `document`. Popups use it to stay closed until the visitor has answered.
- 023d606: The "Cookies" button is now as designed: a round button with a cookie icon, fixed in a bottom corner of the screen, on the banner's surface with an edge and a soft shadow. A theme link marked `data-cookie-settings` no longer hides it for good: the button only steps aside while that link is on screen, and comes back when the link scrolls away. Clicking the icon or the word now works like clicking the button.

## 0.2.1

### Patch Changes

- 362d24e: The choices under "Who sees the cookie banner" now say what each is for: where the law says ask first (the EU, EEA, UK and Switzerland, recommended if you only count visits), those places plus India, everyone everywhere (recommended if you use Clarity, Meta Pixel or Google Ads), or no one when another consent tool asks instead. A line under them explains that visitors who are not asked, for example in the US, can always turn the tools off with Cookie settings and that Global Privacy Control is respected. The Status tab suggests asking everyone when Clarity, Meta Pixel or Google Ads is on and only Europe is asked. Nothing changes for visitors.

## 0.2.0

### Minor Changes

- c8346dc: A new cookie banner, after a review of the leading consent tools and of what the European and UK regulators ask for.
  
  - **Layout.** A sheet across the bottom of the screen, set apart from the page by a slightly tinted surface, a thin rule and a soft shadow, its content lined up with your page. On a phone it takes about a quarter of the screen. It does not dim or block the page, and whatever has keyboard focus stays visible above it. The corner boxes are still there as options.
  - **Wording.** The heading is "Can we use cookies?" and the standard text names what your tools are used for ("analytics cookies to see how this site is used, and marketing cookies to measure our ads. Essential cookies are always on."). Sites that still had the old standard heading and text get the new ones; your own words are kept.
  - **Buttons.** Accept all and Reject all are identical. Choose is now a quieter text button. In the panel, Essential says "Always on" instead of showing a ticked box that cannot be changed, and Analytics and Marketing are switches.
  - **Your colours.** The banner takes your theme's `--cookie-consent-*` CSS variables (colours, fonts, width), or three colours set on the Cookie banner tab: background, text and buttons. Hard-to-read combinations are refused, button text is chosen for contrast, and both answer buttons always share one colour.
  - **Dark mode colours.** A switch on the Cookie banner tab opens three more colour fields for visitors whose device is in dark mode, with the same checks.
  - **Preview.** Preview the banner and Preview in dark mode open your home page with the banner as saved, shown to you wherever you are; answers are not saved and no tool loads.
  - **The "Cookies" button.** After an answer, a small round "Cookies" button reopens the choice, in the bottom left corner by default (chat buttons usually sit on the right) or the right. It stays away on pages that have a `data-cookie-settings` link, and the Status tab warns when it is off.
  - **India.** A new choice under "Who sees the cookie banner": visitors in Europe, the UK and India.
  
  The default position is unchanged (across the bottom), but its look is new: check your site after updating.

## 0.1.0

### Minor Changes

- 414074e: First release of Analytics & Cookie Consent, a native plugin for EmDash 1.2.0 and later.
  
  - Add Google Analytics, Google Tag Manager, Google Ads, Meta Pixel, Microsoft Clarity, HubSpot and Cloudflare Web Analytics by pasting one ID each. Pasting the whole snippet works too, and a wrong ID is explained in plain words.
  - A cookie banner that comes with the tools, so nothing from a tracking company is requested before the visitor agrees. Accept all, Reject all and Choose are styled the same; the second layer lists Necessary, Analytics and Marketing with the tools under each. Keyboard-operable, light and dark, system fonts, no layout shift.
  - Google Consent Mode v2 in basic mode, Clarity and HubSpot consent settings, and Global Privacy Control (Marketing stays off).
  - Shown to visitors in Europe and the UK by default, to everyone, or to no one. The choice is remembered for 6 months and asked again when the list of tools changes. A "Cookie settings" button, or any element with `data-cookie-settings`, reopens the panel; taking consent back deletes the tools' cookies and reloads the page.
  - Enquiries counted automatically: phone and email link clicks, and forms sent through the official forms plugin.
  - The admin, preview links, the visual editor, signed-in staff and any pages you list are never tracked.
  - A consent record with no IP address or personal details, kept for 12 months, with 30-day counts on the Status tab.
  - One admin page, Analytics, under Marketing. No theme edit: the theme only needs `EmDashHead`.
  
  Not a Google-certified consent platform and no IAB TCF; sites that show Google ads on their own pages need one.
