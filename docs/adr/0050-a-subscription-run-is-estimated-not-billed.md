# 0050. A subscription run is estimated, not billed

- **Status:** accepted
- **Date:** 2026-11-10

## Context

A run on a subscription seat (Anthropic, OpenAI or xAI) costs no money per
call. OpenADLC priced every run at API prices and held all of it to the
per-task cap, the monthly, bot and provider limits, the leasing budget and
`cap_warning`, so an install on subscriptions was stopped and warned about
money it was not spending. Its estimated cost is still worth showing, and a
looping task still has to end: the person who filed #285 fixed the guard at
10× the per-task cap, which no task so far has come near (the largest was
about $36 estimated).

## Decision

- **hostd decides whether a run is billed, from the credential, at every
  session start**, and writes it on the task (`tasks.billed`) before the
  session's env is returned. It is false only on a subscription account; a
  key account, the per-bot key, a scripted run and anything unread are billed.
  The bridge copies it from the task row onto each ledger row it writes; the
  session never reports it.
- **The ledger has a `billed` column**, default true, so every row written
  before this change counts as billed and past spend does not move.
  `tasks.unbilled_usd` keeps the part of a task's cost that was an estimate,
  for its card.
- **Caps and warnings sum billed rows only.** The month sums in
  `packages/db/src/store/costs.ts` take `'billed'` (the default) or
  `'estimate'`; `refreshBudget`'s spent figure, which the leasing budget and
  `cap_warning` read, is billed alone, and the estimate is carried beside it
  (`BudgetState.estimateUsd`, `LimitFigure.estimateUsd`, a card's
  `estimateUsd`).
- **A subscription task stops at a runaway guard of its cap plus nine steps**
  (`TaskService.stopAtUsd`): 10× the per-task cap when it starts. It is
  additive, so a "continue for another $15" on the same cost-cap question
  moves the guard by $15. `/usage` and `/headroom` answer `cap` as where the
  task stops, and `billed`; the runner asks at that `cap`.
- **The Costs page's breakdowns by bot, repository and day count every row**,
  so an install on subscriptions still sees what its work cost.

## What this rules out

- **The bridge reading the bot's account at every usage report.** A bot
  moved to another account while a session runs would flip the flag for a run
  still on the old credential.
- **The session reporting `billed`.** It could turn off its own cap.
- **A guard of 10 × the task's current cap.** A $15 continue would move it by
  $150 while the question says $15.
- **No limit at all on a subscription run.** A loop would use up the plan's
  quota for every bot on the seat, with only the provider's rate limit to
  stop it.
- **Keeping the $15 cap on subscription runs.** It stops normal work for
  money that is not spent.

## What would make this worth revisiting

A subscription that bills per call past an allowance (an overage), which
would make some subscription runs spend; or a task whose real work routinely
reaches the guard, which would make 10× the wrong multiple.
