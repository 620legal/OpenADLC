# 0008. A close stops the tasks paused on it, at the close only

- **Status:** accepted
- **Date:** 2026-10-21

## Context

Intake for #46 (task 28ac028c) paused on a question. #46 then merged as #61
while the bridge was down, and the reconciler moved #46 on (`mergeUnheard`).
Nothing stopped the intake, so its computer, `task-28ac028c`, kept running. The
person's **Stop** answered 409, "that task is waiting on a question".

The pieces existed already. `stopTask(…, { unfinished: true })` cancels a task
in hostd, which takes its computer down. It also closes the task's questions
and releases its lease. Two things were missing: who calls it, and what a
person's Stop allows. Every merge path stopped only builds (`stopBuildsOf`) and
reviews (`stopReviewsOf`). An abandon (`stopWorkOf`) stopped every other kind
except deploys. The Stop route refused a task with an open question.

The person asked which paused tasks a close should stop and chose all of them,
deploy and QA included. A merge is also where a deploy or QA task's work starts,
and such a task may ask after the merge ("testing failed, what next?").

## Decision

- **The trigger is the close.** An issue or pull request can close merged or
  not, heard by delivery or found by the reconciler. At that moment, every task
  paused on it, or on the issue's pull request, is stopped, deploy and QA
  included (`Webhooks.stopPausedOn`). The one exception is a task of the
  account that closed it, as `stopWorkOf` already spares it: the SRE closes a
  failed deploy's issue and then sends the change back. A task started after
  the close, by the delivery's `closed_at`, is not the close's: a late or
  resent delivery leaves the QA asking on the merged pull request alone.
  Queued and running tasks keep the rules they had.
- **The thread is told once.** One comment per subject, as the automation
  account, names what was stopped. It is posted only for a task this close
  actually stopped (`stopTask` returns `stopped: true`). Concurrent deliveries
  of one close are deduplicated in-process, so a redelivery, or the issue's and
  the pull request's deliveries together, say nothing twice.
- **A person's Stop ends a task waiting on a question.** `POST
  /v1/tasks/:id/stop` no longer refuses one. Every stop closes the task's
  questions unanswered (`expireGatesOfTask`), so an answer resumes nothing, and
  a question's card offers **Stop**. An answer that claimed its question just
  before the stop does not start the task again: the resume looks at the task
  just before hostd is asked (`TaskService.resumeNow`). `needs-human` comes off
  as an answer would take it off.

## What this rules out

- **A sweep of paused tasks on subjects that are already closed.** It would
  also stop a deploy or QA task asking, legitimately, after its merge, because
  the merged pull request it is about is closed. A stop is taken only when a
  close is seen. A stop that fails then, because hostd is down, is logged and
  not tried again. Tasks left paused on issues that closed before this change
  are not swept either: a person stops them from their question's card.
- **Having `stopTask` post the comment.** The stops for one close would comment
  once per task, and a person's Stop on the console does not need a GitHub
  comment.
- **Stopping tasks on a console request** (`subjectType: 'request'`). Their
  subject is not the issue that closed.

## What would make this worth revisiting

A task that pauses after a close and should still be stopped by it, which
would need a sweep that can tell such a task from a deploy or QA task asking
after its merge. Or a lost stop, from hostd being down at the close, turning
out to be common enough to need a retry.
