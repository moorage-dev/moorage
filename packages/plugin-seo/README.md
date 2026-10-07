# @moorage/plugin-seo

SEO & Schema Markup for [EmDash](https://emdashcms.com): structured data for more content types, a SERP preview, noindex per collection, redirects import from WordPress, IndexNow, and a site-wide hygiene score. Runs on any EmDash site, self-hosted or on Moorage, with no account and no key.

Status: scaffold. The hello route is the only feature so far; features land in the order listed in the repository `AGENTS.md`.

## Install

Registry (after the first release): search "SEO" in your EmDash admin under Plugins.

npm, pinned in code:

```sh
pnpm add @moorage/plugin-seo
```

```js
import seo from "@moorage/plugin-seo";
// astro.config.mjs
import emdash from "emdash/astro";

export default defineConfig({
	integrations: [emdash({ sandboxed: [seo] })],
});
```

## Settings

None yet.

## FAQ

- How do I add schema markup to EmDash? Install this plugin; it emits JSON-LD per collection type.
- How do I import redirects from WordPress? Export the Redirection plugin's CSV and import it on the Search page.
- Is there a Yoast alternative for EmDash? EmDash core covers titles, sitemaps and canonicals; this plugin adds the rest.

## Develop

```sh
pnpm --filter @moorage/plugin-seo build      # emdash-plugin build
pnpm --filter @moorage/plugin-seo test       # validate + vitest through the sandbox harness
pnpm --filter @moorage/plugin-seo validate
```

## Licence

FSL-1.1-MIT; see LICENSE.
