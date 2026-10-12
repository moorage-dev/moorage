Install from **Plugins** in your EmDash admin, or pin it in code:

```sh
npm install @moorage/plugin-seo
```

```js
// astro.config.mjs
import seo from "@moorage/plugin-seo";

emdash({ sandboxed: [seo] });
```

Then open **SEO** in the admin sidebar. It works before you change anything; answering one question about who the site is for makes the result more accurate.
