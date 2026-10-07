# Developing OpenADLC

How to build OpenADLC, check a change, and watch it work end to end without
touching an install that is doing real work. It is written for engineers and
for the bots that work on this repository; [AGENTS.md](../AGENTS.md) is the
short form of it.

## What you need

| Tool | Version | For |
|---|---|---|
| Node | 22 or later | everything |
| pnpm | 10.33.3 (`packageManager` in `package.json`) | the workspace |
| git | 2.41 or later | worktrees; `apps/hostd/src/git-shim.test.ts` runs `git --attr-source`, which older versions refuse |
| tmux | any recent | the local driver's sessions |
| make | any | `make ci` |
| jq | any | `apps/hostd/src/fleetadlc-install.test.ts` runs `infra/local/fleetadlc-install`, which reads hostd's answer with it; macOS 15 and later ship it |
| Docker | any recent | a scratch install's database, and the docker driver |
| jq | any recent | the `fleetadlc-install` wrapper and its tests |
| curl | any | `tests/scratch.sh`, which switches engine updates off on a scratch install with it |
| terraform | 1.6 or later, optional | the `infra/gcp` module's check |
| python3, make, g++ (`build-essential`) | Linux only | `pnpm install` compiles node-pty, which has prebuilt binaries only for macOS and Windows |

## Build and check

```bash
pnpm install          # also restores node-pty's execute bit (apps/hostd/scripts/node-pty-exec-bit.mjs); on Linux, compiles it
pnpm build            # packages first, then apps: apps import @fleetadlc/* from their dist/
make ci               # typecheck and unit tests, what must be green before a pull request
```

Two things trip everybody once:

- **Apps read the packages' builds.** `apps/*` import `@fleetadlc/shared`,
  `@fleetadlc/db` and the rest from each package's `dist/`, in tests too. After
  changing `packages/*`, run `pnpm build` before testing an app, or the app's
  tests run against the old package.
- **vitest does not typecheck.** A test file can pass under vitest and fail
  `tsc`, which CI runs. Run `pnpm build` after the last edit, test files
  included. The root `tests/` are not a package `pnpm build` compiles: `pnpm
  typecheck` (`make ci`) checks them, or `pnpm --filter @fleetadlc/tests
  typecheck` alone.

One package, or one test:

```bash
pnpm --filter @fleetadlc/bridge test                                        # a package's unit tests
pnpm --filter @fleetadlc/bridge exec vitest run src/webhooks.test.ts        # one file
pnpm --filter @fleetadlc/bridge exec vitest run src/webhooks.test.ts -t 'a gate answered'   # one test
```

Unit tests live beside the code they test, as `*.test.ts`. The suites in
`tests/` are different: `tests/*.test.ts` run with `pnpm test` and check the
repository itself (skills, templates, the claims in the docs), and
`tests/*.mjs` drive a running install. [tests/README.md](../tests/README.md)
lists them.

The console's tests run in node and render to static markup, where no effect
runs. A test that needs effects — what a component reads when it mounts, and
whether it stops — starts with `// @vitest-environment happy-dom` and mounts
the component with `react-dom/client`
(`apps/console/src/components/fetch-loops.test.tsx`). A component that reads
on mount and takes a callback from its parent reads that callback through a
ref: a parent passing a new function on every render must not make it read
again.

## A scratch install

`fleetadlc up` starts the install `FLEETADLC_HOME` points at, `~/.fleetadlc` by default.
On a machine that runs OpenADLC that is the real one, with its crew, its
database and its board. To see a change work end to end, start a scratch
install of your checkout beside it.

Do this in a checkout other than the one your real install runs from (a second
clone, or `git worktree add`). A real install runs its services from its
checkout's build and reads `config/` and `crew/` from it, so `pnpm build` or an
edited skill there changes what the running install serves and runs.

```bash
pnpm build
tests/scratch.sh up        # console on :57300, bridge :57311, hostd :57312
tests/scratch.sh down      # stop it and remove its database
```

It shares nothing with another install:

| | A real install | The scratch install |
|---|---|---|
| State | `~/.fleetadlc` | `.scratch/home` in the checkout (gitignored) |
| Database | the `fleetadlc-db` container on :47432 | a `fleetadlc-scratch-db` container on :57432 |
| Ports | 47300, 47311, 47312 | 57300, 57311, 57312 |
| Bots | containers, or tmux sessions on the default server | tmux sessions on a server of its own (`tmux -L fleetadlc-scratch`) |
| Engines | real models | scripted: no model is called |
| GitHub | the crew's accounts | none of the crew's accounts, and nothing is written to GitHub; the walkthrough still asks GitHub's public API, unauthenticated, whether the logins it suggests for the bots exist, and the account type of an owner typed in |
| Engine updates | weekly, rebuilding `fleetadlc-bot:latest` | off, because that image is every install's |
| Dispatching | the bridge, after every change and every five minutes | none in the bridge: the suites run their own passes |

The ports, the directory and the container's name can be changed with
`FLEETADLC_SCRATCH_CONSOLE_PORT`, `FLEETADLC_SCRATCH_BRIDGE_PORT`,
`FLEETADLC_SCRATCH_HOSTD_PORT`, `FLEETADLC_SCRATCH_POSTGRES_PORT`, `FLEETADLC_SCRATCH_DIR`,
`FLEETADLC_SCRATCH_DB_CONTAINER` and `FLEETADLC_SCRATCH_TMUX_SOCKET` (the tmux server
its bots' sessions run on, `fleetadlc-scratch` by default).
`FLEETADLC_SCRATCH_DRIVER=docker` runs it on the docker driver instead, a
container per task as a real install has them, under names and an install
label of its own (`scratch-task-…`, `scratch-tasks`, `scratch-taskdb`) that
`down` removes; `tests/docker-computers.mjs` is the suite for it. `up` refuses a port that is taken rather
than sharing it.

The scratch console at http://127.0.0.1:57300 opens on onboarding, as a new
install does, once you have signed in with the link `up` prints (or
`eval "$(tests/scratch.sh env)" && pnpm fleetadlc console-link`). The console reads the bridge's address when it starts, so a
console built in this checkout talks to the bridge it was started with.

### Working on the console

`next dev` reloads as you edit. Next.js reports anonymous usage to its makers
from `next build`, `next dev` and `next start` by default; set
`NEXT_TELEMETRY_DISABLED=1`, or run `pnpm --filter @fleetadlc/console exec next
telemetry disable` once, to turn it off. Point it at the scratch bridge, on a
port of its own:

```bash
FLEETADLC_BRIDGE_URL=http://127.0.0.1:57311 FLEETADLC_CONSOLE_PORT=57301 \
  FLEETADLC_CONSOLE_SECRET="$(tr -d '\n' < .scratch/home/secrets/console-api-secret.secret)" \
  pnpm --filter @fleetadlc/console dev
```

The secret is what the scratch bridge serves `/v1` for, and what the dev
console signs you in with. Sign in with
`eval "$(tests/scratch.sh env)" && FLEETADLC_CONSOLE_URL=http://127.0.0.1:57301 pnpm fleetadlc console-link`.

Take-over (the Terminal tab) connects the browser straight to hostd's
terminal gateway, at the address in `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL` or, when
that is empty, port 47312 on the console's host. The console reads it when it
starts and hands it to the browser with each terminal token, so changing it
takes a restart, not a rebuild. `tests/scratch.sh` sets none, so take-over on
the scratch console dials :47312, a real install's hostd, which refuses it, and
never the scratch hostd. To use take-over there, export
`NEXT_PUBLIC_FLEETADLC_TERMINAL_URL=ws://127.0.0.1:57312` before
`tests/scratch.sh up`; hostd admits only the origin of the console it was
started with, so the `next dev` console on :57301 cannot use it.

## The integration suites

The suites in `tests/*.mjs` write to the install they run against: leases,
tasks, budgets, deliveries signed with its secret. They also decide what is
leased, a dispatcher pass at a time, so an install whose engines are scripted
starts its bridge without the dispatcher (`fleetadlc up` leaves
`FLEETADLC_DISPATCH_IN_BRIDGE` off and says so): two dispatchers deciding at once
would make the suites flaky. On the scratch console, work is leased by a suite
or not at all.

The suites run only against an install whose engines are scripted, which the
bridge says in `/healthz`. Before anything is read, `tests/scratch-only.mjs`
stops a suite, with exit code 2, when the bridge does not answer or does not
say it is scripted, when any of `FLEETADLC_BRIDGE_URL`, `FLEETADLC_HOSTD_URL`,
`DATABASE_URL` and `FLEETADLC_HOME` is not exported, and when `FLEETADLC_HOME`
is `~/.fleetadlc`: `fleetadlc down` leaves a real install's database running,
and the defaults point at it.

```bash
tests/scratch.sh up
eval "$(tests/scratch.sh env)"       # FLEETADLC_HOME, DATABASE_URL, the three URLs, scripted engines
node tests/all.mjs                     # every suite this machine can run, one verdict
node tests/pipeline.mjs                # or one of them
```

`tests/github-live*.mjs` run only with `--live`: they write to a real
repository with a connected automation account, and clean up after
themselves. They are the only suites meant for a real install, and they act on
its first repository ([tests/README.md](../tests/README.md)).

CI runs these suites on a fresh runner, against an install it starts itself,
and `.github/workflows/ci.yml` decides what a change needs. Every change,
docs alone included, has its commits scanned for secrets: gitleaks, at a pinned
release, reads the commits the pull request adds (or the push brings) with
`.gitleaks.toml`, which allows the tests' fake credentials by their values. A
docs-only change runs the scope check and the tests that read docs. Anything
else runs
actionlint, the build (which is the typecheck), the scope check, unit tests,
migrations on an empty database and the seed, and, except on a draft, the
pipeline, terminal, kill-and-restart, concurrency and onboarding suites. The
Terraform module runs when `infra/gcp/` changed. A pull request from an
`agent/` branch runs once the merge line labels it `adlc:ci`, and a push to
main whose tree already passed on its pull request runs nothing more.

## Running a bot for real

Scripted engines prove the plumbing, not the work. A task that calls a model
needs a real install: a GitHub App, the crew's accounts and a model account,
which the console's onboarding walks through
([self-hosting.md](self-hosting.md)). A skill's behaviour cannot be checked
without one. `tests/skills.test.ts` checks that every "Stop and ask when"
condition in a skill has a scenario in its `tests/` folder, and that each
scenario agrees with its own script; the scripted engine plays the script, not
the skill. Whether a model reading the skill stops takes a live run
([unverified.md](unverified.md)).

## Before a pull request

- **One issue, one pull request**, with `Closes #N` in its body. The project's
  history before publication lived in a private tracker, so code and docs cite
  no issue numbers from before it; say the reason in words instead.
- **Stay inside the issue's Expected paths.** The merge line holds a crew pull
  request to the paths its lease declared, and sends one that strays back to
  its builder with the files named. In this repository CI's scope check
  (`.github/scripts/scope-check.mjs`) also compares the diff with the paths the
  closed issues declare. Both always allow `tests/`, `docs/` and `AGENTS.md`.
  A change that must leave them says so with the `scope:cross-cutting` label.
  A crew pull request that closes no issue waits for a person at the merge;
  CI's scope check does not check one. The check reads every
  closing keyword GitHub does (`Fixed #12`, `Closes: #12`), fails when it cannot
  read an issue rather than passing, ignores a number that is a pull request,
  and runs again when the body is edited. The label counts only when someone
  other than the pull request's author put it on: a person, the OpenADLC app,
  or the automation account. A bot that finds it needs a file outside its lease
  does not take the label — OpenADLC's `gh` refuses it, and the bridge takes
  off one a crew account puts on, audited as `scope.label_refused`. It asks
  for a **plan change** (below), and on approval the file is added to the
  lease and the issue's Expected paths, so both pass without the label. The lead
  reviewer may accept a genuine widening in its approval
  (`"scope":"cross-cutting"` in its `review_posted` marker), and the bridge
  puts the label on as the app once the review's signature checks. On an
  issue whose author is not the repository's owner, a member or a
  collaborator, the check reads the issue as it was when somebody else first
  labelled it, if its author edited it after (`acceptedIssueBody`): a later
  revision counts only when somebody other than the author made it. When that
  text cannot be read it fails and says so, and a person with access edits the
  issue to say what it declares. An author with access that GitHub's
  association does not show, such as a private organisation member, is read
  the same way for edits made after somebody else labelled their issue.
- **A test that would fail without the change.** A green suite on its own
  proves nothing about the change.
- **`make ci` green after the last edit**, and `pnpm build` too. A builder runs
  it through `fleetadlc-ci`, which has hostd run it on the exact commit and
  records the pass; its `git` and `gh` will not push or open a pull request on
  a commit without one. hostd runs it in the worktree when it can prove the
  worktree is that commit's tree, and in a clean checkout of the commit when
  it cannot (hidden index entries, hooks, replace refs and the like); a
  session changing files while it runs is not covered.
- **The docs in the same pull request** when behaviour changes.
- **Paths that need a person.** The `## Human review` section of
  [AGENTS.md](../AGENTS.md), read from the base branch, names who must approve
  a change to the files that define how the crew is held in check: `config/`,
  `infra/`, the workflows, the scope check, `docs/platform-plan.md`, the merge
  decision and gates, the access, authorship, human-review and check rules, and
  each skill's `tools.yaml`. That section is the list; `.github/CODEOWNERS`
  mirrors it. Skill prose, roles, templates and the rest of the code are the
  crew's to review. A change to that section itself needs every person the
  base branch's section names; an edit elsewhere in AGENTS.md needs nobody.

## Plan changes

A task that needs to write outside its lease's paths ends a message with a
`plan_change` marker, in the same way it asks a question
(`crew/skills/implement/SKILL.md`, "Asking to widen your paths"):

```
<!-- fleetadlc:{"event":"plan_change","paths":["apps/hostd/src/skill-runner.ts"],"reason":"the runner drops the field"} -->
```

- **It is a gate with two choices**, `Approve` and `Refuse`, so it shows as a
  question in Needs you and on the issue. The paths and the reason are in it.
  The task pauses like it does for any gate.
- **Who is asked.** When the issue had a design pass, whoever answered its
  spec gate; otherwise the person who filed the console request it came from;
  otherwise the person who filed the issue on GitHub, when they have access to
  the repository; otherwise anyone who may answer a gate: one of the install's
  `humans`, or somebody with triage or more on the repository, as GitHub's
  permission lookup says rather than the author-association label. The task cannot
  choose: a person it names in its request is used only when none of these is
  known. A person signed in to the console is known by an email address;
  they are asked by mentioning the GitHub login whose public email is that
  address. When GitHub
  has none, or several, the question mentions nobody rather than the bot's
  pick, and only ever a login is written as a mention. A person answers `Approve` or `Refuse` (any letter case, or the number
  1 or 2). Any other words grant nothing and go to the bot as they are; a path list a bot wrote is data, and is cleaned before it is
  shown (no space, no `..`, nothing outside the repository).
- **Approve** writes the paths into the issue's Expected paths on GitHub, which
  is where people and OpenADLC's own CI scope check read them, then widens the
  lease, which is what the merge line holds the pull request to, and the issue's
  paths in one statement (`leases.widenPaths`), and resumes the task. GitHub goes
  first because the reconciler rewrites the issue's paths from its body. The
  body is edited as the seat that wrote it: an edit signed as another seat fails
  signature verification (`seat-mismatch`). The resumed task's write scope is
  the widened lease. Answering `Approve` again finishes an approval that stopped
  part-way; every step can be repeated.
- **Refuse** stops the task and releases its lease. `needs-human` stays on the
  issue, because taking it off would hand the issue to the dispatcher, which
  would lease it again and ask for the same paths.
- **A path another lease holds** is not granted. Another active lease, or an
  issue in build or review that declared or changed an overlapping path, holds
  it, whatever the repository's path policy says. The approval is kept, the issue is
  told which issues hold the paths, and the task stays paused. The paths are
  added when that work ends (a task ending, a pull request closing or merging),
  and a person answering `Approve` again tries at once. There is no timer for
  this: a lease that only expires is let go the next time some work ends. A
  task ending, a pull request closing or merging, and an answer that stops a
  task and releases its lease (Refuse, or handing off or abandoning at the
  cost cap) all retry the held approvals. Two paused tasks that each
  ask for a path the other holds wait on each other until a person refuses or
  edits one of them. The issue is told once, when a person's answer holds the
  approval, and again only when the issues it waits on change; a retry that
  finds the same blockers says nothing. The check for a blocking lease and the
  widening are not one step, so another issue can be leased onto the paths in
  between; the window is a GitHub round trip. While
  an approval is held, a comment that is not `Approve` or `Refuse` changes
  nothing: the gate stays open and the issue says what it waits on.
- **`docs/**`** is never asked for by a build or patch task, and triage names
  the documentation a change touches in its Expected paths.

## Expected paths decide what runs together

The dispatcher holds an issue back when its Expected paths overlap work in
flight, by the repository's path policy (`paths:` in `.github/fleetadlc.yml`;
`packages/shared/src/path-overlap.ts` and `blockingOverlaps` in
`apps/dispatcher/src/dispatcher.ts`). Overlap on a shared path (the Makefile,
`README*`, `package.json`, `AGENTS.md` and the like) never holds it; an
exclusive path (migrations, lockfiles, generated code) holds it until the
other change merges; any other overlap holds it while the other issue is being
built, not while it is in review. So the paths decide how many issues can be
built at once on separate builders, and an issue that names a folder waits on
every issue being built that names a file in it. So intake (`crew/skills/triage/SKILL.md`) lists
files: each file the change edits, the test beside each, and the docs page it
updates. A folder is listed only for files the change adds, and then the
narrowest one. When an issue has a design pass, the design stage
(`crew/skills/spec/SKILL.md`) replaces the list with the files its design names.

Every path on a line is read (`declaredPathsFrom`, `packages/shared/src/checks.ts`):
`` `a.ts`, `a.test.ts` ``, `a.ts, a.test.ts` and `a.ts and a.test.ts` are two
files each, a brace group such as `apps/bridge/src/{gates,send-back}.ts` is
expanded into its files (at most 16 from one path, as many as
`{a,b}/{c,d}/{e,f}/{g,h}` names; one that would name more is left as written,
so its line is not a path), and what is said after a path (`` `greet.mjs` — the
greet function ``) is left off. A path with a space in it is written in
backticks. A line that is still not a path ("the migration and its test") is
not declared: the bridge sends the issue back to the stage that wrote the
paths, quoting the line, and that stage rewrites the section from the code,
one file per line. Only when it cannot be sent back is it labelled
`needs-triage`, for a person.

An issue held back says what it waits for. The dispatcher's decision reads
`declared paths overlap work in flight: #68 (apps/bridge/src/gates.ts against
apps/bridge/src), being built`, naming each issue in flight, each pair of paths
that collide, the issue's own first, and what holds it (`being built`, or an
exclusive path being built or in review).

## Never, on a machine that runs OpenADLC

- `fleetadlc up`, `fleetadlc down` or `fleetadlc restore` without knowing which
  `FLEETADLC_HOME` they act on. Every `fleetadlc` command reads `~/.fleetadlc` unless told
  otherwise.
- `docker rm` or `docker stop` of `fleetadlc-db`, `fleetadlc-taskdb`, a `task-*` or a
  `bot-<name>` container, or the `fleetadlc-tasks` network: those names belong to
  the real install, and a `task-*` container is a running task's computer.
- `pnpm build` in the directory a real install runs from, without restarting it
  (`fleetadlc down && fleetadlc up`): the running console serves the old build and
  fails with `ChunkLoadError`.
