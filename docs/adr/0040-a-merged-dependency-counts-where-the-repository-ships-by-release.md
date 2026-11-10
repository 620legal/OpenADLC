# 0040. A merged dependency counts where the repository ships by release

- **Status:** accepted
- **Date:** 2026-11-10

## Context

`dependencyIsSatisfied` counted a dependency as shipped in Done, or in Merged
with `deployed:testing`. In a repository that ships by release
(`testing.on: release`), no deploy ever labels a merge, and the card reaches
Done only when a published release contains it, which may be weeks later. On
2026-11-10 #254 waited on #251, and #255 on #252 and #254, after each had
merged: a person edited Dependencies and swapped `blocked` for `start:now` by
hand each time.

Five places ask the rule: the dispatcher's unblock pass and its lease check,
the board's "Waiting on" (`waitingOf`, which Needs you reads too), stacking,
and intake's hand-off (`StageHandoff.markReadiness`). If they disagree, the
board says an issue waits while the dispatcher leases it, or the other way
round.

Separately, the unblock pass skipped a `blocked` issue whose Dependencies
listed nothing, so the label stayed until a person took it off.

## Decision

- In a repository that ships by release, a dependency in stage `merged`, not
  labelled `openadlc:abandoned`, satisfies what waits on it. The merge into
  the default branch is what the dependent builds on. The rule follows the
  repository the **dependency** is in (`dependencyRepository(ref, own)`), so
  a cross-repository dependency is judged by its own repository's rules.
- `dependencyIsSatisfied(dependency, ignored, delivery)` takes
  `{ shipsByRelease }` as a **required** third argument, so a caller that does
  not pass it fails to compile.
- The answer comes from the bridge's cached delivery rules
  (`DeliveryKnowledge`), the same reader the release sweep acts on, through
  `releaseShipping` (`apps/bridge/src/delivery-rules.ts`). A repository the
  install does not manage, a read with `readError`, or anything that throws
  answers false: the stricter rule, which only waits longer.
- Nothing else changes about shipping: `hasShipped`, the Merged → Done move by
  `ReleaseShipping` and the stored labels stay as they were. A merged,
  unreleased card stays in Ship and reaches Done only when a release ships it.
- Where a repository deploys, a merged dependency still needs
  `deployed:testing`. Abandoned never counts; an ignored dependency still
  counts only once closed as completed (ADR 0020).
- A `blocked` issue whose Dependencies section lists no ref, or that has no
  section, is unblocked on the dispatcher's next pass (`/unblock` with
  `dependencies: []`, reason "it lists no dependency"), unless it carries
  `openadlc:ignore`. The lease check reads the body on every pass, so nothing
  is leased onto unshipped work if the Dependencies arrive after the label.

This amends ADR 0013's "`dependencyIsSatisfied` is unchanged".

## What this rules out

- **Reading `repos.delivery_rules` inside `resolveDependency`.** The stored
  row is used only when the repository has no `.github/openadlc.yml`, so a
  repository that ships by release because of its file would read as
  deploying, and the dispatcher would disagree with the release sweep and the
  board.
- **An optional `shipsByRelease` that defaults to false.** A caller that was
  missed would keep the old rule with no error, which is the inconsistency
  this decision exists to remove.
- **Judging by the dependent's repository.** Only the dependency's own
  repository's rules say whether its merge is its shipping.
- **Counting a merged dependency as Done.** Done still means a release
  contains it; only what waits on it may start sooner.

## What would make this worth revisiting

A repository that ships by release but whose dependents need the released
artifact itself rather than the default branch (a package consumed from a
registry, say). There the merge is not enough, and the rule would need a
per-repository choice rather than following `testing.on` alone.
