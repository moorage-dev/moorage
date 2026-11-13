# Site Health & Broken Links for EmDash

Tells you what is broken on your [EmDash](https://emdashcms.com) site before a customer does: a dead link in the menu, a page that shows an error, a map that will not load. It is a broken link checker for your pages, your menu and the links to other sites, with an email when something breaks and a short setup checklist. It runs on any EmDash site, with no account and no key.

![The Problems tab](images/problems-0-2-0.png)

## What it does

- **Problems, grouped by how bad.**
  - **Every page:** a broken link in the site menu or footer.
  - **One page:** a page that shows visitors an error, or loads a map, video, script or form over an insecure connection (browsers block those, so visitors see an empty box).
  - **One link:** a link inside a page that goes to a page that does not exist, a page not published yet, or a page another website has removed.

  There is one row per broken address, with the pages it was found on. A row is marked "New since the last check" when it first appeared in the latest check. Under each group, a folded "Details for your web person" gives each row's technical answer to copy: the HTTP status and when it was checked (in UTC), or why no request was made.

- **Fix menu on every row.**
  - **Send visitors to another page:** adds a redirect from the dead address to a page you pick from a list, which fixes it everywhere at once. Admins only, as in EmDash itself.
  - **Edit:** opens the page, with the link named.
  - **Check it again now.**
  - **This is fine, stop checking it.**
- **Two folded lists that never count.**
  - **Worth a look:** links that work but take a detour, and pictures over an insecure connection.
  - **Links we could not check:** sites that turn away automatic checkers, such as LinkedIn and Instagram. These are never called broken.
- **Email.**
  - At once when a page shows an error or a menu link breaks.
  - A weekly list of only what is new.
  - Sent to several addresses, with the site's name first in the subject.
  - Never more than one email a day of each kind.
- **Checklist** (Admins):
  - the site address is set and secure;
  - the insecure address sends visitors to the secure one;
  - the address with and without www;
  - a made-up address shows the "page not found" page;
  - search engines may list the home page (no `noindex` in its meta tags or its `X-Robots-Tag` header), checked with every full check;
  - search engines are allowed in: robots.txt is read one group of crawlers at a time, so keeping out Google, or every search engine, needs attention, while keeping out only AI crawlers or one folder does not;
  - the list of your pages for search engines (sitemap) answers: the one robots.txt names, or `/sitemap.xml`, as a list of pages or a list of lists;
  - pages can be kept ready for visitors;
  - scheduled tasks are running;
  - email works: who gets it, whether an email service is chosen, and when it last worked, with the test button beside it;
  - a reminder, not a check, for sites on Cloudflare: blocking AI training in Cloudflare's AI Crawler and Agent access policies also blocks Google, so set Training to Allow or Disallow and check that Google Search Console can read your sitemap. Site Health cannot see this block (Cloudflare turns away only Google's own requests), so the line has no status and is never counted.
- **Left over from WordPress**, a group that shows only when something is found, with no setting. Each row says what it is and what to do, and its Fix menu opens the page (or Menus), or marks it as fine:
  - a WordPress shortcode visitors see as plain text, such as `[contact-form-7 id="…" title="…"]` or `[gallery]` (only the WordPress shape: a name with settings, a closing tag, or a well-known name; ordinary words in square brackets are left alone), one row per shortcode with the pages it is on;
  - an empty HTML block, which is what a WordPress block such as Latest Posts becomes;
  - links to WordPress addresses: `/?p=12` and `/?page_id=7` on this site, dated addresses such as `/2024/05/post/` when your own posts do not use dates, anything under `/wp-content/` or `/wp-admin/`, and every link to the old WordPress site once one of those has named it (in your pages, and in the menu and footer the home page shows; a site no page links to that way any more is forgotten at the next check);
  - a page whose slug is in WordPress's coded form (`%cf%84…`), which opens "Page not found": type a new slug in plain letters (content with no page of its own is left out);
  - pictures with no alt text: featured images and pictures inside the page.

  These are read from the same pages the daily check reads, at no extra cost, and are not counted as broken. Editors see them too, and in the "Links on this page" panel.

- **Dashboard widget** with the count.
- **"Links on this page" beside each entry** in the editor: what the checks found in that page's links, in the same plain words. Read-only; it shows what is already stored and opens no website, so it is instant. Nothing to set up.

| Links on this page, in the editor | The Checklist                   |
| --------------------------------- | ------------------------------- |
| ![](images/links-panel-0-2-0.png) | ![](images/checklist-0-2-0.png) |

Editors see the links they can fix. Page errors, the Checklist and Options are for Admins.

## What it does not do

- It does not change the links inside your pages. That would need permission to rewrite content; the redirect fixes an address on your own site everywhere instead.
- No score, grade, history, charts or CSV export.
- No speed tests, security headers, certificate expiry or version checks.
- It does not check canonical addresses (the SEO plugin does that). Pictures with no alt text are listed with what a move from WordPress left; the SEO plugin lists them too.
- It cannot read menus, widget areas or sections directly. Menu and footer links are found on the rendered home page, so they need the site to be public. A menu the header does not show (such as the second menu a WordPress import adds) is not seen.

## Install

Install from **Registry** in your EmDash admin, or pin it in code:

```sh
npm install @moorage/plugin-site-health
```

```js
// astro.config.mjs
import siteHealth from "@moorage/plugin-site-health";

emdash({ sandboxed: [siteHealth] });
```

`sandboxed` needs a sandbox runner. On Cloudflare that is two things: the `LOADER` Worker Loader binding in `wrangler.jsonc` (Workers Paid only) and `sandboxRunner: sandbox()` in `astro.config.mjs`, with `sandbox` imported from `@emdash-cms/cloudflare`; answering Yes to sandboxed plugins in `create-emdash` adds only the binding. On a site without one (such as the Workers free plan), list it under `plugins: [siteHealth]` instead. It works the same. Since 0.1.3 the email list and the outside-link choice survive moving the plugin from one list to the other (the check results are rebuilt by the next check); when updating from an earlier version, update first, open the Site Health page once, then move it.

**Needs EmDash 1.5.0 or later** (from 0.4.0; earlier versions of Site Health work on EmDash 1.3 and 1.4).

**On Cloudflare's Workers free plan** each request gets about 10 ms of CPU. EmDash's own saving and publishing already comes close to that, and every plugin run in the site's process adds a little, so a save or publish can now and then fail with "Worker exceeded resource limits"; trying again works. Workers Paid (30 seconds per request) does not have this problem.

Then open **Tools > Site Health** in the admin sidebar.

**Permissions it asks for:**

| Permission                     | Why                                                                 |
| ------------------------------ | ------------------------------------------------------------------- |
| Read content and content types | Finds the links in your pages.                                      |
| Change redirects               | For "Send visitors to another page".                                |
| Fetch any address              | Links to other sites and your own address are not known in advance. |
| Send email                     | Alerts and the test email.                                          |

**It needs EmDash's scheduled tasks.** On Cloudflare that means a Cron Trigger on the Worker. If they are not running, the Checklist says so and gives your web person the steps to copy; the check then moves one step each time the page is opened.

## How it checks

| What                 | How                                                                                                                                                                                                                                                  | How often                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Your pages           | Reads every entry, a batch each minute. Links to your own site are checked against your pages and redirects, with no fetching.                                                                                                                       | Every day, and a page again when it is saved or published. |
| Your rendered pages  | Opens the home page (for the menu and footer) and then each page, two a minute.                                                                                                                                                                      | Every day.                                                 |
| Links to other sites | Three a minute, on different sites, never one site more than once a minute. Each one says who it is: `EmDash-SiteHealth/0.1 (+your address)`. A link is broken only when the other website says the page is gone on two checks at least a day apart. | Every week, and again a day after a failure.               |
| Checklist            | Up to five requests. The home page's search-engine tags come from the home page the check opens anyway.                                                                                                                                              | Once a week.                                               |

The numbers on the page are always a finished check. A check that is still running never changes them.

Each run stays within the EmDash sandbox's limits of 10 calls (it makes at most 9) and about 50 ms of CPU. The scheduled task runs every minute.

**If the site cannot open its own pages** (not public yet, bot protection, or a host that blocks a site from fetching itself), it says so in one banner. If your site is in the middle of an update and shows every visitor an error page, it says that instead, and emails at once. Links inside your content are still checked, and anything that needed the live page is listed as "could not check", never as broken.

**Links to your own site, written in full** (`https://your-site/about`, or `http://127.0.0.1:4321/about` on a site set up as `localhost`) are checked like `/about`: against your pages and redirects. On a site that is not public yet, one that matches no page is listed as "could not check" and checked once the site has a public address: EmDash does not let plugins open addresses on your own computer or network, so the plugin cannot ask the site itself.

## Use with an AI assistant (MCP)

An AI assistant connected to your site through EmDash's MCP server can read what Site Health found and, for an Admin, fix a dead address with a redirect. Two tools, both off until an Admin switches them on:

| Tool                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site-health__problems`     | The Problems tab as the caller sees it: the counts, then each problem worst first, with its address, the same sentence the page shows, the pages it was found on, and the HTTP status and time of the last check. Editors see what the page shows Editors (no page errors, no menu rows). Read-only. Options: `limit` (1 to 100, default 25) and `kind` (`broken`, `worth_a_look`, `could_not_check`, `wordpress_leftovers`). |
| `site-health__add_redirect` | The Fix menu's "Send visitors to another page", for one problem from the list: same checks, same refusals (a live page, the same address, a draft or a page error), and it never replaces a redirect that is already there. Admins only. EmDash marks it Destructive when an Admin switches the tools on, and AI clients may ask before using it.                                                                             |

To switch them on, an Admin opens **Plugins** in the admin, opens Site Health & Broken Links and turns on **Agent access**. The assistant then needs an API token (Settings, API Tokens) with the plugin tools scope for this plugin only (`mcp:tools:site-health`) or for all plugins (`mcp:tools`). A tool works only for a user allowed to do the same thing on the page: Editors and Admins for `problems`, Admins for `add_redirect`. The tools never change the links inside your pages, and never publish, unpublish or delete anything.

## FAQ

**Why does a link show under "could not check"?** Some sites refuse automatic checkers, ask them to slow down, or did not answer within 8 seconds. Open it to see for yourself; it is tried again next week.

**I moved from WordPress. What is "Left over from WordPress"?** Things the move left in your pages that visitors may see: shortcodes shown as text, empty blocks, links to WordPress addresses or to the old site, coded slugs that open "Page not found", and pictures without alt text. Each row says what to do, and goes as you tidy up. A site that never used WordPress normally sees none; a link to another site's WordPress address (a file under `/wp-content/`, say) can show, worded "looks like your old WordPress site", and "This is fine, stop listing it" takes it off.

**Why do links to other sites take a day?** A site that is down for an hour should not send you an alert, so a broken answer is confirmed a day later.

**Who gets the emails?** The first Admin who opens Site Health, plus anyone added under Checklist, Options. An empty list means no email. Your site needs an email service chosen in EmDash (Settings, Email); the Email row on the Checklist says whether it has one, and "Send a test email" checks it now.

**Does it send anything anywhere?** Only to the websites your pages link to (to check them) and the email addresses you list.

**What is the line at the foot of the page?** Only admins see it: "Help · More free plugins · by Moorage", links to the guide on moorage.dev and to more free plugins. Editors never see it. To hide it, switch on "Hide the help line at the foot of this page" under Checklist, Options and press Save.

**Why do the checks and emails use the site's old address?** Plugins keep the site address EmDash had when the server started; Site Health uses it to open your own pages, to tell your links from other sites' and in its emails and instructions. After changing the site's address, restart the site.

## Changelog

- **0.1.0:** first version.

## Develop

```sh
pnpm --filter @moorage/plugin-site-health build
pnpm --filter @moorage/plugin-site-health test      # sandboxed, own pages and other sites simulated
DEMO_SITE_PORT=4402 pnpm --filter demo-site exec playwright test tests/site-health.spec.ts
DEMO_SITE_PORT=4402 DEMO_SITE_SITE_HEALTH=in-process pnpm --filter demo-site exec playwright test tests/site-health.spec.ts
```

The tests never contact a real site.

## Licence

MIT. Copyright 2026 GoSi Tech.
