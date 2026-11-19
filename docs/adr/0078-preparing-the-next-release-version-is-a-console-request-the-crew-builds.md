# 0078. Preparing the next release version is a console request the crew builds

- **Status:** accepted
- **Date:** 2026-11-19

## Context

A release page offers no cut when the default branch's version is not above
the last release ("X is not above the last release, Y: raise it in
<versionFile>"). The person who wants to release then has to raise the version
by hand. The default branch is protected: everything on it goes through a pull
request, crew review, ci and the merge line. Raising a version often moves
other files with it — a README badge, a doc, a CI check that compares them —
that only the repository's own instructions name.

A release is cut only through the boundary ADR 0072 draws: a view the bridge
pinned, a person with Approves on, a fresh device-code proof, and one caller of
`ReleaseService.start`. A way to prepare the next version must not widen that
boundary.

## Decision

**The next version is prepared by a console request the crew builds.**

- **The press.** Prepare next version on a release page files a feature
  request, in the approver's name, through the same `fileRequest` that
  `POST /v1/requests` uses. Intake triages and files it like a typed one.
- **The request.** It carries:
  - the target version;
  - the last release's version and tag;
  - the recipe's versionFile and versionKey;
  - the instruction to raise the version to exactly that value, and to change
    and list under Expected paths every file the repository's AGENTS.md,
    README, docs or CI say moves with it.
- **The bridge and the app never write a version or push to the default
  branch.** They write no branch and no commit. The version lands as a crew
  pull request.

**Prepare is offered only for a not-above refusal, from a pinned view.**

- **When it is offered.** `repoVersionNotAbove` holds when
  `compareRepoVersions` gives -1 or 0, and never for a label mismatch. When it
  holds, it marks the view's `Blocked` as `notAbove`. A missing version file,
  an unreadable last release, a missing tag and a head that does not contain
  the tag leave it unmarked.
- **The route.** `POST /v1/repos/:name/release/prepare` takes exactly
  `{ viewId, version }`. `ReleaseCuts.preparable` decides it with the view's
  own `viewer()` check (linked, Approves on), and never spends the view. A
  crew account is refused.
- **The version sent.** It is held to `repoVersionGate` against the last
  release, and a refusal names the versionFile.
- **The suggestion.** `suggestNextRepoVersion` gives the label's `n` plus one
  when the last release has a label, otherwise the last number plus one, and
  null when that would overflow.
- **The answer.** The view answers `prepare` (the offer) and `preparing` (the
  open preparation).

**The open preparation is found from its audit row.**

- **How it is found.** `release.prepare_requested` on `<fullName>:release`
  names the request. The preparation is open while the request is queued,
  draft or questions, or while any issue it was filed as is open on GitHub.
  An issue or pull request state that cannot be read counts as open.
- **One at a time.** Filing runs under
  `withAdvisoryLock('release-prepare:<fullName>')`, which checks that nothing
  is open before it files. No column.

**`release-prepare.ts` holds no release handle.**

- It takes `ReleaseCuts` only as `Pick<'preparable'>`.
- It imports neither `ReleaseService`, the publisher nor hostd's client, so a
  Prepare route cannot start, pin or sign anything.
- `ReleaseService.start` keeps its one caller in `release-routes.ts`.
- `release-prepare.ts` is not under Human review, since it cannot reach the
  boundary. `release-routes.ts` gains only reads.

## What this rules out

- **The bridge committing the version itself.** That would put a commit on
  the default branch that no review or ci saw. It would also leave every file
  that moves with the version unchanged, so the repository's own checks would
  fail after the merge.
- **A device-code proof for Prepare.** The request only starts crew work.
  That work still passes crew review, ci, the merge line, and a later cut with
  its own proof. "Approves on, with a linked GitHub account" is the bar the
  issue named.
- **A `release_preparations` table, or a `requests.purpose` column.** Either
  is exact, but it needs a migration for one lookup that the audit row already
  answers. The audit row also already records who asked.
- **A prepare route that reads the head itself, without a view.** That would
  repeat `version()`'s GitHub reads outside the reviewed file. It could also
  offer Prepare where the page refused a cut for another reason (no tag,
  behind). Going through `preparable(viewId)` makes "offered" and "accepted"
  one decision.

## What would make this worth revisiting

- **The audit write.** If its failure after a request is filed became more
  than a database failure between two writes, a second press could file a
  second request. The person would see both in Needs you. A column would then
  be worth its migration.
- **Pushing for the release.** If a repository's release flow ever needed the
  bridge to push a commit (a generated changelog, say), the line "the bridge
  never writes the version" would need its own decision. It would not belong
  in this route.
