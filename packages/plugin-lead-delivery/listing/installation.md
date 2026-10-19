Install from **Plugins** in your EmDash admin, or pin it in code:

```sh
npm install @moorage/plugin-lead-delivery
```

```js
// astro.config.mjs
import leadDelivery from "@moorage/plugin-lead-delivery";

emdash({ sandboxed: [leadDelivery] });
```

It needs the official forms plugin (`@emdash-cms/plugin-forms`), 0.2.11 or later: earlier versions save a ticked consent box as unticked. Then open **Lead delivery** under Marketing in the admin sidebar and follow the three steps: connect your forms, choose where enquiries go, send a test.
