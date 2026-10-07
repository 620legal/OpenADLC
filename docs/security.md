# Security model

OpenADLC runs autonomous agents that read untrusted text, execute code, comment as
real GitHub accounts and can reach deploy environments. This document states what
it defends, how, and what it does not defend.

## Threat model in one paragraph

Assume an agent will at some point be told to do something harmful by text it
reads — an issue filed by a stranger, a document in a fixture, a dependency
changelog. The design does not rely on the agent refusing. It relies on the agent
having little worth stealing, few places to send it, narrow write scope (a
task's GitHub token reaches its own repository only once the app's client
secret is given, see [The account](#the-account)), and review before anything
merges: the lead reviewer approves every change, and a
change to how CI runs also needs the security reviewer's approval. A revert
skips only the reviewers that are there by default, never one its labels or
paths ask for. By default
the security reviewer runs on the lead's provider, so that second approval is a
second, security-focused review rather than a second model. The second
reviewer, on another provider, advises unless `config/review.yaml` marks it
`blocking`. To put a
second model on CI changes, move the security seat to another provider (Grok,
say) in `config/bots.yaml`, or have a person merge them with `ciMergeByPerson`.

## Trust boundaries

### The container

Each task runs in a computer of its own: under the `docker` driver a container,
`task-<id8>`, made when the task starts and removed when it ends — or, for a task
paused on a person, `FLEETADLC_PAUSED_KEEP_MINUTES` after it pauses. A seat is
the task's GitHub identity and never its computer: two tasks of one seat run in
two containers. On an `infra/gcp` install a task's computer can reach only
GitHub, package registries and its engine's API; anywhere else it can reach
any host, as below under [Egress](#egress). It holds no long-lived secrets on disk: hostd reads credentials
from the secret store at task start and puts them in the tmux session's
environment, which dies with the session, and the signing agent runs inside
the container and is stopped when the task ends, or dies with it. Under the
`local` driver the agent runs on the host, and hostd stops it, by the PID it
started, when the task ends. It can reach the ports the host publishes,
through `host.docker.internal`, which is how it reaches its own task database;
the platform database is one of those ports, and its password, below, is what
keeps a task out of it.

OpenADLC turns the engine CLIs' own sandboxes off inside a container
(`FLEETADLC_CONTAINED`), so the container is what limits a task. It runs with
its seat's CPUs and memory, at most 4096 processes (`--pids-limit`), so a fork
bomb fills its own container and not the host's process table, and with
`no-new-privileges`, so a setuid binary in the image (`su`, `mount`,
`passwd`) gives the `bot` user nothing more. Its capabilities are Docker's
defaults, and its root filesystem is writable.

None of this holds under the `local` driver. There a task is a tmux session on
the host, running as the user hostd runs as, with no container around it. It
can read the secret store (`~/.fleetadlc/secrets/`: the GitHub App's private
key, every bot's sign-in, the model keys) and `install.json` (the database
password, the webhook secret), and can run anything on the machine. A bot
talked into it by what it reads could act as the App or as any bot. Use local
only with a throwaway App, accounts and repositories. A new install takes
`docker` when Docker answers and the bot image is built; while hostd runs
local, `fleetadlc up` and `fleetadlc doctor` say so and the board shows a
`hostd-driver` warning card.

It does reach the host's bridge and hostd ports: that is how its own task
reports in, through `/internal/tasks/<its id>/*` with a token for that task
alone. The token never expires, so it speaks for its task only while that task
is running or paused on a person's question: a gate, a message, usage or a new
state for a task that has ended is refused with 409 and changes nothing. It
does not reach the console's API. On a local install the bridge
serves `/v1/*` only to a caller presenting the install's console secret, which
only the console's server and the `fleetadlc` CLI hold, and the console serves
nothing to a browser that has not signed in. Before that, anything that reached
port 47311 or 47300 — a task's container through `host.docker.internal`, or a
host on the LAN — named itself and was an admin: it could download a backup of
every credential, or mint a terminal into another seat's session.

The one exception is a bot on an OpenAI or xAI **subscription**. That CLI keeps
its own login and refreshes it as it works, so the login lives in a directory
rather than in the session's environment: `~/.fleetadlc/logins/<account-id>` on the
host, 0700 and made by hostd. Under the docker driver a task does not get that
directory as its home. Its `CODEX_HOME` or `GROK_HOME` is
`logins/.homes/<slot>`, outside the slot — the slot is mounted at its host
path, so a directory inside it can be replaced with a link — and mounted at
`/fleetadlc/login`. It starts empty apart from mount points. The sealed files
— `config.toml`, `managed_config.toml`, `requirements.toml`, `AGENTS.md`,
`AGENTS.override.md` and `.env` — are bind-mounted read-only from
`logins/.published/<account-id>/` over that home. A file the task creates
there, including a Grok `plugins/` directory, `hooks/`, `lsp.json`,
`trusted_folders.toml`, `CLAUDE.md` or `Agents.md`, or a Codex `agents/`
directory or `environments.toml`, stays in that home and goes when the task
does. It is not what the next task loads.

The sign-in stays the account's `auth.json`, one file every task on the
account uses, kept in a directory of its own:
`logins/<account-id>/sign-in/auth.json`. Codex 0.155.1 writes that file in
place, so it is bind-mounted at `/fleetadlc/login/auth.json` and a refresh
is the same inode. A Codex task gets no directory of the account's. Grok
renames a new file over `auth.json`, which a file mount refuses with EBUSY
and would leave the old inode, so a Grok task has the `sign-in` directory,
and nothing else of the account's, at `/fleetadlc/auth`, and
`GROK_AUTH_PATH` names `auth.json` there. A refresh is visible to the other
tasks at once, and a hostd crash before the computer ends does not lose it.
OpenAI refresh tokens are single-use, so a per-task copy made the next
task's refresh fail. A link or a directory is not a sign-in: `auth.json`
has to be a regular file, or the account shows as signed out and the next
task gets no sign-in mount; a sign-in replaces whatever a task put at that
name, and the account shows as signed in only once the file is there,
whatever the CLI's exit code. A Grok task can write files beside the
sign-in. Nothing reads them: no container has the `sign-in` directory as
its home, a backup carries only `auth.json` from it, and a sign-in, a model
list, a check, an engine-update call and a backup's restore check each get
a fresh home and the same sign-in mount a task gets, so they do not load a
plugin, a hook or an instructions file planted there. An earlier build kept
the sign-in at the top of the account directory and mounted that whole
directory for Grok; hostd moves such a sign-in into `sign-in/` when it
starts.

A task on an API key, on a Claude subscription or on another seat has no such
home, and since a computer is made per task, a bot moved off the account has
no computer that still holds it. A bot that has the home can read the login
mounted into it — it is that bot's credential, as a key in its environment
is — so the blast radius of a compromised bot on a seat is that seat, the
same as a key's. Under the local driver, which isolates nothing, every bot
on one account still shares the `sign-in` directory as the CLI's home,
config included. Removing the account deletes the directory and the
published files beside it. A home whose slot directory is gone is removed
with the leftover-slot sweep, a directory a task made unreadable included;
one that cannot be removed is left for the next sweep, and the sweep goes on
to the others.

A **Claude** subscription needs no directory. `claude setup-token` prints a
long-lived token, which is stored in the secret store like a key and injected
per session as `CLAUDE_CODE_OAUTH_TOKEN`, never alongside an
`ANTHROPIC_API_KEY`.

Signing a seat in shows a one-time code, and it is shown to the operator only:
it travels in the answer to the request that started the sign-in and nowhere
else. hostd logs nothing a CLI prints during a sign-in or a check, and audits
only that one started or ran and whether the check passed. A failed sign-in is
reported with the code and its link taken out, and a failed check with the
account's secret, and anything shaped like a token, taken out and cut to 400
characters. A secret handed to a checking container is named on the `docker`
command line and valued only in the docker client's own environment, so it is
not in the process list.

With the `docker` driver every task's container sits on one network per
install, `fleetadlc-tasks`, made with inter-container traffic off
(`com.docker.network.bridge.enable_icc=false`): a task cannot open a connection
to another task's container, whichever seat either belongs to. A network per
task would have been simpler to reason about, but would exhaust Docker's
default address pools, about thirty networks, on the first busy afternoon. A
task's container mounts its own folder (its clone, its briefing, its home) at
the path it has on the host, and nothing else of the work root: no other
task's folder and no mirror.

A task whose seat runs checks gets a database of its own on the host's one
task database server, `fleetadlc-taskdb`: a login role and a database named
after the task's whole id (`t_<id>`), owned by that role, closed to every other role
(`revoke connect … from public`), limited to 20 connections so one task's pool
cannot take the server from the rest, and dropped with the task's computer.
The role's password is an HMAC of the task's id under the install's internal
secret, which no task holds, so a hostd that restarts can give an adopted
computer's local CI the same URL without the password being stored anywhere.
The server is published only on the host's gateway address — the Docker
bridge's on Linux, loopback on Docker Desktop and OrbStack — and reached from a
task as `host.docker.internal`. What separates two tasks' data is Postgres's
role permissions, not a network: a task that found a way to act as the
server's superuser would reach every task's database on the host. So the
superuser has no password and cannot log in over the network at all; hostd
reaches it only through `docker exec psql` inside the server's container, over
its local socket. The image will not make a server without a superuser
password, so a new one gets a random password that is kept nowhere and removed
as soon as the server is up; it is removed again at every hostd start, and a
server that still had one has its task template made again, in case somebody
changed it. Neither that password nor a role's is on a command line in the
host's process list: the first is in the docker client's own environment when
the server is made, and a role's goes to `psql` on its stdin. The `local` driver gives none of this and exists for development
only.

What a repository's tasks share on a host and can write is its cache volume,
`fleetadlc-cache-<install>-<repo>`, mounted at `/cache`, and on it only npm's
cache, which keeps each package under the hash its lockfile names and verifies
it as it is taken out. A task can write anything there, so a cache that did not
check would let one task — any seat's, in that repository — plant something the
next task runs. pnpm's store does not check: for a package it already holds,
pnpm trusts its own index, which a task could rewrite along with the files, and
it does not hash a file older than the index again. So each repository's pnpm
store is a volume of its own, `fleetadlc-pnpm-<install>-<repo>`, mounted
read-only at `/pnpm-store` in every task's computer, and hostd alone writes it:
as a task starts or resumes, it runs `pnpm fetch --ignore-scripts` on a copy of
the task's lockfile in a short-lived container that has no task's folder, no
login and no GitHub or model credential. The lockfile may be an attacker's,
which is acceptable: `pnpm fetch` checks each tarball against the lockfile's
integrity and keeps it under that hash, so a hostile lockfile can add packages
but cannot change what another package's hash names. A session that adds,
updates or removes a dependency has OpenADLC's `pnpm` ask hostd to fill the
store from its own lockfile, and where the store cannot be filled — a failed
fill, the `local` driver — the task installs into a store of its own, in its
home. Global installs and `~/.cache` are the task's own too, and go with it. A
task in another repository never has either volume.

A warm computer (`FLEETADLC_WARM_POOL`, off by default) is made before its task
is known and claimed by resizing and renaming it, so it holds nothing of any
seat: no login — a task whose account needs one is always made cold — no
credential, and no task's folder until the claim writes whose it is. One left
by a hostd before this one is removed at start rather than claimed.

A task works in a clone of its own, taken from one mirror per repository that
only hostd touches and no container mounts. The clone copies the mirror's
objects (`git clone --local --no-hardlinks`) rather than linking them: a linked
clone shares each object file with the mirror, and git does not check an object
again when it reads it, so a task that rewrote a file in its clone's
`.git/objects` would have changed that object for every later task in the
repository — the base a reviewer's checks run against included. A copy costs
the repository's size per task, and nothing a task does reaches the mirror.
hostd hands git the bot's token for each fetch in git's environment, as an
`Authorization` header, never in a URL or an argument: a mirror's config holds
only the plain `https://github.com/<owner>/<repo>.git`, from the moment it
exists, and one left with a token in it by an earlier version is cleaned the
next time it is used.

A session also starts from a **clean environment**: hostd assembles what a task
gets and the session runs under `env -i`, so nothing of hostd's own leaks into
it. That matters most for `DATABASE_URL` — hostd holds the platform's, and a bot
that inherited it could read and rewrite the ledger and the audit trail that hold
it to account. A task's `DATABASE_URL` is its own database on the task
database server, made for it and dropped with its computer, or absent entirely
for a seat that runs no checks and on the `local` driver, which has no server
to give. Under `docker` the session's environment, its GitHub token included,
goes into the container on stdin, to a file only the bot can read in the
container's memory (`/dev/shm`), which the session reads and removes before it
runs; under `local` it goes into a 0600 file in hostd's temporary directory,
read and removed the same way. `make setup` and `make ci` are given the task's
`DATABASE_URL` and its token by name, valued in the docker client's
environment. A review that checks out a pull request does not run `make setup`:
that Makefile is the pull request's, and it would run outside the skill's tools.
No credential is on a command line in the host's process list.

Keeping the URL out of the environment does not keep a task out of the platform
database on its own. `fleetadlc up` publishes that database on the host's
loopback, and a task's computer reaches the host through `host.docker.internal`,
which on Docker Desktop and OrbStack leads to the host's loopback too. What
keeps it out is the password: `fleetadlc up` gives each install one of its own,
64 hex characters kept only in `databaseUrl` in `install.json` (0600), and on
the container it keeps changes an older install's `fleetadlc` to one on its next
start. Every install used to take `fleetadlc`, which is printed in this
repository, as its superuser's password. `fleetadlc doctor` fails while the URL
it connects with still has that one, and warns while the container is published
beyond 127.0.0.1.

On a cloud install the platform database is Cloud SQL, reached across a VPC
peering, and the connection is encrypted and checked. The instance refuses any
connection that is not encrypted, and the bridge, hostd and the host's
migrations connect with `sslmode=verify-ca`: the server's certificate must chain
to the instance's own certificate authority, which the module keeps as the
secret `<prefix>-database-ca` and puts at `/var/lib/fleet/database-ca/server-ca.pem`
on the bridge and the host. The certificate's name is not checked, because it
names the instance and not the private address the clients dial. A local or
compose install reaches its database container on the same machine without
TLS.

### The account

Each bot acts as a GitHub account, and seats may share one within their group:
a crew account that intake, design, build, QA, ship and automation post and push
as, and a reviewer account the three reviewers approve as. The two groups never
share, because GitHub won't let the account that opened a pull request approve
it, and the bridge refuses it whatever the console offers. Any seat may still
have an account of its own. Every post carries a header naming the stage and a
tag naming the seat, which the bridge signs, so work on a shared account is
still told apart. The tag alone is the account's word: any seat's session holds
the account's token and could write the lead's. So the lead's approval and a
blocking seat's count toward the merge only when the signature checks, names
that seat and was made for that pull request and that review (`mergeDecision`,
`apps/bridge/src/automation.ts`), on any account; and on an account more than
one seat uses, toward the gate and the lead's turn as well
(`checkedForSharedSeats`). That holds in audit mode as well as in enforce. OpenADLC's `gh` and the bridge's signing endpoint also refuse to put
another seat's tag on what a session posts.

What an account may do is the repository role it is invited with, and the
account's role is the widest its seats need:

- reviewers hold write access because approvals only count with it. Nothing on
  GitHub keeps them off work branches: the `agent/**` and `system/**` ruleset
  (`agentBranchesRuleset`, `packages/github/src/rules.ts`) refuses a force-push
  and a deletion there and nothing else, so any crew account can fast-forward
  any bot's branch (see [A skill's `tools.yaml`](#a-skills-toolsyaml));
- an automation account of its own is invited with `triage` where the
  repository's owner is an organization, so it cannot push even by accident. On
  the shared crew account, or a repository a person owns, it has write access,
  and what keeps it from pushing is that it never authors commits;
- builders are asked to write only inside the paths their lease declared, and
  are held to them only where the repository's CI runs the scope check (see
  [A skill's `tools.yaml`](#a-skills-toolsyaml)).

No seat is ever a person's account, or one that administers a managed
repository. The bridge refuses, before anything is stored or assigned, a login
that is one of the install's `humans` or that a managed repository's AGENTS.md
names under Human review (read as the review gate reads it), when a seat
connects, when Settings connects an account, and when Crew puts a seat on one;
Crew shows the same reason beside such an account. Connecting a seat and
putting one on an account are also refused when GitHub says the account has
admin or maintain on a managed repository, since that role can edit the
rulesets and branch protection behind "a bot cannot merge". A lookup that
fails does not refuse; the `bot-access` check asks again every half hour and
fails, blocking, for a bot whose account has admin or maintain, with the change
to make (`apps/bridge/src/account-guard.ts`).

Credentials are short-lived. The device flow yields an eight-hour user token and a
six-month refresh token; only the refresh token is stored, GitHub rotates it on
every use, and a revoked authorization surfaces in `fleetadlc doctor` and the console
rather than failing quietly.

Because that rotation invalidates the token it replaces, **only the bridge
refreshes while it runs**. It is the install's token service: hostd and the CLI
ask it for a short-lived token rather than holding a refresh token of their own,
so two components can never race and lock an account out. There are two
exceptions. When nothing answers on the bridge's port, `fleetadlc github
sync-labels`, `check` and `apply` refresh the token themselves, under the same
Postgres advisory lock the bridge's broker takes for that sign-in
(`github-refresh:<sign-in>`); a bridge that answers with a refusal stops the
command instead. And `fleetadlc restore` refreshes each GitHub sign-in in the
archive once, which is how it checks one and takes it over
(`packages/backup/src/signins.ts`). A task is handed a token with
at least five hours left, because a task may run four and a credential that
expires part way through fails at the end, where the work is. Like every
`/internal` route, the service does not serve the private network alone: a
caller presents a shared secret the bridge generates on first start and keeps
in the same secret store, so reaching the port is not enough to be given a
credential. A task's own session cannot ask it either: its HMAC admits it only
to `/internal/tasks/<its id>/*`.

**What a crew token can reach at all** is the app's installation intersected
with the account's own access: the repositories the app is installed on that
the bot's account can see. Where the bots are collaborators on the managed
repositories only, that is those repositories. An organization that installs
the app on **all** of its repositories and makes the bots members widens it to
every repository they see through the organization's base permission or a
team, beyond the ones OpenADLC manages. Install the app on chosen repositories
only, and where bots must be members, set the base permission to No permission
and keep them out of teams. The `app-selection` check warns about an
all-repositories installation on an organization OpenADLC works in; it cannot
see the organization's membership settings, which need permissions OpenADLC
does not ask for.

**How far a task's token reaches.** Every crew account is invited into every
repository OpenADLC manages, so an account's own token reaches all of them:
code, issues, pull requests, workflows and Actions. A task is therefore given a
token narrowed to its own repository. The bridge checks the repository against
the ones OpenADLC works in, refuses any other, and asks GitHub for a scoped token
(`POST /applications/{client_id}/token/scoped`, `packages/github/src/scoped-token.ts`),
so a call from the task to another repository is refused by GitHub itself, not
by a shim. That needs the app's client secret: the manifest flow stores it, and
an app made by hand, or before it was kept, has one pasted in Settings → GitHub.
**Without a client secret a task's token reaches every repository the account
can**, as before; tasks still run, hostd logs that the token is not scoped, and
the `app-client-secret` check is a card on the board until a secret is given.
The bridge's own calls use the account's token either way.

Narrowing tokens does not separate what a crew account itself can reach. Keep
repositories with different confidentiality apart: give them separate crew
accounts, or separate installs, and never run one crew across public and
private repositories, where an injected task in the public one acting without a
scoped token could read the private one and post what it found.

The app itself may be **public**. GitHub installs a private app only on the
account that owns it, so working in the repositories of more than one account
means making it public, and then any account can install it. What an installer
grants is the app's access to *their* repositories; nothing of this install's is
reached by it. Their deliveries arrive signed like any other, and OpenADLC acts on
none about a repository it does not work in (`ours` in
`apps/bridge/src/webhooks.ts`). An installation only makes the bridge look again
at which repositories the app can reach; an installation on an account where
OpenADLC works in no repository is logged once and otherwise ignored. Nor can such an installation put its repositories
into the install: the app reaches only the accounts OpenADLC knows — the app's
owner, the configured organization, the owners of repositories it already
manages, and accounts an admin allowed (`reach()` in
`apps/bridge/src/app-reach.ts`). The repository picker leaves the others out,
so "Select all" never chooses a look-alike of yours, and adding a repository on
another account is refused with how to allow it. Allowing one is an admin's,
after a warning that the crew is invited to its repositories and its admins
can answer the crew's questions, and is audited as `github.account_allowed`.

### The platform

- No bot merges. The bridge decides the order pull requests land in and brings
  each one up to date first. It then merges each one as the app, never with a
  bot's token, once all of these hold on the head that will become part of
  the base branch (`mergeDecision`):
  - its head is in the repository itself, not a fork, and it lands on the
    default branch, whose `AGENTS.md` names the paths a person reviews;
  - a crew pull request (an `agent/` branch) changes only paths its lease
    declared — OpenADLC's own lease row, widened only by an approved plan
    change, never the issue's body — plus `tests/`, `docs/`, `AGENTS.md` and
    tests beside declared modules, every file counted, a rename's old name too.
    One that strays leaves the merge line and goes back to its builder with the
    files named; `scope:cross-cutting` lets it through only when the app, the
    automation account or a person put it on. One that closes no issue waits
    for a person, since nothing declared what it may change. A person's pull
    request and a revert are not held to a lease;
  - every requested reviewer has approved that version, or an earlier head
    whose whole diff is the same. The lead's or a blocking seat's approval
    counts only when its OpenADLC signature checks for that pull request and
    that review, in either attribution mode: an approval written around
    OpenADLC's `gh` with the account's own token lands nothing, and with
    nothing to check signatures the bridge does not merge. On a GitHub account
    more than one seat uses, an unsigned review there is nobody's;
  - the people named for its paths have approved it, each from an account
    GitHub says has write access or more to the repository (an approval from a
    login that lacks it, or whose permission GitHub did not give, counts for
    nothing: anyone can review a public repository, and a freed login can be
    registered by someone else), nobody asked for a
    review on GitHub is still to give one, and nobody who can write to the
    repository still asks for changes;
  - `ci` is GitHub Actions' own check run of the `ci` workflow on that head,
    since a commit status named `ci` can be set by any token that may write
    statuses and is refused; `review-gate` as OpenADLC published it is green;
    and no check or status is red or errored.

  **The primary gate is the review:** every required reviewer approving the
  exact diff that would land. Everything below is defence in depth around it.

  The rulesets OpenADLC writes do not hold the merge line back. Their one
  bypass actor is OpenADLC's own GitHub App (`bypassForApp`,
  `packages/github/src/rules.ts`), in `always` mode, so it can write CODEOWNERS
  to a branch it protects. The merge line merges as the app, so `mergeDecision`,
  not the ruleset, is what holds its merges, and the app's private key is what
  guards `main`: whoever holds it can push straight to the default branch of
  every repository the app is installed on, past required reviews and checks.

  A pull request that changes how CI runs needs more than the lead: CI runs
  the head's own workflow and scripts, so such a change grades itself. The
  security reviewer is asked for every one, whatever its own triggers say
  and on a revert too, and the bridge merges it only once that seat's verdict on this diff is
  `approve`, from a review whose signature checks — a verdict in a body the
  shared account could have written otherwise is not one. Without a security
  seat, or without signatures to check, a person merges it, as one does in
  every repository the install setting `ciMergeByPerson` (`PATCH /v1/install`,
  repository names, comma-separated) lists. What counts as changing how CI
  runs: anything under `.github/`;
  at the root, `package.json`, `Makefile`, `makefile`, `GNUmakefile`,
  `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`, `.nvmrc` or
  `.node-version`; a test runner's configuration at any depth
  (`vitest.config.*`, `vite.config.*`, `vitest.workspace.*`, `jest.config.*`,
  `.mocharc*`, `playwright.config.*`); the `scripts` of any `package.json`;
  and the `include`, `files`, `exclude`, `references` or `extends` of any
  `tsconfig*.json`. Those last two are compared between the base and the head,
  so a dependency bump in a package's `package.json` still merges; a file
  that cannot be read or parsed on either side counts as changed. A renamed
  file counts under both its old and new names, here and for the paths a
  person reviews.

  A request for changes holds the merge when GitHub says its author can write
  to the repository, or cannot say. A review request taken back by anyone who
  cannot decide that — a crew account, an app, someone without write access —
  still holds the merge until that reviewer reviews. With signatures enforced,
  a crew review counts only when its signature was made for a review of this
  pull request in this repository and its nonce is bound to that review, so
  signed words copied from another post count for nobody. Settings that
  cannot be read leave the merge to a person.

  **What this does not catch.** No list of files covers every way a change can
  make its own tests weaker: a test deleted, an assertion loosened, a skip
  added, a fixture that makes a real failure pass. Those are code, and a
  reviewer who approves such a change lets it land, with every check green.
  The review is what stands between that and the default branch; the rest
  narrows what a change can do without one.

  Every list this reads is read to its end: reviews and files page by page, and
  a pull request with more files than GitHub lists (3000) is not merged. Nor
  does its `review-gate` pass: a file list GitHub refused or cut off keeps the gate
  pending (`cannot read every file this pull request changes`), since the
  paths left out could be ones a person has to review, and a repository that
  merges by its own rules or by hand waits only on that gate. When a diff is
  longer than a comparison shows (300 files), an approval of an earlier head
  is not carried to the current one by comparing diffs, so the head that
  lands must be approved itself. On GitHub's free plan a
  private repository has no branch protection, so the bridge checks these rules
  itself, from what GitHub says at that moment. Every merge is audited as
  `merge.landed`. An install can instead leave a repository's merges to its
  branch rules and a person (`bridgeMergeOff`).
- Only the `revert` label puts a pull request on the fast path
  (`decideReviewers`), and only on a `system/revert-*` branch, the one the
  deploy skill opens a revert on. It skips the reviewers that are there only
  by default (asked on every pull request, or sampled); a seat its own label
  or path asked for, a `blocking` seat, and the security reviewer for a change
  to how CI runs are still asked, and the merge still needs every approval it
  would without the label. `deps` asks for the security reviewer, as
  review.yaml says. OpenADLC's `gh` refuses `revert`, `deps` and
  `scope:cross-cutting` to a crew session, except the deploy skill opening a
  revert's pull request and triage filing an issue as `deps`. A `revert` or
  `deps` put on a pull request around it — by a crew account (the deploy
  seat's `revert` on its revert branch excepted), another app, or anyone who
  cannot write to the repository — is taken off by the bridge and audited as
  `review.fast_path_label_refused`. They stand from OpenADLC's app, the
  automation account and a person who can write.
- `review-gate` holds a pull request until every requested review has been posted
  and, when a human-review path is touched, until a person approves.
- A conflict found at the front of the merge line is resolved by the builder.
  Where every conflicted file is shared, only the lead re-checks it, and
  nothing merges until the lead approves the resolved head itself; the other
  seats' approvals carry across. The resolution may change only the conflicted
  files and what the base brought, as the base has it, or every reviewer is
  asked again. A conflict in a file that can decide how CI runs, or in
  `AGENTS.md`, is always reviewed in full, whatever `paths.shared` says, so the
  security reviewer's earlier verdict never stands for a resolution there.
- A bot dismissing a review is treated as an incident: the bridge audits it
  (`review.dismissed_by_bot`, with the account and the seat) and says so on the
  pull request. A dismissed review no longer counts, so `review-gate` waits for
  a new one, and the bridge asks for it: a seat's review is requested on GitHub
  and a new review task is opened for that seat, once per dismissal; a
  person's review is requested again. The crew carries on without a person.
  What holds the merge does not depend on that delivery arriving:
  `mergeDecision` reads the pull request's timeline every time, and a person's
  request for changes dismissed by a crew account, an app or anyone without
  write access still counts as asking for changes, until that person reviews
  again or someone who can write dismisses it. The bridge's own dismissal of an
  approval a push superseded is recorded by the review's id as it is made
  (`review.dismissed_by_bridge`), and is not an incident.
- Production is a GitHub environment held as the repository's
  `.github/fleetadlc.yml` says: required reviewers who are people, or a wait
  timer. A bot never approves a deploy; the repository's GitHub rules do. Where
  GitHub's plan cannot hold a reviewer on the environment (a private
  repository on Free, Pro or Team), the bridge holds each promote of a
  repository set to `approval: reviewers` itself, as a Needs you card only an
  admin can release; releasing it dispatches the workflow and approves
  nothing. The deploy skill's `tools.yaml` denies `gh workflow run
  promote-production`, so a session does not start one around that hold.
  A skill that denies `workflow run` (QA, spec, triage, a review) is refused
  the same call as `gh api` to `actions/workflows/<workflow>/dispatches`.
  OpenADLC dispatches the deploy workflows as the app, or as the automation
  account where the app cannot act on the repository, and never calls what
  approves a waiting deployment (REST's `pending_deployments`, GraphQL's
  `approveDeployments`; a test in `packages/github` fails if any file in the
  repository's code, configuration, workflows or suites names either), and the `production-rules` health
  check fails, blocking, when a crew account is among the environment's
  reviewers.
- `testing`, `production` and `production-rollback` deploy only from the default branch: each
  environment's branch policy names it and nothing else, because the crew's own
  `agent/**` and `system/**` branches are protected too and "protected
  branches" would admit them. `fleetadlc github check` and the
  `production-rules` health check report any other policy as drift. That
  protects what the environment holds and nothing else: any crew account can
  push a workflow to its own branch and run it, and that workflow reads every
  repository and organization secret. So a deploy credential belongs in the
  environment's own secrets, or behind an OIDC trust bound to the environment
  and `ref:refs/heads/<default>`, never in a repository-level secret.

### A skill's `tools.yaml`

Each skill says in `crew/skills/<name>/tools.yaml` what a task running it may do. No
engine can express all of it, so each rule is held where it can be, and this is
exactly what holds, engine by engine:

| Rule | Claude Code | Grok Build | Codex |
|---|---|---|---|
| `allow.shell` | Only the listed commands run (`Bash(<command>:*)`) | Only the listed commands run, under a run home that refuses the rest | **Not enforced.** Any entry gives a sandbox that runs every command; none gives a read-only one |
| `deny.shell` | Refused (`--disallowedTools`) | Refused (`--deny`) | **Not enforced** |
| `allow.files.write_within` | Yes or no: any entry allows the file tools everywhere, none refuses them (`--disallowedTools`) | Yes or no, the same way; none also refuses a shell `>` | **Not enforced** |
| `allow.git.push_branch_prefix`, `force_push` | OpenADLC's `git` | OpenADLC's `git` | OpenADLC's `git` |
| `deny.github` | OpenADLC's `gh` | OpenADLC's `gh` | OpenADLC's `gh` |

**A repository's own engine configuration does not reach a task.** Claude
Code is started with `--setting-sources user --strict-mcp-config`: it reads
settings only from the task's own home and runs no MCP server OpenADLC did not
pass (it passes none), so a repository's `.claude/settings.json` and
`.claude/settings.local.json` (hooks and permission rules), its `.mcp.json` and
its `CLAUDE.md` do not run or steer a crew task. A builder could otherwise
commit a hook to its branch that the next Claude session there would run, with
the session's GitHub token, outside the rules above. Grok Build is never given
`--trust`, which is what would load a folder's own hooks, MCP servers and
instructions. The brief is the skill's playbook and the context hostd hands over
itself, AGENTS.md among it, so a repository's conventions belong in AGENTS.md,
which every engine gets; a repository's CLAUDE.md no longer reaches a Claude
seat. Codex is started with its own config home, never the worktree's: the
task's own home on a subscription, or `.codex` in the task's own home
(`<slot>/home`, beside the worktree, not in it). It would still read a
worktree's `.codex/config.toml` and spawn the `mcp_servers` listed there once it
trusts the project, and `codex exec` with a sandbox that may write trusts it on
its own. So every Codex invocation names the worktree untrusted
(`-c projects={"<worktree>"={trust_level="untrusted"}}`), and the repository's
`.codex/` does not apply; measured with codex 0.155.1 in the bot image, on
`exec` and `exec resume`, and in `packages/engines/src/engines.test.ts` where
`codex` is installed. The config home's own `config.toml`, `AGENTS.md`,
`AGENTS.override.md` and `.env`, and Grok's `managed_config.toml` and
`requirements.toml`, are, under the docker driver, read-only mounts of the
account's published files rather than the shared login's, so a previous
task on that account cannot have written the `mcp_servers`, the home
instructions or the environment file this one loads
(`docs/self-hosting.md`). Codex still reads the repository's AGENTS.md,
as every engine does. Under the docker driver that home is a directory of
this task's own, so `skills/`, `rules/` and any other file it creates there
go with the task. A Grok task also has the account's `sign-in` directory,
and only that, at `/fleetadlc/auth` so Grok can refresh `auth.json`; a file
written there is in no container's home and in no backup. A sign-in
container gets a fresh home too.

**The paths themselves are not enforced by any engine.** A task that may write
files may write any file its shell can. What holds the paths is the pull
request: the merge line holds a crew pull request to its lease's paths and
sends one that strays back to its builder (`mergeDecision`), and the reviewers
read it. A check in the repository's own CI could be edited out by the very
pull request it checks, so the bridge reads the lease instead. OpenADLC's own
CI also runs a scope check (`.github/scripts/scope-check.mjs`) on the issues'
Expected paths, as an extra layer. The
`scope:cross-cutting` label that waives it counts only from someone other than
the pull request's author: a person, the OpenADLC app, or the automation
account. OpenADLC's `gh` refuses it to every session, and the bridge takes off
one a crew account puts on (`scope.label_refused` in the audit log). The lead
accepts a genuine widening in its approval, and the bridge applies the label as
the app only when that review's signature checks.
A session cannot put on or take off `scope:cross-cutting`, `revert` or `deps`
itself (OpenADLC's `gh`), since each changes who reviews the pull request or
what CI holds it to.

**OpenADLC's `git` and `gh`** (`apps/hostd/bin/`) are first on every session's
PATH, whatever the engine. The engine hands them the skill's rules in
`FLEETADLC_TOOLS_POLICY`, which a task's own environment cannot override. A
person's shell in the same session has no `FLEETADLC_TOOLS_POLICY` and is held to
none of it.

- **`git`** reads every command a task runs (`git-check.mjs`). It resolves an
  alias as git would, and refuses a shell alias it cannot read. It refuses an
  alias or a push setting given with `-c` or `--config-env`, and drops them
  from `GIT_CONFIG_*`. It refuses `send-pack`, `http-push`, the `remote-*`
  helpers and `subtree push`, and a global option it does not know. A push is
  run first with `--dry-run --porcelain`, and refused when any ref it would
  update is not a branch under `push_branch_prefix`, or when it is a forced
  update and `force_push` is false. A skill with no `push_branch_prefix`, or
  with `push` in `deny.github`, pushes nothing. When `force_push` is false,
  `--force` and a `+` are taken out of the real push, so a remote that moves
  between the dry run and the push makes git refuse it, not rewrite it. A `+`
  in a `remote.<name>.push` setting from a file is not taken out; that narrow
  race remains. The dry run is asked without `-q`, because with it git names no refs.
  A push with `--no-dry-run` or `--no-porcelain`, or an abbreviation of
  either, is refused before git runs: the task's arguments come after the
  shim's, so they turned the dry run into the real push, or into one that
  named no refs. A dry run whose output does not end in porcelain's `Done` is
  refused rather than read as changing nothing.
  With `local_ci` (set by the build, resolve-conflict, QA and spec skills),
  each commit a push would put on a branch needs a local CI pass the bridge
  recorded for it (`fleetadlc-ci`).
- **`gh`** refuses a command that starts with a `deny.github` entry
  (`pr review`, `workflow run`, `api`). It reads the command past a flag given
  before the subcommand (`gh pr -R o/r review`), expands an alias before it
  reads, and refuses `gh alias set` and `gh alias import`. It refuses every
  `gh pr merge`, `--auto` included, and the same through `gh api`: the REST
  merge and `merges` endpoints, and GraphQL's `mergePullRequest`,
  `enablePullRequestAutoMerge` and `mergeBranch`, read from the arguments, an
  `--input` file and `-F name=@file`; a GraphQL query on stdin is refused
  because it cannot be read. With `local_ci` it refuses
  `gh pr create --draft`, and `gh pr create` or `gh pr ready` on a HEAD with no
  recorded local CI pass. It refuses a stage label (`adlc:*`) to every skill
  but intake, and to an advisory reviewer (`FLEETADLC_REVIEW_MODE=advisory`)
  `--approve` or `--request-changes`, an `APPROVE` or `REQUEST_CHANGES` review
  event through `gh api` (a field or a JSON body), and a GraphQL review that
  approves or asks for changes. A skill that denies `pr review` (a builder, QA,
  spec, intake) is refused that same `gh api` verdict, not only `gh pr review`;
  a `COMMENT` review through `gh api` still goes through for it, on purpose,
  since a comment approves nothing. `apps/hostd/src/gh-shim-run.test.ts` runs the
  script itself against a stand-in `gh`, so a refusal it stops calling fails.

**Local CI is recorded by hostd, never by the session.** `fleetadlc-ci` asks the
bridge with the task's token, which can start a run and read whether a commit
passed, and nothing more. The worktree's `.git` is the session's, so hostd
first proves the worktree is the commit's own tree, with git's system and
global config, replace objects, fsmonitor and the untracked cache turned off:
`.git` is a real directory there, with no alternate object store, grafts,
replace refs, hooks other than git's samples, `core.worktree` or
`core.hooksPath`, no skip-worktree or assume-unchanged entry in its index, and
a clean status. Changes the builder can see are refused, with how to commit
them. When the proof holds, `make ci` runs in the worktree; when it does not,
hostd clones the commit afresh into the task's own directory (`git clone
--no-local`, so every object is copied and hashed), runs `make setup` and
`make ci` there, and removes it, and the log's first line says so. Either way
HEAD and the tree are checked again after the run, and the result is reported
to the bridge with the install's secret; only then is a pass written. Not
covered: a session changing files while `make ci` runs in its worktree, and
ignored files, which `make setup` and `make ci` create. A
`Makefile` a pull request edits to pass trivially is a change to how CI runs
(`changesCi`), which merges only once the security reviewer approves that diff,
or by a person where no security seat is set up or `ciMergeByPerson` lists the
repository; GitHub's CI still decides the merge.

**They are best-effort guards against a task's mistakes, not boundaries.** A
session holds its bot's GitHub token (`GH_TOKEN`), and `node` and `python` are
allowed commands, so a task can call the API directly and do anything its
account may, around both of them. On Codex, whose sandbox runs every command,
`curl` works too. A session can also run the real `git` or `gh` by its full
path, or unset `FLEETADLC_TOOLS_POLICY` in its own shell. A command git runs itself finds git's own binary
first, so its pushes are not read. The guard refuses the commands and options
whose job is to run one, abbreviated or not: `rebase --exec`/`-x`,
`difftool --extcmd`/`-x`, `--upload-pack` on `fetch`, `pull`, `ls-remote`,
`clone` and `fetch-pack` (and its `--exec`), `archive --exec`,
`grep --open-files-in-pager`/`-O`, `filter-branch`, `bisect run` and
`submodule foreach`. It does not
stop the rest, which is not a closed list:
- a hook;
- an external `git-<name>` command;
- a command a setting names, whether in the repository's configuration, in
  the environment (`GIT_PAGER`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`,
  `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`) or given with `-c`:
  `core.pager` and `pager.*`, `core.editor`, `sequence.editor` (which can
  write `exec` lines into an interactive rebase's todo list),
  `core.fsmonitor`, `core.sshCommand`, `core.hooksPath`, `diff.external`,
  `*.textconv`, and merge, diff and filter drivers;
- `push --receive-pack`/`--exec` to a remote on this machine.

**Nothing on GitHub stops a crew account pushing to a branch.** The `agent/**`
and `system/**` ruleset refuses only a force-push and a deletion
(`agentBranchesRuleset`). It does not say who may update them, so a reviewer
can fast-forward a builder's branch after approving it, and a builder can
fast-forward another bot's. The base branch's ruleset does not dismiss stale
reviews or require the last push to be approved
(`dismiss_stale_reviews_on_push` and `require_last_push_approval` are off,
`mainRuleset`). On GitHub's free plan a private repository holds no rulesets
at all. What does hold, whatever a session runs:

- **`review-gate`**, which the bridge sets. It waits for a verdict from every
  requested reviewer, asks again when the diff changes, and holds for a person
  where a human-review path is touched. A review from an account that was not
  requested, such as a builder's `gh pr review` on its own pull request, is not
  one it waits for. A push by a reviewer or the automation account that changes
  a pull request's diff fails it on that head, naming the account, however the
  commits name their author: who pushed is GitHub's to say, the author is
  whatever the committer typed (`pr.forbidden_push`,
  `apps/bridge/src/webhooks.ts`). The merge line's update of a branch changes
  no diff and is not one.
- **Commit signing per seat.** Each session signs commits with its bot's own
  key, through an agent that signs for it and never hands the key over, and
  the base branch requires signed commits where a ruleset can be set. A
  Verified commit shows which account made it, and on an account with one
  seat, which seat. It is not proof of the seat on a shared account: a
  session's token carries the app's "SSH signing keys" permission, so a
  session could add a key, which verifies for the whole account, or remove a
  seat's key. The `signing-key` check warns of any key on a crew account that
  is no seat's, and registers a seat's own key again when it is gone.
- **The bridge's watch on merges.** A crew account merging a pull request
  whose `review-gate` was not green, or could not be read, is audited
  (`merge.unreviewed`), commented on, and labelled `needs-human`
  (`noticeUnreviewedMerge`). Its testing deploy is held: the issue is not
  moved and nothing is dispatched until a person moves its card to Merged,
  which lets it deploy, or reverts it. This is a hold, not a block. The commit
  is already on the default branch, so the next reviewed merge's deploy
  carries it unless it is reverted. The gate it
  reads is the one OpenADLC published (`publishedGate`): the app's check run
  and the status the app or the automation account set, the most restrictive
  of them. A `review-gate` status any other account wrote counts for nothing.
  A direct push to the default branch of a repository without rulesets is not
  watched.
- **Attribution.** What a session posts through OpenADLC's `gh` is signed as its
  seat and task, and for the task's repository when it has one. A comment,
  review or edit is signed for the issue or pull request it is on, and checks
  nowhere else: when a `gh pr comment`, `pr review` or `pr edit` names no
  number, OpenADLC's `gh` asks the real one for the pull request it acts on
  (the current branch's, or the branch or URL given) and signs for that; if
  the lookup fails the post goes out signed with no number. A new issue or
  pull request has no number yet: its signature is tied to the first place it
  is seen, and refused on any other. Where the install enforces signatures, a crew review written around it
  counts for nobody; in either mode, an approval from the lead or a blocking
  seat written around it lands no merge. With signatures enforced it is not
  shown as anybody's either: the lead's `reviews.md` lists a crew review as a
  seat's only when the merge gate would count it, headed by the seat its
  signature names, and puts the rest under **Not signed by OpenADLC** as no
  seat's verdict. A patch round's `reviews.md` and the crew's comments in
  `pull-request.md` are split the same way. What a person writes in the console
  (a message, a gate's answer, a reason to cancel or close) goes on GitHub
  through a crew account with OpenADLC markup made inert (`inertMarkup`), so
  it carries no marker, seat tag or signature; and design memory is recorded
  only from a comment by the design seat.
- **Dismissing a review:** OpenADLC's `gh` refuses the dismissal endpoint
  (`pulls/<n>/reviews/<id>/dismissals`) and GraphQL's
  `dismissPullRequestReview`. That is a guard, not a boundary: a session holds
  its token, and `node` with `GH_TOKEN` reaches the same endpoint. What holds
  is the merge rule, which reads a dismissed request for changes from the
  timeline and keeps counting it unless someone who can write dismissed it;
  and when a bot account dismisses one, the bridge says so on the pull
  request, audits it, and asks the dismissed reviewer again, while
  `review-gate` waits for that review.
- **Approving a production deploy:** the GitHub environment, where the
  repository's rules say `approval: reviewers` and that environment is holding
  a required reviewer. Where it is not — the plan cannot hold one (a private
  repository below GitHub Enterprise), nobody is named, or the environment
  could not be read — the bridge holds the promote in Needs you until a person
  releases it. With `approval: auto` it waits only for the soak timer
  (`soakMinutes`, 30 by default).
- **Starting a deploy:** OpenADLC's `gh` refuses the deploy skill
  `gh workflow run deploy-testing` and `promote-production`, by name, file
  name, path or number, `gh run rerun` and `gh api`; it may still run
  `rollback-production`. Every other skill denied `gh workflow run` is denied
  `gh run rerun` too, through `gh api` as well: a re-run starts the same
  workflow, a promote included, again.

Nothing holds `gh workflow run` besides the guard: a workflow a task starts
runs with that workflow's own permissions, and anyone with write access can
dispatch `promote-production`, crew tokens included (the app holds
`actions: write`). What holds a promote, whoever started it:

- **The testing check, always.** Before it builds, migrates or deploys
  anything, `promote-production` refuses a candidate that is not on the
  default branch, or that it cannot prove by the runs' names: a successful
  `deploy-testing <sha>` run the bridge dispatched on the default branch, a
  green `smoke-testing of deploy-testing <sha>` that `workflow_run` started
  (the latest that finished and was not skipped or cancelled; a smoke
  dispatched by hand does not count), and the `testing` deployment whose
  status `log_url` names that deploy run, with its newest status `success`, or
  `inactive` after `success` once a newer deploy has replaced it. Not the
  commit's own deployment or `head_sha`: GitHub records those at the default
  branch's tip when the deploy was dispatched. It is the same proof the bridge
  asks before it dispatches one.
- **Then the environment.** Under `approval: reviewers`, where `production` is
  holding a required reviewer, the promote waits for that person. Under
  `approval: auto` GitHub holds it only for its wait timer, the soak
  (`soakMinutes`, which may be 0). Where the environment is not holding a
  reviewer, the bridge's hold in Needs you covers only the promotes the bridge
  dispatches. So a production deploy does not always wait for a reviewer: for
  one dispatched by hand under `auto`, the testing check and the soak are all
  there is.
- **The emergency override.** For a hotfix that cannot wait for testing, a
  person with `admin` or `maintain` on the repository dispatches the promote
  with `emergency_override` set to the reason. The workflow skips the testing
  check only for such a person: it refuses a login ending in `[bot]`, and
  anyone GitHub says has less. The run is named
  `promote-production <candidate> (emergency override)`, its summary records
  who and why, the bridge audits it (`deploy.promote_override`, with the login,
  the commit and the run) and its `promote_waiting` notification says whose
  override it is. Crew seats are invited with write or triage, and the crew
  access check raises a blocking card for one that holds admin or maintain,
  since it could use the override. The deploy skill never sets it.

### The console

Identity is load-bearing: it decides who may answer a gate, move a card and
satisfy `review:human`, and it is what `audit` records for every attach, kill,
restart, gate answer, card move and settings change. So it is verified rather
than read.

Under IAP an identity is the person's email, and what the bridge posts on
GitHub for them (a gate's answer, a card moved back, a Cancel or a Close) is
public. So only the name part of a console identity is written to GitHub: the
part before the `@`, or "a person in the OpenADLC console" when the install
does not know who it was (`publicNameOf`, `apps/bridge/src/thread-view.ts`).
The full identity stays in the audit log, the gate record and the console
thread.

`FLEETADLC_IDENTITY_MODE` chooses how, and `fleetadlc status` and the bridge's start-up
line both say which is in force, because the difference matters and is otherwise
invisible:

| Mode | How the person is established | Use |
|---|---|---|
| `iap` | The `x-goog-iap-jwt-assertion` JWT is verified against Google's published keys, pinned to ES256, and checked for issuer and for `FLEETADLC_IAP_AUDIENCE`. The identity is the `email` claim of the verified token. | A cloud install |
| `local` (default) | The `x-fleetadlc-identity` header, believed only beside the install's console secret (`x-fleetadlc-console-secret`), which only the console's server and the `fleetadlc` CLI hold. A request without it gets 401 and never reaches a handler. `x-goog-authenticated-user-email` is not read. | An install run by `fleetadlc up` or the compose stack |

In `local` mode the console has a sign-in of its own. `fleetadlc up` prints the
console as a link, `http://127.0.0.1:47300/signin?token=…`, and `fleetadlc
console-link` prints a fresh one. The token is an HMAC of its expiry under the
console secret and works for an hour; opening it sets a `fleetadlc_session`
cookie (HttpOnly, SameSite=Lax, thirty days) signed the same way under another
label, so a link is never a session. Until a browser has that cookie the
console answers every page, server action and `/api` route with 401, and only
`/signin` with a page saying how to get a link. The middleware skips only the
exact static paths `/_next/static/…`, `/_next/image` and `/favicon.ico`. A path
that merely starts like one of those still requires the cookie. A server
action checks the cookie again before it attaches the console secret, so one
posted to a path the middleware does not run on still cannot call the bridge. Neither the link nor the cookie
is the secret, and the secret never reaches a browser. The console listens on
127.0.0.1 unless `FLEETADLC_CONSOLE_HOST` says otherwise.

Three things about `iap` mode are worth stating, because each is a way the check
could look like it was working and not be:

- **A request whose assertion does not verify is refused, not downgraded.**
  `x-goog-authenticated-user-email` sits next to the assertion and is only a
  header; anything that reaches the bridge can set it. In `iap` mode it is
  ignored entirely.
- **The audience is checked, not just the signature.** An assertion IAP
  correctly signed for a different backend service is a valid JWT. Without the
  audience it would be accepted here, which is why the bridge refuses to start
  in `iap` mode with no `FLEETADLC_IAP_AUDIENCE` rather than run a check that passes
  everything.
- **The algorithm is pinned, not read from the token.** A verifier that takes
  `alg` from the thing it is verifying can be handed `none`.

`/webhooks/*` and `/internal/*` are not subject to this person check. GitHub
cannot present an IAP assertion, and neither can the dispatcher. That is not a
claim that `/webhooks/github` does not act as a person: an issue comment
answers a gate as the login in the delivery, and that login is read only after
the signature verifies. A browser `Origin` on those routes is still refused,
as below; GitHub and hostd send none, which is why their calls are unchanged.

### Roles

Past identity, each `/v1` request has a role, looked up by the verified email in
the `users` table (cached for ten seconds, cleared by any change made through
the bridge). An admin may call every route; a user only the ones that create and
run work and read the board, threads, crew and costs. Every route is classified
in `ROUTE_ROLES` (`apps/bridge/src/roles.ts`); one missing from it needs an
admin, and `roles.test.ts` fails for any registered route that is missing, so a
new route is safe by default and decided on purpose. The router checks the role
before the handler runs, so a refusal (`403 this needs an admin`) changes
nothing, whatever the console showed.

A role covers every managed repository, whatever the person's permission on
GitHub. A user answers any repository's gates from the console, approving a
plan change and continuing past a cost cap included, where an answer from
GitHub needs one of the install's humans or triage or more on that repository
(`mayAnswerGates`). A user also stops, retries and dismisses any task, has the
crew comment in any managed repository, and reads every thread and attachment,
private repositories included. Give the role only to people trusted with every
repository the install manages.

Someone IAP admits who is not in `users` gets `403 not-a-user` on every route,
with the admins' emails so they know whom to ask, and the refusal is audited
once per person per day. A cloud install whose `admin_emails` and IAP members
name nobody makes no first admin and refuses everyone with `403 no-admin`
rather than trusting whoever arrives first. A cloud install is always behind
IAP, with no setting to turn it off: the module's old switch for that left
anyone on the internet, and every task session, an admin. A bridge on Cloud
Run refuses to start in local mode, and a `cloud.tfvars.json` that still sets
the old variable gets a Terraform "undeclared variable" warning and IAP turned
on at the next apply, so `console_members` must name the operator first. How
the first admins are made, and why a local install does not refuse an unknown
name, is in
[self-hosting](self-hosting.md#who-may-do-what-in-the-console). Adding,
removing and changing a role are audited (`user.added`, `user.removed`,
`user.role_changed`) in the same transaction as the change, and the last admin
cannot be removed or demoted.

On a local install roles are advisory: every console request carries one
identity (`FLEETADLC_IDENTITY`, or `console` when it is unset), so they restrict
nobody, and anyone who reaches the console acts as an admin. The console's Users
card says so. Demoting that identity would close Settings with no way back from
the console, so the bridge refuses it there (`409 self-demote`); an install
locked out already sets `FLEETADLC_IDENTITY` to an admin's address and runs
`fleetadlc up` again.

### Attachments

A person can give the crew files with a request or a message: screenshots,
mockups, PDFs, text. They are kept in OpenADLC's database (`attachments`,
[ADR 0001](adr/0001-attachments-in-the-database.md)), given to the crew's
models when a task about that work item starts, and **never posted to
GitHub**: an issue lists them by name and links to the item in the console,
not to the files.

- **What is taken is decided by the bytes**, not the name or the header:
  PNG, JPEG, GIF and WebP images, PDFs, and UTF-8 text (`.txt`, `.md`, `.csv`,
  `.json`). SVG and HTML are refused under any name, because either can carry
  script, and so is text that starts like a page.
- **Text with a credential in it is refused**, with the kind that was found,
  by the same shapes every log and thread line is masked by (`SECRET_SHAPES`
  in `packages/shared/src/redact.ts`): a GitHub token, an Anthropic, OpenAI or
  xAI key (`sk-ant-…`, `sk-…`, `sk-proj-…`, `xai-…`), a JWT, a `Bearer` token,
  a PEM or OpenSSH private key, and a password in a URL of any scheme. A file
  is handed to a model, and a token in it would be too. Only those shapes are
  known: another credential, such as an AWS access key or a Slack token, is
  not caught.
- **Served so nothing in it runs.** `GET /v1/attachments/:id` answers with the
  type the bytes were found to be, `x-content-type-options: nosniff`, and
  `content-security-policy: sandbox`; images and PDFs show in place, text
  downloads. The console proxies it and keeps those headers, adding
  `frame-ancestors 'none'` to the policy.
- **Only the uploader can send an upload**, within a day; an upload nobody
  sent is swept by the hourly `attachments` job. A request or a message whose
  files cannot be claimed is refused whole.
- **Removing one is an admin's** (`DELETE /v1/attachments/:id`), audited as
  `attachment.deleted` with its name, size and hash.
- **A task reads them, never the network.** hostd fetches each file from the
  bridge with the install's secret (`/internal/attachments/:id`), refuses
  bytes that do not match the hash the bridge sent, and writes them beside the
  task's context, outside the worktree, so nothing commits them. Claude is
  given that one folder to read (`--add-dir`); Codex the images on its command
  line; Grok the list.
- **Images in an issue** are read into its work item by the bridge, for
  intake, design and the build (`apps/bridge/src/issue-assets.ts`): only from
  the body and the comments of people OpenADLC acts for (`actsFor`), only
  from GitHub's image hosts — `github.com/user-attachments`,
  `private-user-images.githubusercontent.com`,
  `user-images.githubusercontent.com`, `objects.githubusercontent.com` — over
  https, following a redirect only to another of them, under the same limits
  and checks. A link in an issue cannot make the bridge fetch an address on
  its own network. Triage still may not run `curl`: it reads the file the
  bridge kept.
- **Personal data.** A screenshot can show a person's name, an email, a
  customer's record. OpenADLC keeps it until an admin removes it (`DELETE
  /v1/attachments/:id`); removing a repository from OpenADLC deletes nothing,
  its attachments included, and backups carry them in the history group.
  Treat attachments as you treat the database: who can read the console, and
  who holds a backup's passphrase, can read them.

### GitHub deliveries

Every signed webhook delivery is recorded in the `events` table. A delivery for
a repository the install manages, or one with no repository (a ping, an
installation change), is kept whole, payload and all: an issue's or comment's
body is in it. A delivery for a repository the install does not manage keeps
only its type, its delivery id and the repository's name, never its content;
an app installed on more repositories than OpenADLC works in does not fill the
database with theirs. Once processed, a delivery is kept for
`FLEETADLC_EVENT_RETENTION_DAYS` (30 by default; 0 keeps them for good), and
the daily `events` job removes older ones, except the newest, which says when
GitHub was last heard from. The platform's own events, which the board reads
back over windows, and the jobs' run records are not removed. Backups carry
what the table holds when they are made.

### A page on another origin

The console's browser does not call the bridge. Reads and actions go to the
console, and the console's server calls the bridge, so the bridge sends no
`Access-Control-Allow-Origin`. A page elsewhere cannot read a response,
including one that mints an attach token.

The bridge refuses a state-changing request that comes from a browser that is
not the console. Browsers send `Origin` on `POST` and `PATCH`, and `Sec-Fetch-Site`
of `cross-site` or `same-site`. `same-site` is the one that matters on a
machine: another port on `127.0.0.1` is a different origin and is still
same-site, so refusing only `cross-site` would leave a page served from this
host working. The origins that are allowed are the console's
(`FLEETADLC_CONSOLE_URL`, or `http://127.0.0.1:47300` when that is unset) and, for
a loopback console, the other loopback names of that same port. A request with
neither header is not a browser — the console's own server, the CLI, hostd,
GitHub — and is served. The check runs in `local` and in `iap`. In `iap` a
credentialed read is unreadable anyway, but a `text/plain` POST would still be
a working cross-site request: the body is parsed as JSON whatever its content
type, so the origin check is what refuses it.

The console needs the same check of its own, because the bridge cannot see the
page behind a console call. Each `/api/*` route handler forwards its body to
the bridge from the console's server, a hop with no `Origin`, and Next checks
the origin of a server action but not of a route handler. So
`apps/console/src/middleware.ts` applies the bridge's rule to `/api/*`. There
the console is the host the request was sent to: an `Origin` whose host is the
request's `Host`, or its first `X-Forwarded-Host`. That is the comparison Next
makes for a server action, so this check needs no configuration for a console
opened under another name; the name itself is checked below.

Nor may a page elsewhere frame the console. Every response it serves carries
`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`
(`apps/console/src/lib/security-headers.ts`), so a site cannot load the console
in an invisible frame and line a click up with a gate's answer, Stop or Hold: a
server action fired inside that frame is same-origin, and neither check above
would refuse it. A file from `/api/attachments/:id` carries both in one policy,
the bridge's `sandbox` and `frame-ancestors 'none'`.

A `GET` passes both origin checks, and one console page acts on a `GET`: the
one GitHub sends a person back to after creating the app, which exchanges the
code it carries for the app's client id, key, webhook secret and client
secret, and stores them. Any link could send the operator's browser there with a code of its
own, minted from a manifest anybody can post, and that replaced the install's
app. So the code is exchanged only beside a `state` the bridge issued when
create was pressed in the walkthrough (`POST /v1/app-manifest/prepare`, which
a page elsewhere cannot read): random, good for an hour, and spent on the
first exchange, whether it worked or not. With no state, or one the bridge
did not issue or already spent, nothing is asked of GitHub and nothing is
stored. An app created in an organization's form must belong to that
organization, too.

Neither comparison stops DNS rebinding. A name someone else controls, rebound to
this machine, is the same origin as the console as far as the browser is
concerned, so the origin checks let a page on it read the console and the
bridge's `GET` routes, a bot's screen among them.

What the page cannot hide is its name: the browser sends it as `Host`. So the
bridge and the console answer a person's request only under a name the install
is served under, and anything else gets `421 Misdirected Request` with no body:

- an address, IPv4 or IPv6: rebinding needs a name, and a page whose own
  address is this machine's was served from this machine. A console opened on
  a LAN address passes this check, once it listens there
  (`FLEETADLC_CONSOLE_HOST=0.0.0.0`); the browser still signs in with the
  link `fleetadlc console-link` prints;
- `localhost` and `*.localhost`, which the browser resolves itself, and
  `host.docker.internal` and `host.containers.internal`, a container's names
  for the machine it runs on;
- the hosts of `FLEETADLC_CONSOLE_URL` and `FLEETADLC_PUBLIC_URL`; for the bridge,
  `FLEETADLC_BRIDGE_URL` (the compose file sets it to the `bridge` service name the
  console calls it by); for the console, `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL`;
- on Cloud Run (`K_SERVICE` is set there), any `*.run.app` name. A service does
  not know its own run.app address to list it, the console's server and hostd
  call the bridge by exactly that address, and nobody but Google can point a
  run.app name anywhere;
- whatever `FLEETADLC_ALLOWED_HOSTS` lists, comma-separated, as names (`mybox.lan`,
  `mybox.lan:47300`) or URLs (`http://mybox.lan:47300`). A console opened under
  a LAN hostname or through a tunnel of the operator's own needs its name here;
  `allowedHosts` in `install.json` keeps it across `fleetadlc up`. `*` switches the
  check off.

A cloud install is defended twice over. The load balancer listens only on 443,
with a certificate for the console domain alone, so a page on a rebound name
fails TLS before any `Host` is read, and IAP's cookie is scoped to the console
domain. The bridge's ingress admits only the VPC and the load balancer.

On the bridge the check covers the routes that act for a person. `/webhooks/*`
arrives under whatever name GitHub was pointed at, a tunnel's included, and is
authenticated by its signature. `/internal/*` needs the install's secret.
`/healthz` is asked by whatever checks health. A page can read nothing from
any of them that it could use. The console checks every path but Next's own
static files, `X-Forwarded-Host` as well as `Host`, since a page on the same
origin can set the former without a preflight. The bridge and the console each
log a refused name once, with the setting that admits it, and stop after a
hundred names, since anything on the network can send a new one with every
request.

The terminal upgrade checks `Origin` before the token is redeemed, so a probe
from another page does not burn a token. A browser cannot omit `Origin` on a
WebSocket. A client that sends none is not a browser and still has to present
a valid token. The origins admitted are the console's, by the same rule as the
bridge: `FLEETADLC_CONSOLE_URL` as hostd sees it, or the loopback console when that
is unset. A console opened under any other name — a cloud domain, a LAN
address, an SSH tunnel, a remapped port — cannot open the terminal until
`FLEETADLC_CONSOLE_URL` names it for hostd, and the terminal pane names the
setting when its socket fails. The cloud module sets it from `console_domain`. The `Host` header is not consulted: an `Origin` that matches
the host the socket was reached on is also what a name rebound to this machine
looks like, and admitting it would let a page on such a name open a shell.

The attach token does not travel in the query string. The console offers it as
the WebSocket subprotocol `fleetadlc-attach.<token>`. Query strings are written to
proxy access logs, and this token is a shell. A token presented only as
`?token=` is refused, and refusing it does not redeem it. Nor does a handshake
the WebSocket server would refuse anyway: the token is redeemed only once the
upgrade is otherwise well formed, and the subprotocol echoed back is the one
whose token was redeemed.

The routes outside the person check, `/internal/*` and `/webhooks/github`, are
each authenticated in their own right.

**`/internal/*` needs the install's shared secret**, on every route, applied
where the route is registered rather than remembered by each handler. The
legitimate callers are the dispatcher, the CLI and hostd, which read it from the
secret store.

A task's own session is the exception, and gets a narrower credential rather
than that one. The skill runner *is* the session's command, so its reports come
from inside the bot's computer — and the install secret would also open
`/internal/dispatch/lease`, letting a bot start work as any other bot, forge the
ledger, or answer for tasks that are not its own. So hostd mints an HMAC of the
task's id under the install secret and puts it in the session environment. It
admits that session to the bridge's `/internal/tasks/<its own id>/*` and,
while the task runs, to hostd's `GET /tasks/<its own id>/registry-token`, which
returns the install's private-registry token when one is configured; to nothing
else. A bot cannot derive one for another task, because it never sees the key.

**A session reports its own usage**, and the token is in its environment, where
the engine and every command it runs can read it. So the bridge records only
what a real engine call of that task could have made. `POST
/internal/tasks/<id>/usage` books the report to the task in the path, never to
a `taskId` in the body. It refuses, with a 400 and nothing written:

- a cost that is not a number, is negative, NaN or infinite, or is more than
  the task's cap plus one step of the per-task cap;
- token counts that are not whole numbers of 0 or more;
- an empty model, or an alias that is not a `newest:` one;
- an engine other than the task's bot's own (`none`, the scripted engine, only
  while `FLEETADLC_SCRIPTED_ENGINES=1`);
- a task that is not running or paused.

The ledger and the task's cost refuse a negative or NaN amount themselves too.
Within those bounds the ledger is only as honest as the session: one can still
under-report what it spent, or report up to the ceiling, and a cap counts what
was reported.

| Caller | Holds | May reach |
|---|---|---|
| Dispatcher, CLI, hostd | the install secret | every `/internal` route |
| The console's server, the CLI | the console secret (local mode); in `iap` mode, IAP's assertion | `/v1/*` |
| A task's session | an HMAC of its own task id | `/internal/tasks/<that id>/*` |
| A task's session, at hostd | the same HMAC | `GET /tasks/<that id>/registry-token`, while the task runs |
| GitHub | nothing; its delivery is signed | `/webhooks/github` |

The console secret is its own, not the install secret, because the install
secret also opens `/internal/dispatch/lease` and the console must never hold
that. Neither is in a task's session.

**Every GitHub delivery is signed.** `POST /webhooks/github` checks
`X-Hub-Signature-256` and refuses the request when the signature is missing,
wrong, or when the install has no webhook secret. There is no configuration
in which that check is skipped. An empty secret is not verified against: an
HMAC under the empty string is computable by anyone, so it would let a forged
body answer a gate as whatever person it named. `fleetadlc doctor` reports
an install that still has no secret, and warns when `FLEETADLC_WEBHOOK_SECRET`, the
install file and the database hold different ones. `fleetadlc init` and the
console walkthrough keep a secret any of those already has, and generate one
only when none does. The value is not written to logs.

A delivery with no signature header, or on an install with no secret, is
refused before any of its body is read, and a signed one is read only up to
GitHub's own 25 MB ceiling (413 past it), the same cap the tunnel's gateway
applies. Every other route reads a JSON body up to 4 MB, and a restore up to
96 MB, counted on the bytes that arrive, so a body that declares no length is
cut off too.

Under the docker driver the terminal is a `tmux attach` inside the task's
container, behind a one-minute, one-use attach token; it reaches nothing on the
host. Under the local driver it is a `tmux attach` on the host as hostd's user,
which is a shell on the host. Only an admin may mint
one (`POST /v1/terminal/:bot/:session/token` is an admin's route, and hostd's
gateway redeems nothing else), for any bot and any session, including a session
that is not running yet — the gateway is what finds that out. On a cloud
install the gateway's own IAM binding (`operators`) applies as well. There is
no per-bot grant; past the role, the token is the whole of the authorization:
one bot, one session, one minute, one use.

## Secrets

| Secret | Where it lives | Lifetime |
|---|---|---|
| Per-bot GitHub refresh token | Secret store (`~/.fleetadlc/secrets/*.secret`, mode 0600, or a cloud secret manager) | 6 months, rotated on every use |
| Per-bot GitHub user token | The task's session environment, and the secret store (`github-token-<bot>`) for an app with token expiry off. Like the session's other credentials (its model key or token, its task token, its database's URL with the password, a registry token) it is on no command line, on the host or in the task's computer, so `ps` never shows it: a session's environment reaches it in a file only it can read, which it reads and removes before it runs (in `/dev/shm` in its container under `docker`, in hostd's temporary directory under `local`); a `docker exec` or `docker run` names a credential with `-e NAME` and holds its value in the docker client's own environment; and OpenADLC's `pnpm` and `fleetadlc-install` hand the task token to `curl` on stdin (`apps/hostd/src/drivers/credential-env.ts`) | 8 hours, or until revoked for a token that does not expire |
| GitHub App private key | Secret store (`github-app-private-key`); never given to a task under the `docker` driver, but readable by a task under `local` | until a new one is generated on the app's page |
| Per-bot SSH signing key | Secret store; loaded into a per-task `ssh-agent` | until rotated |
| Attribution key, which signs the crew's posts | Secret store (`attribution-key`); held by the bridge, never given to a task | until rotated with `fleetadlc attribution rotate`; a rotated key keeps checking old posts for 30 days, unless `--drop-old` |
| Per-bot engine API key | Secret store; injected per session | until rotated |
| Model account API key, or a Claude subscription's `claude setup-token` token | Secret store (`model-account-<id>`); injected per session as the provider's key variable, or as `CLAUDE_CODE_OAUTH_TOKEN`; sent by the bridge and hostd, in a header, to the provider's `/v1/models` to list what the account can call | until replaced or revoked |
| OpenAI or xAI subscription login | `~/.fleetadlc/logins/<account-id>/sign-in/auth.json`, in 0700 directories; mounted (the file for Codex, its `sign-in` directory for Grok) only into the computers of tasks whose seat is on that account, and into hostd's throwaway containers that sign it in, check it and, for xAI, run `grok models` | refreshed by its CLI; deleted with the account |
| Task database superuser (`fleetadlc-taskdb`) | No password: reached only through `docker exec` inside its container. The random one the image needs to make a new server is kept nowhere | removed as soon as the server is up, and again at every hostd start |
| Private package registry token, when `FLEETADLC_REGISTRY_HOST` is set | Secret store (`registry-token`); served raw by hostd to any task running on the host that asks with its own task token, so any session can read it and send it anywhere its egress allows. Store a read-only one ([self-hosting](self-hosting.md#installing-from-a-private-package-registry)) | until a person rotates it; the five minutes hostd sends with it is a caching hint |
| The install's internal secret (`internal-api-secret`), which opens every `/internal` route of the bridge — the token service that hands out every bot's GitHub token among them — and hostd's API | Secret store; generated by the first `fleetadlc up` or bridge start, read by the bridge, hostd and the CLI. Never given to a task, though each task's own token is derived from it | until a person deletes it from the store and restarts the bridge and hostd, which generate and read a new one; the running tasks' tokens stop working with the old one |
| Platform database password | `databaseUrl` in `install.json` (0600), which the first `fleetadlc up` gives a password of the install's own in place of the published `fleetadlc`; `POSTGRES_PASSWORD` under `infra/local/docker-compose.yml`; on Google Cloud, the `<prefix>-database-url` secret in Secret Manager and the Terraform state | until rotated: `ALTER ROLE … PASSWORD` on the server, then the new value where the install reads it; on Google Cloud, replace `random_password.database` and apply |
| Webhook secret | The secret store (`github-webhook-secret`), where the app's creation, the webhook step, `PATCH /v1/install` and `fleetadlc init` write it and the bridge reads it on each delivery; also `install.json` (`0600`) for a local install, the `webhook-secret` volume under `infra/local/docker-compose.yml`, and the bridge's environment (`FLEETADLC_WEBHOOK_SECRET`), which it falls back to. Never the database: an older install's settings row is moved into the store when the bridge starts | until rotated |

Outside this table, a credential is on disk in one more place, and only when
someone asks for it: a backup (`fleetadlc backup`) carries the App key, signing
keys, the webhook secret, the registry token, bot tokens, API keys and
subscription tokens, encrypted with its passphrase — or in plain text when it
is written with `--unencrypted`. Keep one as you would the secret store.

**Rotating the attribution key.** `fleetadlc attribution rotate` asks the
running bridge (`POST /v1/attribution/rotate`, an admin's) for a new key; the
bridge signs with it at once, and the audit log records who rotated it and the
key ids, never a key. A routine rotation keeps the old key checking posts
signed before it for 30 days, so nothing already posted turns into a
stranger's. After a leak — a backup written with `--unencrypted`, or a secret
store someone else read — use `--drop-old`: the old key and every key retired
before it stop checking at once, since a leaked key that went on checking would
let whoever holds it post as the crew. With signatures enforced
(`attributionMode: enforce`), crew reviews posted under the dropped keys stop
counting toward a merge, so an open pull request waits for a fresh lead review;
in audit mode nothing is held. Either way, take a new backup: an older one
restores the old key.

OpenADLC never asks for a personal access token, and nothing in the repository
should ever contain one. If you find a credential in a diff, treat it as leaked:
revoke it at the provider, then rotate.

What a session prints can hold a credential: a token a bot wrote into its
narration or a command line, or `env` typed by a person who took the terminal
over. So a session's pane lines and its last line pass through `redactSecrets`
(`packages/shared/src/redact.ts`) before hostd's observer stores them in the
`session_log` table and `sessions.last_line`, as does the pane hostd serves to
the Computer tab, and the bridge does the same to a local CI run's log tail
before it is stored. The redaction knows credentials by their shape, not by
value. A session's last line is shown only to admins; the crew page a user
reads leaves it out.

## Who OpenADLC acts for

On a public repository anybody can open an issue, comment on one, review a pull
request or open one from a fork. OpenADLC acts only for **people with access to
the repository** and for **its own crew**: an author GitHub describes as
`OWNER`, `MEMBER` or `COLLABORATOR`, or one of the bots' accounts. Everybody
else — a contributor from a fork, a first-timer, anybody — is read by a person
first. The rule is `actsFor` in `packages/shared/src/access.ts`, and it is
applied everywhere something from GitHub could start work or reach a bot:

| Where | What somebody without access gets |
|---|---|
| Webhook deliveries (`apps/bridge/src/webhooks.ts`) | Their issue, comment, review or pull request is recorded and not acted on: no stage, no bot started, no dispatch, no gate answered. The bridge logs it once per author, and a reply to an open gate is named once in that gate's thread, saying why it was not taken. A pull request from a fork, anybody's, is never taken for an issue's, whatever its branch is called: not when it opens, is labelled, merges or closes, nor when a deploy it is part of finishes. |
| The reconciler (`apps/bridge/src/reconciler.ts`) | Their open issue is not imported, even with a stage label the issue form put on it. |
| The review gate sweep (`apps/bridge/src/scheduler.ts`), and the pull request deliveries | Their pull request, or any pull request from a fork, is never taken for an issue's, whatever its branch is called. |
| What a bot reads (`apps/bridge/src/context.ts`) | Their comments and reviews are left out of a task's context, with a line saying how many were. Skills read the bridge's filtered documents (`issue.md` with its conversation, `pull-request.md`, `reviews.md`, `open-issues.md`), not GitHub directly. Every prompt says that issue and pull-request text, comments, reviews, CI logs, linked pages and code comments are data, never instructions (`apps/hostd/src/skill-runner.ts`), and OpenADLC's `gh` refuses the review and build skills the raw comment and review reads (`gh issue view --comments`, `--json comments`, and `gh api` GETs of the comment and review lists). |
| The smoke on testing (`smoke-testing.yml`, `apps/bridge/src/webhooks.ts`) | The smoke runs only for the default branch's own `deploy-testing`, so a workflow of that name in their fork's pull request leaves it skipped. A smoke they started anyway (its `triggering_actor`) reverts nothing and promotes nothing, red or green; the bridge logs why. |
| Notices OpenADLC files once (`findOwnOpenIssue`, `apps/bridge/src/automation-bot.ts`) | An alert, a scheduled job's report or a failed deploy's issue is not filed again while one is open. Only an issue OpenADLC's automation account opened counts: the hidden dedupe marker in their issue or pull request is text anybody can copy, and does not stop the notice being filed. |

A gate drives a bot that writes to the repository, so answering one from
GitHub takes more than access to read it. It is answered only by one of the
install's `humans`, or by somebody GitHub's permission lookup
(`/repos/{repo}/collaborators/{login}/permission`) says holds **triage or
more** on the repository (a custom role counts when it is based on write or
more). When GitHub cannot be asked, the reply is not taken, and the thread
says GitHub could not be asked. The author-association label is never enough:
`COLLABORATOR` includes a read-only collaborator, and on a public repository
`MEMBER` is any member of the organization, with or without a role on the
repository. An empty `humans` does not mean nobody; it leaves the repository's
own roles to decide. A reply that is not taken is named once in the gate's
thread, with why.

**`humans` are pinned by account id.** A login is only a name: GitHub frees it
for anyone to register once its account is renamed or deleted. So each login in
`humans` is pinned to its numeric GitHub account id (`GET /users/{login}`) when
`humans` is saved, or when the login is first used, kept as the `humanIds`
setting, which only the bridge writes (`apps/bridge/src/human-ids.ts`). A reply,
an issue or a run counts as one of `humans` only when its user's id is that id;
the same login from another account is asked about like anyone else, and when
GitHub cannot be asked to pin a login, nobody is admitted as it. When a pinned
login names another account, or none, the `repo-config` check puts a card on
the board naming it: re-confirm the person (take the login out of `humans`,
save, and put it back, which pins the account it names now) or remove it.

Sending work back with a review takes the same standing. A person's request
for changes moves the work back to Build and opens a patch round only when
they may answer a gate; anyone else's stays on the pull request for the lead
to read, uses up no round, and is named once in the builder's thread, with
why. Nothing is posted on GitHub for it.

The crew's own accounts never answer a gate, and neither does another app's
account (type `Bot`, or a login ending in `[bot]`), even an app the repository
gave write access. A machine user — a GitHub account a person created for a
script — is type `User` and cannot be told apart from a person: given triage
or more, it answers gates like one. Do not give one a role on a repository
OpenADLC works in unless that is meant.

A person with access decides what happens to the rest. Acting on somebody
else's issue or pull request — labelling it, moving it, closing it — takes a
role on the repository, so a person with access who labels a stranger's issue
is who OpenADLC then acts for, and intake starts on it. Anything the stranger wrote
in the issue's body is then in front of a bot, which is what that person vouched
for by labelling it. Closing, locking or assigning a stranger's issue vouches
for nothing: it is not recorded and intake does not start. Only labelling does
that. No bot is started on a closed issue at all, by its delivery or by the
hourly sweep.

That vouching covers the title and body as they were when the person acted on
the issue. The bridge keeps that text, and it is what the board stores, what
Expected paths are read from, what a plan change widens, and what every task
reads. GitHub lets the author edit the issue at any time after. Bots do not
read the edit, and the author is told so once, on the issue; the bridge logs
it and records `issue.edit_not_taken` in the audit log. Labelling the issue
again does not take the edit with it: the person accepted the issue, not
whatever it says by then. An edit counts when GitHub says someone OpenADLC acts
for made it: a person with access, who accepts a stranger's edit by editing
the issue themselves, or a crew seat, as when a plan change adds paths. The
reconciler and the webhook judge it the same way (`vouched-text.ts`). CI's
scope check cannot ask the bridge, so it reads the issue's revisions from
GitHub and takes Expected paths from the one from before the author's later
edit, and fails, saying what to do, when it cannot read it
([development.md](development.md#before-a-pull-request)). HTML comments, which GitHub does not show the person
reading the issue, are taken out of a body whose author OpenADLC does not act
for before it reaches a prompt.

A push to a pull request's branch takes no role: on a fork, the fork's owner, a
second account they added, or an app running there can push. So a push, an
open, a reopen, a draft toggled or an edit is judged by the pull request's
author, whoever sent it, and a push to a stranger's fork changes nothing.

A pull request from a fork is reviewed by people, not by the crew: OpenADLC's
reviewers hold write access, so their approval would count, and the bridge never
merges a fork's head itself. A fork's
pull request is never taken for an issue's, whatever its branch is called, so
it holds no lease and closing it releases none. It gets no crew reviewers, and
no review on it opens a review or a patch round. A review or patch task reads a
pull request's description only when its author is someone OpenADLC acts for.

## Prompt injection

What stops an injected instruction from mattering:

1. **Little to exfiltrate.** A session holds its seat's GitHub user token,
   which may be a crew or reviewer account other seats share, narrowed to the
   task's repository when the install holds the app's client secret, and
   expiring in 8 hours; without that secret it reaches every repository the
   account can (see [The account](#the-account)). It also holds its model
   account's API key or Claude subscription token, which lasts until someone
   replaces it and is shared by every seat on that account, so rotate it when a
   task is suspected; for an OpenAI or xAI subscription, the mounted,
   self-refreshing login; a signing agent with its seat's key; and, through its
   task token, the private registry's token when one is set. There are no
   production credentials to find, as long as a repository keeps its deploy
   credentials where the deploy path says: in the `production` and
   `production-rollback` environments' secrets, or an OIDC trust pinned to them
   or to the default branch. A credential in a repository or organization
   secret is one a crew bot can read by pushing a workflow to its own branch
   ([self-hosting §9](self-hosting.md#9-the-deploy-path)).
   The install's own API is out of reach too: the bridge serves `/v1` only
   beside the console secret, which no session holds, so a session cannot
   download a backup or change a setting.
2. **Bounded write scope.** A change may land only inside the paths its lease
   declared, plus tests and its own documentation: the merge line holds a crew
   pull request to its lease's paths, and sends one that strays back to its
   builder. The skill's `tools.yaml` denies network binaries on Claude
   Code and Grok Build; on an `infra/gcp` install the egress allowlist below
   holds on every engine, and elsewhere there is none.
3. **No merge goes unnoticed.** OpenADLC's `gh` refuses a merge, an approval
   and a dismissal, and where GitHub enforces rulesets (public repositories,
   or paid plans) the main ruleset requires the lead's code-owner approval,
   `ci` and the app-pinned `review-gate`. On a private repository whose plan
   refuses rulesets, nothing on GitHub stops a crew account's token from
   merging: such a merge is detected (`merge.unreviewed`), flagged and its
   deploy held, not prevented (see the bridge's watch on merges, above). A
   review the builder dismisses with its token still holds the merge when a
   person had asked for changes, and the bridge says so on the pull request and
   asks the dismissed reviewer again. The builder cannot reach another seat's
   session either: minting a terminal token is a `/v1` route, which needs the
   console secret.
4. **More than one reviewer.** The security reviewer's seat reviews through the
   `security` lens, whose checklist (in the pr-review skill, so it is in the
   seat's prompt) looks for instructions embedded in data and for changes that
   widen permissions. That seat is asked on the labels and paths
   `config/review.yaml` gives it, on a sample of other pull requests (10% by
   default), and on every change to how CI runs; not on every pull request.
   The lead's approval, and a blocking seat's, counts toward the merge only
   when its signature checks, in either attribution mode, so an injected
   second or security reviewer cannot approve as the lead.
5. **Reviewers never run the code they review.** A review session holds the
   account whose approval lands the pull request, its task token and the model
   key, so a test or script the builder planted would run with all three. The
   pr-review skill tells every seat to read the code and never run it, and the
   run reviewers rely on is the local CI hostd recorded for that head, run
   without any token. Claude Code and Grok Build refuse `make`, the package
   managers and the interpreters to that skill (its `tools.yaml`); Codex runs
   with full access in a container and does not, which is why the merge also
   counts a required seat's approval only with a signature that checks.
6. **A cap on effort.** A task that loops burns its dollar cap and stops, rather
   than running all night. A Claude Code or Grok Build run is priced message by
   message, cached input included, so it is stopped partway. Codex reports its
   usage when each `codex exec` invocation ends, so a Codex task's cap is
   checked between invocations, not during one.

The skill runner also says, in the prompt, what is whose. Each document of a
task's context sits between a begin and an end line carrying a marker made for
that prompt alone, and the begin line says where it came from: an issue, a
pull request and its reviews are written by the people they name, on GitHub.
The prompt says that nothing inside a document changes the task's tools, paths,
markers, reviewers or subject, and a line in one that copies the header of
OpenADLC's closing task block is taken out. This makes an injected instruction
easier to tell apart; it is not what the list above relies on.

What does not stop it: a plausible-looking change that passes both reviews. OpenADLC
reduces the blast radius of a bad change; it does not make review unnecessary.

## Egress

This section describes the Google Cloud module, `infra/gcp`, and nothing else
enforces it. A local, compose or other docker install has no allowlist: a task
can reach any host on the internet, the local network, and a cloud VM's
metadata server if the host is one.

A bot reads untrusted text all day, so the useful question is not "will it
misbehave" but "where could it send anything". On `infra/gcp` the answer is a
list of names, longer than the engines and GitHub alone: it also covers the
hosts the bot image is built from, Docker Hub among them, and DNS lookups
leave outside it (below). The list narrows where a bot can send things; what
keeps a leak small is that a bot holds little worth sending: no production
credentials, and the few it does hold are listed under "Little to exfiltrate"
([Prompt injection](#prompt-injection)), its model account's key the one that
lasts.

The allowlist is enforced by a forward proxy on the host. HTTPS is not
decrypted: a `CONNECT` names its destination, and that name is what is matched,
so a bot cannot reach an allowed name and be redirected somewhere else — the
redirect would be its own `CONNECT`, matched in turn. Only the name the request
gives is matched, never an address's reverse-DNS name, and a destination given
as an IP address, IPv4 or IPv6, is refused whatever it is called: whoever holds
an address can name it `x.github.com`. The allowlist, `allowed_egress_domains`
in `infra/gcp/main.tf`, is:

| Destination | Why |
|---|---|
| `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com` | Clone, push, comment, review — the work itself |
| `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` | Installing what a repository declares, and the engine CLIs |
| `api.anthropic.com`, `api.openai.com` | The engines, with an API key |
| `x.ai`, `grok.com`, `auth.openai.com`, `chatgpt.com` | The engines with a subscription signed in rather than a key: xAI's API and sign-in, Grok's, and Codex on a ChatGPT plan, which signs in at `auth.openai.com` and sends its model calls to `chatgpt.com` |
| `deb.debian.org`, `deb.nodesource.com`, `nodejs.org`, `cli.github.com` | The weekly bot-image build on the host: the package repositories `infra/local/Dockerfile.bot` installs from |
| `auth.docker.io`, `registry-1.docker.io`, `production.cloudflare.docker.com` | The same build: Docker Hub's token service, registry and layer CDN, for the image's `debian:12-slim` base |
| `secretmanager.googleapis.com`, `logging.googleapis.com` | hostd's: credentials at task start, and logs |
| The bridge's Cloud Run host (`<prefix>-bridge-<project number>.<region>.run.app`) | A task reports its state, usage and gates to the bridge |
| Whatever is in `extra_allowed_domains`, and `registry_host` | Your own additions, and your private package registry (below) |

The proxy matches every entry with a leading dot, so each one also allows all
of its subdomains: `x.ai` lets through `api.x.ai` and `auth.x.ai`, and
`github.com` any name under it.

One list serves everything on the host: hostd, the weekly image build, and the
bot containers all leave through the same proxy, and it does not ask which of
them is asking. A bot can therefore reach the build-only hosts, Docker Hub's
registry included, and the googleapis hosts, which only hostd needs. A bot
holds no GCP credential, so it can reach Secret Manager's name but read
nothing there.

Add your own with `extra_allowed_domains`, an `infra/gcp` variable — the
hostname of your testing environment, say, so QA can reach it. A private
package registry goes in `registry_host` instead, which adds it to the list
and also tells hostd about it ([self-hosting](self-hosting.md#installing-from-a-private-package-registry)). The
list is written once, in `infra/gcp`, and the proxy's configuration is generated from it; there is no second
copy to go stale.

A private registry on the list does not keep its token inside the install. Any
running task can ask hostd for the raw registry token ([Secrets](#secrets)), and
GitHub is on the list, so the token is only as safe as what it can do: store a
read-only one, scoped to the packages the repositories install.

The proxy is Squid, from Docker Hub's `ubuntu/squid`, the one third-party image
the host pulls. It runs on the host's network, where the metadata server would
hand it the host's token, so its image is pinned by digest
(`egress_proxy_image` in `infra/gcp/variables.tf`): a new host runs the same
proxy as the last, whatever the tag points at by then. To move the pin, take the
tag you want, read its digest with `docker buildx imagetools inspect
ubuntu/squid:<tag>`, check that its configuration is still
`/etc/squid/squid.conf`, and set `ubuntu/squid:<tag>@sha256:<digest>` as the
default or as your own `egress_proxy_image`. An override should be pinned by
digest as well.

Three things hold it, because a proxy on its own is advice:

- **The proxy** refuses a destination by name and logs the refusal as
  `TCP_DENIED`. hostd goes through it too — an allowlist that exempts the
  component holding the credentials is not an allowlist. Its environment sets
  the proxy variables and `NODE_USE_ENV_PROXY=1`, without which Node's own
  `fetch` ignores them, and an iptables OUTPUT rule on hostd's uid (1000)
  refuses, and logs as `fleetadlc-egress-denied`, a new connection to anything
  but the host itself, the metadata server, the docker bridges and the VPC — so
  code in hostd that ignores the variables still cannot leave except through
  the proxy.
- **iptables on the host** rejects traffic leaving a bot container by any route
  other than the proxy, and logs it as `fleetadlc-egress-denied`. A bot that unsets
  `HTTP_PROXY`, or opens a socket to an address it resolved itself, does not get
  out.
- **The VPC firewall** permits egress on 80 and 443 to the internet, Postgres
  and DNS inside the VPC, and denies everything else. A firewall cannot hold a
  list of names, so this is not the allowlist — it is what stops a process
  ignoring the proxy and using some other port.

One channel the proxy does not close: DNS. Bot containers may send DNS, UDP
and TCP port 53, to the metadata server at `169.254.169.254`, whose resolver
answers for any public name by asking the internet on their behalf. So a bot
can put data into the names it looks up, and the nameserver of whatever domain
it names reads them. Neither the proxy nor the iptables chain closes that
route. Port 53 is all of the metadata server a container reaches: everything
else to it, its token endpoint included, is refused. Closing the DNS route
changes how containers resolve names and is not done yet.

Both denial logs feed one log-based metric and one alert, which fires on the
first minute in which the refusals, the proxy's and the firewall's added
together, exceed `egress_denial_rate_threshold` (an `infra/gcp` variable,
default 5). A rise is worth looking at, because a bot has no legitimate reason
to develop new destinations. The alert goes to the module's
`notification_channels`, which `fleetadlc cloud configure` asks for; with none,
it notifies nobody and only opens an incident in the Cloud Monitoring console.

Some refusals are the allowlist working, and are never a reason to widen it:

- The engine CLIs report usage and crashes to their vendors' analytics and
  crash-report hosts (Datadog's log intake for Claude Code, Mixpanel and
  Sentry for Grok Build) unless told not to, and hostd tells them not to (below).
  An operator who opted back in sees those attempts refused here. Those hosts
  are refused on purpose: never add them to `extra_allowed_domains`.
- No shared ingestion host is a candidate for `extra_allowed_domains`. Such a
  host accepts data under whatever key the caller brings, so allowing one
  gives a bot, or whatever wrote the text it read, a way to send the
  repository anywhere.

This is enforcement in `infra/gcp`'s own cloud-init. If you replace
`host_cloud_init`, an `infra/gcp` variable, with your own, neither of the first two
exists, and the allowlist is yours to enforce, as is writing the database's
certificate authority to `/var/lib/fleet/database-ca/server-ca.pem` for hostd.

On a first GCP install, on 2026-09-26, the proxy refused a name outside the
list and the iptables rules refused a container going round it, metadata
server included. The denial alert has not yet been seen to fire.
[docs/unverified.md](unverified.md) records both, the alert as U26.

The host has no external address. Ingress reaches it through IAP (SSH, and
hostd's port for the terminal), from the subnet on
hostd's port (the bridge, which must present the install secret), and from the
load balancer's ranges on hostd's port, for health checks and the terminal. It
holds no credential for any environment the products run in.

**Engine telemetry is off by default**, on every install, not only
`infra/gcp`. Every claude, codex and grok session, under both drivers, and
every sign-in and account or model check hostd runs, starts with the vendors'
switches turned off: `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1` and
`DO_NOT_TRACK=1`; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which also stops
Claude Code's auto-updater and remote feature flags (the image pins its
version); `GROK_TELEMETRY_ENABLED=0`, `GROK_TELEMETRY_MIXPANEL_ENABLED=0`,
`GROK_TELEMETRY_TRACE_UPLOAD=0` and `GROK_FEEDBACK_ENABLED=0`; and
`NEXT_TELEMETRY_DISABLED=1`. Codex reads none of these: it is run with
`-c analytics.enabled=false -c feedback.enabled=false`, its own config keys in
the pinned 0.155.1. Model calls are unaffected. An operator who wants the
vendors' defaults back sets `FLEETADLC_ENGINE_TELEMETRY=on` in hostd's
environment and restarts it; sessions then start with none of the switches.
They could not be set any other way through a session's environment: it starts
under `env -i` with a fresh home. Claude Code's managed settings on a
local-driver host, or a Codex or Grok subscription's published config at
`~/.fleetadlc/logins/.published/<account-id>/config.toml`, can also turn them
off. A computer starting rewrites the copy in the shared login directory
from that file, so an edit there does not last.

## Not yet seen working

Some of what this page relies on has been proven only from the code and its
tests, not against a live install. Each has a row, and the command that would
prove it, in [docs/unverified.md](unverified.md#open):

- IAP has not been seen refusing someone who is not in `console_members` (U21).
- The required reviewer `fleetadlc github apply` sets on `production` has not
  been seen sticking on a real organization's repository (U42). If it does
  not, a promote is not held for a person.
- The `docker` driver's suites have not run on a Linux host, so that one task's
  container cannot reach another's has been seen holding only on macOS
  (U28, U51).
- The egress proxy and firewall have been seen refusing; the denial alert has
  not been seen firing (U26).

## What OpenADLC does not do

- It does not sandbox engine CLIs beyond the container and the tool allowlist.
- It does not scan diffs for secrets; use GitHub secret scanning and push
  protection.
- It does not verify that a model provider handles your code the way you expect.
  Read their terms; the code an agent reads goes to their API, and the terms
  decide whether a subscription may drive an automated crew at all
  ([Subscriptions](self-hosting.md#subscriptions)). Nor does it check how many
  machine accounts GitHub's terms allow you: that is yours to keep to, with
  paid accounts where the free limit is reached
  ([GitHub accounts](self-hosting.md#2-create-the-github-accounts)).
- It does not choose what a provider keeps. A seat on a subscription inherits
  its account's choices on retention and on training with coding data, for
  every repository the seat works on. Grok's trace upload is the one OpenADLC
  can override, and does (`GROK_TELEMETRY_TRACE_UPLOAD=0`); the others are set
  on the account, at the provider.
- It does not stop engine telemetry when an operator asks for it back
  (`FLEETADLC_ENGINE_TELEMETRY=on`, [Egress](#egress)): usage reports then go
  to the vendors' analytics and crash-report services, as well as to the model's
  API.
- It does not answer for what the crew does. Whoever runs OpenADLC runs it
  on their own infrastructure, their own GitHub organization and their own
  model provider accounts, and is responsible for what the agents under their
  control do. A change the crew writes, approves or deploys is not correct or
  safe because the crew did it: the reviews, the checks and the person who
  approves a promotion are how an install decides that, for its own
  repositories.

## Reporting a vulnerability

See [SECURITY.md](../.github/SECURITY.md). Please do not open a public issue for a
vulnerability in OpenADLC itself.
