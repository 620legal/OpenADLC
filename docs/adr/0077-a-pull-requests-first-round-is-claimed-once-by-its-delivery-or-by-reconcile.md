# 0077. A pull request's first round is claimed once, by its delivery or by reconcile

- **Status:** accepted
- **Date:** 2026-11-16

## Context

Only the `pull_request.opened` delivery opens a crew pull request's first
review round (`onPullRequest` in `apps/bridge/src/webhooks.ts`). On v0.1.36 the
webhook tunnel stopped reaching the bridge after 14:44 UTC, the builder opened
#360 at 16:42, and no redelivery ever brought its opening. The board said its
build had ended and it waited for its pull request, Needs you was empty, and
no seat was asked for 35 minutes, until a person turned it to draft and back.

Nothing else would have caught it. The gate sweep (`Scheduler.settleGates`)
only continues a round: it skips an issue's pull request unless the issue is
already in Review, and only `openReviews` moves it there. Reconcile reads
every open pull request each quarter hour, but only recorded such a one as
`webhook.unheard`.

The opening does more than ask the seats: it links the work item, writes the
issue's `pr_number` and the lease's `prNumber`, checks GitHub that the pull
request is still open, records `review.round_opened`, holds a crew head with
no local CI pass, and holds a conflicting head for its builder. A repair has
to do all of that, or it opens a round the delivery would have held.

And it recorded `review.round_opened` on every opening, delivered or not. A
redelivered `opened` for a head that already had its round recorded a second
one, which moved the round's start, so reviews already given on that head
stopped counting; a repair racing a late delivery would have opened two.

## Decision

A first round on a head is claimed once. A delivered `opened` and reconcile's
repair both claim it under `withAdvisoryLock('review-round:<repo>#<pr>')`
(`firstRoundLock`). Inside the lock they check for a `review.round_opened`
with that subject and sha, and record one only when none exists; the one that
finds one opens nothing more. `reopened`, `ready_for_review` and `synchronize`
record as before: a reopen or a new diff is a new round on purpose.

Reconcile opens a first round only for an open, non-draft, same-repository
pull request that a crew account opened, whose branch names an issue with an
active lease, and that has no recorded round on any head and no `review-gate`
status on its head; a status that cannot be read is not "none". It opens it by
running the `opened` delivery that never came through `onPullRequest`
(`Webhooks.reviewUnheard`, with the author as the sender), never by calling
`openReviews` directly. Its claim records `by: 'reconciler'`, and the repair
audits `review.opened_unheard` and reports drift `review_unopened`. One that
fails is reported, the pass goes on, and the next pass tries it again. A
delivery whose lock cannot be had records as before, unclaimed, rather than
leave a pull request unreviewed.

## What this rules out

- **Calling `openReviews` from reconcile.** It would skip the closed check,
  the lease and `pr_number` writes, the local-CI hold and the conflict hold.
- **Leaving fresh pull requests to a grace window** (say ten minutes after
  `createdAt`). A person's manual redelivery, or the tunnel watch's own, can
  arrive at any time, so a window narrows the race without closing it. The
  lock closes it, and costs one lock per opening.
- **A unique row per round.** That needs a migration, and the event plus the
  lock already give one round.
- **Repairing a lost `ready_for_review` or `synchronize`.** A pull request
  opened as a draft and made ready while deliveries were lost has no round on
  any head, so it is repaired; a late `ready_for_review` after that records a
  second round on the same head, as any duplicate one does today. A lost
  `synchronize` (a new diff under an old round) is a different gap.
- **A person's pull request.** One with no lease, or not from a crew account,
  is never started by reconcile, as the gate sweep's rule already is.

## What would make this worth revisiting

A round recorded somewhere other than the `review.round_opened` event (a row
of its own, say), which would carry the claim itself; or deliveries that
GitHub guarantees to bring after an outage, which would make the repair
unnecessary.
