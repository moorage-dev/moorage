---
"@moorage/plugin-seo": minor
---

- Needs EmDash 1.5.0 or later.
- For AI assistants (MCP): a new read-only tool, `seo__to_fix`, gives an assistant connected to your site the pages to fix, as the Overview lists them. It returns each page's content type, id, title, web address and problems (a code and the Overview's sentence), with the pages that have the most problems first, and the Overview's counts. It can be narrowed to one content type and returns 25 pages unless asked for up to 100. It changes nothing and is for Editors and Admins, as the SEO page is. The tool is off until an Admin switches on Agent access for this plugin under Plugins. If you installed from the Registry, the update asks you to approve the new tool. The assistant's token needs the scope `mcp:tools:seo` or `mcp:tools`.
- Each page's record now keeps its slug and language, so the tool can give its address without asking EmDash. For pages last checked before this update, the tool asks EmDash for the addresses, at least nine per answer (more on smaller sites); any others are listed without an address until the page is saved again or the pages are checked again (Check all pages again on the Overview).
