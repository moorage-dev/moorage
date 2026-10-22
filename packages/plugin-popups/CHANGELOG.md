# @moorage/plugin-popups

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
