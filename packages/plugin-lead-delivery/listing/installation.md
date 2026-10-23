Install it in code, in `plugins` (not `sandboxed`, for now: on Cloudflare a sandboxed plugin may make only 10 calls to the site per request, and delivering an enquiry needs more):

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
