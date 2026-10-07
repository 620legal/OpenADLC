# @fleetadlc/bridge

The bridge is OpenADLC's event loop, and the one process that acts on GitHub. It
receives GitHub's webhook deliveries, serves the console's API, and is the
install's token service: while it runs, hostd and the CLI ask it for a bot's
GitHub token rather than refreshing one of their own. Only when nothing answers
on its port does `fleetadlc github` refresh one itself, under the same lock, and
`fleetadlc restore` refreshes each GitHub sign-in once to take it over. From those it runs the GitHub
automation (stage labels, reviewer requests, `review:human`, the `review-gate`
status), opens and settles gates, starts and resumes tasks on hostd, keeps the
merge line, runs the recurring jobs and the health checks, and decides what
starts next. `@fleetadlc/dispatcher` is a library the bridge runs in-process
(`src/dispatch-runner.ts`), not a service. Its state is Postgres, through
`@fleetadlc/db`.

## Running

- **Entry point.** `src/main.ts`, built to `dist/main.js`. `fleetadlc up` starts it
  after hostd, under the keeper (`apps/cli/src/keep-running.ts`), with the
  environment `serviceEnv()` builds from `install.json` (`apps/cli/src/install.ts`)
  plus `FLEETADLC_DISPATCH_IN_BRIDGE=1`, or `0` when `FLEETADLC_SCRIPTED_ENGINES=1`.
  Without it set to `1` it does not dispatch, which is how CI's integration job
  and a scratch install run it: the suites dispatch for themselves. Log: `~/.fleetadlc/run/bridge.log`.
- **Port.** 47311 on every interface: `FLEETADLC_BRIDGE_PORT`, which `fleetadlc up` takes
  from `ports.bridge` in `install.json`; the default is `DEFAULT_PORTS.bridge` in
  `packages/shared/src/env.ts`. Every interface, because a task's container
  reaches `/internal/tasks/*` through the Docker gateway; `/v1` is held to the
  console secret instead.
- **The console secret.** In `local` mode the bridge makes it on first start
  (`ensureConsoleSecret()`) and refuses to start without one; `iap` mode never
  reads it.
- **Configuration.** `src/config.ts` reads the environment once, at start. What
  the console can change — organization, App client id, webhook secret, humans,
  public URL — is read from the settings table on each use and wins over the
  environment (`src/effective-config.ts`), so none of it needs a restart.

## Who calls it

| Routes | Called by | Authenticated by |
|---|---|---|
| `/v1/*` (`src/api.ts` and the modules it registers) | the console's server; `fleetadlc status`, `doctor`, `attach` | the person: in `local` mode (the default), `x-fleetadlc-identity`, believed only beside `x-fleetadlc-console-secret`, the console secret (`consoleSecretRef()`) that only the console's server and the CLI hold; without it, 401 before any handler runs (`src/identity.ts`). A verified IAP assertion when `FLEETADLC_IDENTITY_MODE=iap`. A browser `POST` or `PATCH` from any origin but the console's is refused (`src/router.ts`) |
| `/internal/*` (`src/internal-api.ts`) | hostd's token client, the dispatcher (over HTTP to its own port), the CLI, the integration suites | `x-fleetadlc-internal-secret`, the install secret from the secret store. `/internal/tasks/:id/*` also takes the skill runner's `x-fleetadlc-task-token`, an HMAC of that task's id, and `/internal/alerts` an outside monitor's `x-fleetadlc-alerts-secret` (`alertsSecretRef()`), which opens no other route |
| `/webhooks/github` | GitHub, directly or through the tunnel's one-route gateway (`src/webhook-gateway.ts`) | the `x-hub-signature-256` HMAC; with no webhook secret, every delivery is refused. A verified delivery is acted on only for a repository OpenADLC works in, by full name, and an author with access or one of the crew (`actsFor`) |
| `/healthz` | `fleetadlc up`, `fleetadlc status`, `tests/all.mjs` | none |

It calls Postgres through `@fleetadlc/db`; hostd with the install secret
(`src/hostd-client.ts`); and GitHub, as a bot's own account through
`src/actors.ts` (the install's token broker; see above for the CLI's locked fallback and restore's take-over), or as the App itself — its
JWT or an installation token — for invitations, repository rules and the App's
own webhook. The trust boundaries are in [docs/security.md](../../docs/security.md).

## Source map

- `src/main.ts` — wires everything, listens, then renames bots, lets the crew into repositories, resumes the tunnel, starts health checks and dispatch.
- `src/router.ts`, `src/identity.ts` — routing, the origin refusal, and who a request is.
- `src/api.ts` — the console API: board, crew, threads, gates, sessions, requests, repositories, onboarding, install settings.
- `src/items.ts`, `src/item-routes.ts`, `src/thread-messages.ts`, `src/thread-stream.ts` — a work item (a request, its issue and its pull request) as one conversation labelled by role; where a message written on it goes; the change streams for a bot's panel and an item's view.
- `src/issue-assets.ts` — images in an issue's body and comments, by people OpenADLC acts for, downloaded from GitHub's image hosts only and kept with the work item, for intake, design and the build.
- `src/design-memory.ts` — what the design stage remembers per repository: proposed from a design comment's marker, accepted by a person's answer or the move to build, given to design tasks only, pointed at its ADR once merged, and corrected in Settings.
- `src/attachment-routes.ts` — a file given to the crew: uploaded unclaimed, claimed by the request or message it is sent with, served so it cannot run, removed by an admin.
- `src/internal-api.ts` — the webhook route, the token service, task reports, leases, schedule triggers, `/healthz`.
- `src/webhooks.ts` — what each delivery does to the board, the stages, the merge line and the gates, and when it asks for a dispatch.
- `src/automation.ts`, `src/automation-bot.ts` — labels, reviewer requests and `review-gate`, as the automation account.
- `src/task-service.ts`, `src/context.ts` — opening and resuming a task on hostd, briefed with what GitHub says about its subject.
- `src/gates.ts`, `src/notify.ts` — a question as a GitHub comment and a thread row, and who is told.
- `src/stage-handoff.ts`, `src/merge-line.ts` — who staffs a stage and where an issue goes next; the order pull requests land in.
- `src/scheduler.ts`, `src/job-timer.ts` — the recurring jobs and their intervals (`FLEETADLC_JOB_<NAME>_MINUTES`; 0 turns one off).
- `src/reconciler.ts` — GitHub against the board, and the deliveries that never came.
- `src/dispatch-runner.ts`, `src/dispatch-gate.ts` — when the dispatcher runs, and the pause a restore holds.
- `src/health/` — the checks that prove a person's step was done: `index.ts` lists them, `registry.ts` runs them.
- `src/onboarding.ts`, `src/webhook-setup.ts`, `src/repo-setup.ts`, `src/crew-access.ts`, `src/bot-names.ts` — the walkthrough's steps and what keeps them true.
- `src/backup.ts`, `src/restore-into.ts` — backup, restore and undo from the console, over `@fleetadlc/backup`.

## Testing

```bash
pnpm --filter @fleetadlc/bridge test                                   # every src/**/*.test.ts
pnpm --filter @fleetadlc/bridge exec vitest run src/webhooks.test.ts   # one file
pnpm --filter @fleetadlc/bridge exec vitest run src/webhooks.test.ts -t "reverts on a failed smoke"   # one test, by name
pnpm --filter @fleetadlc/bridge build                                  # tsc, the type check vitest skips
```

- **Imports are built code.** `@fleetadlc/*`, the dispatcher included, resolve to each
  package's `dist/`. After editing one, run `pnpm build` (or
  `pnpm --filter @fleetadlc/<name> build`) before the bridge's tests see the change.
- **vitest does not type-check.** `tsc` compiles the test files too and is what
  CI builds with, so run `pnpm build` after the last edit.
- **Nothing real.** Tests mock `@fleetadlc/db`, fake hostd and GitHub, and hand
  `setSecretStore()` an in-memory store, so none needs a database, a service or
  the network. A new test must do the same: the default store is
  `$FLEETADLC_HOME/secrets`, by default `~/.fleetadlc/secrets`.
- **Not against the installed OpenADLC.** `pnpm --filter @fleetadlc/bridge dev`
  (`tsx watch src/main.ts`) and `start` default to port 47311, the database on
  47432 and `~/.fleetadlc`. Point them at a scratch install first; see
  [docs/development.md](../../docs/development.md).
