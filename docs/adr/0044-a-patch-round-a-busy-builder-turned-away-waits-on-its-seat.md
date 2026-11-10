# 0044. A patch round a busy builder turned away waits on its seat

- **Status:** accepted
- **Date:** 2026-11-10

## Context

On 2026-11-09, on a managed repository, a pull request's `ci` failed after the lead approved it at 21:00:40. The merge line sent it back at 21:00:53. Twenty seconds after the pull request opened, the dispatcher had already leased the next issue to the same builder. So `TaskService.open` refused the patch round as busy (`BotBusyError`).

`openPatchRound` opened every patch round with `whenBlocked: 'record'`. That records a spending cap, an unmet prerequisite and a pending restart, but not `BotBusyError`, `SubjectBusyError` or `HostFullError`. It logged `patch round not started` and returned. Nothing came back for the round:

- `sendBackRed` ignored the result, and the red head was remembered as sent back.
- The merge line waited for the head to change.
- The stage runner restarted only triage and design.
- The recovery ran only recorded tasks.

The send-back comment and the move to Build had both been made before the start, so they said a round had begun. Nothing started it for 21 hours, until a person merged the pull request by hand.

The same shape had already been solved twice: a stage that a busy seat turns away (`stage.waiting_on_seat`, `seat-waits.ts`, `StageHandoff.restoreWaits`), and a conflict resolution round (`conflict.resolving` with `pending: 'busy'`).

## Decision

- **A busy or full refusal of a patch round is a wait, never a drop.** This covers every patch round:
  - CI red after the lead approved;
  - the lead's request for changes;
  - a console Reject;
  - a person's message to the builder;
  - a person's move of the card from Review to Build.

  `openPatchRound` catches `BotBusyError` and its subclasses, but not `RestartPendingError`, which the start already records. It returns `waiting` instead of `refused`. Callers that hand work to someone else when nothing holds it (`Stacking`, the conflict fall-back, the merge line) get `null`, as they do for a started round.
- **The wait is an event, with no table.** It is one `patch.round_waiting` event, in `patch-waits.ts`. The payload carries the pull request, the issue, the builder, the round, who sent it back and on which head, what holds the builder (`busyWith`), and a person's brief (`message.md`).
  - It is not recorded again for the same head, sender, builder and brief.
  - A retry that is turned away again records it once a day, so it stays inside the seven-day window that is read at start-up.
- **When a wait stands.** `standingPatchWaits` says a wait stands until a `patch` task of any skill is created on its pull request at or after it, or until its issue is no longer in Build with that pull request. `since` comes from the first event after the newest patch task, and every other field from the newest event.
- **The send-back says it.** `reviewRound` asks `TaskService.wouldWait` before it comments. That runs the same checks, in the same order, as `openNow` (`busyCheck`: the subject, then the seat, then the hosts). When the round will wait, the comment ends with "**This round is waiting for the builder:** _builder_ is {busyWith}. It starts as soon as builder has room."
  - The card still moves to Build.
  - When a start loses that race, one short comment says the same.
  - `fromMessage` no longer refuses a busy builder. It records the wait with the message as its brief.
- **The `StageRunner` starts it.** `SendBack.startWaiting` runs first in the runner's `start`, and `waitingSeats` joins `waitedOn`. So the wait starts when one of the builder's tasks ends, or within a minute of room. Each start re-reads whether the wait stands, whether the pull request is open, the lease and `maxRounds`, and then says "Review round N started". `SendBack.loadWaits` reads the waits back at start-up.

## What this rules out

- **Recording the busy round as a failed task**, as a spending cap is recorded. That shows a failed card with Try again for something that did not fail. The recovery would run it on its own cadence, not when the seat frees.
- **A `waiting_rounds` table.** It needs a migration, which is the one exclusive path. It would also be a third way of storing the same kind of seat wait, while events already survive restarts for the other two.
- **Holding the dispatcher's new leases while a builder's own pull request waits.** That is a separate policy. The runner's 1 s gather runs before the dispatcher's 1.5 s one, so the builder's own round is normally started first.

## What would make this worth revisiting

- If builders often run several tasks at once, so that a wait rarely happens, the pre-check costs a read on every send-back for little.
- If the dispatcher learns to hold a builder for its own pull requests, rounds would not be turned away in the first place.
