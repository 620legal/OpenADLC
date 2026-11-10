# 0039. Seat trigger labels are read from closing issues

- **Status:** accepted
- **Date:** 2026-11-10

## Context

Intake and design label an issue `safety` or `touches:*` when it needs the
security lens, and `config/review.yaml` asks the security seat for those
labels. But `decideReviewers` read only the pull request's own labels, and a
builder's pull request carries none, so the label asked for nothing: the
security seat came only by path or by sample (620legal/OpenADLC#260).

Seats are chosen in four places — the opened or updated path and the
conflict-resolution re-check in `webhooks.ts`, `reviewStanding` and
`mergeFacts` in `automation.ts` — and all four must agree, or the gate, the
requests and the merge wait on different seats. The person deciding #260
chose to read the issue's labels rather than copy them onto the pull request.

## Decision

- A seat's `trigger.labels` match the labels on the issues the pull request
  closes, as well as its own. They are read from GitHub on every decision
  (`Automation.closingIssueLabels`), and every one of the four places passes
  the same result to `decideReviewers` as `issueLabels`.
- Only labels some seat's `trigger.labels` names are taken from an issue, and
  they stay apart from the pull request's own labels: `fastPathOf`, the revert
  rule and scope read only the pull request's. A seat an issue's label asked
  for counts as asked by label, so a revert keeps it as it would one its own
  label asked for.
- The reason names the issue: `label safety on #251 put this in the security
  lens`. The pull request's own label wins the reason when both carry it.
- This repository's issues only (`closingIssues`), as scope reads them.
- An issue that cannot be read counts as unlabelled. A failed list gives no
  issues, a failed issue is skipped, and the lookup never throws: seats fall
  back to the pull request's own labels, and nothing is held for it.

## What this rules out

- **Copying the labels onto the pull request.** A label added to the issue
  later would need its own handler to copy it across, and the copied labels
  would look like a person's or the author's own. Reading needs one code path
  and covers the late label.
- **Reading the platform database's stored issue labels.** It costs no API
  call, but it is only as fresh as the last delivery; the `Automation` class
  re-derives every decision from GitHub's current state so a missed webhook
  repairs itself, and stored labels would break that for this one input.
- **Merging the issue's labels into `input.labels` at each call site.** Every
  other rule reading `labels` would see them: an issue's `revert` or `deps`
  would reach `fastPathOf` and the fast-path guard.
- **Holding the pull request when an issue cannot be read.** A label can only
  add a seat; before this, an issue's labels asked for none, so falling back
  is no weaker than it was.

## What would make this worth revisiting

Builders opening pull requests that close issues in another managed
repository, which would need that repository's client; or the cost of the
extra GitHub reads on each sweep tick mattering against the rate limit.
