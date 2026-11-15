# 0072. A release is cut by an approver from a pinned view with a fresh device-code proof

- **Status:** accepted
- **Date:** 2026-11-15

## Context

ADRs 0068 to 0071 build, sign and publish a release of one pinned commit.
They leave out who starts a run and how the commit is chosen.
`ReleaseService.start` checks neither: it builds the SHA it is given, for the
person it is told asked. So the one route that calls it is the release's
access rule.

A person presses **Cut release** after reading GitHub's compare of the last
release's tag with the default branch's head. The commit released must be the
one they read, even if the branch moves while they sign in. Only the
install's people with Approves on may cut, and a bot never does. The proof
that it is them must be fresh, as the author's console sign-off is (ADR
0063).

## Decision

- **The bridge pins the view, and the click names the view, never a commit.**
  `POST /v1/repos/:name/release/views` reads the default branch's head once.
  Every later read uses that SHA, never the branch's name:
  - GitHub's compare `<last tag>...<sha>`;
  - the version file at `<sha>`.

  The bridge keeps `{ viewId, sha, last release, version }` in memory and
  answers with the view. `POST /v1/repos/:name/release/cut` takes exactly
  `{ viewId, clean? }`. A body with `sha`, or any other field, gets 400. The
  run's SHA is read only from the bridge's own view.
- **A view** belongs to the identity that built it. It lasts 15 minutes and is
  kept in memory only, so a restarted bridge forgets it and the person
  reloads. It is spent when `ReleaseService.start` accepts a run from it. When
  the service refuses, the view stays unspent, so the person can try again
  with a new proof.
- **No cut is offered that the person could not see the changes of:**
  - a tag that is not in the repository;
  - a head that is `behind` or `diverged` from the tag;
  - a version that hostd's own rule (`parseRepoVersion`, `repoVersionGate`,
    `packages/shared/src/release-version.ts`) would refuse.

  These are refused before any sign-in. hostd checks the version again at the
  same SHA, and its check is the authority.
- **Who may cut:** a console person whose linked GitHub account has Approves
  on in People (`people.personByGithubId`), asked before the sign-in and
  again after it. Each cut starts a new device-code sign-in. Its account id
  and login (ignoring case) must be the linked account's, and must not be an
  account the crew uses. The token is used only to ask GitHub who approved
  the code, and `PersonFlows` revokes it. A second press while a sign-in for
  the same view waits gets 409.
- **The routes are `user` routes,** with Approves checked in the handler:
  - `GET /v1/releases`, `GET /v1/releases/:id`, `GET /v1/repos/:name/releases`;
  - the view;
  - the cut, and its flow, which only the identity that started it can read.

  Anyone in the console may watch a release.
- **Every refusal of a cut is audited** as `release.cut_refused` at
  `<owner/name>:release`, with its `reason` and `stage` (`before_sign_in` or
  `after_sign_in`). A sign-in that ends without the code being approved is
  found by a sweep and audited too (`sign_in_failed`). A cut is audited as
  `release.cut`, with its SHA, version, the release it follows, and who
  approved. An audit row that cannot be written is said in the log, and the
  person is refused all the same.
- **`ReleaseService.start` has exactly one caller:** the cut's sign-in in
  `apps/bridge/src/release-routes.ts`. A source scan in its test fails for a
  second one.
- **`ReleaseService.lastRelease` is the one reader of the last release.**
  `start` takes `after` from it, and the view takes its tag from it, so the
  person compares with the release the run is held above.

## What this rules out

- **The click sends the SHA it was shown.** The bridge cannot tell the SHA a
  view showed from any other commit on the branch. A stale tab or a hand-made
  request would then release a commit nobody compared.
- **Reading the branch head at the click.** That is exactly the commit nobody
  saw.
- **Pinning views in the database.** A view is worth minutes and belongs to
  one sign-in. A restart that forgets it costs a reload, and a table would
  add a migration for nothing that must outlive the bridge.
- **An Approves-only role for the routes.** Roles are `user` or `admin`, and
  Approves is per person, as the sign-off (ADR 0063) checks it. Watching a
  release is not a decision.
- **A second version parser in the bridge.** It would drift from hostd's, and
  the early refusal would then disagree with the real one.
- **Reusing an earlier sign-in, or keeping the token.** The proof is of the
  person at the click. A kept token could act as them well beyond it (ADR
  0018).

## What would make this worth revisiting

- A release that must be cut by more than one person, or by a person who has
  no console account. The proof would then have to move off the console's
  identity.
- A repository whose release must be cut from a branch other than the
  default.
- A bridge run as more than one process. A view kept in one process's memory
  would not be found by a cut that reaches another.
