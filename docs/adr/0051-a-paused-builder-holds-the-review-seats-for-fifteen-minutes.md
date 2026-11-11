# 0051. A paused builder holds the review seats for fifteen minutes

- **Status:** accepted
- **Date:** 2026-11-11

## Context

ADR 0043 holds every review start while a pull request's builder is working
on it, meaning a `patch` round on it, or the `implement` task that opened it
on its head branch, while `queued` or `running`. It let a `paused` builder
hold nothing, because a question can wait on a person for days. It also had
the task-state handler call `StageHandoff.builderEnded` when the builder
paused, so the seats were asked on the head the builder left.

On 2026-11-10 that cost a review. A CI failure sent a pull request back to
Build on an unchanged head:

- Two minutes later the builder's round paused to ask for one more path.
- The pause asked the seats, and the lead started its fourth review of that
  head.
- The question was answered within a minute.
- Eight minutes later a fix commit replaced the head.

Most questions a builder asks mid-round are like this one, answered within
minutes, and the round then pushes. The person who owns the decision chose
one fixed window for any question, with no config key (#287).

## Decision

- **The hold.** A paused `patch` or `implement` task holds review starts on
  its pull request for `PAUSED_BUILDER_HOLD_MS` (15 minutes,
  `apps/bridge/src/task-service.ts`) after `tasks.paused_at`, for any question.
  `builderOn` counts it beside a queued or running one, which it names first.
  `openNow` refuses with `BuilderWorkingError`, saying when the hold lets go
  ("… or at HH:MM UTC if it is still waiting"). As in 0043, the hold is read
  at each start, and a failed read holds nothing. A paused task that does not
  say when it paused holds nothing either. This supersedes 0043's "paused
  holds nothing".
- **A pause asks no seats.** The task-state handler calls
  `StageHandoff.builderEnded` on `done`, `failed` and `stopped` only. On
  `paused` it calls `PauseHolds.paused` (`apps/bridge/src/pause-holds.ts`)
  instead, which:
  - records `review.pause_held` (`{ task, pausedAt, until, subjectRef }`);
  - sets one timer per task for the end of the window.
- **The lapse.** When the window ends, `PauseHolds.lapse` re-reads the task:
  - If the task is still `paused` with the same `pausedAt`, it records
    `review.pause_hold_lapsed` (`{ task, pausedAt, subjectRef }`) and calls
    `builderEnded` once, which asks the seats as 0043 describes.
  - If the round was answered and resumed, its end asks the seats.
  - If it paused again, the new pause has its own window.

  A pull request sent back to Build is in no stage the gate sweep settles, so
  without the lapse nothing would ask its seats while a question waits for
  days.
- **Restarts.** `PauseHolds.load` runs at bridge start:
  - It sets a timer for the remainder of each window still open.
  - It lapses at once a pause that has a `review.pause_held` and no
    `review.pause_hold_lapsed` for that task and `pausedAt`.
  - It leaves alone a pause with no `review.pause_held`. Such a pause is from
    before this change and already asked the seats. Leaving it alone means an
    upgrade does not make the lead decide again on every long-paused pull
    request.
- **Unchanged.** `builderEnded` itself, every review start path, and the
  callers' once-per-task logging are as 0043 has them. There is no migration
  (`tasks.paused_at` has existed since 0082) and no config key.
  `TaskRecord.pausedAt` is added as an optional field.

## What this rules out

- **Holding until the question is answered.** A question left for days would
  block reviews for days.
- **Holding only for a path request (`plan_change`).** The person chose any
  question, and a quick question of any kind ends in the same push.
- **A config key for the window.** The person chose one constant. A key would
  also put the change under `config/`'s human review for no gain yet.
- **Releasing from a minute sweep over paused tasks instead of timers.** The
  seats would be asked up to a minute late. The sweep would still need the
  same two events to survive a restart without asking twice.
- **Keeping the pause's `builderEnded` call and relying on `openNow`'s
  refusal.** The refusal would swallow that ask, and nothing would ask again
  when the window lapsed on a pull request in Build.

## What would make this worth revisiting

- 15 minutes proves too short for the common answer to a path request, so
  heads still move under a review started at the lapse.
- Pauses commonly outlive the window while a head is about to move.
- Questions are commonly left for days, and the 15 minutes of held reviews
  become a cost people notice.
