# 0066. A host check account reaches nothing, and only the bridge's host-check status is skipped

- **Status:** accepted
- **Date:** 2026-11-14

Amends [0064](0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md).

## Context

An independent security review of the host check (#327, pull request #331)
found three gaps (#335).

- **The account probe was too narrow.** It proved only that the account could
  not read `OPENADLC_HOME`, `install.json` or hostd's home. Other ways in were
  left open:
  - A home at `0711` can't be listed but can be passed through, so a file in it
    whose name is known, `install.json` among them, still opens.
  - `OPENADLC_WORK_ROOT` can sit outside `OPENADLC_HOME`.
  - The Docker socket, or membership of the `docker` group, is root on the
    machine.
  - A `NOPASSWD` sudo rule runs something as someone else.
- **A run's `reason` went to GitHub as given.** It can carry git's or the
  build's stderr from the account's folder, which a hook an earlier run planted
  controls. Only `log_tail` was redacted.
- **The red rule skipped every commit status named `host-check`.** A
  repository whose own CI posts a status of that name lost the hold its red
  status was. GitHub's combined status (`/commits/{sha}/status`) keeps only the
  newest status per context, whoever posted it. So once the bridge posted its
  own `host-check`, the other account's red status no longer showed there at
  all.

## Decision

**The account reaches nothing the install guards.** Before every run, and on
every health read, `HostChecks.probe` proves by effect, as the account through
`sudo -n` and `env -i`, that it can't:

- read `OPENADLC_HOME`, `install.json`, the work root or hostd's home (`can_read`)
- enter (`test -x`, which counts ACLs) `OPENADLC_HOME`, the work root or
  hostd's home (`can_enter`)
- connect to any socket `dockerSocketsOf` lists (`docker`, with the socket's path)
- run `sudo -n -l` successfully (`can_sudo`). That catches any `NOPASSWD` rule,
  including one limited to a single command.

The `docker` group is asked about as hostd, with `id -Gn` (`docker`, with no
path).

The first refusal found refuses the run. The health card and the refused
run's reason share one fix per problem (`accountFix`).

**A run's reason is redacted and capped in the store.** `keptReason` is
applied in `host-check-runs` `start` and `finish`, the one place every reason
passes through, whether hostd or the bridge wrote it. It removes NUL, applies
`redactSecrets`, and keeps the first 1,000 characters, ending in `…`. The
start is kept because a reason leads with what happened. Every status the
bridge posts carries the stored reason, a refused head's included.

**The red rule skips only the bridge's own `host-check` status.**
`mergeFacts` reads `host-check` from every status on the head
(`latestStatusesByCreator`, `/commits/{sha}/statuses`): the newest one from
each account. It marks `byBridge` where the poster is the app's bot login or
the automation account's login. `mergeDecision` and `mergeBlockers` skip a
status only when it is `host-check` and `byBridge` is true. Any other red
`host-check` is a red check.

It fails closed. A login that can't be read matches nothing. If the full list
can't be read, the combined status's `host-check` stands as nobody's, and its
red holds.

The merge still decides the host check from the bridge's record
(`host_check_runs`), never from a status, as 0064 says.

## What this rules out

- **Redacting `reason` in hostd before it reports.** That covers only hostd's
  reasons. The bridge writes its own (`accountFix`, `hostd did not take the
  run: …`).
- **Reading `creator` from the combined status alone.** A later post by the
  bridge hides another account's red status there.
- **Telling statuses apart by `target_url`.** Anyone can post a status with
  the console's URL, so it proves nothing about who posted it.
- **`sudo -n true` for the sudo check.** It misses a `NOPASSWD` rule limited to
  one command. The cost of `-l`: under `Defaults listpw=never`, an account whose
  rules all need a password is refused too. The detail quotes the listing so a
  person can see which rule it was.
- **Asking `docker context` for the socket.** hostd runs it without a `HOME`,
  and a fixed list can be tested.

## What would make this worth revisiting

- Docker, or another container runtime the install uses, moves its socket
  somewhere `dockerSocketsOf` doesn't list.
- GitHub starts to keep commit statuses per creator in the combined status, or
  lets a status's context be reserved to one app.
- Something other than the store starts to write a host check's reason where
  people can see it.
