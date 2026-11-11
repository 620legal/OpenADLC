# 0058. A held approval that's someone else's waits on others

- **Status:** accepted
- **Date:** 2026-11-11

## Context

A held Human-review approval can reach someone who cannot decide it. For
example, it reaches the approvers when the named person is not in People
([ADR 0057](0057-a-held-approval-says-why-it-came-to-the-approvers-and-anyone-may-remind-the-person.md)).
On their card:

- The headline "Pull request #N waits for @x's approval" wrapped to two lines,
  while the item's own title was cut to one.
- It said the same thing three times: the headline, "Why you are asked" and
  `decision.notYours`.
- It said "Why you are asked" to someone who was not asked.
- It made Review it on GitHub the dark main button.
- It drew Discuss as a bordered box holding a paragraph, which read as a
  disabled field.
- It counted as theirs in Work's count and the header's badge, and it was
  pushed to them as theirs (#308).

The owner chose a **Waiting on others** list that is not counted, so the badge
counts only what the viewer can act on. They limited it to held approvals:
other kinds of item stay as they are.

`decision.yours` is false for three reasons (`HumanReviewDecisions.mayDecide`):

- 403: the viewer's linked account is another one.
- 409: the viewer has not linked an account, so they may be the named person.
- 503, or the lookup threw: GitHub could not be asked.

## Decision

- **Only a 403 waits on others.** `forViewer` sets `decision.waitsOnOther:
  true` only when `mayDecide` answers 403. `MayDecideOn`'s result carries
  `status`. An unlinked viewer, or one whose lookup failed, keeps the item
  counted, with its `notYours` line, as before.
- **One place leaves it out.** The console's `waiting()` (`attention-card.ts`)
  and `waitingCount` (`api.ts`) leave out `decision.waitsOnOther`. Work's tab
  count, the header's badge and split, the board's strip, desktop alerts and a
  board card's "needs you" mark all go through them, so they agree.
  `othersWaiting()` returns those items. The Work tab lists them below the
  viewer's own items, under a **Waiting on others** heading, with the line
  "Decisions that are someone else's. They are not counted in Needs you."
- **It is not pushed to people who cannot decide it.** `WaitingNotices` skips
  a held approval (`decision` set) whose audience is known and is not `for:
  'person'`, which means the approvers or everyone fallback. It is left
  unrecorded, so it is sent once it routes to the person. A local install, which
  routes nothing, is sent as before. So is a held merge on the approvers.
- **The bridge writes `whyWaits` beside `why`.** It is the same reason with the
  person as they / them / their, for both `approval:` and `approve-again:`. The
  card that waits on someone else reads "Why it waits: " and that text, falling
  back to `why` against an older bridge, and draws no `notYours` line. GitHub's
  request line names them as "them" there too, so the person is named once, in
  the status line. The bridge's `headline`, `detail` and `actions` do not
  change: push text and older consoles read them.
- **A held approval's card leads with its title.** The `<h3>` is the subject's
  number and whole title, never truncated. Under it, `decisionStatus` says
  "Waits for @x's approval" or "Waits for your approval" (with "again" when an
  approval is asked for again), beside the repository badge and the age. The
  sheet draws the same title and line
  ([ADR 0056](0056-a-cards-sheet-holds-everything-its-card-does.md)).
- **The order of the buttons.** Someone else's card has Remind, then Discuss.
  The named person's card has Approve, Reject, Discuss. Discuss is a plain
  button whose accessible name is "Discuss", with its one-line hint tied to it
  by `aria-describedby`. `next.discuss` opens the form it shows. Review it on
  GitHub follows as a secondary button on every held approval's card.

## What this rules out

- **Keying on `decision.yours === false`.** It moved an unlinked named person's
  own approval out of their count. It also hid any approval for a refresh when
  GitHub's user lookup failed.
- **Filtering others' items out of `GET /v1/attention`.** That breaks ADR
  0036's rule, "an annotation, never a filter". The viewer would also lose
  sight of what they can Remind or Discuss.
- **Having the console strip `@login` out of `why`.** Rewriting the bridge's
  prose in the browser breaks the first time the sentence changes.
- **Waiting on others for other kinds** (a bot's question for another role, a
  gate for the admins, a held merge). Intake settled it for held approvals
  only.

## What would make this worth revisiting

Other kinds of item reaching people who cannot act on them often enough that
the badge again counts what they cannot do. A general "is it yours" rule in the
audience code would then replace `waitsOnOther`. A second reason to revisit is
`mayDecide` gaining another answer that means "someone else", which would have
to set `waitsOnOther` too.
