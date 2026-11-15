# 0070. A release recipe is an admin's, and its artifact stays with hostd

- **Status:** accepted
- **Date:** 2026-11-15

Builds on [0068](0068-a-release-is-built-in-its-own-account-and-signed-from-fields-hostd-computes.md)
and follows [0064](0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md)'s
rule that what runs on the machine is an admin's choice. It changes neither.

## Context

ADR 0068 fixed who cuts a release, as which account it builds, and that every
signed field is hostd's. It left open what the build runs, where its version
comes from, how that version is held above the last release, and where the
artifact is kept between the build and the signing (#344).

The repository that asked for releases ships clients that update on a version
of 1 to 4 numbers with an optional `-<label>.<N>`, such as
`156.0.8078.79-abc.29`. They update when the numbers are higher, or the
numbers are equal and `N` is higher. Its published tags are `v<version>`.

## Decision

**The recipe is on the repository's row, set only by an admin.** It has these
columns:

- `release_command`: one line, at most 500 characters;
- `release_artifact` and `release_version_file`: relative paths with no `..`,
  `.` or empty part, no leading `/` or `~`, and no NUL, newline or backslash;
- `release_version_key`;
- `release_repo`: the `owner/name` the release is published to, or null for
  this repository;
- `release_timeout_minutes`: 1 to 1440, 180 by default.

An admin sets them through `PATCH /v1/repos/:name` with `release`, checked by
`releaseSettingFrom`. A null command means the repository does not release. A
pull request cannot choose what runs as the release account.

**The version is read by hostd, from its own mirror, at the pinned SHA**, with
`git show <sha>:<file>`. It is never read from a tag, and never from the
account's tree:

- with no key, the trimmed file is the version;
- for a `.json` file, the key is a dotted path, `version` by default;
- for any other file, the value is that of the first `KEY = value` or
  `KEY: value` line.

No regular expression an admin writes is run.

**A version is `<1–4 numbers>[-<label>.<N>]`.** A label is `[a-z][a-z0-9]{0,31}`,
and no number has a leading zero. A version is at most 64 characters, the
manifest's limit (ADR 0069). The rule lives once, in
`packages/shared/src/release-version.ts` (`repoVersionFrom`,
`parseRepoVersion`, `compareRepoVersions`, `repoVersionGate`), for hostd and
the bridge alike.

**Versions are ordered by their numbers, then by `N`.** A bare version counts
as `N = 0`, and a missing trailing number as 0. This is not semver: a suffix
ranks *above* the bare version, because the shipped clients update on a higher
number, or an equal number with a higher `N`. Two different labels are never
ordered against each other. A version whose label differs from the last
release's is refused.

**A new version must be strictly above the last release.** The last release is
the highest version among the release repository's published, non-draft
releases that GitHub does not mark prerelease, read from their tag names with
one leading `v` taken off. A tag that is not a version is skipped. A tie at the
highest across two labels refuses the run. A list that cannot be read refuses
the run; it is never read as "no release". hostd checks all of this before the
build, so a wrong version costs seconds, not hours.

**"On the default branch" is checked by hostd, on its own fetch, at run
time.** The SHA must be an ancestor of the branch's tip. A branch that has
moved on still holds the SHA, and the run builds that SHA, not the new tip.

**One release runs per hostd, and one per repository.** The repository rule is
held by a partial unique index on `release_runs (repo_id) where state =
'running'`. A release run counts in `inFlight()`, so keep-awake holds the Mac
awake while one builds.

**The artifact and hostd's record of it stay with hostd.** They live under
`<workRoot>/release/artifacts/<runId>/`, which the account cannot enter:

- hostd runs `cat` as the account and hashes the stream as it writes it there,
  in a folder made 0700 and a file created exclusively, 0600;
- `run.json` beside it holds `version`, `sha256`, `bytes` and the artifact's
  name.

#344 signs and uploads from these. It never reads the account's tree, and
never relies on the bridge's report alone.

## What this rules out

- **The recipe in a file in the repository** (`.openadlc/release.yml`). Merged
  code runs as the account anyway, but ADR 0064 keeps what runs on the machine
  an admin's choice, and one pull request could otherwise change the command
  the next release runs.
- **The bridge checking "on the default branch" through GitHub's compare API.**
  The SHA hostd builds is the one on hostd's own fetch, so that is where the
  check holds.
- **A version regex set by an admin.** It would run in hostd's event loop on a
  file from the repository. A file and a key cover plain, JSON and `xcconfig`
  files without one.
- **Semver ordering, or refusing every suffix.** Either way, the requesting
  repository's next release would rank below its last, so it could never
  release.
- **The version from a tag, or from the account's tree.** A build could
  rewrite either. The mirror at the pinned SHA is hostd's alone.
- **Keeping the artifact in the account's tree for #344 to read later.** That
  path is the account's to change, and hostd never opens a path the account
  controls.

## What would make this worth revisiting

- A repository that releases from a version kept in a submodule, or spread
  over several files, which a single file at the SHA cannot read.
- Clients that order two labels against each other.
- More releases than GitHub's first page of 100. The highest might then be on
  a later page.
