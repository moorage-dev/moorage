# Moorage

Plugins and a marketing theme for [EmDash](https://emdashcms.com), the open-source Astro CMS.
Built by [Moorage](https://moorage.dev). Every package here
runs on any EmDash site, self-hosted or on Moorage, with no account and no key.

## Packages

| Package                         | What it does                                                                                                                                           | Format          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `@moorage/plugin-seo`           | SEO & Schema Markup: structured data for more content types, SERP preview, noindex per collection, redirects import, IndexNow, site-wide hygiene score | sandbox-capable |
| `@moorage/plugin-lead-delivery` | HubSpot, Mailchimp & Zapier Lead Delivery: signed delivery of form submissions with a log and retries                                                  | sandbox-capable |
| `@moorage/plugin-site-health`   | Site Health & Broken Links: in-admin checks and a broken-link scan                                                                                     | sandbox-capable |
| `@moorage/plugin-restore`       | Backup & Restore (Point in Time): restore the database to a minute                                                                                     | sandbox-capable |
| `@moorage/plugin-approvals`     | Content Approval & Editorial Workflow: request, approve, send back                                                                                     | sandbox-capable |
| `@moorage/plugin-analytics`     | Analytics & Cookie Consent: GA4, GTM, Clarity, Meta Pixel with consent mode                                                                            | native          |
| `@moorage/plugin-popups`        | Popups, Slide-ins & Exit Intent, reusing EmDash forms                                                                                                  | native          |
| `@moorage/theme-marketing`      | Content-complete marketing theme: components and a copyable site template                                                                              | Astro           |

Status: scaffolding. Packages land in the order listed in `AGENTS.md`.

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

[FSL-1.1-MIT](LICENSE): free to use, modify and self-host; each release becomes MIT two years after it ships.
