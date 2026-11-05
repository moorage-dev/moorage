Install from **Registry** in your EmDash admin, or pin it in code:

```sh
npm install @moorage/plugin-approvals
```

```js
// astro.config.mjs
import approvals from "@moorage/plugin-approvals";

emdash({ sandboxed: [approvals] });
```

`sandboxed` needs a sandbox runner: on Cloudflare, the `LOADER` Worker Loader binding in `wrangler.jsonc` and `sandboxRunner: sandbox()` (from `@emdash-cms/cloudflare`) in `astro.config.mjs`. Without one, list it under `plugins: [approvals]`.

Then open **Approvals** in the admin sidebar, tick the content that needs approval and press **Save**. Nothing is held until you do.
