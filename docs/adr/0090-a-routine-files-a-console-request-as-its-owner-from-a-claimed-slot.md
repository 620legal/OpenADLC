# 0090. A routine files a console request as its owner from a claimed slot

- **Status:** accepted
- **Date:** 2026-11-26

## Context

People wanted to ask the crew for the same work on a schedule: a weekly
dependency review, a nightly docs-drift check, a Monday report (#369). The
scheduler (`SCHEDULED_JOBS` in `apps/bridge/src/scheduler.ts`) ran only the
bridge's own jobs, so nobody could.

A schedule that files work has to hold up to what the bridge already
does: it restarts, it can be down for days, two of its ticks can overlap,
and intake can refuse a request. Whatever it files must go through intake,
gates, caps and leases unchanged, in the name of someone who may ask for it.

## Decision

- **A routine is a row** in `routines` (migration 0174): repository, text,
  details, kind, cadence (`daily`, `weekly` with an ISO weekday, `monthly`
  with a day 1–31), time of day, IANA time zone, paused flag, owner, created
  and updated, next run, last run (time, request, outcome) and last skip
  reason. `next_run_at` is null exactly when paused. A repository removed
  takes its routines with it.
- **The slot is claimed before the filing.** A `routines` job runs every
  minute through `job-timer.ts` (`OPENADLC_JOB_ROUTINES_MINUTES`). For each
  due routine, `RoutineService` (`apps/bridge/src/routines.ts`) moves
  `next_run_at` to the first slot after this minute with a conditional
  update (`claimSlot`, `… where next_run_at = <the slot read>`). Only the tick
  whose update finds the slot fires it. One claim is one firing: a missed
  stretch fires once on the first tick after start; a skip spends its slot;
  a bridge that stops between the claim and the filing loses that slot rather
  than doubling it; a filing that fails is recorded, not retried every minute.
- **It files through `fileRequest`**, the function `POST /v1/requests` uses,
  given to the service by `registerConsoleApi`, as the owner's console
  identity, with the routine's repository, text, details as context, and
  kind. The routine's id is a separate, server-side argument that
  `createRequest` writes to `requests.routine_id`; the route never passes it,
  so no request body can mark a request as a routine's. Deleting a routine
  clears the pointer and keeps every request it filed.
- **The owner is whoever last created or edited it.** Create and edit make the
  caller the owner (`owner_identity`, `owner_login`, `owner_github_id`);
  pause, resume and delete do not. Changing a routine takes a linked GitHub
  account whose person has Approves on (`personByGithubId(id)?.approves`,
  read as release's cut reads it); the routes are `user` in `roles.ts`.
- **Skips, in order:** work paused (`DispatchGate.paused(repo)`); the monthly
  budget `stopped` with `costs.onCap.stopLeasing` on; the owner's Approves
  off or the owner absent from People, re-read at every firing so the
  routine resumes when it comes back; the last request still open. Open is
  ADR 0078's meaning, read from the bridge's own records with no GitHub
  call: `queued`, `draft` or `questions`, or `filed` with an `issue` or
  `pull` link of its work item `open` in `work_item_links`, or with an issue
  the board has no link for yet.
- **Wall clocks are computed with `Intl`**, no date library
  (`nextRunAt` in `packages/shared/src/routines.ts`): a monthly day a month
  lacks falls on its last day; a time a spring change skips is read with the
  offset before the change, so it runs the gap's length later; a time an
  autumn change repeats runs once, at its first occurrence.
- **Templates:** weekly dependency review, nightly docs-drift check, Monday
  project-health report, and Blank. Routines only file requests.

## What this rules out

- **A routine id in the body of `POST /v1/requests`.** The route hands its
  body to `fileRequest`, so any user could mark any request as a routine's.
- **One timer per routine, or a cron library.** A timer held in memory is lost
  on restart, and a cron library is a new dependency. A one-minute sweep of
  an indexed `next_run_at` survives a restart and makes catch-up the same
  rule as a normal run.
- **Firing once per missed slot after downtime.** A week away would file a
  burst of identical requests, each of which the open check would then skip.
- **Filing as the creator after someone else edits it.** A routine would file
  text in the name of a person who did not write it.
- **A Discover template.** A Discover run (ADR 0089) starts only from
  `POST /v1/repos/:name/discover`; a request asking for one would make intake
  file an issue for the crew to build. It was left for a later request,
  answered on #369.

## What would make this worth revisiting

- A cadence finer than a minute, or more routines than one indexed read a
  minute serves.
- Losing a slot to a crash between the claim and the filing proving costlier
  than an occasional double request.
- A firing that should start something other than a console request, such as
  a Discover run, which needs a second firing kind.
