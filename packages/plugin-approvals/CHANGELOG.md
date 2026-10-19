# @moorage/plugin-approvals

## 0.1.1

### Patch Changes

- 4586179: README: on Cloudflare's Workers free plan a save or publish can now and then fail with "Worker exceeded resource limits" (about 10 ms of CPU per request, which EmDash's own saving already comes close to); trying again works, and Workers Paid does not have this problem. No code change.

## 0.1.0

### Minor Changes

- 9748082: First version of Content Approval: Publish sends a page for approval on the content types you choose; approvers approve and publish in one step, approve for later or send it back with a note, and see what changed in words; a text copy of each approved version is kept.
