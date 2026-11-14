# 0061. A local install comes back by a login item that runs up

- **Status:** accepted
- **Date:** 2026-11-14

## Context

A restart left a real install stopped for about 28 hours, and nothing said so.
`openadlc up` already brings the database container back on its own
(`--restart unless-stopped`). hostd, the bridge and the console are detached
keeper processes, and nothing started them after a reboot.

Several constraints shape the fix:

- A second install on the same machine is told apart only by its
  `OPENADLC_HOME`, `OPENADLC_INSTALL_ID`, `OPENADLC_BOT_PREFIX` and
  `OPENADLC_BOT_IMAGE`. Started without them, `up` starts the default
  install's names (`openadlc-db`, `task-*`).
- launchd starts an agent with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which has
  no `docker` and no Homebrew `node`.
- `openadlc down` is also how self-update stops the services before it
  restarts onto a release.
- `openadlc doctor` has to answer when the bridge is down, which is exactly the
  case after a failed restart. The bridge cannot import `apps/cli`.

## Decision

`openadlc up` registers one login item per install, after its services are up:

- on macOS, a LaunchAgent labelled `dev.openadlc.up.<id>`, in
  `~/Library/LaunchAgents/`;
- on Linux, a `systemd --user` unit, `openadlc-up-<id>.service`.

`<id>` is `OPENADLC_INSTALL_ID`, or `default`. The item runs
`node <cli> up --at-login`. `--at-login` exits when all three keepers are
running. Otherwise it opens Docker Desktop or OrbStack and waits up to five
minutes for Docker, then starts the install. It never registers or removes the
item itself.

The item carries an allowlisted environment, and never a credential:

- `OPENADLC_HOME`, always, written as an absolute path;
- the other three install variables, when they are set;
- `PATH`;
- `OPENADLC_NO_SIGN_IN_LINK=1`.

What it says goes to `<home>/run/login-item.log`.

The LaunchAgent has `AbandonProcessGroup`, and the unit has `KillMode=process`,
so unloading the item never stops the services it started.

The item is on by default. `openadlc up --no-login-item` writes
`"loginItem": false` to `install.json`, changing that key alone, and takes the
item off. `--login-item` writes `true`. The bridge learns the choice from
`OPENADLC_LOGIN_ITEM` in the environment `up` gives it. A scratch install
(`OPENADLC_SCRIPTED_ENGINES=1`) never gets an item.

The `down` command takes the item off. Self-update's stop keeps it
(`down({ keepLoginItem: true })`).

The item is judged by its file and by what launchd or systemd holds
(`launchctl print`, `launchctl print-disabled`, `systemctl --user is-enabled`).
One reader, `inspectLoginItem` in `@openadlc/shared`, serves both `doctor` and
the bridge's `login-item` health check. An item whose file names another
install's home is neither overwritten nor removed.

## What this rules out

- **A shell script as the item's program, waiting for Docker in `sh`.** It
  would need its own quoting, could not be tested from vitest, and would drift
  from `up`. With `up --at-login`, the waiting stays in TypeScript.
- **Copying the whole environment into the item.** Any exported model key, or
  `DATABASE_URL`, would end up in a file in `~/Library/LaunchAgents`.
- **The bridge reading `install.json` for the opt-out.** The bridge reads no
  CLI file. `OPENADLC_LOGIN_ITEM` carries the choice. Whether the item is
  registered is still judged from launchd or systemd, never from a flag.
- **Registering the item before the services start.** On macOS, `bootstrap`
  with `RunAtLoad` would start a second `up` beside the running one.
- **`down` always taking the item off, self-update included.** A reboot during
  an update, or an update that fails before its `up`, would leave an install
  that never comes back.
- **Always registered, with `down` as the only way off.** The person deciding
  chose a remembered opt-out.

## What would make this worth revisiting

- macOS or systemd stops running a per-user agent at login, or requires a
  signed app bundle for one.
- A local install gets a supervisor of its own that already starts at boot.
