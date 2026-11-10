# 0038. A late request for changes reopens the lead's decision

- **Status:** accepted
- **Date:** 2026-11-10

## Context

The lead reviews last and decides for the round; every other seat is advice
to it, or, when `blocking`, an approver beside it. Once the lead had posted on
a diff it was never due again (`leadDue` needed the lead not to have posted).
A seat that posted after the lead's approval was read by nothing, except the
security seat's signed verdict on a change to how CI runs (`securityAsks`),
and that one was held for a person.

On #253, on 2026-11-10, `safety` was added after the lead approved, the
security seat found a blocker, and a person had to send the pull request back
by hand. The owner chose that any non-lead seat asked on a head, when its
verdict is a request for changes, holds the merge and asks the lead again
(#261).

## Decision

A non-lead seat asked on the pull request whose latest verdict on this diff
is `request_changes`, given after the lead's latest review of this diff while
the lead approves it, reopens the lead's decision:

- It is held in `review-gate` (`reviewStanding.lateAsks`), not as a new
  `mergeDecision` rule. `mergeDecision` already refuses a head whose gate is
  not green, so the merge holds through the gate, and `mergeDecision`,
  `mergeBlockers` and their parity (ADR 0037) do not change.
- "After" is by `submittedAt`, falling back to GitHub's review id, which
  increases, when either review has none.
- The lead is asked again (`leadDue`, with `lateAsks`) with `since` set to
  the latest late ask's time, so a lead task opened since then is that review
  and the lead is asked once per late ask. Its task carries `asked-again.md`
  naming the seats and reviews; the verdicts themselves are in `reviews.md`.
- When signatures can be checked, only a signed review counts. When nothing
  can check one, a crew-authored verdict counts: it only holds the merge,
  never releases it.
- While the lead is due, `onReview` records no `review.stalled`: the lead is
  deciding, not a person. Once the lead approves again, a blocking seat's
  request still holds as an approver's, and on a change to how CI runs the
  security seat's still holds through `securityAsks`; both stall for a person
  as before. An advisory request the lead has read holds nothing.

A later approval from any seat, or a comment with no verdict, changes nothing.

## What this rules out

- **A new rule in `mergeDecision`.** It is defence in depth on paper only: the
  rule already refuses on a non-green gate, `MergeFacts` carries no review
  times, and adding them would widen ADR 0037's parity surface for nothing the
  gate does not already hold.
- **Dismissing the lead's approval on a late ask**, so the existing "lead not
  posted" path asks it again. A bot may never dismiss a review (`AGENTS.md`
  invariants), and the bridge's own dismissals are kept to superseded
  approvals.
- **Holding for a person (`review.stalled`), as `securityAsks` did.** That is
  what happened on #253: a person had to send the pull request back by hand.
  The lead decides again instead.

## What would make this worth revisiting

Reviews carrying no reliable order — GitHub review ids no longer increasing,
or `submittedAt` no longer set — or advisory seats posting verdicts some other
way than the `review_posted` marker, which is what `seatVerdictOn` reads.
