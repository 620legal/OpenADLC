# 0089. A Discover run is an intake task whose proposals hostd checks against its snapshot

- **Status:** accepted
- **Date:** 2026-11-26

## Context

A person wants OpenADLC to propose new work from a repository's own code:
half-built features, flags left off, clusters of TODO and FIXME, dead code,
and docs that promise what the code lacks (#370). The run has to be
read-only: it reads the default branch, and writes nothing to GitHub.

Every task runs on a seat, and while a seat is busy it holds that seat's other
work back. No seat was made for Discover. A new one would need a bot role, a
`config/bots.yaml` entry (a Human-review path), onboarding and an account,
which is more than the change is worth. The person asked chose the intake
seat: it is cheaper than the design seat, and its `triage/tools.yaml` was
already close to a read-only policy.

A model names files it imagined as readily as files it opened, so "evidence
for anything it says exists" holds only if code checks it. hostd has the
task's clone; the bridge never reads a task's worktree. A model also rewords a
title from one run to the next, and every commit moves lines.

## Decision

- **A run is an intake-seat task.** Kind `intake`, subject type `request`,
  subject `discover:<first 8 of the run id>`, skill `discover`, opened
  through `TaskService.open` by `apps/bridge/src/discover.ts`. The spending
  caps, the per-task cap, the ledger and the busy checks apply to it as to
  any task. hostd gives a task with no branch a clone detached at the default
  branch. A console request that finds intake busy with a run queues, and the
  run's end drains the queue. A start refused for a busy seat, a cap or a
  restart leaves no run behind. Try again on a discover task is refused: a
  new run is a new start.
- **It is read-only by its `tools.yaml`.** The skill may run `rg`, `jq`,
  `cat`, `ls`, `wc` and git's readers, and write only under
  `.openadlc-scratch/**`. `gh` is not allowed at all, so the session makes no
  GitHub call; `tests/skills.test.ts` holds `allow.shell` to that fixed list.
- **Proposals reach the bridge only from the session's own marker, through
  hostd.** The session ends by saying one `discover_proposals` marker.
  hostd's skill runner reads it from that session's output, and only from a
  `discover` session. It reads the clone's `HEAD` before the model runs,
  keeps a `file:line` only when the file is a file at that commit and the
  line is within it, drops a proposal left with no evidence, and posts the
  rest to `POST /internal/tasks/:id/discover` with the task's token. The
  bridge checks the body again with the same `checkProposals` and stores it
  once, only for the run's own task, while the run is running.
- **Two tables hold it** (migration 0173). `discover_runs` keeps the lenses,
  the state (`running`, `done` or `failed`), the commit, the counts, the note
  and the reason. A partial unique index allows one `running` run per
  repository. `discover_proposals` keeps the lens, key, fingerprint, title,
  description, status (`missing`, `partial`, `already there`) and evidence
  (`[{file, line}]`), unique per `(run_id, fingerprint)` and indexed on
  `(repo_id, fingerprint)`. Removing a repository removes its runs and
  proposals.
- **A proposal's fingerprint is `sha256(lens + "\n" + key)`.** The key is the
  model's kebab-case name for the thing. It is kept stable by giving the
  session the last done run's keys, in `earlier-proposals.md`, to reuse for
  the same thing.
- **A run ends with its task.** `done` once its proposals are stored; a task
  that ends `done` without them is failed with "the Discover run ended
  without its proposals", and every other end fails the run with the task's
  reason. An empty repository, for which GitHub answers 409 for the default
  branch, is a `done` run with no proposals and the note "the default branch
  has no commits", and no task starts.

## What this rules out

- **The design seat, or a new seat.** The design seat runs the most capable
  and most expensive model, and designs would wait behind a run. A new seat
  needs a role, a Human-review config change and onboarding.
- **The session writing a JSON file for the bridge to read.** The bridge never
  reads a task's worktree, and hostd would have to hand the file over anyway.
  The marker path already exists, and is tested, for `send_back` and
  `plan_change_verdict`.
- **The bridge trusting the model's evidence.** Only hostd has the snapshot,
  so only hostd can check a line exists; the bridge checks the shape again,
  not trusting hostd to have done it.
- **A fingerprint hashed from the title or the evidence lines.** A model
  rewords titles, and lines move with every commit, so neither would
  recognise the same proposal twice.
- **Running a failed run's task again.** The run is already failed; its task
  would write to an ended run.

## What would make this worth revisiting

A Discover run that has to read the web (issue 2's lenses), which the
read-only policy here denies; Discover runs common enough that console
requests wait behind them, which would make a seat of its own worth its
setup; or keys that drift between runs often enough that the fingerprint no
longer recognises the same proposal.
