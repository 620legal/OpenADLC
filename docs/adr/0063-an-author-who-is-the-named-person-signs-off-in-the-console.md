# 0063. An author who is the named person signs off in the console

- **Status:** accepted
- **Date:** 2026-11-14

Amends [ADR 0036](0036-a-person-decides-a-held-human-review-approval-from-the-console.md).

## Context

`AGENTS.md`'s `## Human review` names a person for some paths. A pull request
that changes those paths waits on that person's approval. The merge gate counts
that approval only through a GitHub `APPROVED` review from their own login:
`review-gate` (`reviewStanding`, `approvedTheHead`) and the merge
(`mergeDecision`, `mergeBlockers`) both read it that way.

GitHub refuses an approval from a pull request's author. This was seen on a
real install. A person opened a pull request on a path named for them, the
crew's reviewers approved it, and `ci` passed. Then `review-gate` stayed at
`waiting on @janedoe` for good. No card said so, because the wait was recorded
only for a crew pull request that closes an issue (`awaitPeople`) (#322).

ADR 0036 ruled out "recording a console approval in the bridge and counting it
in `mergeDecision`". Its own condition for revisiting was `mergeDecision`
coming to count something other than a GitHub review from the named person.
For an author who is the named person, nothing else can count.

## Decision

- **The wait is recorded for a person's pull request too.** `awaitPeople`
  records `review.person_awaited` for a pull request with no issue, as
  `issue: null`. It also records the pull request's author, `{ login, id }`,
  as GitHub says at the time. Needs you shows the same held-approval card,
  with the crew's reviews and the paths, on the pull request's own card
  (`repo#pr`). The board's card says it waits on that person, not on the
  reviewers.
- **When the awaited person is the author, they sign off from the card.** The
  card's button is Sign off (`decision.signOff: 'author'`). The checks are the
  ones Approve already makes:
  - the console person's linked account id is the awaited login's;
  - a fresh device code is approved by that same account, which is not a crew account;
  - the head has not moved.

  Two checks are added: GitHub says that account opened the pull request, and
  People has Approves on for it. Nothing is posted to GitHub. The bridge writes
  one row in `person_sign_offs`, then audits it as
  `pull.human_review_signed_off`. If that audit row cannot be written, the
  sign-off row is deleted and the person is asked to try again. The console's
  approve route is the only writer of that table.
- **The gate and the merge count it, for that author only.** A sign-off row
  counts only when its account id is the pull request author's, and the author
  is not a crew account. It counts as that author's approval for their own
  login, on the head or on an earlier head with the same diff. It is never
  counted through a head a conflict resolution carried. Write access is still
  asked of GitHub. With no row, the pull request holds, whoever opened it.
- **A new diff asks again**, as a person's GitHub review does (`sameDiffAs`).
  The merge line's update from the base moves the head without changing the
  diff. A sign-off pinned to the exact head would have asked the author again
  after every such update.
- **When the awaited person is not the author**, the card is for information
  only (`decision.signOff: 'github'`): Discuss and a link to GitHub, with no
  Approve or Reject. The bridge refuses an approve from it with 409. They
  approve on GitHub, as before.
- **A crew pull request is decided exactly as ADR 0036 says.**

A reader of GitHub will not see this approval as a review. It is seen in the
audit log and in `person_sign_offs`, and the merge line's landing record marks
it `signedOff`.

## What this rules out

- **A platform event as the record.** Anything that records platform events
  could write one, and the gate would read it alongside the rest.
- **The audit row as the record.** The audit log would become a merge-gate
  input, and a write that failed would silently drop the approval.
- **Authorship as the approval.** Opening the pull request is not reviewing
  it. The sign-off is a separate, deliberate act, proved by a device code.
- **A console sign-off for a named person who is not the author.** GitHub
  takes their review, so the console offers no second path for them (decided
  at intake on #322).
- **Reject on a person's own pull request.** There is no builder to send it
  back to.
- **Pinning the sign-off to the exact head.** The author would be asked again
  after every base update that changed nothing they approved.

## What would make this worth revisiting

- GitHub letting a pull request's author approve it, or letting an app record
  an approval its rulesets count as the author's. Then the sign-off can be a
  GitHub review again, as ADR 0036 wanted.
- A repository's own rulesets requiring the named person's GitHub review. A
  sign-off satisfies OpenADLC's gate but not GitHub's, and the pull request
  would hold on GitHub's rule instead.
- People wanting a console sign-off from a named person who is not the author.
