# Integration suites

`tests/` holds the checks that cross package boundaries. The `*.mjs` suites drive
a running install through its HTTP routes and its database. The `*.test.ts`
files are vitest: they read the repository's own files — workflows, templates,
the Terraform module, the skills — and need nothing running. Unit tests live
beside the code in each package; `pnpm test` runs all of them, these
`*.test.ts` files included.

> **The suites default to the install at `~/.fleetadlc`.** The `*.mjs` suites read
> `DATABASE_URL` (default `postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db`),
> `FLEETADLC_HOME` (default `~/.fleetadlc`, for the install secret) and
> `FLEETADLC_BRIDGE_URL`, `FLEETADLC_HOSTD_URL`, `FLEETADLC_CONSOLE_URL` (defaults on ports
> 47311, 47312, 47300) — the database and ports of the installed OpenADLC, on a
> machine that has one. They run under plain `node`, not through `fleetadlc`, so the
> ports and database in a scratch install's `install.json` do not reach them.
> They clear tables to start from a known state: `pipeline.mjs`,
> `concurrency.mjs`, `kill-and-restart.mjs` and `docker-computers.mjs` delete
> every task and lease; `pipeline.mjs` and `concurrency.mjs` also delete every
> gate and session; `pipeline.mjs` also deletes ledger, merge-line and audit
> rows, cancels every task hostd holds and rewrites the month's budget cap.
> **Run them only against a scratch install, with the variables
> `tests/scratch.sh env` prints exported for it**: see
> [docs/development.md](../docs/development.md).

## Running

```bash
pnpm build                          # the suites import @fleetadlc/* from dist/ and run the dispatcher's dist/main.js
pnpm --filter @fleetadlc/tests test     # the *.test.ts files; nothing has to be running
tests/scratch.sh up && eval "$(tests/scratch.sh env)"   # a scratch install beside a real one, and the variables the suites read
node tests/all.mjs                  # every suite whose requirement answers, one verdict
node tests/pipeline.mjs             # one suite, against the install the environment names
tests/scratch.sh down               # stop it and remove its database
```

`all.mjs` runs `pnpm test`, then each suite below whose requirement answers — the
bridge's `/healthz` for an install, the console's `/` and a scripted bridge for
onboarding — then `terraform validate` in `infra/gcp` when `terraform` is
installed and the module is initialised (`fleetadlc cloud validate`). The live
suites run only with `--live`, and then only when the bridge says `acting as` a
connected bot; `--no-live` is still accepted and changes nothing.

**A scripted install** is one whose services were started with
`FLEETADLC_SCRIPTED_ENGINES=1`. hostd then runs the fabricated runs in
`apps/hostd/src/scripted-runs.ts` instead of an engine, and clones every
repository from the local one `FLEETADLC_SCRIPTED_REPO_PATH` names, so the pipeline
moves with no model key and no GitHub account. Under `fleetadlc up` the variable
also creates that repository at `$FLEETADLC_HOME/scripted/testbed` and seeds with
`--scripted-board`. Export it for the suites too: they run the dispatcher
themselves, a pass at a time (`node apps/dispatcher/dist/main.js --once`), and
only with it does the dispatcher stop holding back builders whose GitHub checks
fail. CI's `check` job (`.github/workflows/ci.yml`), after the unit tests, is the
reference setup: an empty Postgres, `FLEETADLC_HOME` and a testbed under `.ci/`,
the scripted seed, and hostd, the bridge and the console started directly, so
its bridge does not dispatch on its own. It runs `pipeline`, `terminal`,
`kill-and-restart`, `concurrency` and `onboarding` (not on a draft pull
request), and never the live suites or `docker-computers`.

## The suites

| File | What it proves | Needs |
|---|---|---|
| `pipeline.mjs` | A routable issue becomes a leased, running, finished task; spec hands on to build; the merge line's order, reverts first; a seat runs no more tasks at once than it may; overlapping paths wait; leases expire; the task and monthly caps stop work; triage and unblocking; an unsigned webhook answers no gate; a red smoke reverts; jobs are safe to fire twice; `/internal` refuses a caller without the secret | a scripted install |
| `terminal.mjs` | Take-over: mint a token, open hostd's `/terminal` socket, type, read the output, detach; the session lives on and every step is audited | a scripted install; the first builder, or `FLEETADLC_TERMINAL_BOT` |
| `kill-and-restart.mjs` | Killing a session leaves the branch and the issue and returns the work to the board; restarting a bot cancels its tasks, gives their computers back and keeps the repository's mirror | a scripted install; deletes every task and lease |
| `concurrency.mjs` | Concurrency 2 is one builder with room for two taking two issues, each in a computer of its own, or two builder seats; a third issue waits rather than going past what the builders run between them | a scripted install; sets the owner's tasks at once and puts it back; adds a `<seat>-2` builder unless one exists, and retires only one it added |
| `docker-computers.mjs` | Under the docker driver, each task gets a container of its own on the install's task network (`scratch-tasks` on a scratch install), mounting only its own folder; two tasks cannot reach each other; the task database server is reachable from a task; container, folder and database go when the task ends; and how long a cold start takes | a scripted install on the docker driver, and `FLEETADLC_DOCKER_COMPUTERS=1` for `all.mjs` to run it: it starts real containers |
| `onboarding.mjs` | The walkthrough tells the truth about accounts, connections and steps; the device flow starts, or is refused without a client id, and no token reaches the browser | bridge, console and database; starts a device flow for the `intake` seat when a client id is set |
| `github-live.mjs` | The GitHub write path as a real account: file an issue, move its stage label, assign it, open and answer a gate comment, write `review-gate`; then close it (`--keep` leaves it) | a connected automation bot; writes to the first repository in the install's database |
| `github-live-pr.mjs` | Clone with a brokered token, branch under `agent/`, commit signed, push, open a pull request, and have GitHub refuse an unknown reviewer on it; then close it and delete the branch (`--keep` leaves them) | a bot with push access (`FLEETADLC_LIVE_BUILDER`, else the automation bot) and `ssh-agent`; stores a signing key if the bot has none |
| `second-builder.mjs` | Not a suite: the helpers `concurrency.mjs` adds and retires its builder with | — |
| `scratch-only.mjs` | Not a suite: `refuseARealInstall()`, which every suite but the live ones calls first. It stops the suite before it reads or writes anything unless `FLEETADLC_BRIDGE_URL`, `FLEETADLC_HOSTD_URL`, `DATABASE_URL` and `FLEETADLC_HOME` are all exported, `FLEETADLC_HOME` is not `~/.fleetadlc`, and the bridge answers `/healthz` saying its engines are scripted | — |
| `action-pins.test.ts` | Every action a workflow runs is named by a commit, every service image by a digest, and every tool a workflow downloads (actionlint, gitleaks) is checked against its checksum | nothing |
| `claims.test.ts` | Every file cited in `docs/platform-plan.md`'s "What is proven, and how" exists, and the plan does not overstate what has run | nothing |
| `cloud-module.test.ts` | What `terraform validate` cannot: `infra/gcp`'s firewall, IAP, invokers, webhook path and egress allowlist are wired as its comments promise | nothing |
| `deploy-path.test.ts` | The deploy workflows' names, jobs and permissions are what the bridge and the deploy skill call, and every `make` target they run exists | nothing |
| `extra-builder-sessions.test.ts` | Retiring the concurrency suite's builder kills its own sessions and nobody else's | nothing |
| `images.test.ts` | Every file `infra/local/Dockerfile.bot` copies onto the PATH is executable in git's index | `git` |
| `local-compose.test.ts` | `infra/local/docker-compose.yml` generates a webhook secret and never prints it | nothing |
| `origin-cors.test.ts` | The bridge, the console's middleware and hostd's terminal gateway refuse other origins, send no CORS headers, and take the attach token only as a subprotocol | nothing; its servers take ephemeral ports |
| `repo-templates.test.ts` | Issues filed from `crew/templates/repo`'s forms are routable by the real parsers, and this repository uses the same forms; this repository's CI skips only a tree a passing pull request vouches for, and its secret scan reads the pull request's own commits and counts in the verdict | `git` |
| `scripted-board.test.ts` | The scripted seed replaces its own rows and leaves every other row alone | nothing |
| `skills.test.ts` | Every skill's "Stop and ask when" condition has an id (`<!-- scenario: <id> -->`) and a scenario in `crew/skills/<name>/tests/` that covers it, and each scenario's script agrees with what it expects and writes only inside its declared paths. The scripted engine plays the script, not the skill's text: that a model reading the skill stops takes a live run | nothing |
| `console-server-imports.test.ts` | A console server component never calls a function from a module marked `'use client'`: the build passes, and the page fails only when it is rendered | nothing |
| `labels.test.ts` | Every label the bridge's alerts route files an issue with is in `config/labels.json`, so label sync gives it a colour and a description | nothing |
| `links.test.ts` | Every relative link in the repository's Markdown resolves, anchors included (`tests/check-links.mjs`) | `git` |
| `no-sign-off.test.ts` | Nothing a person or a bot reads (AGENTS.md, CONTRIBUTING.md, docs/development.md, the skills and the repository templates) asks for a commit sign-off | nothing |
| `publish-fresh.test.ts` | `infra/publish/publish-fresh.sh` makes one commit of a reviewed tree, by the maintainer's noreply identity, with the public remote added and nothing pushed, and refuses a tree that still names the install it was built on | `git`; no network |
| `plan-change.test.ts` | A path a task asks for is read, held while another lease or an issue in build or review declares an overlapping path, written into Expected paths and then accepted by the scope check; the build tools policy allows `docs/**` | nothing |

**The live suites do not call `refuseARealInstall()`.** They need GitHub, which
in practice only a real install has, and they act on the first repository in
the database of the install the environment names: `github-live.mjs` files an
issue labelled for the crew, which that install's dispatcher may pick up, and
sets `review-gate` on the head of `main`; `github-live-pr.mjs` pushes a branch
and opens a pull request there. That is why `all.mjs` runs them only with
`--live`. Point them at a repository you can spare.

They ask that install's bridge for a bot's GitHub token, as the rest of
OpenADLC does, with the internal secret from its secret store. Only when the
bridge does not answer do they refresh the token with a `TokenBroker` of their
own, and only when `FLEETADLC_GITHUB_CLIENT_ID` is set: GitHub rotates a refresh
token each time it is used, so two refreshing the same bot invalidate each
other.
