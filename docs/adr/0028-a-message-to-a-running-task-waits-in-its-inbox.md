# 0028. A message to a running task waits in its inbox

- **Status:** accepted
- **Date:** 2026-11-02

## Context

A person's message to a role on a work item starts that role's work there,
with the message as its brief (`message-starts.ts`). When that role's task
was already under way, it started nothing. The message waited on the thread
for the role's next task, which might be hours away or never come. #229 asks
for the running task to read it at its next turn instead, for every role a
message starts work for, on Claude, Codex and Grok.

Two facts shape how. A message can arrive at any moment, and a task can end
at any moment, including without its runner reporting it: a cancel, or
reconcile failing a silent host. The message has to land in exactly one of
two places: the live session, or the work it would have started had it
arrived a moment later. And the bridge restarts, so whatever holds the
message has to outlive it.

## Decision

- **The inbox.** A message to a live task is a row in `task_inbox` (migration
  0160): `queued`, then `taken` or `returned`, each by one
  `update … where state = 'queued' returning`. When the session's take and
  the bridge's return race for a row, exactly one gets it.
- **The session pulls.** The task's skill runner takes its inbox with its
  own task token (`POST /internal/tasks/:id/inbox/take`): once before its
  first turn on every engine, and whenever a turn ends complete on one that
  takes messages. That is after the turn's usage is in the ledger, and
  before `done`. A take is named by the runner (`take_id`), so one whose
  answer was lost gets its rows back when asked again. Nothing is pushed into a
  session: hostd, the task's container and its network are unchanged.
- **Live** is `queued`, or `running` on an engine that takes messages. The
  runner reports `takesMessages` with `running`, and it is cleared whenever
  the task leaves running. `paused` is never live.
- **The return.** A row a session did not take is returned when the task is
  no longer live: on the runner's `/state`, and by a sweep every 30 s. It
  goes through `MessageStarts.start` again, with its stored sender and
  access, so it does exactly what a new message would.
- **The engines.** An engine says whether it takes messages
  (`Engine.takesMessages`) and continues its session through
  `EngineRunInput.nextTurn`.
  - Claude reads stream-json user messages on a stdin held open
    (`--input-format stream-json`).
  - Codex runs one more `exec resume <thread>` with the message on stdin.
- **Grok takes no messages yet.** Headless `grok` reads its prompt from
  `--prompt-file` and never from stdin. It could continue only by resuming
  its session in a new process, and whether the pinned CLI can do that
  headless was not measured in the bot image for this change. The builder's
  shell had no `grok` and could not reach the image. A running Grok task
  gets the notice that it reads the message at its next task.
- **At the cap,** `nextTurn` takes nothing. The task ends as it would have,
  and the message is returned and starts the next task, whose own headroom
  check asks at the cap. Pausing a finished task to ask instead would have
  left it to run its finished work again on "continue".

## What this rules out

- **Events on the thread message** (as `notify.delivery` is kept). An event
  cannot be claimed atomically, so a message could be read live and started
  again, or neither.
- **Keeping the queue in the bridge's memory.** A restart would lose every
  queued message, and the issue says nothing may be lost.
- **Pushing into a session** through hostd and a socket in the container. It
  is a new way into a bot's computer, and the runner already speaks to the
  bridge with a token scoped to its task.
- **Delivering mid-turn.** A message is read only between turns, so a
  session never has its tool use interrupted, and the ledger's
  usage-before-output order holds per turn.
- **Messages to roles a message does not start today.**

## What would make this worth revisiting

- Grok's CLI being measured to resume a session headless, which would make
  it take messages the way Codex does.
- An engine that takes input mid-turn.
- A need to deliver to a paused task, which today is a new task's worth of
  reading.
- A turn so long that waiting for its end defeats the point of telling the
  bot now.
- Two facts this change relies on and could not measure:
  - that Claude Code's `result` totals are the session's so far;
  - that `codex exec resume` reads `-` from stdin as `exec` does.

  If either turns out false, the per-turn top-up or the resume argv changes.
