---
"@moorage/plugin-analytics": patch
"@moorage/plugin-seo": patch
"@moorage/plugin-popups": patch
---

On Cloudflare Workers, page views that reached a newly started Worker at the same moment could go out without the plugin's output (tracking scripts and the cookie banner, SEO tags, popups), with "This promise was created by a request that has since ended" in the log; a cached page kept that copy until it expired. The settings kept between page views were shared as one read in progress, which Workers ties to the request that started it. Each page view now does its own read until one has finished, and later page views use the value. Reported in #46.
