# 0085. The side panel reads Needs you from attention and tasks from one bridge read

- **Status:** accepted
- **Date:** 2026-11-26

## Context

A person watching the crew had to switch between the board, its running list
and Needs you (#376). The console now draws a collapsible panel beside every
page, from the root layout. It has three tabs: Needs you with its count,
Running, and Recent.

Three facts made its reads a decision:

- **Needs you is filtered per viewer.** `GET /v1/attention` filters per
  viewer (`attentionFor`, `forViewer`). The page counts `groupCounts(items)`,
  which is `waiting(items)`. That leaves out `check_fixed` notices and held
  approvals that are someone else's (ADR 0058). The panel's count has to
  equal the page's.
- **No running read had both state and title.** The board's running list
  (`runningList`) names each task but has no spend or state, and lists only
  `running`. `GET /v1/board/tasks` has state and cost but no title.
- **No read listed tasks by when they ended.** `tasks.ended_at` is set on
  each way out (`done`, `failed`, `stopped`), without an index.

## Decision

- **Needs you** is `/v1/attention`, read by the console's `/api/panel` as the
  person and counted by `waiting()` from `attention-card.ts`. The bridge
  never reads attention a second way for the panel.
- **Running and Recent** are one new `user` read, `GET /v1/board/panel`
  (`apps/bridge/src/board-panel.ts`).
  - Running is the tasks running or paused. Each has a state:
    - `working` when it is running;
    - `waiting` when it is paused with an open gate (a question, a plan change
      or a cost cap), the board's rule for a waiting bot;
    - `paused` for any other pause (a restart pending, a resume the network
      failed).
  - Each Running row also has `since`, `costUsd` and `billed` as stored.
    `since` is `runningSince` or the start for `working`, and `pausedAt` for
    the other two.
  - Recent is `tasks.listFinishedSince(now − 24 h, 20)`: `done`, `failed` and
    `stopped` tasks with `ended_at` in the window, newest first. It needs no
    migration.
- **Names.** Every row is named by `nameTask` with `namingFacts` in
  `board-work.ts`, the code that names the board's running list, so a row
  reads the same in both.
- **Failures.** `/api/panel` always answers 200 with
  `{ tasks, attention }`, and a part that failed or is missing is null. The
  panel draws nothing until it has `tasks`.
- **Polling.** It polls every `REFRESH_EVERY_MS` (15 s), only while the page
  is on screen and at Tailwind's `md` or wider. Below `md` it is hidden by
  CSS.
- **Open or collapsed** is per person, in this browser, building on ADR 0082:
  localStorage `openadlc.sidePanel.<encoded identity>` holds `open` or
  `closed`. A missing or unreadable value, or no identity, means open.

## What this rules out

- **A bridge-side copy of the attention read for the panel.** It would be a
  second audience filter that could drift from the Needs you page and the
  header.
- **Extending `GET /v1/board/tasks` with titles.** It lacks the work-item
  titling of a pull request's review task, and `openadlc ls` reads it as it
  is.
- **Drawing the panel's data in the root layout on the server.** It would add
  a bridge read to every page load for a panel whose open state is not known
  before mount anyway.
- **Keeping the open state on the person's record in the bridge.** The person
  chose this browser's storage.
- **Counting the board's "N running" from the panel.** The board still counts
  `running` alone. The panel's Running badge also counts waiting and paused
  rows, because its tab lists them.

## What would make this worth revisiting

- A stream of the board, which would replace the panel's poll.
- `/v1/attention` becoming too heavy to read every fifteen seconds for each
  open, visible, wide tab.
- Finished tasks growing to where the unindexed `ended_at` window is slow.
  That would call for an index, and the read would stay the same.
