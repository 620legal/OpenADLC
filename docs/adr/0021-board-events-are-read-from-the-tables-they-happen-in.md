# 0021. Board events are read from the tables they happen in

- **Status:** accepted
- **Date:** 2026-11-02

## Context

`openadlc watch` streams what the crew is doing as it happens: a task
started, a question asked, a pull request held, a merge. `openadlc ls` lists
the live tasks. Both read only the bridge's HTTP API, never the database (#227).

The bridge had no stream of board events. Its only streams,
`/v1/threads/:bot/stream` and `/v1/items/:subject/stream`, send a bare "changed"
watermark. Each of these events is written in several places:

- Tasks start in the dispatcher and the task service.
- Gates open from several routes.
- Merges land through `merge-line.ts`, or through a person on GitHub.

`/v1/tasks` cannot serve `ls`. It returns the 50 newest tasks in any state, so
live ones fall off behind finished ones. It also has no bot name, no
repository and no `paused_at`.

## Decision

The board event feed (`apps/bridge/src/board-events.ts`) is derived by polling
the tables each event happens in. No writer emits it, and nothing stores it:

| Event `type` | Read from |
|---|---|
| `task.started` | `tasks.started_at` |
| `question.asked` | `gates.created_at`, with its task's (or thread's) subject and bot |
| `pull_request.held` | a merge-line entry whose `heldForPerson` reason is new or changed, and `pull.held` audit rows |
| `merged` | `stage_moves` forward into `merged`, or into `done` from anything but `merged` |

How it is read:

- One reference-counted poller for the install. It probes every 2 s while
  anyone is subscribed.
- It starts from the database's now (`select now()`), and that first probe
  sends nothing.
- Later probes read from 10 s before the cursor, which catches a row that
  committed after a probe passed its timestamp. Event ids already sent are
  dropped (the 2,000 newest are kept), and the cursor moves to the newest
  `at` it read.
- A merge-line hold is a diff of state, timed at the probe.
- Work on an `openadlc:ignore` subject is left out.
- `Last-Event-ID` is ignored, and nothing is replayed.

An event is `{ id, type, at, bot, item: { ref, repo, url }, text }`:

- `id` is `<type>:<row key>`.
- `bot` is the seat's name, or `null` when no seat did it.
- `item.ref` is the subject as the bridge writes it, and `repo` is the full
  name, or `null` for a request filed in no repository.
- `text` is one line of at most 200 characters.

Clients ignore a `type` they do not know, so types can be added without a
breaking change. The CLI's `--json` prints the object unchanged.

`GET /v1/board/tasks` is the live-task read: tasks queued, running or paused,
oldest first, with bot, item, state, `since`, `costUsd` and `capUsd`. `since`
follows the card's clock:

- `running`: `tasks.runningSince`'s rule, which is the newest answer after its
  pause when it paused, else `started_at`.
- `paused`: `paused_at`.
- `queued`: `created_at`.

Both routes are `user` routes.

## What this rules out

- **An emitter at each writer, or a new `board.*` row in `events`.** A writer
  that forgets to emit is a feed that quietly stops covering it. This is why
  `thread-stream.ts` already watches the database instead.
- **The audit log alone.** It has no row for a task starting or a question
  being asked, and `merge.landed` misses merges a person made. `stage_moves`
  covers both kinds, because a merge's webhook moves the issue through
  `Automation.moveStage`, which records every stage change.
- **Changing `/v1/tasks`.** Its shape would break what reads it.
- **Replay.** History is the board's, not the stream's.

## What would make this worth revisiting

- The polling reads showing up in `pg_stat_statements`. `tasks.started_at` and
  `gates.created_at` have no index, so each probe scans them. An index
  migration would come first, as its own issue.
- Enough event types that one probe's reads stop being cheap.
- A need to resume a stream without loss, which would need an events table
  that writers fill.
