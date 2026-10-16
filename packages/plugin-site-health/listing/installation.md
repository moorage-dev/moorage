Install from **Plugins** in your EmDash admin, or pin it in code:

```sh
npm install @moorage/plugin-site-health
```

```js
// astro.config.mjs
import siteHealth from "@moorage/plugin-site-health";

emdash({ sandboxed: [siteHealth] });
```

Then open **Tools > Site Health** in the admin sidebar. The first check starts by itself and takes about 20 minutes for a site with 40 pages; links to other sites follow a day later.

Site Health needs EmDash's scheduled tasks. On Cloudflare that means a Cron Trigger on the Worker; the Checklist tab says so if they are not running.
