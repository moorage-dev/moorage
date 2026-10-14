# Moorage

Free plugins for [EmDash](https://emdashcms.com), the open-source CMS from Cloudflare. Every
package here runs on any EmDash site, with no account and no key. More at [moorage.dev](https://moorage.dev).

## Packages

| Package                     | What it does                                                                                                                      | Status                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@moorage/plugin-seo`       | SEO & Schema Markup: structured data for every page, a Google preview, SEO checks, noindex rules, redirects import from WordPress | Released: [npm](https://www.npmjs.com/package/@moorage/plugin-seo), [EmDash registry](https://plugins.emdashcms.com/plugins/@moorage.dev/seo) |
| `@moorage/plugin-analytics` | Analytics & Cookie Consent: analytics and ad tags behind a consent banner                                                         | Built, being tested before its first release; not on npm yet                                                                                  |

Planned, not started: Lead Delivery, Site Health, Popups, Backup & Restore, Content Approval and a Marketing Theme.

## Develop

```sh
pnpm install
pnpm check        # build, typecheck, test, validate, lint, format
pnpm dev          # watch mode for every package, plus the demo site on http://localhost:4321;
                  # the site restarts by itself a few seconds after a plugin change
```

The demo site (`apps/demo-site`) needs a local `.env` once:

```sh
pnpm --filter demo-site exec emdash secrets generate --write .env
echo "EMDASH_SITE_URL=http://localhost:4321" >> apps/demo-site/.env
```

Open `/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` to sign in as a dev admin.

Node 22.16 or newer and pnpm 11 are required.

## Licence

[FSL-1.1-MIT](LICENSE): free to use, modify and self-host; each release becomes MIT two years after it ships. Copyright GoSi Tech; Moorage is its product name.
