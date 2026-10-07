# @fleetadlc/db

`fleetadlc_db` as code: the schema (`migrations/*.sql`), the runner that applies it,
the store modules every service reads and writes through, and the program that
loads `config/` into rows. GitHub stays the system of record for issues, pull
requests, reviews and labels; these tables hold what GitHub cannot — the bots
and their hosts, leases, tasks, sessions, threads and gates, the cost ledger and
budgets, settings, model accounts, health checks, the audit and event logs —
and the board's copy of GitHub's issues. It is a library with no process of its
own: the bridge, hostd, the dispatcher, the CLI, `@fleetadlc/backup` and the
integration suites import it. The console does not; it asks the bridge.

## Connecting

- **`DATABASE_URL`**, read when the pool is first used (`src/client.ts`). `fleetadlc
  up` gives each service the URL in `install.json`, whose password is generated
  for that install, so an install's database does not take the fallback used
  when it is unset, `postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db`.
  That fallback reaches a database only where one was started with that
  password, as CI and `tests/scratch.sh` do.
- **Postgres 16.** `fleetadlc up` runs `pgvector/pgvector:pg16` when nothing
  answers; CI uses `postgres:16`. The schema needs the `pgcrypto` extension,
  which `0001_init.sql` creates.
- **Two pools.** `query()`, `queryOne()` and `withTransaction()` use the main
  pool, ten connections. `withAdvisoryLock()` holds each lock on a connection
  from a lock pool of twelve, which the locked work never queries through, so
  lock holders cannot take the connections their own work needs; a waiter
  polls with `pg_try_advisory_lock` and holds none. Both pools refuse after
  thirty seconds with no free connection, with an error naming the pool,
  rather than waiting forever.
- **A connection that dies while held** (a Postgres restart, a failover) is
  logged and thrown away, and the work fails on its next query; it does not
  end the process.
- **Start and stop.** `waitForDatabase()` retries `select 1` for thirty seconds
  before a service starts; `closePool()` ends both pools so a script can exit.

## Migrations and the seed

- **Migrations** are applied by `src/migrate.ts`: every `migrations/NNNN_*.sql`
  not yet in `schema_migrations`, in name order, each in its own transaction.
  They are forward-only, numbered, and never edited once merged
  (.github/CONTRIBUTING.md), so a change is a new file with the next number.
- **A migration's comments describe the design when it was written.** Those
  before 0027 were written when the project was called Fleet: read Fleet as
  OpenADLC, `fleet …` as `fleetadlc …`, `FLEET_*` as `FLEETADLC_*`, and
  `~/.fleet` as `$FLEETADLC_HOME`. Some designs have moved on since: 0003 says branch
  protection lands a pull request, and the merge line now lands it itself, as
  the app (`apps/bridge/src/merge-line.ts`). Numbers were reserved while
  changes were developed side by side, so the notes in 0021, 0031 and 0035
  about taken or skipped numbers are historical; the sequence has no gaps.
- **The seed**, `src/cli/seed.ts`, migrates and then writes `config/bots.yaml`
  into `bots` by seat, keeping any assignment the console made;
  `config/repos.yaml` into `repos`; and the month's budget from
  `config/costs.yaml`. `--scripted-board` adds the integration suites'
  stand-in repository and a board with a card in every column.
- **Who runs them.** `fleetadlc up` runs `dist/cli/migrate.js`, then
  `dist/cli/seed.js` unless `--no-seed`; `fleetadlc seed` runs the seed; `make migrate`
  runs the migrations, and skips without `DATABASE_URL`; the root's
  `pnpm db:migrate` and `pnpm db:seed` run the sources with `tsx`.

## Source map

- `src/index.ts` — the exports: each store as a namespace (`bots`, `issues`, `tasks`…), and the audit and event functions.
- `src/client.ts` — the two pools, `query`, `queryOne`, `withTransaction`, `withAdvisoryLock`, `waitForDatabase`.
- `src/migrate.ts`, `src/cli/migrate.ts` — the runner, and the program `fleetadlc up` runs.
- `src/cli/seed.ts`, `src/cli/seed-crew.ts` — the seed, and the crew loop it runs, seat by seat.
- `src/cli/scripted-board.ts`, `src/cli/scripted-repo.ts` — the suites' stand-in repository and board.
- `src/store/bots.ts` — bots by name, seat and id; model assignments; the row half of a rename.
- `src/store/issues.ts` — the board's issues, what is routable (`listRoutableIssues`) and what is in flight (`workInFlight`).
- `src/store/leases.ts`, `src/store/tasks.ts` — leases and their expiry; tasks and their states.
- `src/store/threads.ts` — threads (each keeping the role and seat it was opened with), messages and gates; a work item's threads and its watermark.
- `src/store/design-memory.ts` — a repository's design memory: proposed, accepted, superseded and retired entries, and the ADR each decision is recorded in.
- `src/store/attachments.ts` — files given to the crew and images read from issues, bytes in the row; nothing else reads `content`, so a bucket can stand behind it later.
- `src/store/costs.ts` — the ledger, which records a concrete model and never an alias, and the budgets.
- `src/store/settings.ts` — the closed list of settings the console may write. `webhookSecret`, the App's private key and its client secret are fields the console sends, but they go to the secret store, never this table; an older install's `webhookSecret` row is moved there when the bridge starts.
- `src/store/audit.ts` — the audit log and the event log, including GitHub deliveries.
- `src/store/health.ts`, `modelAccounts.ts`, `merge-lines.ts`, `credentials.ts` — one table each; the checks' latest answers, model accounts, the merge line, bot sign-in metadata.

## Testing

```bash
pnpm --filter @fleetadlc/db test                                          # every src/**/*.test.ts
pnpm --filter @fleetadlc/db exec vitest run src/store/issues.test.ts -t "breaks a tie on priority"   # by name
pnpm --filter @fleetadlc/db build                                         # tsc; every consumer imports dist/
```

- **No database.** Store tests mock `../client.js` and check the SQL each
  function sends and what it makes of the rows it gets back;
  `migrations.test.ts` reads the SQL files themselves.
- **Consumers read `dist/`.** After changing a store, `pnpm --filter @fleetadlc/db build`
  (or `pnpm build`) before an app's tests or services see it. vitest does not
  type-check, so build after the last edit.
- **The default is somebody's install.** `pnpm db:migrate`, `pnpm db:seed`, the
  package's own `migrate` and `seed` scripts, and any script that imports this
  package act, with no `DATABASE_URL`, on whatever answers on port 47432 — on a
  machine with OpenADLC installed, its database. Export a scratch database's URL
  first: [docs/development.md](../../docs/development.md).
