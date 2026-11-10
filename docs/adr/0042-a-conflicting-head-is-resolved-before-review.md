# 0042. A conflicting head is resolved before review

- **Status:** accepted
- **Date:** 2026-11-10

## Context

On 2026-11-10, #257 conflicted with main after #256 merged. Three seats
reviewed it on two heads, and each time the lead's only blocker was "not
mergeable (`CONFLICTING`)". That cost a whole round of three seats, and it
used one of the review loop's three rounds.

GitHub computes `mergeable` lazily. Right after a push it is usually null,
with `mergeable_state` `unknown`, for a few seconds. A webhook handler cannot
wait for it. `internal-api.ts` answers GitHub only after `Webhooks.receive`
returns, and GitHub fails a delivery after 10 s. `redeliverFailed` then sends
the delivery again, so the review start runs twice.

The bridge already has a round for a conflict: the resolution round
(`conflict-round.ts`, the `resolve-conflict` skill). It gives the builder only
the conflicted files, and it does not count against `maxRounds`.

## Decision

- **A conflicting head goes to the resolution round before review.** On an
  issue's pull request, the review start reads mergeability once, after the
  local-CI hold. This does not apply to the merge line's own update or to a
  lead-only resolution. A conflicting head (`mergeable: false`, or
  `mergeable_state: dirty`) asks no seat. Instead,
  `ConflictRounds.start({ beforeReview: true })` opens the resolution round.
  The reviews after it always run in full, because no approval exists to
  carry. `conflict.sent_back` records `why`
  `FULL_REVIEW_WHY.beforeReview`, so Insights does not count the round as
  sent back.
- **Unknown mergeability is waited for off the delivery, for at most a
  minute.** `MergeabilityWait` re-reads every 5 s. A definite answer decides
  as above. After 60 s of unknown answers, the reviews start as they would
  have. The wait is recorded as `review.mergeability_waiting` and
  `review.mergeability_decided`. At start-up, an open wait is resumed and
  decided from one read.
- A round that waits on a busy builder starts when the builder's seat frees,
  through the `StageRunner`. The recovery runs a failed `resolve-conflict`
  task again with its card in Build.
- Every patch round on a pull request that conflicts is given `conflict.md`.

## What this rules out

- **Sending the work back through `SendBack.reviewRound` with a "merge the
  base" reason.** That counts against `maxRounds`. It moves the card and
  comments as if a review had sent the work back. It lets the builder rework
  any file. That cost is what the issue is about.
- **Waiting inside the delivery.** The wait goes past GitHub's 10 s, the
  delivery fails and is sent again, and the review start runs twice.
- **Treating unknown as clean, or starting the reviews and watching for a
  later conflict.** Unknown is the common case right after a push, so a
  conflict would usually slip past to the seats again.
- **Holding the reviews until GitHub answers, however long that takes.** A
  head GitHub never computes would hold its reviews indefinitely.
- **A second watcher for heads whose wait timed out.** A later push, the
  patch-round notice and the merge line's own update already catch such a
  head.

## What would make this worth revisiting

- GitHub computes mergeability before it delivers a push, or sends an event
  when it has computed it. The wait would then be unnecessary.
- Waits that time out become common. Then the lead's review would again be
  where conflicts are found, and a watcher would earn its place.
