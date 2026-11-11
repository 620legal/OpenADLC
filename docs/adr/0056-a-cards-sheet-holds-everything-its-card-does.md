# 0056. A card's sheet holds everything its card does

- **Status:** accepted
- **Date:** 2026-11-11

## Context

A Needs-you card shows its face. **Show more** opens a sheet that is meant to
hold the rest. On a pull request held for a person's Human-review approval, the
owner found the sheet showing less than the card (#305). The card drew
`HumanReviewDecisionPanel`: what the change does, why the person is asked, the
reviews and the diff, with Approve, Reject and Discuss. The sheet drew none of
that, only `item.detail`'s bare why, and a link to GitHub. A held merge
(`HeldMergePanel`) and a held promote (`HeldPromotePanel`) had the same gap.
The title was also cut to one line in the sheet, which has room for it.

Each panel kept its own `step`, `busy`, `error` and `done`. The Radix `Dialog`
unmounts the sheet's content when it closes. A second, independent copy in the
sheet would therefore start an Approve's or a Merge's device-code sign-in that
only it knew about. Closing the sheet would lose the code and stop the polling,
while the card underneath still offered Approve for the same head.

## Decision

- A Needs-you card's sheet draws everything the card's face does, and never
  less. It may add to the face:
  - a held approval's, merge's or promote's panel, with each review whole
    rather than cut to three lines;
  - the title, wrapped rather than truncated.

  The card's face is unchanged.
- A decision panel drawn in both places shares one state, owned by the card.
  - `NeedsCard` calls `usePanelState()` once and passes it to both copies.
  - The sheet's copy is `full`: whole reviews, and no polling.
  - The card's copy polls a sign-in, because it stays mounted when the sheet
    closes. A sign-in started in the sheet is read to its end, and never twice.
  - A panel given no state keeps its own, so other callers are unaffected.
- The sheet hides `item.detail` where a panel is drawn, as the card does, so
  the why is not said twice.
- A held approval with any review summary has a Show more (`hasMore`), so its
  whole reviews can always be reached.

## What this rules out

- **Two independent panel copies.** It is the smallest diff, but the card and
  the sheet would disagree on whether a decision is under way. A sign-in
  started in the sheet is lost when it closes, and the same head could be
  approved twice.
- **Drawing the panel only in the sheet, with the card linking to it.** The
  card would show less than it does today.

## What would make this worth revisiting

The sheet ceasing to unmount when it closes, or a panel's state moving out of
the component, for example into the bridge's flow record. Either would let each
copy own or read the state without a card holding it.
