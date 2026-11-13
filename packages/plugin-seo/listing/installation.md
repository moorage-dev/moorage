Install from **Registry** in your EmDash admin, or pin it in code:

```sh
npm install @moorage/plugin-seo
```

```js
// astro.config.mjs (on Cloudflare)
import { sandbox } from "@emdash-cms/cloudflare";
import seo from "@moorage/plugin-seo";

emdash({ sandboxed: [seo], sandboxRunner: sandbox() });
```

On Cloudflare, `sandbox()` also needs the Worker Loader binding in `wrangler.jsonc`: `"worker_loaders": [{ "binding": "LOADER" }]` (Workers Paid). Without a sandbox runner, list it under `plugins: [seo]` instead.

Use one schema plugin at a time: EmDash keeps only the first page markup it receives, so a second schema plugin's markup, or this one's, silently goes missing.

Then open **SEO** in the admin sidebar. It works before you change anything; answering one question about who the site is for makes the result more accurate.

Setting up several sites the same way: SEO > Settings > Copy settings to another site shows the settings as text; paste it on the next site, press Check to see what will change, then apply.

For IndexNow (Bing and others), search this registry for an IndexNow plugin.

Needs EmDash 1.5.0 or later.

AI assistants (MCP): one read-only tool, `seo__to_fix`, lists the pages to fix with their addresses and problems. It is off until an Admin switches on Agent access for it under Plugins.
