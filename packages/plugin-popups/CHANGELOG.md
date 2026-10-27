# @moorage/plugin-popups

## 0.2.1

### Patch Changes

- e6af924: Colours for popups are now a choice, not hex codes. In Settings, pick your theme's colours (recommended, as before), one of five ready-made sets (Warm cream with brown buttons, Clean white with blue buttons, Soft grey with green buttons, Pale pink with plum buttons, Dark with gold buttons), or My own colours, which shows the colour boxes as before. Each set has a matching dark version and follows "Light or dark", every one is easy to read, and the cookie banner in Analytics & Cookies offers the same sets, so the two can match.
  
  Nothing to do on your side: if "Choose my own colours" was on, it now shows as My own colours and looks exactly the same. Choosing a set keeps the colours you typed, so going back to My own colours shows them again; an earlier version shows your theme's colours instead of a set.
  
  A correction to 0.2.0: a popup's hidden campaign fields (`utm_campaign` and the others) show when you open a sign-up under Forms and in what Lead Delivery passes on. Forms leaves hidden fields out of its emails, daily digest and CSV download, so they do not show there; the README now says so.
- 6857c03: Clearer kinds, and a helpful "Popups box" list in the editor. Only "Box in a page" is called a box now: a popup "opens by itself over the page, in the middle of the screen", a slide-in "slides in at a bottom corner", and a box in a page "sits inside a page or post, where you place it while editing". When there is no box yet, the editor's "Which box" list says how to make one, and names a popup or slide-in you made instead, since those open by themselves and are not placed in a post. A box that is turned off still shows, marked "(off)".
- 7431138: A finished popup's page is shorter and easier to follow. From the top: "← All popups", the name, one line that says how it is doing ("On · Popup with a form · every page, after they have read a while") with Turn on or off beside it, then "Preview on your site" and More (Change name or kind, Duplicate). A popup that cannot open shows the same warning here as on the list.
  
  Results open on the last 30 days, here and on the Results tab, and show two numbers: Sign-ups (or Button clicks) and Rate. How often it was seen and closed is one line under the chart, and the chart's dates no longer run into each other on a phone. "Compare popups" and "Download CSV" sit together under it.
  
  Edit is one form in the order what it says, when and where, dates, with shorter labels; the times name your site's time zone. The "Turn it on" switch is gone from this form: Turn on or off is beside the name, and pressing it keeps anything you typed but have not saved. Turn on or off, Duplicate and Change name or kind now bring you back to the popup's page instead of the list. "Delete popup" is at the very foot, for administrators, and asks first. The summary that repeated the form is gone.
  
  Editors see Turn on or off and Preview, and one line saying where and when the popup shows. Nothing stored changes.

## 0.2.0

### Minor Changes

- 8e28bac: Results you can read, in one place and one set of words:
  
  - Each popup's own page has a Results section: pick since it started, this month, last month or the last 30 days, and the page changes at once. Four numbers (Seen, Sign-ups or Button clicks, Rate, Closed) show the change from the period before, with a small chart of sign-ups or clicks a day. "Compare with other popups" opens the Results tab on the same period, and "Download this popup's numbers (CSV)" gives that popup's daily counts.
  - The Numbers tab is now Results: "How your popups compare" puts every popup side by side for the same period, sorted by Seen or Rate with a click on the column. Its totals now add up to the rows: a deleted popup's counts show in one "Deleted popups" row instead of only in the totals. The date boxes, the mixed chart and the list's numbers are gone; a popup's own page has them now.
  - Rate and "Seen on phones" both show from 100 views. A period never reaches past the 400 days counts are kept, and says so.
  - Days follow your site's time zone, so "this month" and the chart match your calendar. Counts made before this version were kept by the UTC day; they stay as they are.
  - A form in a popup or a box in a page now fills its own hidden fields `utm_campaign` (the popup's short name), `utm_source`, `utm_medium` and `page_url`, if it has them, so Forms, Lead Delivery and your CRM show which popup a sign-up came from. Add those hidden fields to the form under Forms to use it.
  - The admin page reads only the counts for what it shows, instead of every count on every click.


- 12b45a9: Editing a finished popup now has one Save for everything, so nothing typed is lost; each popup's page shows its own numbers.
- 27f7b3e: On a phone, "When it opens" no longer runs off the edge of the screen: its three choices are now listed on the page to pick from, and their words wrap. The Turn off and More buttons on a popup's page no longer cause a warning in the browser console.

## 0.1.8

### Patch Changes

- 6516427: Admins see a small help line at the foot of the page, with a link to the guide; it can be hidden in Settings.
- 8370eca: New screenshots of the current admin page, with the help line at its foot.

## 0.1.7

### Patch Changes

- 26b26ce: Admins see the list of forms to choose from again on a site that runs on Node, where `localhost` points to both an IPv6 and an IPv4 address and the server listens on only one. Before, the lookup could miss the server and show a box to type the form's short name instead. The same goes for the form check on save and for finding a picture's public address. The signed-in session still only goes to the site's own server.
- f8dd491: README and listing pictures retaken on the current versions: the Popups list with Edit and Preview on each row, and Content Approval's Waiting and Settings tabs without counts. No code change.

## 0.1.6

### Patch Changes

- 9371afb: Fits a phone, and a box in a page looks the same in the preview as on the page:
  
  - On a phone, the list no longer scrolls sideways or cuts off the Preview button. Each row now has just Edit and Preview, and shows the status after the popup's name. Turn on or off, Duplicate and Delete moved to the top of a popup's own page (open it with Edit).
  - The preview of a box in a page now lines it up with the page's text, as visitors see it in a post. Before, it sat in the middle of the page.
  - If your site has its own styles for forms (the Forms plugin's `.ec-form` classes), a form inside a box in a page now uses them. Sites without form styles see no change.

## 0.1.5

### Patch Changes

- 35ba052: Easier to use, from the founder's first round of feedback:
  
  - The list has Edit, Preview and Turn on or off as buttons on each row; only Duplicate and Delete sit in a small menu. The sentence explaining the old menu is gone.
  - Step 2 offers the site's forms in a dropdown, by name. Sites where Forms cannot list them still get the box to type the short name in.
  - Step 2's picture choice lists each picture by its file name, not its full description, and the note under the form is one line.
  - In a top bar's preview, the "Preview: …" label sits on its own row above the bar's words.
  - "It can take a few minutes to reach visitors" now shows after every save that changes what visitors see (including turning off or deleting a live popup), and no longer after saves they never see.

## 0.1.4

### Patch Changes

- 397ec0a: Preview shows each popup exactly where a visitor will see it: a top bar at the top of the page (it showed as a slide-in in the corner before), a slide-in in its corner, a popup centred on a computer and as a sheet at the bottom of a phone (unless it opens on a click), and narrowing the window past a phone's width redraws it. A box in a page now has a preview too, at the top of the page's content.
  
  The preview's tag now always tells the truth about a real visitor: a popup that opens on a click no longer says "this is the first page of the visit", a popup for a collection or kept off a page says "it does not show on this page", a popup for when visitors are about to leave says phones never see it, a centred popup says it waits for the second page, it says when another top bar or popup shows first, and a popup whose steps are not finished says so instead of "it is turned off".

## 0.1.3

### Patch Changes

- 079b9ad: Pages render faster: settings are kept for 30 seconds between page views, and a save takes effect at once.

## 0.1.2

### Patch Changes

- 0b8454c: The "Download as a spreadsheet (CSV)" link on the Numbers tab works again: EmDash 1.3.1 refused it because a plain link cannot send EmDash's request header. The admin page now signs the link for the dates on screen, and it works for ten minutes. The instructions for the web person now give `/#popup-<name>`, which EmDash's menu accepts as a custom link, and the README says that "Save and finish" turns a new popup on and that a paused form shows a yellow warning.

## 0.1.1

### Patch Changes

- dde14f2: README: forms in popups need the forms plugin 0.2.11 or later, because earlier versions save a ticked single checkbox, such as a consent box, as unticked. No code change.

## 0.1.0

### Minor Changes

- 1b42bce: First release: top bars, slide-ins, popups and boxes in a page, set up in four steps on one admin page. A form from Forms or a button, pictures from the media library, dates with times in the site's time zone, fixed respect rules (one per visit, never over the cookie banner, a sheet on phones, always a close button and Esc), a preview that says why a real visitor would not see it, daily results with a spreadsheet download, and an email when a popup cannot open.
