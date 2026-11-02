# 0023. A wait is followed to its root in both reads

- **Status:** accepted
- **Date:** 2026-11-02

## Context

A waiting card said only the first step of what it waited on: "waiting for a
build slot (held by #217)". On 2026-10-30 four issues sat for hours. #216 and
#214 waited for the build slot. The paused #217 held it, its approved plan
change waiting for files #207 held. #207's pull request was stacked on #206's,
and #206's waited for a person's approval. Only that last step was a person's
to do, and no card said so (#221).

Following a chain needs facts that only the Needs-you read (`readAttention`)
had:

- which open gate is an approved plan change waiting on another lease's
  files, rather than a question;
- the merge line's holds for a person;
- the people a pull request is asked to approve again or waits on;
- OpenADLC's stack holds.

None of the reads had the stacks themselves (`stacks`). The board's read had
the first step of each wait alone (`waitingOf`). A person was asked whether the
board should join what Needs you followed, or follow chains itself. They chose
both reads.

## Decision

The board's read (`readBoardWork`) and the Needs-you read (`attentionItems`)
both follow every waiting card's wait to one root. They do it with the same
reader (`readWaitFacts`) and the same pure functions, all in
`apps/bridge/src/wait-chain.ts`:

- `personWaitsOf` gives the waits on a person. Each carries the id
  `attentionItems` gives the same fact (`gate:`, `merge:`, `approve-again:`,
  `approval:`, `stall:`, `stack-hold:`, `parked:`), and a test holds the two
  to one id.
- `followWaits` gives one chain per card. Of the ends it can reach, it keeps
  person, then dead, then too deep, then clears by itself, with the node's own
  end first on a tie. It stops at `MAX_WAIT_DEPTH` (12) links, and a node seen
  on the path is a loop.

Board cards carry `waitChain`. The root's Needs-you item carries `unblocks`.
Whether a stacked issue still waits on what it was built on is the pure
`stackWaitsOn`, which `Stacking.waitingOn` calls too.

The chain is worked out on each read and stored nowhere. The board reads the
facts only when a waiting card waits on another card or a question is open,
so a quiet board costs no extra query.

## What this rules out

- **Following chains in the Needs-you read alone, and joining them on the
  board** as the board joins `awaitedApprovalsOf`. That costs fewer queries,
  and the two could never disagree, but a card's root would refresh at Needs
  you's pace, not the board's. The person chose that a board card carry its
  own root.
- **Following every branch and listing every root.** The outcome asks for the
  one thing a person can do, and keeping person ends first picks it.
- **A table of wait chains.** Its history would be stale the moment a lease
  moved. A wait is read from the tables it happens in, as `waitingOf` reads
  it.

## What would make this worth revisiting

The board's read growing slow enough that the extra reads matter. That would
mean many open questions or linked waits on every read. It would make the
Needs-you-only option, joined on the board, the better trade.
