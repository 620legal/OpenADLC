# 0083. The Checks page reads Actions and the bridge's records, and writes nothing

- **Status:** accepted
- **Date:** 2026-11-26

## Context

Finding out why a pull request was red meant opening GitHub Actions. Nothing
showed which `ci` jobs were flaky, or which jobs a builder's local pass
(`make ci`, run as `openadlc-ci`) never ran. Issue #372 asked for a read-only
Checks page per repository, and for the failing job and step on a red pull
request's item page.

That page sits beside things that do run: `ci`, the host check, which runs a
pull request's code on the machine, and the merge line, which reads checks
to decide a merge. A page that could rerun a job, start a host check or
write a status would be one more way to move what the merge line reads. The
host check's own result has to come from the bridge's record
(`host_check_runs`), never from the `host-check` commit status, which any
crew token could set (ADR 0064).

## Decision

- The Checks view (`apps/bridge/src/checks-view.ts`) and the CI failure
  section (`apps/bridge/src/ci-failure.ts`) read GitHub only through a
  GET-only `GitHubReads` (`get` and `jobLog`), built from the automation
  account's client. They import nothing that runs, reruns or decides:
  `host-check-service`, `hostd-client`, `merge-line`, `gates` or
  `automation`. `checks-routes.test.ts` reads their imports and holds them to
  this.
- Flakiness is worked out on each read from the last 30 `ci` runs, and never
  stored. A job is flaky on a head when an attempt has it failed and a later
  attempt or run on the same head has it passed. The gathering `ci` job
  counts only when it alone failed. Rows are ranked by how many heads
  flaked, then by the latest pass that settled a flake. Job reads are capped
  at 40 per refresh; past that the page says the scan is partial.
- A `ci` job counts as covered by local CI only when one of its `run:` lines
  calls `make` with a target that the default branch Makefile's `ci` target
  reaches (`coveredByLocalCi`, `packages/shared/src/ci-workflow.ts`). With no
  Makefile, only `make ci` itself counts.
- The host check's result on the default branch is the bridge's record
  (`hostCheckRuns.latestFor`) for the pull request that landed the newest
  default-branch commit, found with `GET /commits/{sha}/pulls`. The
  `host-check` status is never read.
- A job log is fetched from GitHub's redirect without the token, capped at
  8 MiB, and every excerpt line is passed through `redactSecrets`.

## What this rules out

- **Storing job results from `workflow_run` deliveries in a new table.** It
  would make flake history cheap and lasting, but it needs a schema, a writer
  in `webhooks.ts` and a backfill. A read of 30 runs answers the question
  asked.
- **Adding a per-repository read to `host-check-runs.ts`.** It would be
  simpler, but that file is under Human review. Going through the default
  branch's merged pull request is also closer to "on the default branch".
- **Building the reads from `GitHubClient` directly.** The client can write,
  and holding the page to `request('GET', …)` by convention would be a
  promise rather than a limit.
- **Showing a per-job local result.** `local_ci_runs` has one pass or fail per
  head, so the page shows that one result as a single line.

## What would make this worth revisiting

- The 30-run window or the 40-read cap regularly leaving the scan partial on
  a busy repository. Stored job results would then pay for themselves.
- GitHub giving per-job flake data itself.
- The local CI recording per-target results, which would let a row show its
  own local result.
