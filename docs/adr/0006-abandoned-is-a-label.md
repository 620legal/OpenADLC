# 0006. An unmerged close is Done, labelled `openadlc:abandoned`

- **Status:** accepted
- **Date:** 2026-10-21

## Context

An issue that someone closed on GitHub without its change merging stayed on
the board. On the webhook path its row kept its column. The reconciler forgot
it at its next pass, so its card left the board. A crew pull request closed
unmerged left its issue's card where it was. Either way the issue's Needs you
cards stood for work that was gone. A "Review stopped without agreeing" card
for #15 stayed after #15 was closed, because the reconciler had already
forgotten #15's row.

The person who asked decided three things. Such a card goes to Done, and its
Needs you cards clear. A pull request closed unmerged closes its issue as not
planned. An issue that depends on one closed this way does not start.

Done meant shipped. `dependencyIsSatisfied` (`packages/shared`) reads Done as
shipped however the card got there, and the dispatcher, the stage handoff and
stacking all call it. So the board has to record whether a card reached Done
by shipping or by being abandoned. A person chose how, from three options.

## Decision

- An unmerged close moves the card to Done with the label `openadlc:abandoned`
  (`ABANDONED_LABEL`). Only the bridge puts it on, and it takes it off when the
  issue is reopened. It is in `config/labels.json`. A repository set up before
  the label existed gets it from `RepoSetup.ensureLabel` on first use.
- Done with that label is not shipped. Every reader that took Done as shipped
  asks `hasShipped` or checks the label instead: dependencies, a stacked pull
  request waiting to join the merge line, design memory accepting a design,
  the board's "N this week", and Insights' merges, which skip a move whose
  reason marks it as an abandon (`isAbandonMove`).
- An abandon is told from a merge by `howClosed`
  (`apps/bridge/src/abandoned.ts`). The issue's own pull request merging
  (`mergedPullOf`) means it merged. Otherwise GitHub's timeline says what
  closed it (`ClosedEvent.closer`, GraphQL): a merged pull request, or a
  commit, means it landed. Anything else means abandoned, whether the close
  says completed or not planned: no closer, or a closer that ships nothing,
  such as a Projects board that closes what reaches its Done column. REST's close event cannot tell: its `commit_id` is
  null for a merged pull request's `Closes #N` too. When GitHub cannot be
  read, nothing moves. A close by a commit with no pull request here is moved
  to Done without the label, and only by the reconciler, so a merge delivery
  still on its way is never overtaken.
- Deliveries race, so a merge that finishes an issue already taken for
  abandoned takes the label off and moves it on from the stage it was
  abandoned from (`takeAbandonOff`).
- The label goes on GitHub first, then on the row, then the card moves. A
  dependent that reads the row between those steps never sees Done without
  the label.
- A pull request closed unmerged abandons its issue only when the issue is in
  Review, the card names that pull request, and a person closed it, not a
  crew account or an app's. The card moves before the bridge closes the issue
  as not planned, so the close's own delivery finds it in Done. Reopening that
  pull request, as a person does to run CI again, reopens the issue and brings
  the card back to Review. Reopening only the issue brings it back to Build,
  where the builder opens a new pull request: Review would review nothing
  while its pull request is closed.
- The tasks on the issue and its pull request stop, but for a deploy task and
  any task of the account that closed it: the SRE closes the issue a failed
  deploy filed and then sends the change back.

## What this rules out

- **A column on `issues` (`abandoned_at`).** It needs a migration, a store
  setter and a change to `dependencyIsSatisfied`'s input and to each caller.
  It shows only on the board, not on GitHub, and is lost when the row is
  rebuilt from GitHub, as a reconcile or a restore does. A label is mirrored by
  the reconciler like every other label.
- **Working it out from what is kept already** (Done, no merged pull request,
  no deploy label). There is no new state, but a missed merge delivery would
  look exactly like an abandon until the reconciler caught it. A dependent
  would be held, or worse, released, on that guess.
- **Forgetting the row, as before.** The card left the board, but its Needs you
  cards stayed, and an issue that depended on it waited on one OpenADLC no
  longer had, with nobody told.
- **Cancel from the board abandoning too.** Cancel still takes the card off
  the board: a person chose to remove it there. Making Cancel leave it in Done
  is a separate decision.

## What would make this worth revisiting

GitHub's REST close event naming the pull request that closed the issue,
which would let `howClosed` do without GraphQL. Or OpenADLC
needing to keep abandoned work in a column of its own rather than in Done,
for instance to count it in Insights: that would be a stage, not a label.
