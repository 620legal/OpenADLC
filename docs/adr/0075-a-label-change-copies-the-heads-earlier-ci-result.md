# 0075. A label change copies the head's earlier ci result

- **Status:** accepted
- **Date:** 2026-11-15

## Context

The merge line lands a pull request only once GitHub Actions' `ci` has passed
on its head. Rulesets count a skipped job named `ci` as a pass, so the
workflow names its job `ci` only when it runs. A run that runs nothing gets
another name: `ci (after approval)`. That covers a crew pull request before
`adlc:ci`, and a label change that tests nothing new.

GitHub counts the newest run of a workflow on a head. A label put on or taken
off after `ci` passed (`needs-human`, say) started a run that skipped its job
as `ci (after approval)`. GitHub then counted that run in place of the one
that passed. A green pull request went back to "Expected" and stayed there.
GitHub said `blocked` and named nothing, and the merge line said "did not say
why" (#357). This repository's own workflow did the same on a label change
and on a title-only edit.

A job's name is fixed before its steps run, so `ci` cannot name itself from a
lookup inside it. It can read `needs.*` in its `name` and `if`.

The merge line judges a `ci` check by its workflow run's `created_at`
(`ciRunElsewhere`): against the base's last change, and against the windows
when other pull requests from the branch were open. A run that copies a
result is made later than the run it copies.

## Decision

- **A run that runs nothing copies the newest completed `ci` on the head.**
  In the template, that is a label change other than `adlc:ci`. Here, it is
  also a label other than `scope:cross-cutting`, and a title-only edit, not
  on a draft. A job ahead of `ci` (*ci lookup*) finds the head's newest run
  of this workflow whose `ci` finished, not cancelled. `ci` then reports that
  result, and runs no `make setup` or `make ci` and uploads no `tested-tree`.
  With nothing to copy, `ci` is skipped as `ci (after approval)`, as before.
- **A failure is always copied.** Copying red launders nothing, so its ties
  are not asked.
- **A success is copied only under the push path's ties, and with the pull
  request the only one ever opened from its branch.** The ties are: a pull
  request run of this workflow on the repository's own branch; every pull
  request with that head, or ever opened from that branch, into the default
  branch; and none of them retargeted. Without them, a copy could carry a
  pass from before a retarget, or another pull request's pass, past the
  windows `ciRunElsewhere` reads.
- **The newest `ci` decides.** An older success is never searched for behind
  a newer failure.
- **A wait that times out never passes.** A run still going is waited for,
  up to 35 minutes, and then `ci` is red. Skipping instead would recreate the
  "Expected" hold this removes. The *ci lookup* job fails too, not only `ci`:
  "re-run failed jobs", which is the bridge's own retry of a first failure
  and GitHub's button, re-runs the failed jobs alone and keeps a passed
  job's outputs, so with only `ci` red it would read the same `timeout` and
  fail again. With the lookup failed, a re-run looks again.
- **A copy is never copied.** A run whose *ci lookup* ran is passed over: the
  result it copied is still on the head, and its red may be a wait that
  timed out, which tested nothing and would otherwise pass on, to every later
  label change, as a failure. A copy still going is not waited on either: it
  waits on the same runs.
- **A GitHub error, or a fork's pull request, copies nothing,** and falls back
  to today's skip.
- **The lookup is one script with two modes.** In the template, the step
  *already passed on its pull request* answers both the push's tree vouch and
  the label copy, sharing `tiedToPullsIntoDefault`. Here, it is
  `release-check.mjs`: `vouchedRun` and `earlierCi` share
  `tiedToPullsIntoMain`.
- **A repository still on an earlier template is told what happened.** When
  a skipped `ci (after approval)` check run is newer, by id, than every `ci`,
  and the newest `ci` passed, the merge line says so: "GitHub says it is
  blocked, most likely by the newest run of ci on the head". It also says
  that `adlc:ci` or a new push clears it, and a person may merge over it, as
  over the unsaid case it narrows. `openadlc github apply` offers the current
  template in place of the earlier one.

## What this rules out

- **A separate workflow for label events.** GitHub counts the newest run per
  workflow, so a second workflow's check named `ci` would sit beside the
  skipped one, not replace it.
- **Keeping the push lookup inside `ci` and adding a copy step in the new
  job.** That makes two copies of the ties to keep in step, and the job's name
  still could not read a step.
- **Copying a success on the ties alone.** A copy run is newer than its
  source, so it can step past the time windows the merge line reads.
- **Searching past a newer failure for an older pass,** and a timed-out wait
  that skips or passes.
- **Taking `labeled` and `unlabeled` off the workflow's triggers.** `adlc:ci`
  starts CI on a crew pull request, and `scope:cross-cutting` re-runs this
  repository's scope check.

## What would make this worth revisiting

- GitHub stops counting a skipped run as the newest run of a workflow's check,
  or lets a label event start no run at all for a workflow that lists it.
- The merge line stops judging a `ci` by its run's `created_at`, so the
  only-pull-request tie is no longer needed.
- Check-run ids stop growing over time, which the hold's wording reads to
  tell which run is newer.
