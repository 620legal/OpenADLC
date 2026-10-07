# Extending OpenADLC

Most changes to OpenADLC are one of six kinds: a skill, a role playbook, an engine, a
stage, a health check or a database migration. Each section gives the files to
touch, in order, and the tests that must change with them. A test that would fail
without the change is the evidence; a passing suite on its own is not.

```bash
pnpm build && make ci    # typecheck and unit tests: green before a pull request
```

Changes under `config/`, `infra/`, `.github/workflows/` and
`docs/platform-plan.md` wait for the person `AGENTS.md` names under
`## Human review` — which includes the crew in `config/bots.yaml` and the engine
pins in `infra/local/`.

## A skill

A skill is what a bot does on one task, in order, and when it stops. It is three
things in `crew/skills/<name>/`, read from disk at every task start — mounted
read-only at `/skills` in each task's container — so a change reaches the next
task with nothing to restart (under the compose install, once hostd's image is
rebuilt and hostd restarted).

1. **`crew/skills/<name>/SKILL.md`**, the instructions. Copy the shape of
   `crew/skills/implement/SKILL.md`: `## Do this, in order`, `## Asking a person`,
   `## Stop and ask when`, `## Never`, `## Markers`. A marker is the last line of
   a comment, `<!-- fleetadlc:{"event":"pr_opened"} -->`, and its event is one of
   `FLEETADLC_EVENTS` in `packages/shared/src/markers.ts`: the bridge learns what a
   bot did from it, and reads a comment without one as narration.
2. **`crew/skills/<name>/tools.yaml`**, what the engine may do: `allow.shell` (command
   prefixes, `git rev-parse` as well as `git`), `deny.shell`,
   `allow.files.write_within`, where `<declared_paths>` stands for the paths
   the issue declared, `allow.git` (`push_branch_prefix`, `force_push`,
   `local_ci`) and `deny.github`. A key outside `allow` and `deny` is ignored,
   so a top-level `files:` leaves the skill with nothing it may write. How each
   engine enforces it is in [An engine](#an-engine).
3. **`crew/skills/<name>/tests/<id>.yaml`**, one dry run for each bullet under
   `## Stop and ask when`. Each bullet ends with its id,
   `<!-- scenario: <id> -->`, on a line of its own, and the scenario names it in
   `covers`; an id rather than a place in the list, so a bullet inserted above
   it re-points nothing. A `## Never` bullet can carry one too, for a skill
   with no stop conditions.

   ```yaml
   name: asks to widen its paths when the change needs a file outside the declared ones
   covers: outside-declared-paths  # <!-- scenario: outside-declared-paths --> in SKILL.md
   given:
     declaredPaths: ["src/**"]     # the lease: every path in touch is inside it
   script:                         # what the scripted engine does
     say: ["The seat that shows the widget is defined in config/bots.yaml."]
     touch: ["src/widget.ts"]
     planChange:                   # or ask: { question, options }
       paths: ["config/bots.yaml"]
       reason: "The widget's seat is defined there."
   expect: { stops: true, reason: plan_change }   # question, plan_change, cap or complete
   ```

4. **The place that starts it.** The bridge names the skill when it opens a task
   (`TaskService.open` in `apps/bridge/src/task-service.ts`):

   | Skill | Started from |
   |---|---|
   | `triage` | `apps/bridge/src/stage-handoff.ts` for Intake; `apps/bridge/src/request-queue.ts` for a console request, which `api.ts` queues |
   | `spec` | `apps/bridge/src/stage-handoff.ts` for Design |
   | `implement` | `apps/bridge/src/build-start.ts` for a lease; `openPatch` in `apps/bridge/src/send-back.ts` for a patch round, which `webhooks.ts` asks for through `reviewRound` |
   | `pr-review` | `apps/bridge/src/webhooks.ts` for the first reviewers; `apps/bridge/src/task-service.ts` for the lead's review (`openLeadReview`) and the gate sweep's (`openMissingReviews`) |
   | `resolve-conflict` | `apps/bridge/src/conflict-round.ts` |
   | `deploy`, `qa` | `apps/bridge/src/webhooks.ts` and `apps/bridge/src/scheduler.ts` |

   **Try again** on a task whose row recorded no skill falls back to the
   `SKILL` map in `apps/bridge/src/task-retry.ts`, one skill per kind of task.

5. **No list in `config/bots.yaml`.** A seat carries no list of the skills it
   runs: the places in step 4 that start a task are the record of which seat
   runs what.

A misspelled skill does not stop a task: the runner starts it with no
instructions and a policy that allows nothing. The name the bridge passes in
step 4 has to be the directory's.

**How the prompt is built.** The skill runner (`buildPrompt` in
`apps/hostd/src/skill-runner.ts`) puts together, in this order, what to do, what
the bot is accountable for, and the work itself:

1. `SKILL.md`.
2. Each context file under a `--- <file> ---` line: the role's playbook,
   `crew/roles/<role>.md`; the worktree's `AGENTS.md`; and what the bridge read from
   GitHub for this subject, such as `issue.md` or `reviews.md`
   (`apps/bridge/src/context.ts`).
3. The task itself: the bot, the skill, the subject, the repository, the shell
   commands it may run (“anything else is refused, and nobody is there to approve
   it”), the files it may write, and its spend cap.

The last part is there because every refused command is a turn paid for: a
triage bot tried `git rev-parse HEAD` seven times before it found what it was
allowed.

**Tests.** `tests/skills.test.ts` fails when a skill has no dry run, when a stop
condition has no id or no scenario, when a scenario covers an id its skill does
not carry or has a field the harness does not read, when what a scenario says
happens does not, or when its script writes outside its declared paths. A skill
that asks a person anything must carry the `## Asking a person` rules word for
word — one question per message, choices first, an open question only when no
choices fit — with one question marker that offers choices and one that is
`"open":true`: an intake bot once asked four numbered questions in one message.
A scenario proves the scenario, not the model; whether a real engine stops where
it says is still open in `docs/unverified.md`.
`apps/hostd/src/skill-runner.test.ts` covers the brief.

```bash
pnpm --filter @fleetadlc/tests exec vitest run skills.test.ts
pnpm --filter @fleetadlc/hostd exec vitest run src/skill-runner.test.ts
```

## A role playbook

A skill is what a bot does on one task; a role is what it is accountable for
across every task. A role's playbook, `crew/roles/<role>.md`, is the first context a
task is given, read by hostd at every task start (`contextFilesFor` in
`apps/hostd/src/task-runner.ts`) and mounted read-only at `/roles` in each
container.

Each file states what the bot owns, what it never does and who it hands to, under
`## You own`, `## You never` and `## You hand to`, in under 60 lines, because
every task pays for it in tokens. A rule that can be a check belongs in a check.

**Tests.** `apps/hostd/src/playbooks.test.ts` fails for a role in `BOT_ROLES`
(`packages/shared/src/types.ts`) without a playbook, for a playbook no role has,
for a role in `config/bots.yaml` that is not in `BOT_ROLES`, for a missing
section, and for a file of 60 lines or more. It exists because nine roles once
shared four files, and the spec bot was briefed as a builder with nothing to say
so: a missing playbook is only a warning in hostd's log. `tests/skills.test.ts`
also holds `crew/roles/intake.md` to asking one question at a time.

A new role, not only a new playbook, is also `BOT_ROLES`, a migration that
widens the `role` check on `bots` (`packages/db/migrations/0001_init.sql`),
`roleLabel` and `accountGroupOf` (which account group the role's seat goes on) in `packages/shared/src/onboarding.ts`,
`COMMITTING_ROLES` there if it commits, `NEVER_AUTHORS` in
`packages/shared/src/checks.ts` if it must not, and a seat in `config/bots.yaml`.
The console keeps its own copies, which no test ties to `BOT_ROLES`:
`PIPELINE` and `accountGroupOf` in `apps/console/src/lib/crew.ts`, and
`BY_ROLE` in `apps/console/src/lib/crew-colors.ts`. A reviewer role is also in
the reviewer sets of `apps/bridge/src/items.ts` (`ON_THE_PULL_REQUEST`),
`apps/console/src/lib/signed-posts.ts` and
`apps/console/src/lib/model-onboarding.ts`.

## An engine

An engine is how a provider's model is reached, behind one interface in
`packages/engines/src/types.ts`: `available()`, `run(input)`, which yields
`text`, `tool_call`, `file_change`, `question`, `usage`, `done` and `error`
events, and `usage()`. Two rules come with it:

- **Usage as it happens.** Emit `usage` as each turn reports it, cached input
  included. The runner writes each one to the ledger before the engine's next
  turn, which is where a cap trips; totals reported once at the end would let a
  task run past it. Claude Code and Grok Build report each message, so their
  cap is checked during a run. Codex reports usage only when each `codex exec`
  invocation ends, so a Codex task's cap is checked between invocations, not
  during one. When the bridge does not take a report (it is restarting,
  unreachable, or cannot write), the runner tries again for about a minute,
  sending everything not yet recorded with the next report it takes. If the
  ledger still cannot be written, it stops the engine and fails the task with
  "usage could not be recorded". A headroom check the bridge does not answer
  counts as no headroom, and the engine is not started.
- **No stand-in.** An engine whose `available()` is false fails the task
  (`apps/hostd/src/engine-choice.ts`). A fallback to the scripted engine once
  produced fabricated work that reached a real pull request and a real review.

The files, in order:

| Step | Files |
|---|---|
| The adapter | `packages/engines/src/<engine>.ts`; `spawnJsonLines` in `process-engine.ts` runs a CLI that prints JSON lines, and `runStreamJson` in `stream-json.ts` reads Claude Code's stream format, which Grok Build also writes |
| The name | `ENGINES` in `packages/shared/src/types.ts`, `createEngine` in `packages/engines/src/index.ts`, and a migration widening the `engine` check on `bots` |
| The provider | `MODEL_PROVIDERS` in `packages/engines/src/provider-models.ts` and in `packages/db/src/store/modelAccounts.ts`; `ModelAccount` in `packages/shared/src/types.ts`; `PROVIDERS` in `apps/bridge/src/model-accounts.ts`; `PROVIDERS` and `ArchivedAccount` in `packages/backup/src/archive.ts`; `SPENDING_PROVIDERS` and `PROVIDER_OF_ENGINE` in `packages/db/src/store/spending-limits.ts`; `PROVIDERS` and `PROVIDER_ORDER` in `apps/console/src/lib/model-onboarding.ts`; the provider names shown to people, as in `PROVIDER_NAME` in `apps/bridge/src/health/words.ts` and `PROVIDER_LABEL` in `apps/console/src/components/spending-limits.tsx`; a migration widening the `provider` check on `model_accounts` (`0007_model_accounts.sql`) |
| Which engine an account runs | `ENGINE_PROVIDER`, `PROVIDER_ENGINE`, `ALIAS_FAMILIES` and `SUBSCRIPTION_LISTS_MODELS` in `packages/engines/src/model-choice.ts` |
| The credential | The variable a session is given, in `apps/hostd/src/session-env.ts`; `KEY_SOURCES` and `COMMANDS` in `packages/engines/src/readiness.ts`; for a subscription signed in by device code, `CLI` and `LOGIN_HOME_ENV` in `apps/hostd/src/logins.ts` |
| Pricing | `DEFAULT_PRICES` in `packages/engines/src/pricing.ts`, with the date each rate was checked; an install overrides it in `config/models.yaml` |
| The bot image | The pin in `infra/local/build-bot-image.sh`, as `<package>@<x.y.z>`, and its two verification loops; `ENGINE_PACKAGES` in `packages/shared/src/engine-updates.ts`; `build()` in `apps/hostd/src/engine-updates.ts`; `ENGINES` in `apps/console/src/components/engine-updates.tsx` |

`pnpm build` finds much of what the table misses: a table typed
`Record<ModelProvider, …>`, or the exhaustive switch in `createEngine`, stops
compiling until it has the new one. The `Partial<…>` tables — `ENGINE_PROVIDER`,
`ALIAS_FAMILIES`, `KEY_SOURCES`, `COMMANDS` — do not, which is why they are
named. The provider names themselves are written out by hand in many more
places than the table can promise to keep up with, several as `string[]` or
`Record<string, …>` that the build does not check: a backup refuses an account
whose provider `archive.ts` does not know ("model account N has no known
provider"), and an engine `PROVIDER_OF_ENGINE` does not name escapes the
per-provider spending caps. Before calling a new provider done, look for every
other one by name — `grep -rn "'xai'" apps packages --include='*.ts' --include='*.tsx'` —
and add it beside each.

A model list is asked of the account and kept for three minutes
(`MODEL_LIST_TTL_MS` in `packages/engines/src/model-catalog.ts`), so a model a
provider adds reaches a task after that without a restart. The list is only
the ids a bot can run: `botCanRun` in `packages/engines/src/provider-models.ts`
allows families such as `gpt-5`, `o3`, `*-codex*` and `grok-4.7`, and leaves out
the rest of an OpenAI or xAI list. It is an allowlist, so a new provider needs
its families added there, and in the console's copy in
`apps/console/src/lib/model-onboarding.ts`. Otherwise a key that lists only
unknown families is refused. Anthropic's list is taken as it is. A model the price
table does not name is priced as the model its id extends with a hyphen, a dated
snapshot, or else at a $5 in, $20 out fallback. The fallback is a guess that can
undercharge or overcharge: it charged Fable half its price until it had a row,
and charges every grok-4.x more than its own. The first time a session prices an
id at the fallback, it warns once in its log, naming the id and
`config/models.yaml`. A new model gets a row.

**How `tools.yaml` becomes each engine's permissions.** "Non-empty" below is
the write scope with `<declared_paths>` left out, so a skill whose only entry is
`<declared_paths>` has `Edit` and `Write` denied by both Grok and Claude Code.

| `tools.yaml` | Claude Code (`claude.ts`) | Grok Build (`grok.ts`) | Codex (`codex.ts`) |
|---|---|---|---|
| `allow.shell` | `--allowedTools Bash(<command>:*)`, one rule each | `--allow Bash(<command>:*)`, under a run home that refuses what no rule allows; its own read-only commands run regardless | Any entry: a sandbox that runs commands, with the network; none: `read-only` |
| `deny.shell` | `--disallowedTools Bash(<command>:*)` | `--deny Bash(<command>:*)`, `kubectl` unless allowed, and `Bash` outright when nothing is allowed | Not translated |
| `allow.files.write_within` | Non-empty: `Edit` and `Write` allowed; every run is in `acceptEdits` mode, so empty: `Edit`, `Write`, `MultiEdit` and `NotebookEdit` in `--disallowedTools` | Non-empty: `Edit(./**)` and `Write(./**)`; empty: both denied, a shell `>` included | Not translated |
| `allow.git`, `deny.github` | `FLEETADLC_TOOLS_POLICY`, applied by OpenADLC's `git` and `gh` | The same | The same |

Claude Code rules were once a single `Bash(make,pnpm,git,…)`, which it reads as
one literal command, so every shell call needed an approval nobody could give.
Claude Code is also given `--setting-sources user --strict-mcp-config`, so a
worktree's `.claude/` settings and hooks, `.mcp.json` and `CLAUDE.md` do not
load; Grok Build is never given `--trust`, for the same reason.
Codex's sandbox inside a container is `danger-full-access`, because bubblewrap
cannot run there; the container is the sandbox. The paths themselves are said
to the bot in its brief, and the merge line holds a crew pull request's diff to
its lease's paths, sending one that strays back to its builder (`mergeDecision`).

The adapters run inside the skill runner, which hostd's build bundles into one
file that each container mounts read-only (`apps/hostd/build-runner.mjs`); the
next task runs a rebuilt one. A new pin reaches the bots when the image is
rebuilt: each task's container is made from the image at the task's start.

**Tests.** `packages/engines/src/engines.test.ts` has a block per engine that
runs the adapter against a fake binary and asserts its arguments, its tool
rules and what it reads back; pricing and `config/models.yaml` are there too.
Beside it, `model-choice.test.ts`, `provider-models.test.ts`, `readiness.test.ts`
and `model-catalog.test.ts`; in hostd, `engine-choice.test.ts`,
`session-env.test.ts`, `logins.test.ts` and `engine-updates.test.ts`.

## A stage

A stage is a GitHub label, `adlc:<key>`, and nothing else defines one: the
board's columns are those labels. A bot moves a card forward only by the
moves `isForwardMove` allows. A card moves back only by a send-back to the
stage `previousStage` works out from the issue's history (`BACKWARD` in the
same file; `apps/bridge/src/send-back.ts`): a task's own request, the review
loop, or the bridge after a red smoke or a failed deploy, within the limits in
`config/review.yaml`. A person may move a card anywhere, back only with a
reason.

| Step | Files |
|---|---|
| The stage | `STAGE_KEYS` (the board's order), `STAGE_LABELS`, `STAGE_COLUMN_TITLES`, the forward moves, and the stages a send-back may go to (`BACKWARD`, and `stageBefore` when there is more than one) in `packages/shared/src/stages.ts` |
| Its mode | The `stageModes` default in `packages/shared/src/config.ts`, and `config/repos.yaml` |
| The database | A migration widening the `stage` check on `issues` (`0001_init.sql`) and the `from_stage` and `to_stage` checks on `stage_moves` (`0031_stage_moves.sql`), and setting the `stage_modes` default on `repos` (last set in `0018_assist_is_autonomous.sql`: copy that value, not 0001's), all in `packages/db/migrations/` |
| The label | `config/labels.json`; `fleetadlc github sync-labels` writes it to each repository |
| Who works it | `STAFFING`, `stageAfterIntake` and `stageAfterTask` in `apps/bridge/src/stage-handoff.ts`; `stageOfTask` in `apps/bridge/src/work.ts`; `stageOfSender` in `apps/bridge/src/send-back.ts` if its tasks may send work back; `PAST_DESIGN` in `apps/bridge/src/design-memory.ts` if it comes after Design |
| The board | `STAGES` in `apps/console/src/lib/stages.ts`, a copy with a subtitle each; the empty-column words in `apps/console/src/components/board-view.tsx`; the status line in `apps/console/src/lib/card-status.ts` |

The console keeps its own copy of the stages because it does not depend on
`@fleetadlc/shared`, whose barrel carries the config loader and `node:fs`. A stage
worked by a new kind of task also needs `TASK_KINDS` in
`packages/shared/src/types.ts`, a migration widening the `kind` check on
`tasks`, and the words for its work in `apps/bridge/src/attention.ts` and
`card-status.ts`.

A staffed stage needs its bot started when an issue arrives there, and again by
the hourly sweep, because a webhook that never came, a busy bot and a label
applied while the bridge was down all look the same. Intake and Design were once
columns work went into and never left, because nothing staffed them.

**Tests.** `packages/shared/src/stages.test.ts` (the forward moves, and where a send-back goes),
`apps/console/src/lib/stages.test.ts` (the copy matches, in order),
`apps/bridge/src/stage-handoff.test.ts`,
`apps/console/src/lib/card-status.test.ts` and
`packages/db/src/migrations.test.ts`.

## A health check

The rule in `AGENTS.md`: anything OpenADLC cannot do for itself — a setting no API
reaches, an account only a person can create, a sign-in approved in a browser, a
permission added on the app's page — comes with a check that proves it was done,
by its effect rather than by a setting that says so. The same check is the card
while it fails, the notification when it lasts, the tick on the walkthrough's
step and a line in `fleetadlc doctor`.

1. **The check**, in `apps/bridge/src/health/checks/`, beside the others. It is a
   `HealthCheck` (`apps/bridge/src/health/types.ts`): a stable `id`, a sentence
   for what it `proves` and one for `how`, `everyMinutes`, the walkthrough
   `steps` it answers, and `run(now)`. It takes a reader interface rather than
   the database or GitHub, so a test can hand it fakes. Each result is one of:
   - `ok: true`, with `fixed`, said once when it passes after failing, and
     `note` for something OpenADLC did about it on its own;
   - `ok: false`, with `severity` (`blocking` stops work, `warning` costs
     something and lets it go on), a `title` a person reads first, a `detail`
     saying what to do and why, one `action` (a console path, a GitHub URL or a
     command), and `waitingFor` when another row's fix comes first;
   - `ok: null`, with a `reason`, when it could not be asked. That neither
     raises a card nor clears one: a GitHub that did not answer is not a verdict.

   Console places and a provider's refusals are worded once, in
   `apps/bridge/src/health/words.ts`, which failed tasks use too.
2. **Registration**, in `defaultChecks` in `apps/bridge/src/health/index.ts`,
   with the real readers.
3. **The step**, when it proves something a person does in the walkthrough: its
   key in `MANUAL_STEPS` (`packages/shared/src/onboarding.ts`), the same as the
   console's `?step=`, and in the check's `steps`.
4. **Sooner than its interval**, when something it is about happens:
   `health.runSoon(['<id>'])` from the route or delivery that changes it, as
   `apps/bridge/src/api.ts` does.
5. **Holding work**, when a failure means a build could not land:
   `apps/dispatcher/src/hold.ts` reads rows by `<check>:<subject>`.
6. **Work that waits on it**, when a failure means a bot cannot do a task at all:
   add its id to `PREREQUISITE_CHECKS` and its failure's wording to
   `blockersOf` and `causeOfFailure` (`apps/bridge/src/health/checks/crew.ts`).
   `TaskService.open` then refuses the task while the row fails, or records it
   failed for work only an event starts (`whenBlocked: 'record'`), and
   `retryAfterRecovery` (`apps/bridge/src/scheduler.ts`) runs a task that failed
   for it once when the registry's `onFixed` reports the row passing, or on the
   merge job's sweep after that. It, and the continuation of a build that ended
   without its pull request, start work only where the dispatcher would start
   it now (`dispatcherWouldStart`): the card in the task's stage and free of the
   labels that hold it, and for a build, room under the repository's
   concurrency and no overlapping build in flight.

No migration: every row is kept in `health_checks` by its id.

**Tests.** A block in `apps/bridge/src/health/checks/fleetadlc-checks.test.ts` or
`github-checks.test.ts` with fake readers: failing, passing after failing, and
unknown. `apps/bridge/src/health/registry.test.ts` fails for a `MANUAL_STEPS`
entry no registered check answers — a step the system would never tell anybody
had come undone — and for an id used twice or a check that does not say what it
proves and how.

## A database migration

Migrations are forward-only, numbered, and never edited once merged. `fleetadlc up`
applies every file in `packages/db/migrations/` it has not applied yet, in name
order, each in a transaction, and records the file's name in
`schema_migrations` (`packages/db/src/migrate.ts`). An edited file never runs
again where it already ran, so installs quietly differ; a renamed one runs twice.
A rollback is a traffic decision, never a schema one.

1. **`packages/db/migrations/<NNNN>_<what>.sql`**, numbered after the highest.
   Open with a comment saying why, as every one does. It runs on installs that
   already have rows, inside `fleetadlc up`, and a failure stops the install:
   - `create table if not exists` and `add column if not exists`;
   - a check added to a table with rows is `not valid`, so old rows cannot fail
     it (`0008_model_assignment.sql`);
   - a column is filled before it is required (`0010_bot_slots.sql`);
   - a check from `0001_init.sql` is widened by dropping it under the name
     Postgres gave it, `<table>_<column>_check`, and adding the wider one;
   - nothing is deleted, and a column is dropped only in a later release,
     once no running version reads it (`0019_drop_bot_teams.sql`).
2. **The store**, `packages/db/src/store/<table>.ts`, exported from
   `packages/db/src/index.ts`; shared shapes in `packages/shared/src/types.ts`.
3. **The backup**, when a restore has to carry it, in `packages/backup/src/`:
   the format and its version in `archive.ts`, the read in `live.ts` and
   `contents.ts`, and the write in `apply.ts` (`RestoreDb`, which `live.ts`
   implements), with `plan.ts` and `compare.ts` for what a restore shows.

**Tests.** `packages/db/src/migrations.test.ts` reads a migration statement by
statement and asserts the properties above for one that touches existing rows.
A store's test mocks the client. CI's `migrations apply to an empty database`
step applies them all to Postgres 16. To apply them yourself, name a database of
your own — without `DATABASE_URL` the command migrates the install on 47432.
The command never creates the database, and waits half a minute before saying
one it names does not exist, so make an empty one first:

```bash
createdb -h 127.0.0.1 -p <port> -U fleetadlc scratch
DATABASE_URL=postgres://fleetadlc:fleetadlc@127.0.0.1:<port>/scratch pnpm db:migrate
```
