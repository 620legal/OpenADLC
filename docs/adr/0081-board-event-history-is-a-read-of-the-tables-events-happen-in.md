# 0081. Board event history is a read of the tables events happen in

- **Status:** accepted
- **Date:** 2026-11-26

## Context

A person following the crew had to watch the board or GitHub (#374). The
console now has an activity button in its header, with a count of what this
browser has not seen and a panel of recent events, and an Activity page that
pages back 30 days across repositories. Both need history: the live stream
(`GET /v1/board/events`, ADR 0021) starts from now and replays nothing.

ADR 0021 ruled out writers that emit events, and a table they fill. Four
events the console needs were not in the stream: a bot opened a pull request,
the lead approved, a release was published, and a task stopped at its cost
cap. Each of them is already recorded somewhere: GitHub's deliveries in
`events`, and `release_runs`, and the gate a capped task asks.

## Decision

The history, `GET /v1/board/events/history?repo=&bot=&before=&limit=` (a
`user` route), is a read of the same tables the stream polls, through the same
derivation. There are no writers, no table and no migration.

- **One set of sources.** `SOURCES` in `apps/bridge/src/board-events.ts` reads
  each type's rows for a window, and `deriveEvents` turns them into events for
  both the stream and the history. A type added there is in both. `BoardEvent`
  keeps its shape, and new types are additive.
- **The new types**, each read from where it already happens:

  | `type` | Read from | `bot` |
  |---|---|---|
  | `task.capped` | a gate whose options are `costCapGate`'s (`isCostCapGate`) | the task's seat |
  | `pull_request.opened` | `events` rows of `pull_request.opened` by one of the crew's logins, in a managed repository, each pull request once at its first delivery | `whoWrote`'s seat, with the head branch `agent/<seat>/…` as the hint; null on a shared account the branch does not resolve |
  | `pull_request.lead_approved` | `events` rows of `pull_request_review.submitted`, state approved, by a crew login, kept when `whoWrote` with the review's marker names the lead seat | the lead seat |
  | `release.published` | `release_runs` in `published`, timed at `published_at` | null |

  SQL takes only the payload fields an event needs, never the payload.
- **A cost-cap gate is `task.capped`, not `question.asked`.** It is reported
  once; as both, the bell had two rows for one stop. Needs you is unchanged,
  and every other gate is `question.asked` as before.
- **The window, the cursor and the tie rule.** Every read takes
  `{ from, to?, limit? }` and answers newest first, at most `limit` rows plus
  every row tied at the last one's time, compared to the millisecond. The
  history reads each source in batches of `max(limit, 100)`. A batch is
  complete only down to the newest oldest-row time among the sources that
  filled it, so it keeps events down to there and reads on from just below.
  The cursor is opaque, `<at ISO>~<id>`, and events order by `(at, id)`
  descending. Paging with `next` until it is null gives every event since the
  floor exactly once.
- **The floor is 30 days**, from the database's now. Nothing older is read,
  and `next` is null once a page reaches it. `limit` is 1 to 200, 50 by
  default, and a bad `limit` or `before` answers 400 saying what to send.
- **Filters apply to the derived events.** `repo` (a name or a full name)
  keeps events whose `item.repo` is that repository, which hides a request
  filed in no repository. `bot` keeps events whose `bot` is that seat, which
  hides one no seat did. A request older than the newest 200 the facts list is
  read by its prefix, so it still resolves to its repository.
- **A merge-line hold is in the history only while it is held.** It is a state,
  not a row with a time. The history reads entries in `merging` that
  `heldForPerson` names, timed at the row's `updated_at`, under the same id the
  stream gives them, so a client that has both shows it once.
- **The two types read from GitHub deliveries reach back only as far as
  `OPENADLC_EVENT_RETENTION_DAYS`** (30 by default, so the page is full). A
  shorter setting shortens those two alone. A pull request that reconcile
  opened, whose delivery never came (ADR 0077), has no `pull_request.opened`.
  The lead seat is the review's marker's word on a shared account, which is
  enough for a display feed; the merge decision never reads this.
- **Unread is per browser.** The console keeps the newest event time its panel
  showed in localStorage `openadlc.activity.seen`, as it keeps the board's
  view, and never sends it to the bridge. A browser with none starts at zero,
  never the backlog, and every change is announced in the tab
  (`ACTIVITY_SEEN_CHANGED`). The button lists from the history, read when its
  stream opens (and so on every reconnect), when the stream cannot open, or on
  the stream hook's five-second timer where there is no EventSource. The
  stream's events are merged in by id.

This amends ADR 0021's "Replay: history is the board's" point. The stream
itself still starts from now and replays nothing.

## What this rules out

- **A new events table that writers fill.** It reverses ADR 0021: a writer that
  forgets to emit is a feed that quietly stops covering it.
- **Polling the history every few seconds in each tab.** Every open tab would
  run seven reads each time. The shared poller reads once for the install,
  however many people watch.
- **Reading `pull_request.opened` from `review.round_opened`.** That event
  names neither the author nor the seat.
- **Emitting a cost-cap gate as both `question.asked` and `task.capped`.** The
  second row would only repeat the first.
- **Filtering the rows before deriving them.** A filter would then mean
  something other than what the row shows: a request's repository, and an
  approval's seat, are only known once the event is derived.

## What would make this worth revisiting

- The reads showing up in `pg_stat_statements`. `tasks.started_at` and
  `gates.created_at` are scanned, as the stream already scans them every 2 s
  (ADR 0021's revisit point). An index would be its own issue and migration.
- A need for more than 30 days, or for the GitHub-delivery types past
  retention. Either would need the deliveries kept longer, or a table.
- A display of the lead's approval that someone acts on. It would then need
  the checked signature, not the marker.
