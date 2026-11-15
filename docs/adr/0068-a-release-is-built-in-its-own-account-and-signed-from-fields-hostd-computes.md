# 0068. A release is built in its own account and signed from fields hostd computes

- **Status:** accepted
- **Date:** 2026-11-15

Builds on [0064](0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md),
[0066](0066-a-host-check-account-reaches-nothing-and-only-the-bridges-host-check-status-is-skipped.md)
and [0067](0067-a-host-checks-working-folder-keeps-only-gits-objects-refs-and-index.md).

## Context

A repository whose product is a macOS app is released by building it on the
install's own machine, signing what was built, and publishing it to clients
that check the signature (#341–#345). Nothing in a container can build it,
and GitHub's hosted macOS runners are priced by the minute for a build that
takes hours.

The machine already runs one kind of code outside every container: the host
check (ADR 0064). It runs a pull request's own Makefile, as an account that
reaches nothing the install guards (ADR 0066). A release differs in what is
at stake. What it builds is signed with a key whose public half is pinned in
every client, and shipped to people who trust it. So the boundary is written
down, and its account made provable, before any release code exists. The
files that will hold the boundary are under Human review before anyone writes
them.

A release's build tree is worth keeping between releases, since an Xcode build
from scratch is long. A kept tree is only as trustworthy as everything that ever
ran in it. In the host check's account, that includes pull request code.

## Decision

**Who.** Only the install's people with Approves on may cut a release. Each
one proves who they are with a fresh device-code sign-in whose account id and
login match their People row, as ADR 0063 does for a sign-off. A bot or crew
account never cuts one. A refused click is audited.

**What is built.** One commit on the default branch, pinned when the person
clicks: the head the compare view showed. Nothing else is built. The tag is
made on that SHA only after the build and the signing succeed, so a failed run
leaves no tag. A SHA that is not on the default branch is refused.

**As whom.** A dedicated OS account, `OPENADLC_RELEASE_ACCOUNT`, with no
default: unnamed, the install builds no releases. It is never the host
check's account, by name (ignoring case) or by uid, and never root or hostd's
user. hostd runs it through `sudo -n -u … -- /usr/bin/env -i` with only
`PATH`, `HOME`, `USER`, `LOGNAME` and `LANG`, and no credential.
`ReleaseAccount.probe` (`apps/hostd/src/release-account.ts`) passes before
every run, and the `release-account` health check reports it.

- It reaches nothing the install guards: ADR 0066's list, checked by the same
  function as the host check's account (`probeAccount`,
  `apps/hostd/src/account-probe.ts`).
- The host check's account can neither read nor enter its home
  (`host_check_reaches`). The step is skipped only when there is no host
  check account, or hostd cannot run anything as it. Then no pull request
  code runs there either.

The card is quiet unless hostd names a release account. The release account
is not in `MANUAL_STEPS`, because an install that never releases has no step
to do. When repositories gain a release setting (#343), the check gains
`wanted: () => repos.anyRelease()`. A repository set to release with no
account named then raises the card too.

**How the code reaches it.** The same way it reaches the host check's
account. hostd fetches the SHA into a mirror of its own, and gives the
account a git bundle on stdin, with the same `.git` cleaning (ADR 0067). No
path is shared and no token is passed.

**The kept tree.** The account keeps its build tree between releases, and
checks each pinned SHA out over it. A clean build is available on request.
Only merged commits ever run there. That is why keeping the tree is
acceptable here, and it is the reason for a second account.

**What leaves the account.** hostd runs `cat <artifact>` as the account, and
hashes the stream as it reads it. hostd never opens a path the account
controls: a symlink there would have hostd read, sign and publish a file of
its own.

**What is signed.** hostd computes every signed field:

- the version, which hostd reads from its own mirror at the pinned SHA, never
  from the account's tree;
- the sha256 of the stream;
- the URL of the uploaded asset.

Nothing the account prints is signed. There is one documented byte layout. A
repository picks which fields are signed, never their values.

**The key.** One ed25519 key per repository. A CLI command on the host imports
it from a file, never through the browser. It is kept in the secret store and
goes into encrypted backups only. Only the signing step
(`apps/hostd/src/release-sign.ts`) reads it. It is never in the account's
environment, a log or GitHub. Rotating it is out of scope, because the public
key is pinned in clients.

**Publishing.** As the app, with its installation token. No new credential is
added.

**The run's end.** Each run is limited to between 1 and 1440 minutes. Every
run, a pass included, ends with TERM and then KILL to every process of the
account, and so does the start of the next one. A run's reason is redacted
before it is stored or posted (ADR 0066).

**Awake.** A release run in flight counts in the bridge's `inFlight()`, so
keep-awake (ADR 0028) holds `caffeinate -i` while it runs.

**Human review.** `apps/hostd/src/release-run.ts`,
`apps/hostd/src/release-sign.ts`, `apps/bridge/src/release-service.ts`,
`apps/hostd/src/account-probe.ts` and `apps/hostd/src/release-account.ts`
need @orzelig's approval, in `AGENTS.md` and `.github/CODEOWNERS`.
`account-probe.ts` is listed because the host check's boundary moved into it
from `host-check.ts`, which was already under review.

## What this rules out

- **Building in the host check's account.** Pull request code runs there. It
  could leave a step in the kept tree for the next release build to run, or
  read and change a release's output before hostd signs it.
- **Signing inside the account, or signing what it prints.** The first gives
  the account the key. The second lets the account choose what is signed: a
  version, a hash or a URL it printed would be signed as if hostd had
  computed it.
- **GitHub-hosted macOS runners.** They are priced by the minute, which is too
  much for a build that takes hours.
- **A second copy of the probe for the release account.** #335 and #340 each
  widened the host check's probe, and a copy would have missed both.
- **A card on every install until the account exists.** An install that never
  releases would carry a warning for a step it has no reason to take.

## What would make this worth revisiting

- **Notarization or a Developer ID.** Either needs a credential inside the
  account, which this decision keeps out of it.
- **A host other than macOS.** The boundary assumes a machine hostd runs on
  with `sudo` and a second local account.
- **Affordable hosted macOS builds.** A build that need not run on the
  install's machine needs no account on it.
