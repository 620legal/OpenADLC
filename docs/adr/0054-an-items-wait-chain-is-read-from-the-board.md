# 0054. An item's wait chain is read from the board

- **Status:** accepted
- **Date:** 2026-11-11

## Context

A waiting card on the board says one thing: the end of its wait, followed to
its root (`followWaits`, ADR 0023, #221), with "N items wait behind it" and a
button to the root. The steps between the card and that root were not said
anywhere, so a person who opened the card's item could not see why it was not
moving (#296).

The chain is built in `withWaitChains` (`apps/bridge/src/board-work.ts`)
inside `readBoardWork`, from inputs the `/v1/board` handler in
`apps/bridge/src/api.ts` gathers: issues, links, cards, lone and loose pulls,
requests with their positions, gates, sessions and `waitingReads`. A chain's
`behind` counts every card on the board whose chain ends at the same root, so
it is a fact about the whole board, not about one card.

## Decision

`GET /v1/items/:subject` carries `waitChain`, taken from the all-repositories
board read: the board handler's read is one closure, `readBoard`, and
`waitChainOf(ref)` looks the item's card (`repo#n`) up in what
`readBoard(undefined)` gives. The read is not made for an item with no issue
on the board, nor for one in Done, nor for one with no repository
(`itemWaitChain` in `apps/bridge/src/items.ts`). A read that fails is no chain,
as on the board.

The sheet draws it as "Why it isn't moving", one line per link and a line for
the end (`waitSteps` in `apps/console/src/lib/card-status.ts`). It offers a
root button only on a person end. The button is the board's `rootButton`: the
board passes its own, so it has the label and destination the card has. A
`dead`, `deep` or `self` end gets the board's words and no button. That
narrows the board on purpose: a board card also offers "Open #N" on a dead
end.

## What this rules out

- **Following the wait from the item alone.** It would duplicate
  `withWaitChains`' inputs, and its `behind` would not be the board's, so the
  sheet and the card could disagree.
- **Narrowing `readBoardWork` to one card.** `behind` needs every card's
  chain.
- **One repository's board.** It would undercount `behind` for a root that
  cards in other repositories wait on.

It costs one board read for each item read of an item that waits and is not
done.

## What would make this worth revisiting

The board read becoming expensive enough that an open sheet, which reads its
item again on every change, slows the bridge. If that happens, cache the
board's chains rather than follow the item's own. Or the board reading less
than every repository's cards, so that the all-repositories read is no longer
the one whose `behind` the board shows.
