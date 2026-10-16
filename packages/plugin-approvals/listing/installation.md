Install from **Plugins** in your EmDash admin, or pin it in code:

```sh
npm install @moorage/plugin-approvals
```

```js
// astro.config.mjs
import approvals from "@moorage/plugin-approvals";

emdash({ sandboxed: [approvals] });
```

Then open **Approvals** in the admin sidebar, tick the content that needs approval and press **Save**. Nothing is held until you do.
