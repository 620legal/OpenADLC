# 0025. The hosts page reads what reconcile judges

- **Status:** accepted
- **Date:** 2026-11-02

## Context

A stopped or overloaded hostd was visible only in `openadlc doctor`. Settings →
Hosts (OpenADLC#231) lists each host that runs tasks, read-only: its
heartbeat, its tasks against its capacity, its CPUs and memory, and, for a host
that went silent, what that cost. One host per install is what OpenADLC
supports; there is no Add a host.

Two rules about a host already existed. The dispatcher's `taskLoad` counts a
host live while it beat in the last two minutes, to count the room it has.
Reconcile calls a host silent after `HOST_SILENT_MS` (five minutes) without a
beat and fails each task still running on it with `HOST_STOPPED_REPORTING`
("the host stopped reporting"), leaving the task's `host_id` set. `hosts`
recorded no CPUs or memory.

## Decision

- **A host's state on the page is judged with reconcile's rule, on the
  bridge's clock.** `GET /v1/hosts` (admin) calls a host `never_seen` while its
  `last_seen_at` is null, `live` while its last beat is at
  `now - HOST_SILENT_MS` or later (reconcile's `>= silentBefore`), and `silent`
  after that. `now` is the bridge's and is sent with the list, so "seen 8 s ago"
  does not depend on the browser's clock.
- **Per-host load is `taskLoad`'s predicate grouped by `host_id`.** A host's
  `used` is its tasks that are queued, running, or paused with their computer
  kept. Queued tasks no host has claimed are counted apart as `unclaimed`, so
  the page adds up to the board's "N of M running".
- **What a host's silence cost is read from `tasks` and never stored.** It is
  the tasks on that host with `state = 'failed'`,
  `exit_reason = HOST_STOPPED_REPORTING` and `ended_at >= hosts.last_seen_at`,
  that is, failed since its last beat, so an outage last week is not counted
  again. The reason is passed in by the bridge: `@openadlc/db` does not import
  the bridge's constant.
- **`hosts.cpus` and `hosts.memory_bytes` are what hostd saw at its last
  registration** (`os.availableParallelism()`, `os.totalmem()`): overwritten at
  each start, not coalesced, and null until a hostd reports them. Under Docker
  Desktop or OrbStack they are the VM's, not the Mac's.

## What this rules out

- **`taskLoad`'s two-minute window, or `hosts.status`, for "silent".** The page
  would call a host silent three minutes before reconcile fails its tasks, and
  say they were failed when they were not. Nothing writes `status = 'down'`.
  The two-minute window stays the dispatcher's, for counting room.
- **A failed-tasks counter on `hosts`, bumped by reconcile.** It changes
  reconcile, which this issue ruled out, and keeps a second copy of what
  `tasks` already says (ADR 0021: read from the tables things happen in).
- **Reporting CPUs and memory on every heartbeat.** A machine's size does not
  change while hostd runs, and hostd registers at every start.
- **Add a host, `openadlc host join`, editing or removing a host.** Extra
  machines are not supported.

## What would make this worth revisiting

Reconcile changing how it judges or fails a silent host — another threshold, a
stored state, resuming a silent host's tasks — would make the page's rule and
its count wrong; they should follow it. Supporting more than one host per
install would make this page the place to add and remove one.
