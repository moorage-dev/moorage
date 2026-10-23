Install from **Plugins** in your EmDash admin (it runs sandboxed there; use 0.4.0 or later), or pin it in code, in `plugins` or, from 0.4.0, in `sandboxed` (on Cloudflare a sandboxed plugin may make only 10 calls to the site per request; from 0.4.0 Lead Delivery stays within that, and up to 0.3.1 it belongs in `plugins`):

```sh
npm install @moorage/plugin-lead-delivery
```

```js
// astro.config.mjs
import { formsPlugin } from "@emdash-cms/plugin-forms";
import leadDelivery from "@moorage/plugin-lead-delivery";

emdash({ plugins: [formsPlugin(), leadDelivery] });
```

It needs the official forms plugin (`@emdash-cms/plugin-forms`), 0.2.11 or later: earlier versions save a ticked consent box as unticked. Then open **Lead delivery** under Marketing in the admin sidebar and press New delivery: choose a form and where its enquiries go, and a test is sent.
