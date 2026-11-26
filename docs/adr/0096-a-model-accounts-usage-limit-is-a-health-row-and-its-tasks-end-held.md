# 0096. A model account's usage limit is a health row, and its tasks end held

- **Status:** accepted
- **Date:** 2026-11-26

## Context

On 2026-11-25 a shared Claude account answered every session with "You've hit
your org's monthly spend limit … your weekly limit resets 11am (UTC)". The
engine exits 1 before anything reads that, so every task on the account was
written `failed`. 32 tasks failed on 12 issues in about an hour. Three leases
each without a pull request (`attemptsWithoutPullRequest`) parked nine issues
`needs-triage`. When the limit lifted nothing started again, because
`retryAfterRecovery` leaves a model account's failures to a person. The crew
stood still for about a day.

A limit is the account's state, not the task's failure. Two things had to be
settled: where the hold on an account is recorded, and what a task that ran
into it ends as (#395).

## Decision

- **The hold is the health row `model-limit:<accountId>` and nothing else.** A
  person chose this on #395 over a table of its own. No table is added.
  - **Opened only by a task's end.** The task state route matches the runner's
    reason with `usageLimit` (`apps/bridge/src/usage-limit.ts`) and calls
    `HealthRegistry.raise`. That goes through the registry's chain and
    `nextRow` like a check run. A raise on an account already held keeps its
    `failingSince` and `facts.since`, so a second hold cannot exist.
  - **Cleared only by a passing check of the account.** The `model-limit`
    check (`apps/bridge/src/health/checks/model-limit.ts`) runs the account's
    one-line prompt with the session's credential (`verifyModelAccount`), or
    counts a person's Verify that passed after the hold began.
  - **Read like the other blockers.** `holdFor` (dispatcher), `blockersOf`
    (`TaskService.open`) and `retryAfterRecovery` treat this row the way they
    already treat `bot-sign-in`, `bot-access` and `hostd`. `holdFor` and
    `blockersOf` read it under scripted engines too, because the limit comes
    from the engine's own output, not from GitHub.
- **A task that ends on a recognised limit ends `held`.** Migration 0176
  widens `tasks.state` to allow it.
  - **Its reason** is the bridge's own words, `held on model account <id>:
    <words>`, which is how the recovery names the row it waits on.
  - **It is an end.** `held` belongs to `TASK_ENDINGS`, and it is never written
    over `done` or `failed`. Stop on a held task drops it.
  - **It parks nothing.** `attemptsWithoutPullRequest` does not count it, and
    the board puts up no failure card for it: the account's card stands for
    every task held on it.
  - **It starts again by itself.** The recovery reads held tasks without the
    board's seven-day window. It starts one when its seat's account has no
    failing row, and either that row was put right after the task ended, or
    the seat now thinks with another account. The task it starts is not
    claimed, so a task held again is started again the next time the account
    works.
- **A reset time only schedules the check.** One message can name a weekly
  limit that resets next to a monthly spend limit that does not. So the reset
  time, when the message gives one, is when the check runs next. With no reset
  time, or once that time has passed, the check runs every 15 minutes.
- **The card's link is shown only for a provider's own host.** The link must be
  on `claude.ai`, `console.anthropic.com`, `platform.openai.com`,
  `chatgpt.com` or `console.x.ai`. Otherwise the card points at the model
  accounts step. A link copied from engine output is never put on a card
  otherwise.

## What this rules out

- **A `model_account_holds` table.** The card, the dispatcher and the recovery
  would each read it beside the health row, which makes two records to keep in
  step. The row already survives a restart. Health rows are not backed up, so a
  restore cannot bring back an old hold either: a restored held task is started
  once its account has no failing row.
- **Clearing a hold at its reset time.** The incident's message named a monthly
  spend limit beside the weekly reset. A clock alone would have restarted every
  held task into the same wall.
- **Treating a per-minute rate limit as a hold.** A bare 429 or
  `rate_limit_error` stays a failure. Holding every seat on an account for a
  limit that clears in seconds would stop the crew for nothing.
- **Keeping a held task as a live paused task.** A paused task keeps its
  computer and its lease while the limit lasts, which can be weeks. A held task
  gives both back, and the recovery starts a new one, within each seat's tasks
  at once.

## What would make this worth revisiting

- A provider that reports a limit in a way `usageLimit` cannot recognise
  reliably from the engine's exit text, such as a structured status that
  hostd should pass on instead.
- A cheap call that shows a limit before a task runs into it. That would let
  the check open a hold as well as clear one.
