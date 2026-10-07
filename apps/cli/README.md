# @fleetadlc/cli

`fleetadlc` starts, stops and inspects an install from a terminal. `fleetadlc up` is the
install's process manager: it brings Postgres up when it can, applies the
migrations, loads `config/`, and starts hostd, the bridge and the console, each
under a keeper that starts it again when it dies. The other commands read the
install's database and secret store directly, or ask the running bridge and
hostd. Setting an install up belongs to the console's walkthrough; the CLI keeps
connecting the crew (`fleetadlc auth login`) and the few
settings a browser cannot reach.

## Running

```bash
pnpm build                                  # the CLI runs from dist/; bin/fleetadlc.mjs refuses without it
node apps/cli/bin/fleetadlc.mjs help            # every command and what it does
node apps/cli/bin/fleetadlc.mjs status          # what is running, the board, the month's spend
node apps/cli/bin/fleetadlc.mjs logs hostd      # where a service writes its log
```

- **Which install.** Every command reads `$FLEETADLC_HOME/install.json` (`~/.fleetadlc`
  by default; `src/install.ts`) and fills each variable the shell left unset
  from it. `FLEETADLC_HOME` is what chooses an install: `fleetadlc up` starts each service
  with `serviceEnv()` laid over the shell's environment, so for what it sets —
  ports, URLs, driver, `DATABASE_URL` — `install.json` wins over an export.
- **Ports.** `ports` in `install.json`, defaulting to `DEFAULT_PORTS`: console
  47300, bridge 47311, hostd 47312, Postgres 47432. `fleetadlc init` sets only the
  driver and the database URL (and a webhook secret); edit the file for the rest.
  `ports` may name only the ports being changed (`"ports": {"console": 3001}`);
  the others keep their defaults. Moving Postgres means changing `databaseUrl`
  too when the file has one. A key the CLI cannot use, such as a port that is
  not a number, stops every command with its name and what to write.
- **Services.** hostd, then the bridge (with `FLEETADLC_DISPATCH_IN_BRIDGE=1`, or `0`
  when `FLEETADLC_SCRIPTED_ENGINES=1`, since the integration suites dispatch), then
  the console, each as `node dist/keep.js <name> -- <command>`: detached, leading
  its own process group, pid and log in `$FLEETADLC_HOME/run/`. A service counts as
  up only when its health URL answers and its own process is the one answering.
  The keeper restarts one that exits, waiting one second and doubling to thirty,
  and gives up after five deaths in a row within ten seconds of starting.
  `fleetadlc down` signals each group, and also stops a standalone dispatcher an
  older install left running (`RETIRED`).
- **Postgres.** When the configured database does not answer, `fleetadlc up` runs
  `pgvector/pgvector:pg16` as a container named after the install on
  `ports.postgres` — `fleetadlc-db` for the default one, `<FLEETADLC_BOT_PREFIX>db`
  for one with a `FLEETADLC_INSTALL_ID`, such as `scratch-db` (`databaseContainer`)
  — or creates the database on a server that answers without it. `fleetadlc down` leaves Postgres and the bot containers up.
  The container is published on 127.0.0.1 only, with the user, password and
  database in `databaseUrl`. The password is generated per install and saved
  to `install.json` before the container is made; an older install's
  `fleetadlc` is changed with `ALTER ROLE` on its own container, which keeps its
  data (`databasePasswordStep`, `rotateDatabasePassword`). A server `up` did not
  make is never altered.
- **No demo mode.** A command refuses any flag it does not read (`src/flags.ts`),
  so `fleetadlc up --demo` stops and points at docs/development.md rather than
  starting the real install. `FLEETADLC_SCRIPTED_ENGINES=1`, exported by hand, is the
  suites' fabricating mode ([tests/README.md](../../tests/README.md)).

## What it talks to

| Command | Reaches |
|---|---|
| `up`, `down` | Docker (the database container, the bot image under the docker driver), Postgres (migrate, seed), each service's health URL |
| `status`, `doctor` | Postgres; the bridge's `/v1/status` and `/v1/health/run`; each service's health URL |
| `auth login` | GitHub's device flow; stores the refresh token and a signing key; asks the bridge's `/internal/bots/reconcile` to rename the bot |
| `attach` | the bridge's `/v1/terminal/:bot/:session/token`, then hostd's `/terminal/redeem`, then runs the command it is handed |
| `attribution rotate` | the bridge's `POST /v1/attribution/rotate`, which makes the new key the bridge signs with and audits it |
| `github sync-labels`, `check`, `apply` | a token from the bridge's `/internal/tokens/:bot`, then GitHub. A bridge that refuses stops the command; only when nothing answers on its port is the token refreshed here, under the bridge's lock (`github-refresh:<sign-in>`). `sync-labels` and `apply` write as the OpenADLC app, with an installation token per repository, as the console's repository setup does, when the app's key is in the secret store; the automation account's token only without it |
| `backup`, `restore` | Postgres and the secret store through `@fleetadlc/backup`; hostd to adopt a subscription's sign-in. `restore` also calls GitHub, to check each GitHub sign-in by refreshing it and take it over, and the model providers' model lists, to prove each key |
| `seed`, `cloud` | `packages/db/dist/cli/seed.js`; `terraform` in `infra/gcp` with `$FLEETADLC_HOME/cloud.tfvars.json`, and `gcloud`, which creates the install's bucket and copies that file, webhook secret included, to and from it |

A call to `/internal/*` or hostd carries `x-fleetadlc-internal-secret`, which the CLI
reads from the secret store: it runs as the operator, on the install's machine.

## Source map

- `bin/fleetadlc.mjs` — the `fleetadlc` binary; imports `dist/main.js`.
- `src/main.ts`, `src/flags.ts` — dispatch the command, refusing a flag it does not read; load `install.json`; `attach`, `logs`, `seed`.
- `src/install.ts` — `InstallConfig`, its defaults, `serviceEnv()` (every service's environment, assembled once), the webhook secret.
- `src/commands/up.ts` — `fleetadlc up` and `fleetadlc down`.
- `src/processes.ts`, `src/keep-running.ts`, `src/keep.ts` — starting, stopping and polling a service; the keeper.
- `src/commands/init.ts` — the driver and the database URL, which the console cannot set.
- `src/commands/doctor.ts` — `fleetadlc status` and `fleetadlc doctor`, including the bridge's health checks.
- `src/commands/auth.ts` — connecting the crew's accounts. Setup itself is the console walkthrough, not a command.
- `src/commands/github.ts` — labels, rulesets, environments and CODEOWNERS on the managed repositories.
- `src/commands/attribution.ts` — `fleetadlc attribution rotate`, a new key for signing the crew's posts.
- `src/commands/backup.ts` — `fleetadlc backup` and `fleetadlc restore`, the terminal around `@fleetadlc/backup`.
- `src/commands/cloud.ts` — `fleetadlc cloud configure | pull | push | plan | apply | output | validate`.

## Testing

```bash
pnpm --filter @fleetadlc/cli test                                        # every src/**/*.test.ts
pnpm --filter @fleetadlc/cli exec vitest run src/keep-running.test.ts    # one file
pnpm --filter @fleetadlc/cli build                                       # tsc; bin/fleetadlc.mjs runs this output
```

- **No database, no terminal.** Tests mock `@fleetadlc/db`, give `init` a temporary
  `FLEETADLC_HOME`, and drive backup's decisions through injected ports.
- **Built imports, no type check.** `@fleetadlc/*` resolves to each package's
  `dist/`, and vitest does not type-check: `pnpm build` after editing a package,
  and after the last edit.
- **Not the installed OpenADLC.** From a development shell, `fleetadlc up`, `down`,
  `init`, `seed`, `auth login` and `restore` act on the install at `~/.fleetadlc`
  unless `FLEETADLC_HOME` names a scratch one: [docs/development.md](../../docs/development.md).
