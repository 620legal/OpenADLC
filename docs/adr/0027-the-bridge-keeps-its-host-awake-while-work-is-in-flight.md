# 0027. The bridge keeps its host awake while work is in flight

- **Status:** accepted
- **Date:** 2026-11-02

## Context

On 10-29 a laptop running a local install slept with a task running, a merge
waiting on CI and a deploy on its soak timer, and each stopped where it was
until the lid was opened. On a local install the bridge and hostd share one
machine. A person decided on #224 that the bridge holds the assertion on its
own host, from what it knows is in flight, and that a hostd on another
machine is out of scope. The bridge already runs the dispatcher, the merge
line and the deploy waits, so it needs no new channel to know what is in
flight.

## Decision

- **What counts as in flight** is one read, `inFlight()`
  (`packages/db/src/store/in-flight.ts`), one statement with three counts:
  - tasks `queued` or `running`. A `paused` task waits on a person and does
    not count.
  - merge line rows `updating`, `testing` or `merging`, with `updated_at` in
    the last 24 hours. `waiting` is held for a person, an approval or a
    stack.
  - deploy runs with `updated_at` in the last 24 hours that are either
    waiting on a promote (not dispatched, promotable, on a soak or held for a
    person), or dispatched and not seen to end (a testing deploy with no
    `testing_conclusion`, a promote with no `production_conclusion`).

  The 24-hour bound is there because a merge or deploy row stuck for a day is
  a fault, not work, and would otherwise keep a laptop from ever sleeping.
  Tasks need none: reconcile fails the stale ones.
- **One child, with a grace.** `KeepAwake` (`apps/bridge/src/keep-awake.ts`)
  ticks every 30 s. On `darwin`, with an executable `caffeinate` in a PATH
  directory, and `keepAwake` not `off`, it holds exactly one
  `caffeinate -i -w <bridge pid>` while anything is in flight. It lets go
  60 s after the last tick that saw work, which stops it flapping between
  tasks. A child that exits on its own is started again on the next tick
  with work in flight. A spawn that fails with `ENOENT` makes the host
  unavailable. A failed `inFlight()` changes nothing, so a database blip
  does not let go mid-task. `-w` ties the child to the bridge, so a crash or
  a `SIGKILL`, where shutdown never runs, leaves no orphan holding the
  assertion. Shutdown and `process.on('exit')` let go as well. Changing the
  switch through `PATCH /v1/install` evaluates at once.
- **A sleep is two clocks apart.** Each tick keeps the wall clock and the
  monotonic clock, which stands still while macOS or Linux is suspended. The
  machine slept when the wall gap since the last tick is over 120 s and wall
  minus monotonic is over 60 s. It is recorded only when the tick before saw
  work in flight. The check runs on every host, not only where keep-awake can
  hold.
- **A sleep is an event, read by a history check.** It is written as
  `bridge.slept` with `{sleptAt, wokeAt, seconds, inFlight, keepAwake:
  holding | off | unavailable}`. The health check `slept` reads the last
  hour's, newest first, and raises a warning card naming the duration, what
  was in flight and what keep-awake was doing. It is dismissed by occurrence
  (`wokeAt`) and clears an hour after the last sleep.

## What this rules out

- **hostd holding the assertion on each host that runs a task.** The bridge
  would have had to tell hostd about merge and deploy waits over a new
  channel, and a sleeping bridge, which stops webhooks, the merge line and
  deploy waits, is the real outage.
- **A `caffeinate -t` refreshed every tick.** A late tick leaves a gap, and
  it spawns a process every 30 s for nothing.
- **Keeping the sleep in the module's memory.** A restart inside the hour
  would lose the card. Facts like this are already kept as events with no
  table of their own.
- **Reusing the bridge heartbeat (ADR 0022) to detect a sleep.** Its gap is
  measured only at a start. A sleep suspends a running bridge, which never
  restarts, so the heartbeat sees nothing. A gap is the bridge being down; a
  sleep is the host stopping under a running bridge.
- **Counting a paused task or a merge `waiting`.** Either can wait on a person
  for days, and would keep a laptop from ever sleeping.

## What would make this worth revisiting

- Installs that run hostd on a separate Mac that sleeps, where the host that
  matters is not the bridge's.
- macOS changing what `caffeinate -i` holds, or a monotonic clock that keeps
  counting through suspend, which would make every sleep look like a blocked
  loop.
- Stuck merge or deploy rows that last under a day often enough that the
  bound keeps a machine awake for nothing.
