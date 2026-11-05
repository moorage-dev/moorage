---
"@moorage/plugin-analytics": minor
---

The cookie banner now speaks your site's language. On pages marked as German, French, Spanish, Italian, Dutch or Portuguese (the `lang` of your pages), visitors read the banner, the standard heading and text included, in that language; English pages look exactly as before. Under Banner > Button words you can put Accept all, Reject all, Choose, Save my choices and the small Cookies button in your own words; a heading or text you typed yourself is shown as typed in every language.

YouTube and Vimeo videos and Google maps in your pages now wait for consent too. Where the banner can ask, visitors first see a placeholder that says which company shows the video or map, with a button to load just that one and a link to open it on its own site; it appears by itself once they allow Marketing, and straight away for visitors who are not asked. Nothing for editors to do. Sites where nobody is asked see no change.

Four more tools, one box each: Plausible and Umami Cloud (visitor counts without cookies, so on their own they need no banner), and LinkedIn Insight Tag and TikTok Pixel (they wait for Marketing).

Tools now load only on your site's own address, the Site URL in Settings > General (with or without www). On a staging copy or a workers.dev address the banner still shows, but nothing is tracked and no answer is recorded. If your site lives at a different address than its Site URL, the Status tab says so: update the Site URL there, or tracking stops.

Also new: an Ask everyone again button on the Banner tab; the consent log keeps the country the server saw rather than the one the browser reported; other scripts can read the visitor's answer from `window.cookieConsent` and a `cookie-consent:change` event; and the banner keeps working across page changes on sites that use Astro's `<ClientRouter />`. The README, banner and icon now use the plugin's name, Analytics & Cookies.
