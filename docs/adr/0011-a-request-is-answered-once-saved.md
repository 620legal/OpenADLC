# 0011. A console request is answered once it is saved, and its triage starts after

- **Status:** accepted
- **Date:** 2026-10-23

## Context

#134: sending a new request from the console kept the New request dialog on
"Sending…" until intake's triage session had been prepared and started.
`POST /v1/requests` wrote the request, claimed its files, and then waited for
the request queue's drain, which waited for `TaskService.open`. That takes
seconds. The bridge already had `Afterwards`, which Try again on a task and
Stop use to answer once the decision is in the database and do the slow part
after.

The route cannot know whether its request will start until the drain has run.
Another bridge may start or claim it, intake may fill up, or a start may be
refused. So an answer given before the drain is a prediction.

## Decision

- With an `Afterwards`, as `main.ts` always gives one, `POST /v1/requests`
  answers from the saved row. Everything that refuses still refuses before
  the row is written. The drain (`queue.drain()`) runs after the answer,
  through `Afterwards`.
- The answer is a prediction read before the drain. It is 202 with
  `queued`, `position` and `paused` when the request will wait: work paused
  in the install or its repository, the intake seat paused, intake with no
  room, or a request ahead of it that the queue's walk would start first.
  Otherwise it is 200 with `task: null, starting: true`. It never carries a
  task it has not read, and the console words `starting` as "Intake is
  starting on it", never as started.
- A drain that fails after the answer leaves the request queued, or claimed
  and put back by the next drain's `recover`, for the sweep. The failure is
  said on the request's thread and in the log.
- `AfterWhere` gains an optional `thread: { botId, repoId }`. When the subject
  has no thread yet, `threadOf` makes the one its task will write to, so a
  failure on a brand-new request reaches the person and not only the log.
- Without an `Afterwards` (tests that build the API without one) the route
  waits for the drain and answers with the task, as before.
- Try again on a request's triage (`POST /v1/requests/:id/triage`) still waits
  for the start. A person pressed it because a start failed, and the answer
  is what tells them whether this one did.

## What this rules out

- **Racing the drain against a short timeout.** In the common case it still
  waits on the slow part, and it adds a second path to the answer.
- **Always answering 202 queued, at place 1.** That says "Queued" when intake
  is free and starts the request at once, which is wrong in the other
  direction.
- **Calling `triageFromQueue` after the answer.** It swallows what the drain
  throws, so `Afterwards` could not say the failure anywhere.

## What would make this worth revisiting

Starting a triage becoming fast enough, around the time of saving the request,
that waiting for it costs nothing. Or the console needing the started task in
the answer itself, for example to open its session straight away.
