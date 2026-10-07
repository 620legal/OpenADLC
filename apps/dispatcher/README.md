# @fleetadlc/dispatcher

The dispatcher decides what starts next: it leases each routable issue to a
builder that is free, holds an issue back while another change's declared
paths could touch the same file — while that change is being built on an
ordinary path, until it merges on an exclusive one (migrations, lockfiles,
generated code, schemas), and never on a shared one (`Makefile`, `README*`,
`package.json`, `AGENTS.md`…), as `paths:` in a repository's
`.github/fleetadlc.yml` sorts them — sends an issue that does not say enough to
triage, lifts `blocked` once what an issue waited on has shipped, and leases
nothing once the month's spend reaches its cap. It is a **library**, not a
service. The bridge runs it in-process (`apps/bridge/src/dispatch-runner.ts`)
as soon as something changes that could let work start — an issue or pull
request delivery, a deploy's status, a task ending — and every five minutes
besides. It used to be a process of its own that looked every five minutes; `fleetadlc up`
no longer starts one, and `fleetadlc down` stops one an older install left running
(`RETIRED` in `apps/cli/src/commands/up.ts`).

## How it is run

- **As a library.** `package.json` exports `dist/dispatcher.js`: the `Dispatcher`
  class and the `DispatchDecision` it returns. The bridge builds one when it is
  started with `FLEETADLC_DISPATCH_IN_BRIDGE=1`, which `fleetadlc up` sets except with
  scripted engines (see `docs/development.md`, The integration suites), and calls
  `runOnce()`, one run at a time.
- **As a program, for the suites.** `src/main.ts` is still built to
  `dist/main.js`. The integration suites run one pass with
  `node apps/dispatcher/dist/main.js --once`. `--dry-run` creates no lease but
  still expires, unblocks and triages; without `--once` it repeats every
  `FLEETADLC_DISPATCH_INTERVAL_SECONDS` (300). Nothing in the repository runs
  it as a service: docker-compose and the GCP deployment, like `fleetadlc up`,
  run the dispatcher in the bridge (`FLEETADLC_DISPATCH_IN_BRIDGE=1`).
- **No port.** It listens on nothing.

## What it reads and what it calls

- **Postgres, through `@fleetadlc/db`.** It reads repositories, the crew, unfinished
  tasks, leases, the issues on the board, the health checks' last answers, the
  seats a person paused (and, run on its own, the paused install and
  repositories), the hosts' room for tasks and the spending limits.
  It writes leases — created when it hands work out, released when the bridge
  refuses one, expired when one outlives its hours with no pull request — an
  audit line per expiry, the month's budget row, recomputed from the ledger,
  and `overlap.waited` and `overlap.cleared` events, which it also reads back
  to measure a wait from when it began.
- **The bridge, never GitHub.** Every lease becomes a task through
  `POST /internal/dispatch/lease`; `unblock` and `triage` under
  `/internal/issues/:repo/:number/` become labels written by the automation
  account. Each carries `x-fleetadlc-internal-secret`. The bridge refuses a lease
  while a restore is writing (`apps/bridge/src/dispatch-gate.ts`).
- **Its options.** `costs` from `config/costs.yaml` (`monthlyCapUsd`,
  `warningAt`, `onCap.stopLeasing`), `leaseHours` from `FLEETADLC_LEASE_HOURS` (12),
  and the bridge's URL.

## Source map

- `src/dispatcher.ts` — one pass: expire stale leases, check the budget, then per repository find the idle builders, unblock, triage or lease.
- `src/pool.ts` — who builds in a repository: its owner, then every bot with the owner's role; `builderSlots` caps them at the repository's `concurrency`; an owner with no model builds nothing.
- `src/overlap.ts` — re-exports `@fleetadlc/shared`'s `path-overlap.ts`: whether two sets of declared paths can touch one file, coarse on purpose, and which kind of path they meet on; the merge line's conflict round reads the same policy.
- `src/hold.ts` — passes over a builder the health checks say cannot sign in, is not in the repository, or whose signing key GitHub lacks where signatures are required, and every builder while hostd is not answering: what the bridge would refuse to start.
- `src/main.ts` — the standalone program above.

What makes an issue routable is `listRoutableIssues` in `packages/db/src/store/issues.ts`
(stage `build`, `start:now`, none of `needs-human`, `needs-triage`, any do: label
but `do:ai` (`do:human`, `do:product`, `do:legal`), `fleetadlc:ignore`;
`fleetadlc:next` first);
whether it says enough is `missingForRouting` in `packages/shared/src/readiness.ts`;
what it waits on is `parseDependencies` in `packages/shared/src/dependencies.ts`.

An issue's Expected paths are read by `declaredPathsFrom` in
`packages/shared/src/checks.ts`, every path on a line: several backticked
paths, a list split by commas or "and", and a brace group such as
`src/{gates,send-back}.ts`, which is expanded into its files. What is said
after a path (` — `, ` (`, `: `) is left off. A line that is still not a path
is not declared. When that is all an issue lacks, the dispatcher asks the
bridge (`POST /internal/issues/:repo/:number/expected-paths`) to send the issue
back to the stage that wrote its paths, which rewrites them from the code; it
is labelled `needs-triage` only when it cannot be sent back. Anything else
missing, and three builds with no pull request, still send it to triage.

## Testing

```bash
pnpm --filter @fleetadlc/dispatcher test                                 # every src/*.test.ts
pnpm --filter @fleetadlc/dispatcher exec vitest run src/decide.test.ts   # whole passes against a mocked store
pnpm --filter @fleetadlc/dispatcher build                                # tsc; the bridge imports dist/
```

- **The bridge runs the built copy.** After a change here, build before the
  bridge's tests or a restarted bridge see it. Its own imports of `@fleetadlc/*` are
  built code too, and vitest does not type-check: run `pnpm build` after the
  last edit.
- **The tests mock `@fleetadlc/db`** and need no database. `src/overlap.test.ts` is
  the pattern for pure logic that .github/CONTRIBUTING.md points to.
- **The program leases for real.** `dist/main.js` reads `DATABASE_URL`
  (default: the database on 47432), the install secret under `~/.fleetadlc` and the
  bridge on 47311. Run by hand against those defaults, it leases work on the
  installed OpenADLC, beside the dispatcher its bridge is already running; point it
  at a scratch install ([docs/development.md](../../docs/development.md)). The
  `dev` script runs it every 60 seconds with `--dry-run`, which creates no
  lease but still expires, unblocks and triages. It refuses to start without
  the install's internal secret, and refuses an option it does not read.
