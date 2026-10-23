---
"@moorage/plugin-lead-delivery": patch
---

Your deliveries, private address and known forms now stay put when your site moves the plugin between running in-process (`plugins: []`) and sandboxed (`sandboxed: []`). EmDash keeps most plugin data in a different place in each mode, so before this Lead delivery started over after a switch: no deliveries, and a new private address that every connected form would no longer match. They are now kept where EmDash finds them in both modes.

Nothing to do on your side: the first enquiry, scheduled run or visit to Lead delivery after updating copies everything to the new place, keeping the same private address. Update first, open Lead delivery once, and only then switch modes. Each save also keeps a copy where earlier versions look, so going back to 0.3.0 still shows your latest deliveries and forms. If you go back, change something there and then update again, the update shows what you had before you went back; make the change again.

An arriving enquiry now makes a few fewer calls to the site's storage, because the plugin reuses what it has already read in the same run.
