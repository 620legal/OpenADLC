# 0097. A host check's git starts no background maintenance

- **Status:** accepted
- **Date:** 2026-11-26

## Context

A host check's account keeps one working folder per repository, and `RECEIVE`
keeps its `.git/objects` between runs so that hostd can send a thin bundle
([ADR 0067](0067-a-host-checks-working-folder-keeps-only-gits-objects-refs-and-index.md)).
A release run executes the same script as its own account (`release-run.ts`).

Every fetch of a bundle adds a pack to the kept objects. After about 50 runs,
the folder passes `gc.autoPackLimit` (50). From then on, every `git fetch`
ends by starting `git maintenance run --auto` (git 2.29+; `git gc --auto`
before that). That process detaches by default (`gc.autoDetach`) and can
outlive the script. It keeps running as the account after the run ends, which
breaks ADR 0064's rule that every run ends with nothing of the account left
running. It is also still writing `objects/` while the next run cleans `.git`.
In CI, a test's cleanup of a fixture's `.git` failed with ENOTEMPTY (#406's
ci on runner image 20261122). #370 worked around the failure in the test, but
the script still started maintenance (#411).

## Decision

Every git call that `RECEIVE` makes goes through `g()`, including the
submodule pass's. `g()` adds these flags after the ones ADR 0064 and ADR 0067
set:

- `-c maintenance.auto=false` stops `fetch` and any other command from
  starting `git maintenance run --auto`.
- `-c gc.auto=0` turns off the loose-object and pack-count triggers of
  `gc --auto`.
- `-c gc.autoDetach=false` and `-c maintenance.autoDetach=false` keep in the
  foreground any auto work that still starts, so it ends with the script.
  `maintenance.autoDetach` arrived in git 2.47; older git ignores an unknown
  key.
- `-c fetch.writeCommitGraph=false` is already git's default. Pinning it keeps
  the fetch from writing a commit-graph if a later default or a `feature.*`
  setting turns it on.

As a result, the run starts no git process that outlives it. The kept folder
just keeps its packs, and a Clean build resets it as before. The script's
arguments, stdin and exit codes are unchanged, and so is the `.git` it leaves.

This amends ADR 0067's decision point 4.

`host-check.test.ts` proves the decision. A test plants 51 packs in the kept
`.git`, then receives a thin bundle with `GIT_TRACE2_EVENT` set. It finds no
`child_start` of `maintenance` or `gc`, and every git process that started
also exited.

## What this rules out

- **`git fetch --no-auto-maintenance` (`--no-auto-gc`) on the fetch only.**
  This covers the fetch but not a git call added later, such as a `commit` or
  `merge` step, that could start auto gc. It would also be a second place to
  look. Flags on `g()` cover every call, as the existing ones do.
- **Killing leftover processes after the script.** The host check already does
  this for the account as a last line of defence. Relying on it leaves the
  race with the next run's cleaning, and keeps work running that nobody asked
  for. Not starting the maintenance is the fix.
- **Removing the kept objects each run.** This would avoid the threshold, but
  every run would then need the full bundle, and ADR 0067 keeps the objects so
  that hostd can send a thin one.

## What would make this worth revisiting

- **Git adds automatic background work that these keys do not cover.** If a
  new auto task starts from `fetch` or `checkout` under another setting, `g()`
  needs that setting too, and the trace2 test is where it would show.
- **The kept objects grow enough to slow the fetch.** Then the folder would
  need maintenance that the script runs in the foreground, on purpose, rather
  than git's automatic kind.
