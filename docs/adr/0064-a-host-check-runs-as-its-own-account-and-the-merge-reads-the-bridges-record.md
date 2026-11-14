# 0064. A host check runs as its own account, and the merge reads the bridge's record

- **Status:** accepted
- **Date:** 2026-11-14

## Context

Some repositories have a build that only the install's own machine can do. A
macOS app builds only with Xcode, and no task container has Xcode. The person
who approves such a pull request had no way to know it builds (#327).

Running that build means running the pull request's own code, its Makefile, on
the machine outside every container. hostd's own user can read
`OPENADLC_HOME`: the secret store, `install.json`, and every bot's token. So
can the person's account. A build run as either of them can read the install's
secrets.

A result also has to be trusted, and GitHub alone cannot be trusted for it.
Any crew token can write a commit status. If the merge counted a status named
`host-check`, a bot could land a change by posting one.

A host build can take hours. The merge line brings a pull request up to date
with its base when it reaches the front, which makes a new head with the same
changes. The crew's approvals and a person's sign-off already carry to a head
like that; `ci` reruns.

## Decision

- **Settings are on the repository's row.** An admin sets
  `host_check_command`, `host_check_timeout_minutes` (1 to 1440, default 60)
  and `host_check_required` (default true) through `PATCH /v1/repos/:name`.
  The command is one line of at most 500 characters, and every change is
  audited. Nothing reads it from `config/repos.yaml` or from the pull request.
- **When it runs.** The bridge asks for a run once the crew's reviews approve
  a head (`crewApprovedHead`): the lead and every other approver approve it, no
  approver asks for changes on it, the security seat does not either, and the
  lead is not due again. It asks beside `awaitPeople`, from the review webhook
  and from the gate sweep, including pull requests that close no issue. Never
  for a fork's pull request or a draft. A new head, a close or a merge cancels
  the run that is going.
- **Whom it runs as.** hostd runs it as an OS account a person made,
  `OPENADLC_HOST_CHECK_ACCOUNT` (default `openadlc-hostcheck`), with
  `sudo -n -u <account> -- /usr/bin/env -i` and only `PATH`, `HOME`, `USER`,
  `LOGNAME`, `LANG`, `CI=1` and `OPENADLC_HOST_CHECK=1`. Before every run,
  hostd proves three things:
  - the account exists, and is neither root nor hostd's own user;
  - `sudo -n` can run a command as it;
  - as the account, `OPENADLC_HOME`, `install.json` and hostd's home cannot be
    read.

  A failed proof refuses the run, with the fix as its reason. The same proof
  answers the `host-check-account` health check.
- **How the code reaches the account.** hostd fetches the head into a mirror
  of its own with the crew's token, then writes it as a git bundle to the
  account's stdin. The account fetches the bundle into its own working folder,
  which it keeps per install and repository, so builds are incremental. No
  path is shared between the two users, and the account never holds a token.
- **How runs are scheduled and stopped.** One run at a time per hostd. A start
  for a pull request replaces any start queued for it, and cancels its run
  that is going. Every run ends by sending TERM, then KILL, to every process
  the account runs, a pass included; on a cancel or the time limit the KILL
  waits up to 30 seconds for the command to exit. hostd does the same before
  each run starts. The account runs nothing else.
- **What git runs as the account.** The fetch and checkout run with
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
  `core.hooksPath=/dev/null` and `core.fsmonitor=false`, since an earlier run
  can write the account's `~/.gitconfig` and the folder's `.git`. A result is
  still only as trustworthy as every head that ran before it in the folder.
- **Where the result is recorded.** hostd reports the result to
  `POST /internal/host-check` with the install's secret. The bridge writes it
  to `host_check_runs`, which only the bridge writes, and posts `host-check`
  as the app, for people to read.
- **What the merge reads.** `mergeFacts` reads the table. With the host check
  required, `mergeDecision` and `mergeBlockers` hold the merge until a run has
  passed on the head, or on a head in `sameDiffAs`. The hold is a `check`, so a
  held merge offers no Merge over it. The red rule leaves out the `host-check`
  status context: if the check is not required, a failure doesn't hold the
  merge.
- **A pass carries through `sameDiffAs`, never through `carriedFrom`.** A
  person chose this on #327. Updating the branch from its base doesn't rerun a
  build of hours. Resolving a conflict changes the code, so it does rerun. The
  bridge records the carry as a `carried` row, for the card and the status. The
  merge never counts that row, and works out the carry itself.
- **What the card shows.** The held approval's card and the held merge's card
  show the result for their head: passed (or carried), failed with the last 40
  lines of the log, running with the time since it started, or not run with
  why. A run's page in the console shows the last 64,000 bytes of what it
  printed.

## What this rules out

- **Merging on GitHub's `host-check` status.** Any crew token can set a status,
  so a status cannot be the pass.
- **The command in `config/repos.yaml`.** That file is in OpenADLC's own
  checkout, which a pull request can change, and the command must come only
  from an admin.
- **Running it as hostd's user, or as the person's.** Either can read
  `OPENADLC_HOME`.
- **Running it in the task container.** The container cannot run Xcode, which
  is why this exists.
- **A shared bare repository, or a shared group, for the code.** A bundle on
  stdin needs no path that both users can write.
- **Signalling only the command's process group.** hostd's user cannot signal
  the account's processes, and a build can start daemons outside the group.
  Stopping every process of an account that runs nothing else is exact.
- **Rerunning on every head, like `ci`.** A build of hours would hold the merge
  line through each update from the base. The person chose to carry the pass
  instead.

## What would make this worth revisiting

- If two installs on one machine both need host checks. One run at a time is
  held per hostd, and `kill -1` as the account would reach the other install's
  build. Each install would need its own account, which `openadlc up` does not
  pass yet.
- If a host build has to run on the cloud host. Its hostd has no account to run
  as, so there the health check fails and nothing runs.
- If the merge line stops carrying approvals to a head that only merges the
  base in. A pass should carry exactly as far as the approvals do.
