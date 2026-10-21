# 0007. Self-update takes verified releases, and the checkout stays the install

- **Status:** accepted
- **Date:** 2026-10-21

## Context

An install runs from a git checkout (`repoRoot`, often `~/OpenADLC`). Every
service starts from it (`apps/cli/src/commands/up.ts`), the `openadlc` on a
person's PATH is its CLI, `config/` is read from it, and each task's computer
mounts the skills, the role playbooks and OpenADLC's `gh` and `git`
(`apps/hostd/bin`) from it, for as long as the computer lives, a paused task's
included. Updating meant `git pull && pnpm install && pnpm build` and a
restart, by hand.

The person who asked for self-update decided that it follows releases a
person makes by tagging a version, not every commit of `main`, and that
`release-build.yml`, called at `main` by the tag's `release.yml` (#46),
builds each release once, on GitHub, as one archive of the built output with
a build provenance attestation. A release is code every
install then runs with the services' rights, so taking one is a trust
decision, and an update must never cut a bot's work off or leave an install
half-changed.

## Decision

- **Only a release, checked before it is opened.** An update takes the newest
  version tag of the checkout's own `origin` that has the three files the
  contract names (docs/self-hosting.md#what-a-release-holds), whose commit
  is a first-parent commit of `main` and a fast-forward from the commit in
  use, and that GitHub holds immutable. Its archive must match `SHA256SUMS`
  and then pass `gh attestation verify --bundle` with the identity of
  `release-build.yml@refs/heads/main` as signer, that tag and commit as
  source, and a GitHub-hosted runner. Only then is it
  read, by OpenADLC's own reader, against the contract: directories and
  regular files of the built output and a manifest naming the commit and its
  tree, nothing else. `gh` is the verifier because the GitHub CLI is already a
  tool OpenADLC depends on and System manages, and with `--bundle` it needs no
  GitHub credential.
- **Prepared beside the install, then switched in place.** While tasks run,
  the bridge adds a detached worktree of the release's commit under
  `$OPENADLC_HOME/self-update/<tag>/`, unpacks the output there and runs
  `pnpm install --frozen-lockfile`, which builds node-pty for this machine and
  fills the pnpm store. Nothing the services run from is touched, so any
  failure leaves the install as it was. Once no task runs, a detached
  `openadlc self-update apply` from the release's own CLI stops the services
  and sees each keeper gone, fast-forwards the checkout, writes the built
  output over the checkout's file by file in place, installs offline from
  that store, migrates and starts. The checkout stays the install. Writing
  over in place is what a paused task's computer needs: it bind-mounts the
  skill runner's bundle, one file, by inode. An install refuses to update a
  checkout another running install also runs from.
- **No task is cut off, and the wait ends.** While a restart is owed, the
  dispatch gate is held and `TaskService.openNow` refuses every start as busy,
  so event-driven starts that never read the gate wait too. A paused task does
  not count and stays paused. The restart starts after two looks, a poll
  apart, find no task queued or running and no engine update.
- **Put back before the migration, never after.** A failed fast-forward, swap
  or install is undone (`git reset --keep`, the old output moved back, the old
  lockfile installed) and the install restarted as it was. Once the release's
  migrations may have run, the checkout stays on the release and the failure
  is reported, since migrations are forward-only.

## What this rules out

- **Building each commit on every install** (#45's first design): every
  install would run its own `pnpm build`, and "may take" would be every
  commit whose `ci` passed. The person chose releases a person tags instead.
- **Running from release directories** (`$OPENADLC_HOME/releases/<tag>`,
  with `install.json` pointing at one). Near-zero downtime, but the services
  would leave the person's checkout: local edits under `config/` would stop
  applying, the `openadlc` on their PATH would be older than what runs, and a
  task's computer that mounted the old directory would need it kept for as
  long as the computer lives.
- **Unpacking with the system's `tar`.** GNU tar and bsdtar differ in what
  they do with links, absolute paths and `..`, and in their defaults; the
  contract is checked entry by entry instead, by one reader on every machine.
- **Verifying the attestation in Node.** A Sigstore verifier is a large piece
  of cryptography to keep correct, or a new dependency; `gh` already does it.
- **Unpacking straight into the checkout.** A failure half-way would leave
  the running console's `.next` and the bridge's `dist` mixed between two
  releases, which is what "a failed update leaves the install as it was"
  forbids.
- **Moving each output directory aside and copying the new one in.** Every
  paused task's computer would go on mounting the old skill runner, a file
  renamed away, under the new hostd. Recreating those computers, by putting
  the bundle's hash in their mounts label, would lose a paused task's session.

## What would make this worth revisiting

The install no longer running from a git checkout (a packaged install, or
the cloud's images), which would make release directories the natural shape;
a release that has to differ per OS or architecture; or downtime at the
restart, a few minutes, mattering more than keeping the checkout the install.
