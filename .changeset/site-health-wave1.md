---
"@moorage/plugin-site-health": patch
---

- **Checklist, Email row:** worked out fresh every time the Checklist opens, instead of repeating the last email sent. It now says "Not set up" only when it knows (no email service chosen, on a site where Site Health runs in the site's own process), needs attention when nobody is on the list, and otherwise says when it last checked and how that went, with "press Send a test email to check now". The Email line, directly under the Checklist table, shows its status, who gets the emails and the "Send a test email" button together. Options opens by itself when nobody is on the list.
- **A site in the middle of an update:** when the home page answers with EmDash's "database update not finished" page, Site Health no longer says the site turns checkers away. It shows "Your site is in the middle of an update" on the Problems tab, a "Site up" line on the Checklist, and emails at once (still at most one urgent email a day). Bot protection is reported as before.
- **Scheduled tasks not running:** the instructions for your web person now start with one plain sentence before the commands.
