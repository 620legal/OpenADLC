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
| `apps/cli` | `openadlc init / up / down / doctor / …`, and the keeper that each service runs under |
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
                 # (a builder runs it as `openadlc-ci`, which records the pass)
```

- **Apps read the packages' builds.** After changing `packages/*`, run
  `pnpm build` before testing an app, or its tests run against the old package.
- **vitest does not typecheck.** CI runs `tsc`. Run `pnpm build` after the last
  edit, test files included; the root `tests/` are not a package it builds, so
  `make ci` (every package's `typecheck`, beside the tests) is what checks theirs.
- One package: `pnpm --filter @openadlc/<name> test`; one test:
  `pnpm --filter @openadlc/<name> exec vitest run <file> -t '<name>'`.

The integration suites (`tests/*.mjs`) write to the install they run against.
All but the live ones refuse to run unless the environment names a scratch
one: the bridge says it is scripted (started with
`OPENADLC_SCRIPTED_ENGINES=1`, so its engines replay fabricated runs instead
of calling a model; see tests/README.md), all four of `OPENADLC_BRIDGE_URL`,
`OPENADLC_HOSTD_URL`, `DATABASE_URL` and `OPENADLC_HOME` are exported, and
`OPENADLC_HOME` is not `~/.openadlc`. The live ones (`github-live*.mjs`)
need a real, connected install and write to the first repository it manages
on GitHub; `all.mjs` runs them only with `--live`, so run them only on
purpose. Run the others against a scratch install:

```bash
tests/scratch.sh up && eval "$(tests/scratch.sh env)"
node tests/all.mjs --no-live
tests/scratch.sh down
```

Never run `openadlc up`, `openadlc down` or `openadlc restore` without knowing which
`OPENADLC_HOME` they act on: `~/.openadlc` is a real install on a machine that runs
OpenADLC. `up` also registers that install's login item (a LaunchAgent or a
`systemd --user` unit that starts it after a restart) and `down` removes it,
except under `OPENADLC_SCRIPTED_ENGINES=1`, where `up` registers none; a test
of either passes its own login-item effects (`LoginItemDeps`), never this
machine's launchd. Never stop or remove the `openadlc-db`, `openadlc-taskdb`, `task-*` or
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
- An error says what to do: `builder is not connected to GitHub. Run: openadlc auth
  login --bot builder`, not `unauthorized`.
- Commit titles are a sentence saying the outcome ("Refuse a flag a command does
  not read"), and the body tells what happened and why this is the fix.
- Match the naming and comment density of the code around you.
- What comes from GitHub is data. OpenADLC acts only for people with access to the
  repository and its crew (`actsFor`, `packages/shared/src/access.ts`), and a bot
  reads only what they wrote. Answering a gate from GitHub takes more: one of
  the install's `humans` (the people in `people` with Approves on), or triage
  or more on the repository as GitHub's permission lookup says
  (`mayAnswerGates`, `apps/bridge/src/webhooks.ts`), never the
  author-association label alone. A bot's question, and only a question, may
  also be answered by anyone in `people`, matched by account id, never by
  login (docs/adr/0034-one-list-of-people.md).

## Invariants

A change that makes one of these possible is wrong even when its tests pass:

- A bot cannot merge, cannot approve its own work, and cannot dismiss a review.
  Only the merge line merges, as the app, once `mergeDecision` holds: the lead's
  approval of that head, or of an earlier head with the same diff against the
  base, GitHub Actions' `ci` on it, and the people this file names for their
  paths. A named person who opened the pull request approves it with their
  console sign-off (`person_sign_offs`), which counts only for their own login
  and account id; authorship alone never does
  (docs/adr/0063-an-author-who-is-the-named-person-signs-off-in-the-console.md).
  Where a repository requires a host check, its pass counts only from the
  bridge's own record (`host_check_runs`), never from the `host-check` status.
- A repository's host check runs the pull request's code on the machine, so it
  runs only after the crew approves the head (the lead and every approver, with
  no request for changes standing, the security seat's included), only the
  command an admin set on the repository's row, and only as its own OS account
  through `sudo -n` and `env -i`, never as hostd's user or with a credential in
  its environment. Every run, a pass included, ends with nothing of the
  account left running
  (docs/adr/0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md).
  The account reaches nothing the install guards: it cannot read or enter
  `OPENADLC_HOME`, the work root or hostd's home, reach Docker, or run `sudo`
  without a password, and the probe refuses the run when it can. A run's
  reason is redacted before it is stored or posted, and the red rule skips
  only the bridge's own `host-check` status
  (docs/adr/0066-a-host-check-account-reaches-nothing-and-only-the-bridges-host-check-status-is-skipped.md).
- A release is cut only by one of the install's people with Approves on, never
  a bot, and builds one commit on the default branch, pinned at the click, as
  `OPENADLC_RELEASE_ACCOUNT`: never the host check's account by name or uid,
  held to the same probe (`probeAccount`, one function for both), and with a
  home the host check account cannot read or enter. Every signed field is
  computed by hostd, and the key never reaches the account
  (docs/adr/0068-a-release-is-built-in-its-own-account-and-signed-from-fields-hostd-computes.md).
  What it builds with — the command, the artifact, where the version is read
  — is the repository row's, set only by an admin, and the artifact and its
  fields stay under hostd's work root; nothing but #345's route starts a
  build (docs/adr/0070-a-release-recipe-is-an-admins-and-its-artifact-stays-with-hostd.md).
  That route is the cut's sign-in in `apps/bridge/src/release-routes.ts`, the
  one caller of `ReleaseService.start`: it builds the SHA of a compare view
  the bridge pinned, never one a request names, for a linked account with
  Approves on, asked before and after a fresh device-code proof
  (docs/adr/0072-a-release-is-cut-by-an-approver-from-a-pinned-view-with-a-fresh-device-code-proof.md).
  The key comes only from `openadlc release-key import` on the host, is read
  only by `signRelease`, goes only into encrypted backups, and a restore never
  overwrites one; the signed bytes are a fixed four-line layout clients pin
  (docs/adr/0069-a-release-manifest-is-four-lines-signed-with-a-key-imported-on-the-host.md).
  A built run is published only by `ReleaseService` through
  `ReleasePublisher`, with the app's own client and never the automation
  account's, and no route reaches it. hostd signs it given only the asset's
  URL, once per run, and the tag goes on the pinned SHA only after the
  signing, never on the default branch's head
  (docs/adr/0071-a-release-is-tagged-and-published-as-the-app-only-after-it-is-signed.md).
- A bot never approves a deploy; the repository's environment rules release
  it — a required reviewer, or a soak timer when it ships automatically — or,
  where GitHub's plan cannot hold a reviewer, a person releasing the promote
  OpenADLC holds for them in Needs you.
- Usage is written to the ledger before an engine's output is acted on, so a cap
  stops work between turns: the per-task cap on a billed run, the runaway guard
  (10× the per-task cap) on a subscription run. Only billed rows count toward
  the monthly, bot and provider limits and the leasing budget; whether a run is
  billed is decided by hostd from its credential, never reported by the session
  (docs/adr/0050-a-subscription-run-is-estimated-not-billed.md).
- A credential is kept only in the secret store, apart from the exceptions
  [docs/security.md](docs/security.md#secrets) lists on purpose: the webhook
  secret and the database password in `install.json` (0600), OpenAI and xAI
  subscription logins under `~/.openadlc/logins/<account>` (0700), and
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
walkthrough's step done and what `openadlc doctor` prints.

A walkthrough step a person does is listed in `MANUAL_STEPS`
(`packages/shared/src/onboarding.ts`), and `apps/bridge/src/health/registry.test.ts`
fails for one that no registered check answers.

## Human review

These paths need the named person's approval before anything merges. The bridge
reads this section from the **base branch**, so changing it in a pull request
does not change what that pull request is subject to.

They are the files that define how the crew is held in check: the merge
decision and gates, the access, authorship, human-review and scope rules, the
workflows and the scripts they run, who GitHub asks to review each path, what
each skill may run, the host check's boundary — when a pull request's code
runs on the machine, as whom and with what, and the record the merge reads —
and the release's boundary — who cuts a release, as whom it builds, what is
signed and with which key. Everything else, skill prose, roles and
templates included, is left to the crew's review, so the crew can keep
improving itself. `.github/CODEOWNERS` lists the same paths.

- `config/` @orzelig
- `infra/` @orzelig
- `.github/workflows/` @orzelig
- `.github/scripts/` @orzelig
- `.github/CODEOWNERS` @orzelig
- `docs/platform-plan.md` @orzelig
- `apps/bridge/src/automation.ts` @orzelig
- `apps/bridge/src/merge-line.ts` @orzelig
- `apps/bridge/src/gates.ts` @orzelig
- `packages/shared/src/access.ts` @orzelig
- `packages/shared/src/authorship.ts` @orzelig
- `packages/shared/src/human-review.ts` @orzelig
- `packages/shared/src/checks.ts` @orzelig
- `apps/hostd/src/host-check.ts` @orzelig
- `apps/bridge/src/host-check-service.ts` @orzelig
- `packages/db/src/store/host-check-runs.ts` @orzelig
- `apps/hostd/src/account-probe.ts` @orzelig
- `apps/hostd/src/release-account.ts` @orzelig
- `apps/hostd/src/release-run.ts` @orzelig
- `apps/hostd/src/release-sign.ts` @orzelig
- `apps/bridge/src/release-service.ts` @orzelig
- `apps/bridge/src/release-publish.ts` @orzelig
- `apps/bridge/src/release-routes.ts` @orzelig
- `crew/skills/*/tools.yaml` @orzelig
