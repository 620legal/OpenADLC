# 0022. The bridge keeps its own heartbeat and a gap report

- **Status:** accepted
- **Date:** 2026-11-02

## Context

#223: while the console could not reach the bridge, a page that read itself
again turned into the full-page "cannot reach the bridge" screen. When the
bridge came back, nothing said how long it had been away, or which tasks it
resumed or ended as orphaned at start. Those lines went to its log, which
nobody reads.

Only hostd kept a heartbeat (`hosts.last_seen_at`, every 10 s). The bridge
kept no record of when it was last running, so a start could not tell an
outage from a restart. Reconcile's `orphaned_task` verdicts did not exist yet
at start either: the timed reconcile first runs one interval (15 min) after
start (`job-timer.ts`).

A person chose that the report stays until a person dismisses it, kept by the
bridge so it survives reloads. Where it is kept is a schema choice, and they
chose two new tables over a Needs-you history card in `health_checks` and over
settings rows.

## Decision

- **The bridge keeps its own heartbeat** in `bridge_heartbeat`, a one-row
  table (migration `0158_bridge_gaps.sql`). `seen_at` is set to the database's
  `now()` at start, every 30 s (`BRIDGE_HEARTBEAT_MS`) and once more on a
  clean shutdown. The start reads the old value and writes the new one in one
  statement (`bridgeGaps.beat`).
- **A gap is measured on the database's clock.** It is a start whose previous
  `seen_at` is more than one interval old. An install's first start (no row)
  and a restart back within the interval record nothing. The last beat on
  shutdown means an ordinary keeper restart or self-update never reports one.
- **One gap report is open at a time**, in `bridge_gaps`, held to one by a
  partial unique index. A new gap while one is open moves the row's
  `last_up_at` and `back_at` to the latest gap and keeps its `tasks`, so the
  earlier gap's tasks are not lost. The gap is stored before its tasks are
  known, so a gap that cost nothing still says how long, as does a start that
  dies part way.
- **What the start cost goes in the report.** That is the tasks
  `resumeAnswered` resumed (its `onResumed` callback) and, after a gap only,
  the repaired `orphaned_task` verdicts of one reconcile pass run at start.
  `Drift.taskId` names the task. Each entry is
  `{taskId, subject, outcome: 'resumed' | 'orphaned', why, backAt}`.
- **A report is dismissed for everyone, guarded by its `backAt`.** It is read
  with `GET /v1/bridge/gap` and dismissed with
  `POST /v1/bridge/gap/dismiss {backAt}`, both `'user'`. A dismiss whose
  `backAt` is not the open row's answers 409: a person cannot dismiss, unseen,
  a newer gap merged into the report they read. It is audited as
  `bridge.gap_dismissed`.
- **The console's live refresh probes the bridge before it refreshes.**
  `consoleServesThisPage` returns `{ ok, bridge }`. On `bridge: false`,
  `readUnlessUpdated` answers `'unreachable'` and skips `router.refresh()`, so
  the page keeps what it shows under the offline banner. This half is browser
  state only, with nothing stored.

## What this rules out

- **A Needs-you history card in `health_checks`.** That table holds answers
  from the health registry's checks, and this is not one. A card has no room
  for a list of tasks with links. The heartbeat would still need a table of
  its own.
- **Settings rows (`bridgeLastSeen`, `bridgeGap`).** The bridge would write a
  setting every 30 s. Settings are the closed list a person sets, and the
  settings list and backups would carry the beat as if it were one.
- **Stacking one report per gap.** A second outage before anyone looked would
  be a second strip saying much the same thing. Merging keeps one strip and
  every task.
- **Taking the orphans from the timed reconcile.** It runs up to 15 minutes
  after start, and the report would have no orphans until then.
- **Probing with `fetch` from the browser.** The browser does not reach the
  bridge: every read goes through the console's server with the person's
  identity headers. Only a server action tests the path the page's reads take.

## What would make this worth revisiting

- A bridge that runs as more than one process, or one whose restarts take
  longer than 30 s as a matter of course. The heartbeat would then report
  gaps that are not outages.
- A stream of the board to the console. The banner could then come from the
  stream closing, rather than from a probe every tick.
