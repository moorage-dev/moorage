# @moorage/plugin-restore

Backup & Restore for [EmDash](https://emdashcms.com): put the whole site back to any moment in the last 30 days, from the admin, and undo it if you picked the wrong time. For the day an import overwrites 31 product prices, a menu change goes wrong, or someone deletes the wrong things. It uses the point-in-time history Cloudflare keeps for every site database (D1 Time Travel), through a key you make in your own Cloudflare account. No account with anyone else, no key from us.

> **Not released yet.** Restoring a site's database while the site runs has not yet been checked on Cloudflare. `scripts/time-travel-check.mjs` does that on a test account; the plugin is released only after it passes.

## What it does

- **Go back to just before a change.** The page lists recent changes, newest first (what, who, when), each with its own button: "Go back to 11:04". A burst, such as an import that changed 31 products in a minute, is one row. You remember the mistake, not the time.
- **Or pick a moment:** one you saved earlier ("Before the menu import"), or a day, hour and minute in your site's time zone.
- **Review before anything happens.** How many changes are undone, what they were, entries that come back from the Trash, and the **text of every good edit that will be lost**, in a box to copy so you can make those edits again. The warning names **who gets their access back** (people removed or switched off since then) and who loses it (people added since).
- **Enquiries are never lost silently.** If anyone sent a form since the moment, they are named (form, sender, time) and the page will not go on until you download them from Forms > Submissions or say they reached you. Records Lead Delivery saved since then are kept aside and put back with one button afterwards.
- **Confirm deliberately:** tick "I understand the 34 changes made since 11:04 will be undone", then press the red button and confirm in the dialog.
- **Undo every restore** with one button. An undo is a restore too, and can itself be undone.
- **Right site, every time.** The plugin finds this site's database by itself (it leaves a random check mark in its own storage and looks for it), and checks again seconds before every restore. One restore at a time.
- **Shows what the key can reach.** Cloudflare can't limit this permission to one database, so the page lists every site the key can change, in red when that is more than this one, with the advice to keep each client in a separate Cloudflare account.
- **Emails** whoever looks after the site (several addresses, the site's name first in the subject, at most one a day of each kind) when the site is put back, when Restore stops working, and before the key expires. A daily check keeps the list of people current; a weekly one checks the key.

## What it is not

- **Not an off-site backup.** Cloudflare keeps the history in the same account as your site. For a copy to keep somewhere else, download one from Settings > Backups (EmDash's own page; this plugin leaves downloads to it).
- **Nothing before setup.** It can only go back to moments after it was set up, so **set it up on the day a site launches.** It also refuses moments before your own account existed (you would be locked out) and before the site's last EmDash upgrade (until that is proven safe).
- **No pictures.** Picture files are never deleted by a restore, and deleted files don't come back. Pictures added since the moment leave the media library; the files stay in storage.
- **Up to 30 days** (7 on Cloudflare's free plan).
- Only for sites that run on Cloudflare (D1). On SQLite, Postgres or Turso the page says so and points to Revisions, the Trash, Settings > Backups and your host's own restore.
- No scheduled restores, no partial restores, no preview of the old site, no restore of a single page (EmDash's Revisions and Trash do that).

## Install

```sh
npm install @moorage/plugin-restore
```

```js
// astro.config.mjs
import restore from "@moorage/plugin-restore";

emdash({ sandboxed: [restore] });
```

It also runs in-process (`plugins: [restore]`) on sites without a sandbox runner.

Then open **Tools > Restore** in the admin, press "Open Cloudflare to make the key" (Cloudflare's key page opens with the one permission it needs, Account > D1 > Edit, already filled in), create it, copy it and paste it. If someone else looks after your Cloudflare account, "Copy the instructions for your web person" gives them the steps.

## Settings

- **The key from Cloudflare.** Stored as a secret setting, encrypted by EmDash. Replace it or disconnect from the page.
- **Who to email.** Filled in with every administrator's address; edit the list on the page.

Everything else is found by itself: the Cloudflare account, this site's database, how far back it can go, and the time zone (the site's own).

## Who can use it

Administrators only. Editors who open the page are told who to ask, and how to undo their own change to one page with Revisions.

## Permissions

`network:request` to `api.cloudflare.com` only, and `email:send`. No content, user or media access: every read for the review (content, revisions, pictures, people, form enquiries, plugin records) is a read-only query through your key; the one write is putting Lead Delivery's records back when you press the button. It never reads passwords, sign-ins or keys.

## FAQ

**Is a restore instant?** Cloudflare doesn't say how long it takes. Keep the page open; visitors may see an error for up to a minute.

**What if the restore can't be confirmed?** If Cloudflare stops answering mid-restore, the page checks whether the site actually moved before it says anything. "Nothing was changed" is only shown once that is checked.

**What if the admin itself is broken after a restore?** The success screen keeps "If this page ever disappears": the instructions to undo the restore from a computer, for whoever set up the site.

**Does it work with several sites in one Cloudflare account?** Yes, but the key can change all of them, and the page says so.

## Develop

`pnpm test` runs the unit tests against a simulated Cloudflare (`test-support/simulated-cloudflare.mjs`); nothing in a test reaches Cloudflare. The demo site puts the same simulator in front of `api.cloudflare.com` (`apps/demo-site/simulated-cloudflare.mjs`), so its browser tests (`apps/demo-site/tests/restore.spec.ts`, sandboxed and with `DEMO_SITE_RESTORE=in-process`) never do either.

### The scratch-database check

Run it on a **test** Cloudflare account only, with a key that has D1 Edit on that account:

```sh
CLOUDFLARE_API_TOKEN=... node scripts/time-travel-check.mjs --test-account=<account id> --sizes=1,50
```

It refuses to run without `--test-account`, when the key belongs to another account or to several, and when the account already holds other databases (override with `--account-has-other-databases`; they are never touched). It creates its own scratch databases, writes rows, restores, undoes, and reports timings and what survives, then deletes them. `--worker` also uploads a tiny Worker that restores its own database while running (needs a key that can edit Workers). `--simulate` runs the whole thing against a simulated Cloudflare with no key.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) once released.

## Licence

MIT. Copyright 2026 GoSi Tech.
