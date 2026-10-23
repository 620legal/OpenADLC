# 0013. A dependency may name an issue in another managed repository

- **Status:** accepted
- **Date:** 2026-10-23

## Context

#141: an issue's `## Dependencies` section was read by `parseDependencies`,
which returned issue numbers. It read a line only when the line started with
`#N`. `- owner/name#N` was skipped, so an issue waiting on work in another
repository the install manages was given `start:now` and built before that
work shipped. #137 has intake file one linked issue per repository for a
single request. For "must ship first" to hold between those issues, a
dependency has to reach across repositories.

The dispatcher, the stage handoff, the board, Needs you and stacking each read
the section, and each looked the numbers up in the issue's own repository.

## Decision

- A line under `Dependencies` that starts with `owner/name#N` names issue N in
  that repository: bare, after `-`, `*` or `+`, or after `1.` or `1)`. Case is
  ignored, as GitHub ignores it. `#N` still names this issue's own
  repository. A reference partway through a line is still prose, not a
  dependency.
- `parseDependencyRefs` (`packages/shared/src/dependencies.ts`) replaces
  `parseDependencies`. It returns `{ repo, number }`, where `repo` is
  `owner/name` as written or null for `#N`. `formatDependencyRef` gives `#N`
  or `owner/name#N` wherever one is shown or audited, and `namesRepository`
  says whether a ref names a given repository.
- A ref is resolved by `resolveDependency(own, ref)`
  (`packages/db/src/store/issues.ts`). A full name equal to the issue's own
  repository counts as same-repository, stacking included. Any other is looked
  up with `getRepoByName`, then `getIssue`. A repository the install does not
  manage, or has removed, gives `managed: false` and no issue, so the
  dependency never ships. `dependencyIsSatisfied` is unchanged:
  `openadlc:abandoned` is never shipped, wherever it is.
- Stacking is same-repository only. A branch cannot sit on another
  repository's branch, so a dependency in another repository is outstanding
  and never the one an issue stacks on.
- The board's `waitingOn` and the internal unblock route's `dependencies` are
  strings in that format, not numbers.

## What this rules out

- **Keeping `parseDependencies` beside the new function.** It would still drop
  a cross-repository line without a word, and that silent drop is this bug. A
  later caller that picked it would regress with nothing to catch it.
  Removing it lets `tsc` find every caller.
- **Making `parseDependencies` return strings like `owner/name#N`.** Every
  caller would have to parse them again.
- **Looking an unseen issue, or an unmanaged repository, up on GitHub.** The
  platform acts on what it has seen. A dependency it cannot read holds the
  issue back, as an unknown `#N` already did, and a person looks.

## What would make this worth revisiting

Stacking across repositories, if a build could ever start from work in another
repository. Or issues the install does not manage becoming something it can
read and trust as shipped.
