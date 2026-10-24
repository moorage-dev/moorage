---
"@moorage/plugin-popups": minor
---

Results you can read, in one place and one set of words:

- Each popup's own page has a Results section: pick since it started, this month, last month or the last 30 days, and the page changes at once. Four numbers (Seen, Sign-ups or Button clicks, Rate, Closed) show the change from the period before, with a small chart of sign-ups or clicks a day. "Compare with other popups" opens the Results tab on the same period, and "Download this popup's numbers (CSV)" gives that popup's daily counts.
- The Numbers tab is now Results: "How your popups compare" puts every popup side by side for the same period, sorted by Seen or Rate with a click on the column. Its totals now add up to the rows: a deleted popup's counts show in one "Deleted popups" row instead of only in the totals. The date boxes, the mixed chart and the list's numbers are gone; a popup's own page has them now.
- Rate and "Seen on phones" both show from 100 views. A period never reaches past the 400 days counts are kept, and says so.
- Days follow your site's time zone, so "this month" and the chart match your calendar. Counts made before this version were kept by the UTC day; they stay as they are.
- A form in a popup or a box in a page now fills its own hidden fields `utm_campaign` (the popup's short name), `utm_source`, `utm_medium` and `page_url`, if it has them, so Forms, Lead Delivery and your CRM show which popup a sign-up came from. Add those hidden fields to the form under Forms to use it.
- The admin page reads only the counts for what it shows, instead of every count on every click.
