# 0043. No review seat starts while its builder works on the pull request

- **Status:** accepted
- **Date:** 2026-11-10

## Context

On #257 on 2026-11-10, a person's message started a builder round. It ran
from 05:45 to 05:47 and from 05:56 to 05:58. During both runs the lead
reviewed the head that the round was about to replace, so that review was
paid for and then thrown away.

Review tasks start from several places:

- the `opened`/`synchronize` delivery's seat loop;
- `openMissingReviews` (the gate sweep and the stage hand-off);
- `openLeadReview` (a seat finishing, the sweep, a conflict resolution);
- `askAgain` (a dismissed review);
- a person's message to a reviewer.

Every one of them goes through `TaskService.openNow`. A person's hold
(`heldWords`) and the closed-pull-request read already hold review starts
there.

## Decision

- **What holds a review.** `openNow` refuses a task of kind `review` with
  `BuilderWorkingError` (409) while the pull request's builder is working on
  it (`builderOn`). The builder is working when one of these is `queued` or
  `running`:
  - a `patch` task on the pull request (`repo#pr`): a review-loop round, a
    round a message started, or a conflict-resolution round;
  - an `implement` task on the issue the pull request closes, whose branch is
    the pull request's head.
- **What does not hold.** A `paused` builder does not hold reviews: it may wait
  on a person for days, and the head it left can be reviewed. A read of the
  tasks table that fails holds nothing, as a hold's read does.
- **Where it is read.** The hold is read from the tasks table at each start.
  Nothing is stored, so it survives a restart and needs no timer.
- **Callers.** `openMissingReviews`, `openLeadReview` and `askAgain` check the
  hold early and return nothing. They log it once per builder task, so the
  ten-minute sweep is quiet. `askAgain` still records `REVIEW_ASKED_AGAIN`
  first.
- **The push.** The delivery's seat loop treats the error as expected. The push
  still records its round (`REVIEW_ROUND_OPENED`) and sets the gate.
- **A person's message.** A message to a reviewer is answered "nothing starts"
  with the builder's words.
- **Running reviews.** A review already running when the builder starts
  finishes. Only new starts are held.
- **The release.** When a `patch` or `implement` task becomes `done`, `failed`,
  `stopped` or `paused`, the task-state handler calls
  `StageHandoff.builderEnded`. It runs after `onTaskDone`, so a patch round's
  card is back in Review first. `builderEnded` finds the pull request: the
  patch round's subject, or for a build, the issue row's pull request, open on
  the build's branch. It then reads the head from GitHub:
  - on a lead-only conflict resolution pushed as that head, it asks the lead
    to re-check with the resolution's brief;
  - otherwise it runs `backToLead`. After a push, every seat before the lead
    is unasked on the new round. With nothing pushed, the lead decides again.
- **`patchDone`.** It only moves the card back to Review, so the seats are not
  asked twice.

## What this rules out

- **A check at each caller** (webhooks, scheduler, message starts, the three
  `TaskService` methods). That is six places to keep in step, and the next
  start path would miss it. `openNow` is where every review start already
  passes.
- **Stopping running reviews when a builder starts.** The issue says they
  finish. Stopping one throws away paid work, which may still be valid when the
  builder pushes nothing.
- **A recorded "held" event and a timer to release it.** The tasks table
  already says whether the builder is working, and the bridge already handles
  the end of its task.
- **Holding patch rounds behind running reviews.** The hold goes one way only.
- **A change to `mergeDecision`, the gate's state or description, or the
  round-recording rule.** While reviews are held, the gate still says
  "waiting on" its seats, which is true.

## What would make this worth revisiting

- A builder task that ends without the bridge hearing it, which happens often
  enough that the gate sweep's ten minutes are a real wait. The sweep reads
  the same table and asks the seats once the builder is no longer queued or
  running.
- Reviews that should run beside a builder on purpose, such as a seat that
  reviews only files the builder cannot touch.
