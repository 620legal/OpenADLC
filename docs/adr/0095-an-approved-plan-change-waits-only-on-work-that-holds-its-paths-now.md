# 0095. An approved plan change waits only on work that holds its paths now

- **Status:** accepted
- **Date:** 2026-11-26

## Context

A builder that needs a path outside its lease asks with a `plan_change`, and a
person's approval is held while other work has an overlapping path
(`Gates.blockers`, `apps/bridge/src/gates.ts`). That rule used to count every
issue in build or review that had ever had an implement task, by its declared
paths and its pull request's changed paths together. The dispatcher counts
less: it waits only on work being built (a queued, running or paused implement
or patch task, `workInFlight.building`).

On 2026-11-26 the gap became a deadlock. #377's builder asked for three console
test files that #374 declared. #374 was not being built: its implement tasks
the night before had failed on a model-account limit. The approval was held
because "#374 holds paths that overlap them", and the dispatcher would not
start #374 because its paths overlapped #377, which was being built. Each
waited on the other until a person took the files off #374's Expected paths by
hand.

## Decision

Three things hold a path for a plan change:

- another active lease, by its declared paths, as before;
- an issue whose build or patch round is queued, running or paused, by its
  declared and changed paths (`workInFlight.paths`);
- an open pull request that is not being built, by the files it changes only
  (`workInFlight.changedPaths`, which is empty when the issue has no
  `pr_number`, so the files a closed pull request left on the row hold
  nothing).

An issue in build or review that is only waiting its turn holds nothing, even
after an earlier failed build and with the path in its Expected paths. The
plan-change hold is never wider than what the dispatcher waits on, so the two
cannot wait on each other. `workInFlight` returns `paths`, `changedPaths` and
`building` apart so `Gates` can tell them apart; the dispatcher's rule is
unchanged. A held approval is re-decided on the existing retry that runs
whenever any work ends.

## What this rules out

- **Making the dispatcher wait on work that is not being built instead.** The
  two rules would agree that way too, but every issue whose Expected paths
  overlap one that failed once would be held back until a person stepped in.
- **Breaking the cycle in the "two wait on each other" card
  (`apps/bridge/src/attention.ts`).** That card stays for two real holders; it
  is not where a hold that should never have happened is undone.
- **Holding exclusive paths for an issue in review that is not being built.**
  The dispatcher does so when it starts work; a plan change does not. An issue
  in review that is not being built holds only what its pull request changes,
  and nothing a plan change grants can collide with the pull request's
  unchanged declared paths.

## What would make this worth revisiting

The dispatcher waiting on more than work being built, or less. The two rules
have to change together, or a waiting build and a paused builder can deadlock
again.
