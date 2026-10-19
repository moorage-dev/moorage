# @moorage/plugin-popups

## 0.1.2

### Patch Changes

- 0b8454c: The "Download as a spreadsheet (CSV)" link on the Numbers tab works again: EmDash 1.3.1 refused it because a plain link cannot send EmDash's request header. The admin page now signs the link for the dates on screen, and it works for ten minutes. The instructions for the web person now give `/#popup-<name>`, which EmDash's menu accepts as a custom link, and the README says that "Save and finish" turns a new popup on and that a paused form shows a yellow warning.

## 0.1.1

### Patch Changes

- dde14f2: README: forms in popups need the forms plugin 0.2.11 or later, because earlier versions save a ticked single checkbox, such as a consent box, as unticked. No code change.

## 0.1.0

### Minor Changes

- 1b42bce: First release: top bars, slide-ins, popups and boxes in a page, set up in four steps on one admin page. A form from Forms or a button, pictures from the media library, dates with times in the site's time zone, fixed respect rules (one per visit, never over the cookie banner, a sheet on phones, always a close button and Esc), a preview that says why a real visitor would not see it, daily results with a spreadsheet download, and an email when a popup cannot open.
