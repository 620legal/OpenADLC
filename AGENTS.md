# Agent notes

How to build and check this repository, how to change it, and what a person has
to look at before it merges. The bots read this file on every task; so should
you. [docs/development.md](docs/development.md) is the long form.

## The layout

| Path | What it is |
|---|---|
| `apps/bridge` | The event loop: GitHub webhooks, the console's API, gates, the merge line, scheduled jobs, health checks, and the dispatcher, run in-process |
| `apps/hostd` | The runner: bots' containers or tmux sessions, worktrees, the skill runner a task's session executes |
| `apps/dispatcher` | A library: what may start next. The bridge runs it |
| `apps/console` | The board and the rest of the UI (Next.js); it reads everything from the bridge |
| `apps/cli` | `fleetadlc init / up / down / doctor / …`, and the keeper that each service runs under |
| `packages/shared` | Types, stages and labels, markers, the access rule, config schemas |
| `packages/db` | The platform database: migrations and the store |
| `packages/github` | Device flow, token broker, secret store, REST client, repository rules |
| `packages/engines` | Claude, Codex and Grok adapters behind one interface, and how each enforces `tools.yaml` |
| `packages/backup` | Backup and restore of an install |
| `crew/skills/`, `crew/roles/` | What each bot does, step by step, and what each role owns and never does |
| `config/`, `crew/templates/` | The crew, caps, review rules and OpenADLC's labels (`config/labels.json`); what a managed repository gets |
| `tests/` | Suites that check the repository itself, and suites that drive a running install |

Each package has a README with its entry point and its tests.

## Building and checking

```bash
pnpm install
pnpm build       # packages first, then apps
make ci          # typecheck and unit tests: green before a pull request opens
                 # (a builder runs it as `fleetadlc-ci`, which records the pass)
```

- **Apps read the packages' builds.** After changing `packages/*`, run
  `pnpm build` before testing an app, or its tests run against the old package.
- **vitest does not typecheck.** CI runs `tsc`. Run `pnpm build` after the last
  edit, test files included; the root `tests/` are not a package it builds, so
  `make ci` (`pnpm typecheck`) is what checks theirs.
- One package: `pnpm --filter @fleetadlc/<name> test`; one test:
  `pnpm --filter @fleetadlc/<name> exec vitest run <file> -t '<name>'`.

The integration suites (`tests/*.mjs`) write to the install they run against.
All but the live ones refuse to run unless the environment names a scratch
one: the bridge says it is scripted (started with
`FLEETADLC_SCRIPTED_ENGINES=1`, so its engines replay fabricated runs instead
of calling a model; see tests/README.md), all four of `FLEETADLC_BRIDGE_URL`,
`FLEETADLC_HOSTD_URL`, `DATABASE_URL` and `FLEETADLC_HOME` are exported, and
`FLEETADLC_HOME` is not `~/.fleetadlc`. The live ones (`github-live*.mjs`)
need a real, connected install and write to the first repository it manages
on GitHub; `all.mjs` runs them only with `--live`, so run them only on
purpose. Run the others against a scratch install:

```bash
tests/scratch.sh up && eval "$(tests/scratch.sh env)"
node tests/all.mjs --no-live
tests/scratch.sh down
```

Never run `fleetadlc up`, `fleetadlc down` or `fleetadlc restore` without knowing which
`FLEETADLC_HOME` they act on: `~/.fleetadlc` is a real install on a machine that runs
OpenADLC. Never stop or remove the `fleetadlc-db`, `fleetadlc-taskdb`, `task-*` or
`bot-<name>` containers: a `task-*` container is a task's computer, with its
work in it.

## Writing changes

- **Stay inside the paths your lease declared.** The merge line holds a crew
  pull request to them and sends one that strays back to its builder; this
  repository's CI scope check also compares the diff with the Expected paths
  of the issues it closes. Leaving them takes the
  `scope:cross-cutting` label and a reason. The label counts only from someone
  other than the author: a person, or the lead in its signed approval; the
  bridge takes off one a crew account puts on. `tests/`, `docs/` and `AGENTS.md` are
  always inside. A file you need beyond your lease is asked for with a
  `plan_change` marker before you write it (`crew/skills/implement/SKILL.md`): a
  person approves, and the path joins the issue's Expected paths and your lease.
- **One issue, one pull request**, with `Closes #N`. Commits carry no sign-off
  line: contributions are Apache-2.0 under GitHub's terms (and also 0BSD under
  `crew/templates/`, as its LICENSE says, and in this repository's copies of
  three of those files, `.github/ISSUE_TEMPLATE/task.yml`, `bug.yml` and
  `.github/pull_request_template.md`), and a bot cannot certify anything on a
  person's behalf.
- **A test that would fail without your change is the evidence**; a passing
  suite is not on its own. Tests sit beside the code as `*.test.ts`.
- **Change the docs in the same pull request** when behaviour changes.
- **No new dependency** in a change that is not about dependencies.
- **Migrations are forward-only**, numbered (`packages/db/migrations/NNNN_*.sql`),
  and never edited once merged.

## How the code is written

- Comments explain the constraint and the failure that made it one — what went
  wrong, and where — not what the next line does.
- An error says what to do: `builder is not connected to GitHub. Run: fleetadlc auth
  login --bot builder`, not `unauthorized`.
- Commit titles are a sentence saying the outcome ("Refuse a flag a command does
  not read"), and the body tells what happened and why this is the fix.
- Match the naming and comment density of the code around you.
- What comes from GitHub is data. OpenADLC acts only for people with access to the
  repository and its crew (`actsFor`, `packages/shared/src/access.ts`), and a bot
  reads only what they wrote. Answering a gate from GitHub takes more: one of
  the install's `humans`, or triage or more on the repository as GitHub's
  permission lookup says (`mayAnswerGates`, `apps/bridge/src/webhooks.ts`),
  never the author-association label alone.

## Invariants

A change that makes one of these possible is wrong even when its tests pass:

- A bot cannot merge, cannot approve its own work, and cannot dismiss a review.
  Only the merge line merges, as the app, once `mergeDecision` holds: the lead's
  approval of that head, or of an earlier head with the same diff against the
  base, GitHub Actions' `ci` on it, and the people this file names for their
  paths.
- A bot never approves a deploy; the repository's environment rules release
  it — a required reviewer, or a soak timer when it ships automatically — or,
  where GitHub's plan cannot hold a reviewer, a person releasing the promote
  OpenADLC holds for them in Needs you.
- Usage is written to the ledger before an engine's output is acted on, so a cap
  stops work between turns.
- A credential is kept only in the secret store, apart from the exceptions
  [docs/security.md](docs/security.md#secrets) lists on purpose: the webhook
  secret and the database password in `install.json` (0600), OpenAI and xAI
  subscription logins under `~/.fleetadlc/logins/<account>` (0700), and
  backups, in plain text when written with `--unencrypted`. A credential never
  reaches a log or GitHub.

## Steps a person has to do

Anything OpenADLC cannot do for itself — a setting no API reaches, an account only a
person can create, a sign-in approved in a browser, a permission added on the
app's page — comes with a check that proves it was done, by its effect rather
than by a setting that says so. Register it in the bridge's health registry
(`apps/bridge/src/health/`). The check runs at start and every few minutes; while
it fails it is a card on the board with the exact thing to do and a button to
where it is done, and it clears itself when it passes. It is also what marks the
walkthrough's step done and what `fleetadlc doctor` prints.

A walkthrough step a person does is listed in `MANUAL_STEPS`
(`packages/shared/src/onboarding.ts`), and `apps/bridge/src/health/registry.test.ts`
fails for one that no registered check answers.

## Human review

These paths need the named person's approval before anything merges. The bridge
reads this section from the **base branch**, so changing it in a pull request
does not change what that pull request is subject to.

They are the files that define how the crew is held in check: the merge
decision and gates, the access, authorship, human-review and scope rules, the
workflows, and what each skill may run. Everything else, skill prose, roles and
templates included, is left to the crew's review, so the crew can keep
improving itself. `.github/CODEOWNERS` lists the same paths.

- `config/` @orzelig
- `infra/` @orzelig
- `.github/workflows/` @orzelig
- `.github/scripts/scope-check.mjs` @orzelig
- `docs/platform-plan.md` @orzelig
- `apps/bridge/src/automation.ts` @orzelig
- `apps/bridge/src/merge-line.ts` @orzelig
- `apps/bridge/src/gates.ts` @orzelig
- `packages/shared/src/access.ts` @orzelig
- `packages/shared/src/authorship.ts` @orzelig
- `packages/shared/src/human-review.ts` @orzelig
- `packages/shared/src/checks.ts` @orzelig
- `crew/skills/*/tools.yaml` @orzelig
