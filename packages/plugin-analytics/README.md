# @moorage/plugin-analytics

Analytics & Cookie Consent for [EmDash](https://emdashcms.com): add Google Analytics, Google Tag Manager, Google Ads, Meta Pixel, Microsoft Clarity, HubSpot and Cloudflare Web Analytics by pasting one ID each, with a cookie banner that holds every one of them back until the visitor agrees. Tools and banner live in one plugin, so "nothing loads before consent" is true by construction, and there is no theme file to edit. Runs on any EmDash site, self-hosted or on Cloudflare, with no account and no key.

## What it does

- **Tracking tools.** One box per tool. Paste the ID, or the whole code the tool gave you; the ID is picked out of it. A wrong ID is explained ("That is a Google Tag Manager ID. Put it in the Google Tag Manager box instead."). An empty box means off.
- **Cookie banner.** Accept all, Reject all and Choose look the same, so no answer is pushed. Choose opens a panel with Necessary, Analytics and Marketing (nothing ticked in advance) and the list of tools under each. It works from the keyboard, follows the visitor's light or dark setting, uses system fonts, and never moves the page.
- **Nothing before consent.** No script from any tracking company is requested until the visitor allows its category. Google tags get Consent Mode v2 signals (all four denied by default, updated on the answer). Clarity and HubSpot get the visitor's answer through their own consent settings. There are no `<noscript>` pixels.
- **Changing your mind.** A small "Cookie settings" button reopens the panel, and so does any link or button in your theme with the attribute `data-cookie-settings`. Taking consent back tells the tools, deletes their cookies and reloads the page without them.
- **Who is asked.** Visitors in Europe and the UK (the default), everyone, or no one if another consent tool is in charge.
- **Enquiries.** Clicks on phone and email links, and forms sent through the official forms plugin, are counted as a lead (`generate_lead` in Google Analytics, `Lead` or `Contact` in Meta, an `enquiry` event in the data layer). Only the kind of enquiry is sent, never a number, an address or anything typed into a form.
- **Never tracked.** The admin, preview links, the visual editor, a browser that has signed in to the admin, and any pages you list.

## What it does not do

- It is **not a Google-certified consent platform and has no IAB TCF support.** That only matters if you _show_ Google ads on your own pages (AdSense, Ad Manager); those sites need a certified tool. Measuring your own Google Ads campaigns works.
- It does not make a site "GDPR compliant" by being installed. The banner is built to the EDPB cookie banner taskforce report and the UK ICO's guidance; what your tools do with the data is still yours to describe in your privacy policy.
- No dashboards or reports: read your numbers in each tool.
- No cookie scanner, no cookie wall, no consent by scrolling.
- Not yet: custom code snippets, banner text per language, a self-test of your site, an export of the consent record.

## Install

This is a native plugin: it is added by a developer in the site's code, not from the plugin registry.

```sh
pnpm add @moorage/plugin-analytics
```

```js
// astro.config.mjs
import { analyticsPlugin } from "@moorage/plugin-analytics";
import emdash from "emdash/astro";

export default defineConfig({
	integrations: [emdash({ plugins: [analyticsPlugin()] })],
});
```

Needs EmDash 1.2.0 or later. There are no options; everything is set on the admin page.

### What your theme must render

The plugin adds one inline script to the page head and nothing else. Your layout must render EmDash's head component, as every EmDash template already does:

```astro
---
import { createPublicPageContext } from "emdash/page";
import { EmDashHead } from "emdash/ui";

const page = createPublicPageContext({ Astro, kind: "custom", pageType: "website", title });
---

<head>
	<title>{title}</title>
	<EmDashHead page={page} />
</head>
```

Only the `head` placement is used. `EmDashBodyStart` and `EmDashBodyEnd` are not needed by this plugin. The banner is built by the script inside a shadow root, so your theme's styles do not change it and it does not change your theme.

To put a "Cookie settings" link in your footer:

```html
<a href="#" data-cookie-settings>Cookie settings</a>
```

### Content Security Policy

EmDash does not add a nonce or hash to scripts that plugins put on the page. If your site sends a `Content-Security-Policy` header, it has to allow:

- inline scripts (`script-src 'unsafe-inline'`, or a hash you maintain yourself, which changes whenever a setting changes), and inline styles for the banner (`style-src 'unsafe-inline'`);
- the hosts of the tools you switch on, in `script-src` and `connect-src`: `www.googletagmanager.com` and `*.google-analytics.com` (Google), `connect.facebook.net` and `www.facebook.com` (Meta), `www.clarity.ms` and `*.clarity.ms` (Clarity), `js.hs-scripts.com` or `js-eu1.hs-scripts.com` plus the HubSpot hosts that script loads, `static.cloudflareinsights.com` and `cloudflareinsights.com` (Cloudflare).

## The Analytics page

One page, **Analytics**, under Marketing in the admin sidebar, with four tabs.

- **Status**: one line per tool saying what it does right now ("Google Analytics: on. Waits for visitors in Europe and the UK to accept Analytics cookies."), warnings first (no privacy policy link, Google Analytics and Tag Manager both on, Tag Manager loading before the answer), and how visitors answered in the last 30 days.
- **Tracking tools**: the seven ID boxes, "My HubSpot account is in the EU data centre", "Cloudflare Web Analytics: wait for consent anyway", and "Track enquiries automatically".
- **Cookie banner**: who sees it, your privacy policy page, the heading and text (with a button to put the original back), where it appears, light or dark, the "Cookie settings" button, and whether to ask again after 6 or 12 months.
- **Advanced**: pages not to track (one address per line; everything under it is covered), and when Google Tag Manager loads.

Admins can change settings. Editors see the Status tab, read-only.

**Changes can take a few minutes to reach visitors.** The script is part of the page, and pages are cached. A new setting shows when the cached copy of a page expires or the page is published again. There is no way for a plugin to clear the cache.

## How consent is decided

Everything is decided in the visitor's browser, because the same cached page is sent to everyone.

1. A saved answer for the current list of tools, not older than 6 months (or 12), is followed.
2. Otherwise, a visitor who must be asked gets the banner and nothing loads. With "Visitors in Europe and the UK", that means the EU and EEA countries, the UK and Switzerland. The country comes from Cloudflare when the site runs there (a small route on your own site reads it from the request; nothing is looked up and no outside service is called). When the country is unknown, the browser's time zone decides, and when that is unknown too the visitor is asked.
3. Everyone else is not asked: the tools load when the browser is idle. They can still open "Cookie settings" and say no.
4. A browser that sends Global Privacy Control never gets Marketing tools, whatever was clicked. The panel says so.

Adding or removing a tool asks everyone again, because they agreed to a different list. Changing an ID or the banner text does not.

| Category  | Tools                                                                         |
| --------- | ----------------------------------------------------------------------------- |
| Analytics | Google Analytics, Microsoft Clarity, Cloudflare Web Analytics if told to wait |
| Marketing | Google Ads, Meta Pixel, HubSpot                                               |
| Either    | Google Tag Manager: it loads once the visitor accepts at least one category   |

Google Tag Manager is a container. This plugin tells it the answer (Consent Mode signals and a `cookie_consent_update` event with `analytics` and `marketing` set to true or false, both in the data layer before the container starts); the tags inside must be set up to respect it. Cloudflare Web Analytics sets no cookies and starts without asking unless you turn on "wait for consent anyway".

## What is stored

In the visitor's browser:

- a cookie `cookie_consent` with the answer (which categories, the day, a random reference, and a code for the tool list), kept 6 or 12 months;
- `cookie_consent_geo` in local storage: the two-letter country and the day it was learned, kept 30 days.

On your site, one row per answer: the random reference, the time, the answer, the code for the tool list, and the country. **No IP address, no browser details, nothing that identifies a person.** Rows are deleted after 12 months by a daily job. The route that writes them is public, so it accepts only that exact shape, only for the banner that is live, and at most 2,000 rows a day.

## FAQ

- **Is it free?** Free to use on any number of sites, your own or your clients', with no account and no key. You may read, change and self-host the code. The licence (FSL-1.1-MIT) does not allow making the plugin available to others in a commercial product or service that substitutes for it or offers substantially the same functionality. Each release becomes MIT two years after it is published.
- **I accepted the banner but my visit does not show in Google Analytics.** A browser that has signed in to the EmDash admin is treated as staff and never tracked. Test in a private window.
- **I changed a setting and the site still shows the old one.** Pages are cached. Wait a few minutes, or publish the page again.
- **Do I need the banner if I only use Cloudflare Web Analytics?** No. It sets no cookies, so no banner is shown.
- **Can I use my own consent tool?** Yes: choose "No one, I use another consent tool". The tools then load for everyone without waiting and this plugin sends no consent signals, so your other tool has to hold them back itself. With Google Tag Manager that works well; with the other tools it usually does not, and the Status tab warns you.
- **A form redirects to a thank-you page. Is it counted?** Not by the form itself: the page changes before the success message appears. Count the thank-you page as a conversion in your analytics tool instead.
- **Both Google Analytics and Google Tag Manager?** Only if your container does not also contain Google Analytics, or every visit is counted twice.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) once a version has been released; unreleased changes are in the repository's `.changeset` folder.

## Develop

```sh
pnpm --filter @moorage/plugin-analytics build      # dist/index.mjs
pnpm --filter @moorage/plugin-analytics test       # Vitest
pnpm --filter demo-site test:e2e                   # Playwright, on apps/demo-site
```

The code has two halves.

- **Server** (`src/*.ts`): settings (`config.ts`), ID checking (`ids.ts`), the admin page as Block Kit (`admin.ts`), the consent record (`record.ts`), and `fragment.ts`, which turns settings into the one script a page gets. All pure functions; `index.ts` wires them to EmDash.
- **Browser** (`src/client/*.ts`): `consent.ts` holds the rules (who is asked, what a saved answer allows) with no browser access, and `boot.ts` is the script itself: banner, loaders, enquiries.

EmDash plugin routes cannot serve JavaScript files, so the browser half travels inside the page. It is still real TypeScript: `client-script.ts` is a small build plugin that bundles `src/client/main.ts` into one minified function and hands it to the server code as a string (`import code from "virtual:client-script"`). The server replaces one placeholder in it with the settings as JSON. The same plugin runs in `tsdown.config.ts` and `vitest.config.ts`, so tests see exactly the script that ships, and nothing generated is kept in the repository.

Tests: `tests/consent.test.ts` and `tests/client.test.ts` (the browser script in a simulated page), `tests/fragment.test.ts` (the real page hook, the escaping, and the size budget: the whole inline script must stay under 6 KB gzipped; it is about 4.6 KB with every tool on), `tests/admin.test.ts` (every screen checked against EmDash's Block Kit validator, which EmDash does not run for native plugins), and `apps/demo-site/tests/analytics.spec.ts` (a real browser with the tracking hosts stubbed: no request before consent, the right ones after, keyboard use, the forms plugin).

In browser tests the visitor's country is forced by answering the plugin's own route, `/_emdash/api/plugins/analytics-consent/geo`, with `{ "success": true, "data": { "country": "DE" } }`.
