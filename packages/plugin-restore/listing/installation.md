Install from **Plugins** in your EmDash admin, or pin it in code:

```sh
npm install @moorage/plugin-restore
```

```js
// astro.config.mjs
import restore from "@moorage/plugin-restore";

emdash({ sandboxed: [restore] });
```

Then open **Tools > Restore** in the admin sidebar, press "Open Cloudflare to make the key", create the key Cloudflare offers (one permission, filled in for you) and paste it. Do it on the day the site launches: Restore can only go back to moments after it was set up.
