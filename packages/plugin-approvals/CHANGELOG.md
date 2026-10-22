# @moorage/plugin-approvals

## 0.1.4

### Patch Changes

- 969d4c5: On a phone, all the tabs (Waiting, Sent back, History and, for admins, Settings) now fit on the screen. Before, Settings was cut off at the right edge. The tabs no longer show counts; the numbers at the top of Waiting still do.

## 0.1.3

### Patch Changes

- c76285f: Your own requests are listed apart under "Yours, waiting", with what each waits for, and no longer show Approve buttons you cannot use. An admin publishes their own request with "Publish without review" (a reason is required and emailed to the other approvers). When nobody else can approve, Settings, the Approvals page and the held Publish say approval needs a second person. Short help under each setting replaces the long explanation.

## 0.1.2

### Patch Changes

- afbde42: Dates in the approver's review and in the approved text copy now read "19 Oct 2026", or "19 Oct 2026, 14:05 UTC" with a time, instead of "2026-10-19T00:00:00.000Z"; copies saved before this show the same way and do not count as a change. README and listing: Contributors ask from Approvals > Your drafts, because EmDash 1.3.1 shows them the editor's "Ask for approval" button and Approval panel but refuses both ("Plugin action failed"); the History tab shows the latest approved text of each page, not every approved version.

## 0.1.1

### Patch Changes

- 4586179: README: on Cloudflare's Workers free plan a save or publish can now and then fail with "Worker exceeded resource limits" (about 10 ms of CPU per request, which EmDash's own saving already comes close to); trying again works, and Workers Paid does not have this problem. No code change.

## 0.1.0

### Minor Changes

- 9748082: First version of Content Approval: Publish sends a page for approval on the content types you choose; approvers approve and publish in one step, approve for later or send it back with a note, and see what changed in words; a text copy of each approved version is kept.
