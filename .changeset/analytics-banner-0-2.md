---
"@moorage/plugin-analytics": minor
---

A new cookie banner, after a review of the leading consent tools and of what the European and UK regulators ask for.

- **Layout.** A sheet across the bottom of the screen, set apart from the page by a slightly tinted surface, a thin rule and a soft shadow, its content lined up with your page. On a phone it takes about a quarter of the screen. It does not dim or block the page, and whatever has keyboard focus stays visible above it. The corner boxes are still there as options.
- **Wording.** The heading is "Can we use cookies?" and the standard text names what your tools are used for ("analytics cookies to see how this site is used, and marketing cookies to measure our ads. Essential cookies are always on."). Sites that still had the old standard heading and text get the new ones; your own words are kept.
- **Buttons.** Accept all and Reject all are identical. Choose is now a quieter text button. In the panel, Essential says "Always on" instead of showing a ticked box that cannot be changed, and Analytics and Marketing are switches.
- **Your colours.** The banner takes your theme's `--cookie-consent-*` CSS variables (colours, fonts, width), or three colours set on the Cookie banner tab: background, text and buttons. Hard-to-read combinations are refused, button text is chosen for contrast, and both answer buttons always share one colour.
- **Dark mode colours.** A switch on the Cookie banner tab opens three more colour fields for visitors whose device is in dark mode, with the same checks.
- **Preview.** Preview the banner and Preview in dark mode open your home page with the banner as saved, shown to you wherever you are; answers are not saved and no tool loads.
- **The "Cookies" button.** After an answer, a small round "Cookies" button reopens the choice, in the bottom left corner by default (chat buttons usually sit on the right) or the right. It stays away on pages that have a `data-cookie-settings` link, and the Status tab warns when it is off.
- **India.** A new choice under "Who sees the cookie banner": visitors in Europe, the UK and India.

The default position is unchanged (across the bottom), but its look is new: check your site after updating.
