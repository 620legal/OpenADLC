# @fleetadlc/hostd

hostd is the runner, and it owns the tasks' computers. Under the `docker`
driver each task gets a container of its own, `task-<id8>`, made when the task
starts and removed when it ends — or a while after it pauses on a person
(`FLEETADLC_PAUSED_KEEP_MINUTES`, fifteen by default) — on the install's one
network, `fleetadlc-tasks`, which keeps its containers from reaching each
other; a task whose seat runs checks gets a database of its own on the host's
task database server, `fleetadlc-taskdb`. A seat is the task's GitHub
identity, never its computer. Under `local` a task's computer is its folder
and tmux sessions on the host, with no isolation at all. hostd starts,
resumes, cancels and ends tasks — a fresh clone of its repository's warm bare
mirror, an environment minted for the session, a tmux session running the
skill runner — watches every session, takes back computers that outlived it
after a restart, serves the terminal take-over, signs model subscriptions in,
answers whether each bot's engine and model credential are ready to run a task, and updates the engine CLIs in the bot
image once a week. It decides nothing about what runs: the
bridge tells it. It holds no refresh token either; it asks the bridge's token
service for a bot's GitHub token when a task starts (`src/token-client.ts`).

## Running

- **Entry point.** `src/main.ts`, built to `dist/main.js`. The build also bundles
  `dist/skill-runner.bundle.mjs` (`build-runner.mjs`), which the docker driver
  mounts read-only into every container, so a rebuilt runner reaches the next
  task without recreating one. `fleetadlc up` starts hostd first, under the keeper
  (`apps/cli/src/keep-running.ts`), with the environment `serviceEnv()` builds
  from `install.json`. Log: `~/.fleetadlc/run/hostd.log`.
- **Port.** 47312 on every interface: `FLEETADLC_HOSTD_PORT`, from `ports.hostd` in
  `install.json`, default `DEFAULT_PORTS.hostd`. The terminal socket shares it.
- **Configuration.** `src/config.ts`. `FLEETADLC_HOSTD_DRIVER` picks the driver, and
  `fleetadlc up` sets it from `install.json` over anything exported. Work lives in
  `FLEETADLC_WORK_ROOT` (`~/.fleetadlc/work`: `mirrors/`, a task's `slots/<task>/`,
  the local driver's `cache/`), subscription sign-ins in
  `FLEETADLC_LOGIN_ROOT` (`~/.fleetadlc/logins/<account>`); the image is `FLEETADLC_BOT_IMAGE`
  (`fleetadlc-bot:latest`, built by `infra/local/build-bot-image.sh`).

## Who calls it

| Surface | Caller | Authentication |
|---|---|---|
| `GET /healthz` | `fleetadlc up`, `fleetadlc status`, the bridge | none; it answers nothing a caller could act on |
| every other route (`src/server.ts`) | the bridge (`apps/bridge/src/hostd-client.ts`), `fleetadlc attach`, `fleetadlc restore`, the integration suites; `fleetadlc doctor` calls `/bots/builder/sessions` without the secret on purpose, to prove the 401 | `x-fleetadlc-internal-secret`; `x-fleetadlc-on-behalf-of` names the person for the audit log, taken on trust |
| `GET /tasks/:id/registry-token` | that task's own session | its `x-fleetadlc-task-token`, or the install secret |
| `WS /terminal` | the console's browser, `tests/terminal.mjs` | a one-use, sixty-second attach token as the subprotocol `fleetadlc-attach.<token>`; a browser's `Origin` must be the console's (`FLEETADLC_CONSOLE_URL`) |

The secret is read per request, and until one exists every authenticated route
answers 503. hostd reads and writes Postgres through `@fleetadlc/db`, calls the
bridge's `/internal/tokens/:bot` and the providers' model lists, and runs
`docker`, `tmux`, `git`, `ssh-agent` and, for the engine update, `npm`. Inside a
session, the skill runner reports state, usage, messages and gates to the
bridge's `/internal/tasks/:id/*` with the task token.

## Source map

- `src/main.ts` — picks the driver, registers the host with its capacity, carries paused tasks' branches out of the per-bot mirrors from before, makes the task network and the task database server, retires the seats' old containers, takes back computers that outlived the last hostd, fills the warm pool, starts the server. Under the local driver it brings each bot's idle shell up.
- `src/server.ts`, `src/auth.ts` — the HTTP API, and what a caller has to prove.
- `src/task-runner.ts` — a task end to end: model, the host's room, a computer of its own (`acquire`), a clone, `make setup` against its own database, context files, session; at its end its branch kept in the mirror and its computer released; a paused one's computer given back after `FLEETADLC_PAUSED_KEEP_MINUTES`.
- `src/task-attachments.ts` — the files a task's work item carries, fetched from the bridge (`/internal/attachments/:id`), checked against their hash and written under `<context dir>/attachments/` and listed in `attachments.md`. A text file is also a context document, so its text goes into the prompt. Images and PDFs never are: they are passed by path in `FLEETADLC_ATTACHMENTS`.
- `src/skill-runner.ts`, `src/engine-choice.ts` — the process a session runs: the engine, usage to the ledger as it arrives, a gate at the cap.
- `src/session-env.ts`, `src/drivers/base-env.ts` — all a session inherits, under `env -i`: tokens, the engine's credential, the signing agent.
- `src/model-resolution.ts` — the model a task calls, an alias resolved against what its account lists.
- `src/drivers/types.ts`, `docker.ts`, `local.ts`, `tmux.ts` — the one interface to a task's computer, and its two drivers: `acquire` makes a task's computer (its directory under `slots/<task>`, its database emptied) when it starts, `release` takes it down — sessions, database, directory — when it ends, and sessions are still listed, killed and attached per bot, the driver knowing which computer each is in.
- `src/worktree.ts`, `src/worktree-files.ts` — one mirror per repository, touched only by hostd under a lock, and a self-contained clone per task (`git clone --local`), whose branch is kept in the mirror when its computer goes; the bounded read-only view the console's Computer tab reads.
- `src/observer.ts` — every ten seconds: records sessions and their output, and stops a task whose session has been missing from three listings in a row. A listing that could not be read stops nothing. Every minute it reaps: a computer whose task is over goes, one whose task still runs is taken back after a restart, a paused task's is given back once it has been paused past its keep time, and folders nothing holds are cleared with their branches kept.
- `src/task-db.ts` — the host's task database server: a role and a database per task, from a template with the usual extensions, closed to every other role, dropped with the computer.
- `src/legacy.ts` — retiring each seat's container, sidecar and network from before a task had its own.
- `src/warm-pool.ts` — computers made ahead of their task (`FLEETADLC_WARM_POOL`, off by default), claimed by resizing and renaming one, drained on a replaced image, after a day and at start.
- `src/terminal-gateway.ts`, `src/attach-tokens.ts` — take-over as `tmux attach` bridged to a WebSocket. `POST /terminal/tokens` takes a `taskId` as well as a bot and a session, and then mints for that task's own session, or says why it has none (409: a paused task whose computer was given back, with the branch its work is on).
- `src/logins.ts` — subscription sign-ins, account checks and model lists, with the image and credential a session would have.
- `src/engine-updates.ts` — the weekly engine update: candidate image, proof, swap, rollback.
- `src/rename.ts` — moving a bot's computer and folder when it takes its account's handle.
- `src/scripted-runs.ts` — fabricated runs for the integration suites, used only under `FLEETADLC_SCRIPTED_ENGINES=1`.

## Testing

```bash
pnpm --filter @fleetadlc/hostd test                                    # every src/**/*.test.ts
pnpm --filter @fleetadlc/hostd exec vitest run src/server.test.ts -t "refused to a caller without"   # by name
pnpm --filter @fleetadlc/hostd build                                   # tsc, then the runner bundle
```

- **Real tools, fake services.** Tests run the real `git`, `ssh-keygen`,
  `ssh-agent` and, when installed, `tmux` (`drivers/tmux.test.ts` names its
  session `fleetadlc__tmuxtest__<pid>`). Docker answers from a script, the database
  is mocked, the secret store is in memory, and nothing reaches the network.
- **Imports are built code, and vitest does not type-check.** After editing a
  package, `pnpm build` before these tests see it, and again after the last edit.
- **Names are machine-wide.** Containers are `task-<id8>`, the network
  `fleetadlc-tasks` and the database server `fleetadlc-taskdb` on the machine's
  Docker — another install names its own after `FLEETADLC_BOT_PREFIX` — and the
  local driver's sessions are `fleetadlc__<bot>__<session>` on the default tmux
  server, so two local installs with the same seats on one machine collide. `dev` and `start` also default to port 47312, `~/.fleetadlc` and the
  database on 47432. Run a second install as
  [docs/development.md](../../docs/development.md) describes.
