# 0027. The board by state is grouped in the console

- **Status:** accepted
- **Date:** 2026-11-02

## Context

The board groups cards by stage, and a person reading it had to read every card
to see what was running, what waited on them and what was idle (#226). A view by
state needs what a card waits on, which the board already sends (`active` with
`since`, `waiting`, `waitChain`, `costUsd`), and what waits on the person, which
is in the Needs-you items the page also reads (`attentionItems`), not on the
board. `Board.waitingOnYou` is a count of open gates (`openGates.length`), not a
set of cards: a merge held for a person, a stalled review and a failed task are
Needs-you items and are not gates.

## Decision

By state is computed in the console, from the board and Needs-you reads, with
nothing stored (`stateOf` and `stateColumns`, `apps/console/src/lib/board-state.ts`).
It groups the cards By stage draws (after the moves in flight, the text filter
and Done's week) into four columns. A card goes in the first that fits:

1. **Needs you**: a waiting work-group Needs-you item, other than
   `plan_change_waiting`, whose `subject.ref` or `subject.item` is the card's
   ref, its item key or `repo#prNumber`; or `gateOpen`, unless the card's held
   approval has a non-empty `blockedBy`. This is the set the header's badge
   counts, so the column and the badge cannot disagree.
2. **Working**: a task in `active` is `running`.
3. **Waiting**: any other card not in Done. It keeps the line By stage gives
   it, its wait's root first.
4. **Done today**: in Done, `shippedAt ?? updatedAt` at or after midnight in
   the browser's time zone.

A Done card from before today is in no column.

`GET /v1/board` sends each repository's effective per-task cap as
`repositories[].taskCapUsd`: `effectiveTaskCap(repo.id, costs.perTaskCapUsd)`,
the cap gates enforce. That is the lower of the global task cap and the
repository's own. A Working card says the card's whole spend against it. From
an older bridge, at zero, or where it cannot be read, the card says the spend
alone.

The choice of view is kept per browser under `openadlc.board.view` and read
after mount, so the server always draws By stage.

## What this rules out

- **A `state` on each card from the bridge.** That would put a person's view
  into the board contract, and the bridge would still need the Needs-you items
  it builds in a separate read. The console has both already.
- **Needs you from `Board.waitingOnYou`.** It counts gates, and would miss
  every Needs-you item that is not one.
- **The global task cap alone.** A repository with its own $5 cap would show
  "of $15" while its tasks stop at $5.
- **Keeping Done's week in By state.** By state is about now; the week is
  still in By stage.

## What would make this worth revisiting

The bridge starting to group cards for another reader, such as `openadlc watch`
or a notification, which would then disagree with the console's rule. Or a
per-task spend on cards, which would compare better with a per-task cap than
the card's total does.
