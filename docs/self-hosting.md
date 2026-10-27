# Self-hosting OpenADLC

OpenADLC is single-tenant: one install, one crew, working in the repositories its
GitHub App is installed on — a person's, an organization's, or both. Everything
runs on infrastructure you control.

## Requirements

| Thing | Why |
|---|---|
| Node 22+ and pnpm 10+ | The platform is a TypeScript monorepo |
| git | Bots clone, branch and push |
| python3, make, g++ (`build-essential`), on Linux | `pnpm install` compiles node-pty, which has prebuilt binaries only for macOS and Windows |
| tmux | Sessions are tmux sessions; take-over is `tmux attach` |
| PostgreSQL 16 | `openadlc_db`. `openadlc up` starts one in a container if Docker is present |
| Docker (recommended) | The `docker` driver gives each task a container of its own, and a database of its own on the host's task database server |
| The bot image | Each task's container runs it. Build with `infra/local/build-bot-image.sh` |
| cloudflared, on a laptop | The console's webhook step runs a quick tunnel with it, so GitHub's webhooks reach this machine. An install with a public URL of its own does not need it |

A quick tunnel's address is new each time one is raised, and can die while
cloudflared goes on running: a laptop that sleeps can wake to an address that
no longer reaches it. The bridge raises a new tunnel at every start for one it
raised itself. While it runs, it tries the address of the tunnel it raised
from this machine every five minutes, and at once on waking; when one that
answered has stopped for a minute, and GitHub's deliveries to it fail too, it
raises a new tunnel, points the app's webhook at it with the same secret, and
has GitHub send again what failed meanwhile. It waits twice as long after
each, from half an hour up to eight hours, until GitHub delivers to the new
one, and never raises one for an install taken off the internet, one with a
fixed address, or a quick tunnel of your own given as one; see
[Webhooks do not arrive](troubleshooting.md#webhooks-do-not-arrive).

Which it is, the webhook step stores beside the address as the `webhookMode`
setting: `tunnel` when the step raised one for you (**set it up for me**),
`address` when you gave one (**use this address**). An address in
`install.json` or `OPENADLC_PUBLIC_URL` is always one you gave, and so is one
sent as `PATCH /v1/install {"publicUrl": …}`, which stores `address` with it;
`webhookMode` itself is written only by the step, and the route refuses it. A
quick tunnel of your own (`cloudflared tunnel --url …`) given as the address
is kept through every restart and a take-down, never called a tunnel that
stopped, and judged by what GitHub delivers to it: the `webhook` check says
"GitHub cannot reach this bridge" once GitHub's deliveries to it fail. An
install from before the mode was stored has none, and a stored quick tunnel's
address is read as one the bridge raised, as it was; the next start stores
`tunnel`. If yours is a tunnel of your own on such an install, give its
address on the step once more, which stores `address`.

A backup carries the mode with the address, and one from `install.json` as an
address you gave; a restore takes them together as one item, "The public
address, and who made it". Restored from a backup made
before the mode was stored, another address clears this install's mode, which
Undo puts back, and is read as one from before the mode was; the same address
keeps the mode this install has for it.

Without Docker, the `local` driver runs the same tmux sessions on the host, as
your user. A session there can read the App's private key, every bot's sign-in,
the model keys and the database password, and can run anything on the machine.
It is fine for development with a throwaway App, accounts and repositories; use
Docker for anything that matters. A new install takes `docker` when Docker
answers and the bot image is built, and `local` otherwise; `openadlc init`
writes the choice to `install.json`, and `openadlc up` warns at every start
while the driver is `local`. To switch: `infra/local/build-bot-image.sh`, then
`openadlc init --driver docker` and `openadlc down && openadlc up`.

The `docker` driver's suites have run on macOS, under Docker Desktop and
OrbStack, and not yet on a Linux host ([unverified](unverified.md#open),
U28 to U30 and U51). On Linux, file ownership and the address a container reaches
the host on differ, and that one task's container cannot reach another's has
not been seen holding there.

Neither driver restricts where a task connects. Only the Google Cloud install,
`infra/gcp`, limits a task to GitHub, package registries and its model; on a
laptop, compose or other host a task can reach anything the host can. See
[Egress](security.md#egress).

### Building the bot image

The `docker` driver runs every bot from one image, and it is not published
anywhere — you build it:

```bash
infra/local/build-bot-image.sh            # tags openadlc-bot:latest

# For a cloud install, build the same thing for the host's architecture,
# under the registry's name, and push (Installing on a cloud sets the registry up):
DOCKER_DEFAULT_PLATFORM=linux/amd64 IMAGE=us-central1-docker.pkg.dev/<project>/openadlc/bot:latest infra/local/build-bot-image.sh
docker push us-central1-docker.pkg.dev/<project>/openadlc/bot:latest
```

The cloud host runs `linux/amd64` only. Without `DOCKER_DEFAULT_PLATFORM`, an
Apple-silicon Mac builds an arm64 image, the host's pull finds nothing it can
run, and hostd never starts.

The engine CLIs are pinned in that script, and the script refuses to finish if
they are not on the PATH inside the image it just built, or are not the versions
pinned, or if uv, which the Dockerfile pins, does not run there for the bot
user. The pins are where an install starts; [System](#engine-updates)
keeps them current after that, along with the GitHub CLI and Node once an
update has recorded those versions. One script for both
installs, so a laptop and a cloud host cannot end up running different bots.

`openadlc up` refuses to start under the `docker` driver when the image is absent,
rather than coming up healthy and failing every task.

### Third-party notices for an image you publish

**Do not publish a bot image that contains Claude Code.** `build-bot-image.sh`
always installs it, beside Codex and Grok. Claude Code is Anthropic's
proprietary software under Anthropic's terms: its licence lets you install it
for your own use, not redistribute it. (The Codex and Grok CLIs at the pinned
versions are Apache-2.0.) Keep the bot image the script builds on the machine
that built it, or in a private registry that only your install pulls from, as
the cloud install does. The rest of this section is for the service and
console images, which install no engine CLI, and for a bot image you build
yourself with `docker build -f infra/local/Dockerfile.bot` and an
`ENGINE_CLI_PACKAGES` that leaves Claude Code out.

The images carry OpenADLC's own LICENSE and NOTICE (the console's also its
THIRD_PARTY_NOTICES), but not the licences of everything they install: the
Debian packages, Node, the engine CLIs and the npm packages. Those are not
baked in. Anyone who publishes an image — pushes it to a registry others pull
from, or hands it on — lists them from the built image and ships the list with
it:

```bash
infra/local/third-party-notices.sh <service or console image> service-notices.txt
infra/local/third-party-notices.sh <bot image built without Claude Code> bot-notices.txt
```

The script runs the image once, as root and with no network, and reads
`/usr/share/doc/<package>/copyright` for each Debian package,
`/usr/local/share/doc` (Node's LICENSE in the bot image), and the LICENSE,
LICENCE, COPYING and NOTICE files of every npm package in it, global ones,
corepack's pnpm and an app's `node_modules` included; it says which package each
engine CLI comes from. Nothing is added to the image. Run it again for every
image you publish: each build can install different versions. A release's
`service` and `console` images are published this way: the release workflow
runs the script on each image it built and adds its output, as one more
layer, at `/usr/share/doc/openadlc/THIRD_PARTY_NOTICES`, so the list travels
with the image (`docker run --rm --entrypoint cat <image>
/usr/share/doc/openadlc/THIRD_PARTY_NOTICES` prints it). Run against an
image that holds Claude Code, the list quotes its licence as the package ships
it; that is a notice, not permission to pass the image on. An image you build
and run yourself, and do not pass on, needs none of this.

## 1. Bring the stack up

[`infra/local/install.sh`](../infra/local/install.sh) does this section and
the [Requirements](#requirements) in one command, on macOS (Homebrew) or Linux
(apt or dnf), asking before it installs anything; the README's quick start
runs it. It is safe to run again. By hand, it is:

```bash
pnpm install
pnpm build
infra/local/build-bot-image.sh                     # the image each bot runs
node apps/cli/bin/openadlc.mjs init --driver docker   # writes ~/.openadlc/install.json
node apps/cli/bin/openadlc.mjs up
```

This applies migrations, loads `config/`, and starts hostd, the bridge and the
console. The bridge also dispatches: it decides what starts next as soon as an
issue changes, a task ends or a pull request closes, and every five minutes
besides. Open the console link it prints, which signs your browser in and
redirects to the walkthrough until the install is finished.

`openadlc` in the rest of this document is `node apps/cli/bin/openadlc.mjs`, run from
the checkout, or `pnpm openadlc` ([cli.md](cli.md)). Every command acts on the
install `OPENADLC_HOME` points at, `~/.openadlc` by default, and the ports and paths
below are that default install's.

There is no demo mode ([why](#7-give-the-bots-engines)): an install is either
live or not configured yet. Nothing reaches GitHub before you supply
credentials, and a bot whose engine is missing fails its task rather than
pretending.

Ports default to 47300 (console), 47311 (bridge), 47312 (hostd) and 47432
(postgres) — deliberately uncommon, so they are unlikely to collide with anything
(and `openadlc up` refuses to start a service whose port something else already
answers on). Under the
docker driver, the task database server (`openadlc-taskdb`) also uses 47433,
published on loopback (Docker Desktop, OrbStack) or on the Docker bridge's
gateway (Linux).

The database container `openadlc up` makes, `openadlc-db`, is published on
127.0.0.1 only, and its password is generated for the install and kept in
`databaseUrl` in `install.json`. It runs with `--restart unless-stopped`, so it
comes back by itself when Docker or the machine restarts; `openadlc up` gives
one made before that the same policy, and says so once
([troubleshooting](troubleshooting.md#the-installs-database-isnt-answering)). An install from before that had `openadlc`
as its password, which is printed in this repository, and its container
published on every address. The next `openadlc up` changes that password in
place, and `openadlc doctor` reports both the password and a publish on every
address. The address needs the container made again, which `up` does not do,
since the data is in the container's own volume; `openadlc doctor` warns until
it is done. To keep the data, start a new container on the old one's volume:

```bash
openadlc down
docker stop openadlc-db && docker rename openadlc-db openadlc-db-old
docker run -d --name openadlc-db --volumes-from openadlc-db-old \
  -p 127.0.0.1:47432:5432 pgvector/pgvector:pg16
openadlc up
docker rm openadlc-db-old     # once the install is back; not -v, which would delete the data
```

`openadlc up` prints the console as a sign-in link,
`http://127.0.0.1:47300/signin?token=…`. Open it: the console serves nothing to
a browser that has not signed in, because its server holds the console secret
the bridge serves `/v1` for (`console-api-secret` in the secret store, made on
the first `openadlc up`). The link works for an hour and the browser then
stays signed in for thirty days; `openadlc console-link` prints a fresh link
whenever you need one. The console listens on 127.0.0.1. To open it from
another machine, start it with `OPENADLC_CONSOLE_HOST=0.0.0.0` (and add the
name you use to `OPENADLC_ALLOWED_HOSTS`), then open a link from
`openadlc console-link` with that machine's name in place of `127.0.0.1`.

### Or with Docker Compose

[`infra/local/docker-compose.yml`](../infra/local/docker-compose.yml) runs the
database, the bridge, hostd and the console in containers. The bridge, hostd and
the console are on the same ports as `openadlc up`, so run one or the other; the
database is not published on the host, since the services reach it on the
compose network. hostd runs the bots with the docker driver, through the host's
Docker socket.

The database's password is `POSTGRES_PASSWORD`, and the stack refuses to start
without it. Generate it once, keep it, and export it in every shell that runs
`docker compose` against this file:

```bash
mkdir -p ~/.openadlc-compose          # or OPENADLC_COMPOSE_HOME=/some/absolute/path
(umask 077; openssl rand -hex 32 > ~/.openadlc-compose/postgres-password)
export POSTGRES_PASSWORD="$(cat ~/.openadlc-compose/postgres-password)"
docker compose -f infra/local/docker-compose.yml up -d --build
```

Use hex, as above: the value is also put into the services' `DATABASE_URL`,
where other characters would have to be escaped.

**A compose stack from before `POSTGRES_PASSWORD` was required** had the
password `openadlc`, printed in this repository, and published the database on
every address. The password is kept in the database itself, so a new
`POSTGRES_PASSWORD` alone changes only the services' URL, and they could no
longer connect. Change it in the database first, then restart with the new
value:

```bash
(umask 077; openssl rand -hex 32 > ~/.openadlc-compose/postgres-password)
export POSTGRES_PASSWORD="$(cat ~/.openadlc-compose/postgres-password)"
# if the stack is stopped, start only the database: docker compose -f infra/local/docker-compose.yml up -d db
docker compose -f infra/local/docker-compose.yml exec db psql -U openadlc -d openadlc_db -c "ALTER ROLE openadlc PASSWORD '$POSTGRES_PASSWORD'"
docker compose -f infra/local/docker-compose.yml up -d
```

The console image turns Next.js's anonymous usage telemetry off
(`NEXT_TELEMETRY_DISABLED=1`). A console built or started from a checkout, as
`openadlc up` does, has it on unless that is set in the environment, or
`pnpm --filter @openadlc/console exec next telemetry disable` was run once.

A one-shot `setup` service applies the migrations and loads `config/` first, as
`openadlc up` does; as there, only a failed migration keeps the services from
starting, and a problem loading `config/` is in `setup`'s log.

The bridge and the console run as uid 1000, the images' `node` user, not as
root. hostd starts as root only to copy the bots' assets, then runs as uid 1000
too, with the Docker socket's group so it can still drive the bots' containers,
as it does on the cloud host. So `home/` and `work/` in the install directory,
below, are owned by uid 1000, and `assets/` by root. `setup` sees to that on
every start: it hands to uid 1000 whatever under `home/`, `work/` and the
`webhook-secret` volume is not already its, which on a stack the older,
root-run images made is everything, and does nothing once it is done. There is
nothing to run by hand. If it cannot change an owner, it stops, naming the
path, and the bridge and hostd do not start. On Docker Desktop and OrbStack the
mount maps ownership for you, and `setup` leaves the directory as it is.

Everything the install keeps but the database and the bridge's first webhook
secret (two named volumes, `db` and `webhook-secret`) is in one directory on the
host, `OPENADLC_COMPOSE_HOME` (`~/.openadlc-compose` unless you set it), mounted
into hostd and the bridge **at the same absolute path**:

| Inside it | What it is |
|---|---|
| `home/` | `OPENADLC_HOME`: the secret store (`home/secrets`) — the secret hostd and the bridge authenticate each other with, the console secret, the crew's GitHub sign-ins and the model-account keys — and subscription logins |
| `work/` | One mirror per repository, and each task's clone under its bot's folder |
| `assets/` | The skills, roles, skill runner and `gh` the bots are given, copied out of the image each time hostd starts |

The same path on both sides is what lets a bot task run. Every bind mount hostd
gives a bot's container is resolved by the host's Docker daemon, so each has to
be a path that exists on the host; one that exists only inside hostd's container
gave the bot an empty directory, and a task there had no repository. A bot's
container reaches the bridge and hostd on the ports published on the host
(`OPENADLC_HOSTD_TASK_BRIDGE_URL`, `OPENADLC_HOSTD_TASK_HOSTD_URL`), since it cannot resolve their
compose names.

`setup` also makes the console secret, `home/secrets/console-api-secret.secret`,
when it is missing. The console is given that one file, read-only, and not the
rest of the home, and is published on 127.0.0.1 unless you set
`OPENADLC_CONSOLE_HOST`. Print a sign-in link for it with

```bash
OPENADLC_HOME=~/.openadlc-compose/home pnpm openadlc console-link
```

`OPENADLC_COMPOSE_HOME` must be an absolute path, and `OPENADLC_BRIDGE_PORT` and
`OPENADLC_HOSTD_PORT` move together; hostd refuses to start otherwise, since either
would send this install's tasks somewhere else. Its task containers, task network
and task database server are named after the compose project
(`<project>-bot-task-<id8>`, `<project>-bot-tasks`, `<project>-bot-taskdb`) and
labelled with it (`openadlc.install=compose-<project>`), so they are never the
containers of an install `openadlc up` runs on the same machine, and a hostd never
reuses or removes a container another install made. They run an image of the project's own,
`compose-<project>-bot:latest`, which hostd builds with
`infra/local/build-bot-image.sh` on its first start (a few minutes) and which the
weekly engine update replaces and rolls back without touching `openadlc-bot:latest`.

`OPENADLC_COMPOSE_HOME` is not `~/.openadlc`, so `openadlc` commands run on the
machine do not see this install; run them in the bridge's container instead, which runs as
uid 1000, so anything a command writes stays readable by the services. The CLI asks the bridge at
127.0.0.1, which is that container's own; in hostd's container nothing answers
there, and `doctor` skips the bridge's health checks while the `github`
commands report the automation account as not connected:

```bash
docker compose -f infra/local/docker-compose.yml exec bridge node apps/cli/dist/main.js doctor
```

There `doctor` cannot reach hostd or the console, so it reports them as not
running and skips hostd's authentication check; the compose stack's own
`docker compose ps` is what says they are up.

That directory holds the install's sign-ins and keys. `docker compose down -v`
keeps it, since it is not a volume; deleting the directory means connecting
every account again. The webhook signing secret is in its secret store too,
once the console has set up the app or the webhook; before that it is in the
`webhook-secret` volume. `down -v` deletes both volumes, `db` and
`webhook-secret`: the board, the settings (the app's client id among them),
the crew's account assignments, the model accounts and that first secret. Take
a `openadlc backup` first, and expect to go through the walkthrough again
afterwards.

## 2. Create the GitHub accounts

**Open http://127.0.0.1:47300/onboarding and work down it** (signed in with the
link `openadlc up` printed, or one from `openadlc console-link`). The GitHub accounts
step asks for two accounts — one that does the work and one that approves it —
with a suggested address and username, and a connect button that runs the device
flow for the account, not for a seat. The Crew step is where each bot is put on
one of those accounts, and it stays open while a seat has no account or a bot
that commits has no signing key on its account. That console page is the only
walkthrough; there is no terminal one.

Each step has an address, `/onboarding?step=<key>`.

What it is walking you through, for the record:

Two real accounts at the least — a crew account and a reviewer account — or up to
one per bot. The reviewers can never share the crew account: GitHub won't let the
account that opened a pull request approve it, and the walkthrough refuses it.
Afterwards, **Settings → GitHub → Connected accounts** lists the accounts OpenADLC
holds and which bots use each: connect another account there (for no bot yet),
reconnect one, or disconnect one no bot uses. **Settings → Crew** is where each
bot is put on an account, and where its model is chosen. The bridge refuses a
reviewer on the crew account (and a crew bot on the reviewers'), and an account
whose sign-in has stopped working, whatever the page offers. No bot may be a
person: an account that is one of the install's `humans`, or that a managed
repository's AGENTS.md names under Human review, is refused when a seat
connects, when an account is connected here, and in Crew's choices, which say
why beside it. Connecting a seat, or putting one on an account, is refused too
when GitHub says the account has admin or maintain on a managed repository;
the refusal names the repository and the role to lower it to. If the code was
approved in a browser signed in as you, sign in as the bot's own account (a
private window helps) and enter a new code. A Reconnect that GitHub approved
as another account says so under that row — which account approved it, and
that the row's account still needs reconnecting — and offers to disconnect the
other account when no bot uses it. Taking a bot off its
account, or moving it to another, is asked once more on its row, and the bridge
refuses it while the bot has a task that has not ended or holds a lease: stop the
task or let it finish, then move it. A bot on no account is put on one straight
away. Taking the last bot off an account leaves the account connected, used by
no bot, until you disconnect it. **Settings → Appearance** is where each repository's color and
each crew member's color are chosen; a repository's color is on its own page as
well. A crew member's color is By role until someone chooses one, which is the
tint its role already has.

`config/bots.yaml` lists the crew as seats — what each bot is for — and names no
account:

| Seat | Role | What it does |
|---|---|---|
| `intake` | intake | Clarifies everything a request needs with the person who asked, one question at a time, reading the files they gave, and files the issue they agree to |
| `system-engineer` | system engineer | Writes the design as an issue comment, stops on architectural choices, and opens pull requests that add ADRs under `docs/adr/` when a person decides to record a decision |
| `builder` | builder | Branches, implements inside declared paths, runs the checks, opens the pull request |
| `lead-reviewer` | lead reviewer | Correctness and contract; GitHub requires this review |
| `second-reviewer` | second reviewer | Quality and edges, on a different model so two reviewers do not share a blind spot |
| `security-reviewer` | security reviewer | Secrets, authorization, injection, dependencies |
| `sre` | SRE | Reverts a change whose smoke failed on testing, instead of fixing forward; diagnoses a failed testing deploy and fixes a broken deploy workflow by pull request; and reviews workflow, runbook and infrastructure changes as the workflows lens; shipping follows the repository's rules |
| `qa` | QA | Journeys, smoke and visual suites |
| `automation` | automation | Labels, assignments, reviewer requests and the `review-gate` status; never pushes |

For each account: a unique email, two-factor authentication, its email kept
private, and access to the repositories the crew works in, which OpenADLC gives
it by inviting it as a collaborator with the role its seat needs (below).

Keep each account's email private: signed in as the account, open
[github.com/settings/emails](https://github.com/settings/emails) and tick **Keep
my email addresses private** and **Block command line pushes that expose my
email**. The bots' own commits use the account's noreply address, but the commits
GitHub writes for the crew — the squash merge of each pull request, and the
merges that bring a branch up to date — carry the account's primary email
unless the setting is on when GitHub writes them; then they carry its noreply
address ([GitHub's docs](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)).
Without the setting, every crew pull request merged in a public repository
publishes your address, and its `+openadlc-<seat>` tag says what it is for. A
commit keeps the address it was written with, so ticking the setting later
does not take it off the ones already merged. The `commit-email` check reads
the newest commit GitHub wrote for each account and raises a warning card,
naming the commit and when it was written, when it carries the account's own
address; it cannot read the setting itself, so it does not say the setting is
off. The card clears by itself once GitHub writes a newer commit for the
account with its noreply address. Should one written after the setting was
ticked still carry the address, make the account's primary email an address
that is fine to publish, which is the one GitHub writes otherwise.

Worth knowing before you create the accounts:

- **GitHub limits free machine accounts.** GitHub's
  [Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#3-account-requirements)
  allow machine accounts but allow each person no more than one free one, in
  addition to their free personal account. The limit applies to the accounts
  themselves and is not changed by putting them in an organization — an
  organization admits accounts, it does not own them. The person who creates a
  machine account accepts GitHub's terms for it and is ultimately responsible
  for what it does, even when, as GitHub allows, several people direct it. So
  the two required accounts are one free machine account and one on a paid
  plan, or free machine accounts created by two people who each take that
  responsibility for their own. Each account beyond those needs a paid plan or
  another such person. Our advice, which is OpenADLC's and not a GitHub rule:
  do not ask someone to create an account they will not stand behind, and do
  not create one in someone else's name; GitHub may suspend accounts it finds
  created to get around the limit, and the crew's work stops with them.
  Neither account should be your personal account: OpenADLC treats everything
  that account writes as the bot's. More accounts are optional, because every
  seat can share the crew account or the reviewer account. Check GitHub's
  current terms before you create them; this paragraph summarises them and is
  not legal advice.
- GitHub needs a distinct address per account, and most providers deliver
  `you+anything@` to the same inbox — so `you+openadlc-builder@` and
  `you+openadlc-lead-reviewer@` put the crew's mail in one mailbox. Onboarding
  suggests these from your own address. A distinct address does not change
  how many free accounts GitHub allows you.
- **Who owns the repository does not change how OpenADLC works.** A person and an
  organization both share a repository with the bot accounts as collaborators,
  and both send an invitation when they do. What differs is one role and what
  the plan will enforce, below.

### What a bot is called

A bot is the account it acts as, so that is what it goes by. Until an account
is assigned on the Crew step, a bot is named after its seat. Whichever account
it is put on is the one it is: when it has that account to itself, the bot
takes the account's login, lowercased, as its name, and from then on the
console shows it by that handle, with its role beside it where there is room —
*irisexampleco · second reviewer*. Seats that share one account keep their
seats' names, since bots all called by one login could not be told apart.

Everything the bot has is kept under that name — its folder under
`~/.openadlc/work`, its secret files under `~/.openadlc/secrets`, and its sessions
(`<bot>/<skill>-<task>`) — so all of it moves when the bot is renamed. Its tasks'
computers — the container each task runs in — are named after the tasks, not the bot. A bot is never renamed in the middle of a task: one that is
working is renamed once it has finished. The seat does not move. It is what
`openadlc up` finds the bot by and what a repository's `owner` names, so connecting
an account never changes the configuration.

Nothing is reserved in advance. `config/bots.yaml` names no account, so none can
be set aside for a bot nobody has connected — which is how an install once refused
the account its operator actually had, because the configuration had promised it
to another bot. The username the walkthrough offers is a suggestion, made from the
role and the name of the account that owns the repositories (such as
`acme-openadlc-builder`) and checked against GitHub before it is offered. An account
you already have works as well.

### How a bot looks

Each bot's avatar is drawn in its role's tint, so the crew can be told apart at
a glance. Two seats of one role, such as two builders, share a tint until
one of them is given a color of its own. Choose it in **Settings → Appearance →
Crew colors and avatars**, from eight named tints or *By role*. It is stored per bot, audited
as `bot.color_changed`, and used wherever the bot's avatar appears: the board,
its thread, /crew and Settings. `config/bots.yaml` names no color, and `openadlc up`
leaves a chosen one alone.

On the tint is a small mark for the engine the bot thinks with: petals for
Claude, a dot grid for Codex, an orbit for Grok, and a gear for the automation
bot. These are marks drawn for OpenADLC, not the vendors' logos. A mark moves
only while its bot is working, and only where the avatar is large (a crew
card, a thread's head, a message). It is still everywhere else, including on
the board, and still for anyone whose system asks for reduced motion. Choose
another mark, or the bot's two initials, in **Settings → Appearance → Crew
colors and avatars**, or, as an admin, in the Settings tab of its panel on
**/crew** (click its card). *By engine* is the default,
so a bot moved to another engine takes that engine's mark. The choice is stored
per bot and audited as `bot.avatar_changed`. A backup keeps each bot's color and
avatar, and a restore puts them back with the seat.

| The picker, light | The picker, dark |
|---|---|
| ![The avatar picker in the light theme](images/crew-avatars/picker-light.png) | ![The avatar picker in the dark theme](images/crew-avatars/picker-dark.png) |

The engine marks, each on a crew card:

| Engine | Mark |
|---|---|
| claude | ![Petals, claude's mark, on the Builder's card](images/crew-avatars/petals.png) |
| codex | ![Dot grid, codex's mark, on the Security reviewer's card](images/crew-avatars/dots.png) |
| grok | ![Orbit, grok's mark, on the Second reviewer's card](images/crew-avatars/orbit.png) |
| the automation bot | ![Gear, the automation bot's mark, on the Automation card](images/crew-avatars/gear.png) |

### Accepting the repository invitations

OpenADLC lets each bot into a repository the same way whoever owns it: it invites
the account as a collaborator. On an organization, GitHub adds an account that
is already a member of it directly; any other gets an invitation, as on a
person's repository.

GitHub sends each bot that is not in yet an invitation, and a bot does nothing
at all until it is accepted. This is the step that strands an install
quietly: the account is connected, its token is valid, `openadlc auth status` says
so — and every call 404s, because an invitation is sitting unread in a mailbox.

OpenADLC accepts them with the bot's own credential, the one the device flow
produced. Nothing else is needed — **provided the app has `Administration: read
and write`**. Without it:

```
$ curl -sD- -X PATCH -H "authorization: Bearer $GHU_TOKEN" \
    https://api.github.com/user/repository_invitations/<invitation-id>
HTTP/2 403
x-accepted-github-permissions: administration=write
{"message":"Resource not accessible by integration"}
```

`Resource not accessible by integration` reads like a limit of app tokens. It is
not: the header beside it names the permission, and with that granted the
identical call returns `204`. `$GHU_TOKEN` is the bot's own token, which a
session of that bot holds as `$GH_TOKEN`; your own token gets a different
answer, and a bot's token is never refreshed by hand, since GitHub rotates the
refresh token and the bot would be disconnected.

`Administration` is a wide permission — *"Repository creation, deletion,
settings, teams, and collaborators"* — and it lands on every bot's token, not
only the ones being invited. It is also the permission that edits whatever
rulesets the repository has. That is the price of not signing in as nine
accounts by hand, and it is the same price whoever owns the repository.

**OpenADLC sends the invitations, which is how it knows their ids.**

Finding an invitation is the half that cannot be done. All three routes are
closed to an app token, measured:

| Route | Answer |
|---|---|
| `GET /user/repository_invitations` | `200 []` — evaluated against a repository the invitee cannot see yet, so empty is indistinguishable from none |
| `GET /repos/{owner}/{repo}/invitations` | `403`, naming `private_repository_invitations=read`, which no GitHub App can be granted |
| a `repository_invitation` webhook | no such event to subscribe to |

So OpenADLC does not look for one. It **creates** it:
`PUT /repos/{owner}/{repo}/collaborators/{username}` returns the invitation it
just made, id included, and the bot that invitation names then presents that id
to `PATCH /user/repository_invitations/{id}`.

Two identities, because neither can do both halves. Inviting needs admin on the
repository, and the crew are collaborators — so the **app** invites, using an
installation token, which carries the app's permissions without being
intersected by any account's access. Accepting can only be done by the invitee
— so each **bot** accepts its own, with the credential it already has.

That needs the app's private key, which is the one credential here that is not
per bot and the widest: paste it into the console at the step where you create
the app. It is stored where the refresh tokens are, never returned to the page,
and never given to a task under the docker driver; under local a task can read
it. The merge line, the `review-gate` check and the repository's rules need it
too, so an install without it never merges anything; only the invitations have
a way round it, by hand with the `gh` path in the console.

The walkthrough's **Repository access** step,
and **Try again** on a repository in settings, invite every bot
that is not in yet and accept for it. The `bot-access` check says which accounts
are in each repository and which are still outside, with **Let the crew in** on
its card, so this is visible rather than discovered at the first failed push.

The role each seat is invited with is the least its work needs:

| Seats | Repository role |
|---|---|
| builder, system engineer, SRE, QA | write; the lease, and the merge line that holds a crew pull request to it, keep each to its paths |
| the three reviewers | write, because an approval only counts from an account with write access |
| intake and automation | triage on an organization's repository; write on a person's, whose access page has no triage |

Where intake and the automation account hold write, what keeps them from pushing
is OpenADLC's own gates: neither ever authors a commit. Seats that share an account
share its role, which is the widest any of them needs.

## 3. Create one GitHub App as the OAuth client

Settings → Developer settings → GitHub Apps → New GitHub App.

- **Name:** one no other app on GitHub has; GitHub app names are unique across
  all of GitHub.
- **Device flow:** enabled. Without it, `openadlc auth login` cannot work.
- **Expire user authorization tokens:** on. This is what makes user tokens last
  eight hours and issue a refresh token.
- **Webhook URL:** your bridge's `/webhooks/github`, with any secret for now:
  the walkthrough's Webhook step replaces it with the install's own once
  OpenADLC holds the app's private key, writing one secret to both sides.
  Exporting `OPENADLC_WEBHOOK_SECRET` does not set it: that variable is read
  only before `openadlc init` has generated a secret, and afterwards the one in
  the secret store wins.
- **Permissions:** under Repository permissions, read and write on contents,
  issues, pull requests, commit statuses, checks, workflows, actions and
  **administration**, and read-only on deployments and metadata; under Account
  permissions, read and write on SSH signing keys. None under Organization
  permissions: OpenADLC asks nothing of an organization. A user token is limited by the
  intersection of the app's permissions and the account's own access, so the
  app is the outer bound and the account's role on the repository is the real
  limit.
- **Subscribe to events:** issues, issue comment, pull request, pull request
  review, workflow run, deployment status and release. Release is what moves
  the cards of a repository that ships by release
  ([configuration](configuration.md#shipping-by-release)) as a release is
  published; without it the deploy sweep finds the release later, and the
  `ships-by-release` check says so only where a repository ships that way.
- Install the app on the repositories the crew works in — on each account they
  belong to, when that is more than one (below).

An app has four parts OpenADLC holds: the **client id**, the **private key**, the
**webhook secret** and the **client secret**. The client secret is what narrows
each task's GitHub token to the task's own repository
([the security model](security.md#the-account)). For an app made by hand,
generate one on the app's page under **Client secrets** and paste it into
Settings → GitHub → **App client secret**; GitHub shows it once. Without it a
task's token reaches every repository its bot can, and the `app-client-secret`
check says so on the board.

`Administration` is the one whose absence is hardest to diagnose. Without it the
app cannot invite a bot, a bot cannot accept its own invitation and the
repository's rules cannot be applied, and GitHub reports each as the misleading
`403` shown under
[Accepting the repository invitations](#accepting-the-repository-invitations).
The webhook is not among them: it is the app's own setting, written with the
app's private key, so no repository permission affects it.

**The console can create this app for you.** The walkthrough's app step builds a
GitHub App manifest with the permissions, events and webhook address filled in,
and hands you to GitHub to confirm it, which is fewer chances to miss a checkbox
than doing it by hand. Two settings no manifest can carry, **Enable Device
Flow** and **Expire user authorization tokens**, are then ticked on the app's
settings page; until Device Flow is on, a board check says so and no bot can
sign in. Installing the app is a step of its own.
GitHub sends back all four parts, and the bridge stores them. An app the console
made before it kept the client secret needs one pasted, as a hand-made app does.
The console proposes a name unique to each attempt — `OpenADLC (<owner>)` and
a short random ending, within GitHub's length — so a second install, or "create
a different app instead", is not refused for a name already taken. If GitHub
still says the name is taken or too long, change it on GitHub's page: OpenADLC
keeps the app's id and key, not its name.

**An app created before OpenADLC asked for deployments** has neither the permission
nor the event, because a manifest decides them only for the app it creates. Until
both are added, GitHub sends no `deployment_status`, so no change is labelled
`deployed:testing` or `deployed:prod` and no promote moves a card to Done. The
`app-permissions` check says so on the board and in `openadlc doctor`, with a link to
the page. On GitHub: **Settings → Developer settings → GitHub Apps → your app →
Permissions & events** (under the organization's settings for an app an
organization owns), then:

1. **Repository permissions → Deployments:** Read-only.
2. **Subscribe to events → Deployment status:** ticked. It is offered once the
   app may read deployments.
3. **Save changes.** GitHub then asks each account the app is installed on to
   accept the new permission, on the installation's page; the same check links
   there until it is accepted.

OpenADLC acts as the app for the repository's administration and its merge
line: inviting a collaborator, writing the repository's rules and environments,
committing CODEOWNERS and the templates when you press Apply, merging, the
`review-gate` check, the `adlc:ci` label and draft changes on a pull request,
re-running failed CI, dispatching deploys, and pointing the webhook at this
bridge. Those merges and commits appear as the app's bot. Reviews and comments
never do: they come from a bot's own account.

### Repositories under more than one account

The app is installed on each account on its own — a person's, an organization's
— and OpenADLC works only in the repositories an installation covers. Settings →
**GitHub App** lists each account OpenADLC works in, installed or not, with the page
on GitHub where each is changed. A repository typed into **Add a repository** that
the app cannot reach is not added: the field says what to do first and, while
the page stays open, adds it once GitHub says the app can reach it.

The walkthrough creates the app **private**, and GitHub installs a private app
only on the account that owns it. So an app made under a personal account such as `janedoe` cannot be
installed on an organization such as `exampleco` until its owner transfers the app to that organization.
**Install on another account** explains the transfer and what making the app public instead costs, and
links to the app's Advanced settings, where either is done. No API can do that.
A public app can be installed by any account, and cannot be made private
again while another account has it installed. OpenADLC works only in the
accounts it knows: the app's owner, the organization in its settings, the
accounts of the repositories it already has, and accounts an admin has
allowed. An installation anywhere else is ignored: its repositories are not
offered in the picker, and one typed in is refused, saying how to allow the
account. To work in a second account, an admin allows it — **Allow <account>**
in the field, after a warning that the crew will be invited to its
repositories and that whoever can write there can answer the crew's
questions (`POST /v1/github/allowed-accounts`, audited as
`github.account_allowed`) — and then installs the app there as above. See
[the security model](security.md#the-account).

On an organization only an owner can install the app; a member who tries sends
the owners a request. OpenADLC then invites each bot as a collaborator, which GitHub
turns into an addition for a bot that is already a member. An organization that
does not allow outside collaborators refuses the rest, and each bot's line in
settings says so; its owners make those bots members instead. Then set the
organization's base permission to **No permission**, keep the bots out of
teams, and grant each bot access per repository: a member's token reaches every
repository it sees through the base permission or a team, and a crew session's
token is the app's installation intersected with that.

Each installation's own page — linked beside every account under **GitHub App** —
is where an account gives the app more of its repositories. Choose **Only select
repositories** and pick the ones the crew works in. An organization's installation
on all of its repositories, with the bots its members, lets a crew token reach
repositories OpenADLC does not manage; the `app-selection` check warns when an
organization OpenADLC works in has one.

## 4. Configure and connect

An install brought up in step 1 is already configured here: `openadlc init`
there set the driver and the database url, and generated a webhook secret, as
it does whenever the install has none. The account the repositories belong to,
the app client id, the operator's address, the webhook and who may answer gates
are asked for by the console's walkthrough and stored in the database, so an
install can be configured from a browser without editing a file or restarting
anything.

The walkthrough's GitHub accounts and Crew steps (step 2) also connect the
accounts and put each seat on one: its connect button runs the device flow
for an account. The terminal does the same, for a seat at a time or for all of
them, once `openadlc up` is running:

```bash
openadlc init --driver docker   # only for an install step 1 did not set up; also takes --database-url
openadlc up                     # the bridge is what connects each seat
openadlc auth login --all       # or --bot <seat>
```

For each seat the CLI prints a code, and whichever account approves it becomes
the seat's account:

```
  › Sign in to GitHub as acme-openadlc-lead-reviewer (not as yourself) and approve the OpenADLC app.
    open https://github.com/login/device and enter this code:

    WDJB-MJHT
```

Sign in **as the account for that seat** — the crew account for a crew seat,
the reviewer account for a reviewer — not as yourself, enter the code, approve. The CLI hands the
sign-in to the bridge, which connects the seat exactly as the console's
walkthrough does: it stores the refresh token under `~/.openadlc/secrets` with
`0600` permissions, generates an SSH signing key, uploads the public half to
the account, and records the refresh token's expiry: the scheduler's
credential job opens an issue three weeks before it runs out. The bot then takes the account's handle as its name,
unless other seats share the account.
`openadlc auth login --bot lead-reviewer` connects one seat. With the bridge
not running, the CLI stores nothing and says to run `openadlc up` first.

Seats can share an account, as in the two-account crew above. A seat that
signs in as an account another seat of its group is already on joins that
account: the newer sign-in becomes the account's, every seat on it uses it, and
the seat keeps its own name, signing key and computer. A reviewer seat signing
in as the crew's account, or a crew seat as the reviewers', is refused, because
GitHub won't let the account that opened a pull request approve it. A seat
that signs in as a different account than before leaves its old one first, so
the other seats on that account keep working.

`--all` asks for each seat in turn; a seat whose group's account is already
connected joins it once you approve as that account. Whichever way, connecting
an account is a person's step, because GitHub requires a browser sign-in: the
console's connect button, or the code the CLI prints. After it, nothing needs
rotating on a schedule.

```bash
openadlc auth status     # which accounts are connected
openadlc doctor          # tools, database, host heartbeat, accounts, spend
```

## 5. Point it at repositories

Edit [`config/repos.yaml`](../config/repos.yaml):

```yaml
organization: exampleco     # read, not used: it may be left out
repos:
  - name: your-service
    fullName: exampleco/your-service   # a person's repository works the same: janedoe/your-service
    owner: builder          # the seat of the builder that owns this repository
    concurrency: 1
    stageModes:
      intake: autonomous
      spec: autonomous      # a design pass on every issue; conditional: only spec-required ones
      build: autonomous
      review: autonomous
      merged: autonomous    # production asks through its environment's reviewers
```

Which paths need a person's review is not set here. It is the `## Human review`
section of the repository's own `AGENTS.md`, read from its base branch
([§6](#6-protect-the-repositories)).

`spec: autonomous` is what a new repository starts with, written or not: every
issue gets a design pass before Build. `spec: conditional` gives one only to
issues with a spec-required label (`touches:schema`, `size:large`, `safety`
and the like), so most go straight to Build. In the console the choice is
Design on the repository's row in **Settings → Repositories**, which links to
where it is changed on the repository's page.

Run `openadlc seed` to load changes, or change the same values from the console's
repositories page (those changes are audited). A setting written in this file
wins at every `openadlc up` and `openadlc seed`, so a change to it in the console
lasts only until then; a setting the file leaves out keeps the console's value,
or the default a new repository starts with. Each change the seed makes to a
repository already there is audited as `repo.seeded`. Leave out what you want
to manage from the console: the example above sets `stageModes`, so its stages
are put back at every start. `owner` names a seat, so it stays right when the
builder connects an account of its own and takes its handle; one that names no bot is an
error the seed prints, naming it. An entry whose `name` another repository
already has, under a different `fullName`, is refused: the seed names both and
exits non-zero, and leaves that repository as it is.

Each repository gets a color when it is added, the first one no other
repository has. The board tells repositories apart by it, always beside the
name. Change it on the repository's own page, or for every repository at once
in **Settings → Appearance → Repository colors**. Either way it is audited as
`repo.settings`.

### The files a repository needs to be legible

A repository OpenADLC manages needs more than labels and a webhook, and `openadlc
github check` says which of these are missing:

| File | Why a bot needs it |
|---|---|
| `.github/workflows/ci.yml` | Publishes the `ci` check the merge line and the ruleset wait for, by running `make setup` and `make ci`; nothing else publishes it, so without it nothing lands. It runs on the repository's own Actions minutes: see [What CI costs a repository](#what-ci-costs-a-repository). |
| `.github/ISSUE_TEMPLATE/task.yml` | Its field labels **are** the headings the platform parses. GitHub renders a form response as `### <label>`, and `Outcome`, `Acceptance criteria`, `Expected paths` and `Verification` are what make an issue routable at all. |
| `.github/ISSUE_TEMPLATE/bug.yml` | A bug filed without the four sections goes back to intake instead of to a builder. |
| `.github/ISSUE_TEMPLATE/config.yml` | Keeps blank issues available, so the form is not something people work around. |
| `.github/pull_request_template.md` | `Closes #N` says which issue a pull request answers. The merge line holds a crew pull request to that issue's lease's paths, and holds one that closes no issue for a person. |
| `AGENTS.md` | How to build and check, and the `## Human review` section the bridge reads reviewer paths from. |
| `.github/CODEOWNERS` (written by the rules, [step 6](#6-protect-the-repositories), not by this check) | Without it, "review from a code owner" on the default branch cannot be satisfied by anyone. |
| `Makefile` | hostd runs `make setup` at task start, and `make ci` when the builder runs `openadlc-ci`. |
| `docs/runbooks/README.md`, `docs/adr/README.md`, `docs/adr/0000-template.md` | Reviewed by the workflows lens, and where decisions stop being re-argued. |

```bash
openadlc github check     # names the missing ones and why each matters
openadlc github apply     # writes only the ones that are absent
```

`apply` never overwrites what a repository wrote. What a repository says about
itself is its own — an `AGENTS.md` that matched the shipped template would be
one nobody had filled in — so this fills gaps and leaves every existing answer
alone. Two things OpenADLC wrote itself and nobody changed are brought up to
date: an `AGENTS.md` still naming the template's `@owner`, and a CI workflow
that is byte for byte an earlier template (see below). Settings → Repositories
lists both as changes to agree to before anything is written.

### What CI costs a repository

The `ci` workflow runs on the repository's own GitHub Actions minutes, so the
template OpenADLC writes runs as little as the merge line needs:

- **A crew pull request** runs CI once, after the lead reviewer approved and at
  the front of the merge line (`adlc:ci`); the builder ran `make ci` on its task's
  computer (container) before that, at no cost in minutes.
- **A change to docs alone** passes without `make setup` or `make ci`. Set
  `DOCS_ALONE_SKIPS: 'false'` in the workflow if your tests read your docs. A
  file moved into `docs/` from elsewhere is not docs alone: it takes code out
  of the build, so it runs.
- **The push to the default branch** after a merge runs nothing again when its
  pull request already passed that exact tree, which a merge the merge line
  made always did. Only a pull request into the default branch counts: a
  passed run of the workflow itself, for a pull request of the repository
  rather than a fork's, whose base never changed, on that tree, with `make ci`
  run and passed. A pull request into any other branch runs that branch's copy
  of the workflow, which could pass anything, so neither it nor any other pull
  request from the same branch vouches for a tree; and whatever GitHub does not
  answer, or answers too slowly (three minutes), the push runs the tests for.
  To tell, the workflow reads the run and its jobs, the branch's pull requests
  and their events (`actions: read`, `pull-requests: read`, `issues: read`)
  with the runner's own `node` and `gh`, so it needs no action beyond
  `actions/checkout` and `actions/upload-artifact`, and writes nothing. The
  step's log, *already passed on its pull request*, says which run it
  counted, or why each did not count (not yet watched on a live repository:
  [unverified](unverified.md#open), U87). The template runs on a push to
  `main`, `master` or `trunk`; add your default branch to its `push:` filter
  if it is called something else.
- **A hung run** stops after 30 minutes rather than GitHub's six hours.
- **A first failure** is run again once, as the app, before the work goes back
  to the builder: a rerun costs minutes, sending it back costs a model's round.

What a run costs beyond that is the repository's `make setup` and `make ci`.
Caching dependencies in the workflow (`actions/cache`, or `setup-node`'s
`cache:`, keyed on the lockfile) is usually the biggest saving left. A public
repository's runs on GitHub's standard runners are free.

A repository set up before this template keeps its workflow until it is set up
again: Settings → Repositories offers the current one in place of an earlier
template nobody changed, and leaves an edited one alone. An edited copy of an
earlier template that skips the push's tests counts a pull request into any
branch, so its default branch can pass a tree nothing tested: copy the
template's steps from *the tree it tests* to *what this change needs*, and its
`permissions`, into it.

The shipped copies are in `crew/templates/repo/`. This repository shares the
issue forms and the pull request template with them, kept identical by a test
that also renders the task form the way GitHub does and asks the real parsers,
so a renamed field label fails rather than quietly making every new issue
unroutable. Its workflows are its own, written for building and shipping
OpenADLC itself, and differ from the templates.

## 6. Protect the repositories

The settings are made by a command, not listed here to make by hand, because a
rule an operator has to remember is a rule that will be missing on the
repository that mattered.

What it can actually set depends on the **plan**, not on who owns the
repository. On a private repository, rulesets hold on GitHub Pro (a person's
account), Team and Enterprise; CODEOWNERS on Pro and above; and a required
environment reviewer only on GitHub Enterprise. Where GitHub will hold
nothing, OpenADLC's own gates still do — the review gate, the merge line with
the lease it holds a crew pull request to, and the author check — and `openadlc github check` reports which of the two is
carrying the weight.

The console's **Protect the repositories** step in the walkthrough is the
default way to apply them: the bridge writes them as the app, whose key it
holds. The CLI does the same:

```bash
openadlc github check     # what is missing, drifted, or cannot be expressed here
openadlc github apply     # create it
openadlc github check     # confirm it from the outside
```

`github apply` and `github sync-labels` act as the OpenADLC app, with an
installation token for each repository, as the console's repository setup
does, so they need the app's private key on the same machine, as the console's
install has it. Without it they act as the automation account, which needs
admin on the repository for rules and cannot create a label with triage. The
key is also how `apply` learns the app's id, which the rulesets name as their bypass actor and
pin `review-gate` to. Without the key, `apply` leaves a ruleset that already
names the app alone and reports it skipped, rather than take the bypass and the
pin off; use the console's Protect step then.

`check` is read-only and exits non-zero when anything is missing or has drifted,
so it belongs in whatever watches this install. What the two of them cover:

- the **`openadlc: main`** ruleset — linear history, no force push, no deletion,
  signed commits, squash-only, one approving review **from a code owner**,
  conversation resolution, and required checks (`ci`, `review-gate`) with
  **branches up to date before merging**;
- the **`openadlc: agent and system branches`** ruleset, which stops one bot
  rewriting or deleting another's work branch under `agent/**` and `system/**`
  while leaving each free to create its own. Repairing either one changes only
  what OpenADLC declares there: a rule, a branch or a required check you
  added to it stays, and is not drift. Apply still removes any exclude
  pattern, since an exclude can carve the default branch back out, and says
  which patterns it removed. When GitHub lets it read only the ruleset's list
  entry, which has no rules, apply leaves the ruleset as it is and says so
  rather than write over rules it could not see. Both name OpenADLC's app as a
  bypass actor, in `always` mode, so it can write CODEOWNERS to a branch they
  protect; the merge line merges as the app, so what holds its merges is
  `mergeDecision`, not the ruleset, and the app's private key is what guards
  `main`;
- **who else may bypass them**, judged entry by entry on both rulesets. A
  person may: a `User` who is not one of the crew's accounts, and the
  organization's owners (`OrganizationAdmin`) or a repository role
  (`RepositoryRole`: maintain is 2, write 4, admin 5) while no crew account
  holds that role or one above it. A `User` entry carries only an id, so the
  crew is matched by GitHub user id: the id the install stored when each
  account connected, for every account the crew works as (each seat's, the
  automation account's and the reviewers' among them, and any account
  connected without a seat), and both ids where an account and its seat's
  sign-in stored different ones. An account's login now is asked by that id
  (`GET /user/<id>`), so a renamed account is still known and whoever
  registers its old login is not taken for crew; a 404 there, which GitHub
  also gives a flagged or suspended account that keeps its role, leaves that
  account's role not known. A seat with no stored id is
  looked up by login, and a login with no account behind it is not known, not
  nobody: reconnecting the seat stores its id. A role is read from the
  repository's permission for each crew account, where an organization owner
  shows as admin. `check` names each person beside the ruleset ("a person may bypass it:
  janedoe (user 1001, always)"), as `openadlc doctor` does under its passing
  line; apply keeps them and never adds one. Anything else is drift, named in
  the warning and taken off by apply: a crew account, an app other than
  OpenADLC's, a team, a deploy key, a custom role, or a role a crew account
  holds, so a person on the list who later becomes a seat's account is flagged
  on the next check. When GitHub would not say a crew account's id or role,
  or the install's database would not say who the crew is, whether an entry
  covers a crew account is not known: `check` says so, and apply leaves that
  entry as it was;
- **`crew accounts`**: no crew account may be an admin of the repository,
  directly, through a team or as an organization owner, since an admin can
  change these rulesets and merge past them. `check` reports one as drifted
  with where to lower it, and so does one whose role could not be read; apply
  reports it skipped, since it changes nobody's role. On the board it is a
  line on the repository's protection card, and the `bot-access` card for
  that bot;
- the **`testing`**, **`production`** and **`production-rollback`**
  environments, each held to the default branch alone by its deployment branch
  policy, and production held as the repository's choice says: a wait timer
  of the soak when it ships automatically after testing (the default), or a
  required reviewer, the person named for it, when a person approves (the
  rollback's waits for nobody). The command asks which for a repository that
  has not said (`--production auto|reviewers`, `--reviewer`, `--soak` for a
  script), and never writes production with an empty reviewer list;
- **`CODEOWNERS`**, written if absent — without it, "review from a code
  owner" on `main` cannot be satisfied by anyone. It is looked for where GitHub
  looks, in `.github/`, then the root, then `docs/`, and the first found is the
  one read and repaired; a new one is written to `.github/` only when none of
  the three exists, and nothing is written while one cannot be read. Who owns
  what is a decision, so an existing file keeps your lines: apply rewrites only
  a `*` line naming crew no longer leading review, and a line owned by nothing
  but the organization, which GitHub cannot ask for a review.

A required check is named by the **job**, not by the workflow. The aggregate job
in `.github/workflows/ci.yml` is `ci`, so the context GitHub publishes is `ci` —
not `workflow / job`, which is what a reusable-workflow call produces. A ruleset that requires a context no job
publishes never goes green and nothing says why, so the name lives in one place,
`REQUIRED_CHECK` in `packages/shared/src/checks.ts`, which the merge line and
`openadlc github apply` both read, and a test fails if the workflow's job name drifts
from it.

Two things `check` will tell you that `apply` cannot fix, and reports as
*cannot be expressed* rather than passing over them:

- A **private repository** can require an environment reviewer only on GitHub
  Enterprise, whoever owns it. The environment is still created without one, and
  production is unguarded by GitHub until the repository is public or on that
  plan (below).
- **No repository owned by a user has a Triage role.** Intake and the automation
  account hold `write` there, and what keeps them from pushing is OpenADLC's own
  gates. This is the one functional difference between the two owners, and it is
  the only one.

`AGENTS.md` in the repository is where two things live that are not settings:
how to build and test, and **who has to approve what**.

```markdown
## Human review

- `config/` @you
- `infra/` @you
- `.github/workflows/` @you
```

The bridge reads that section from the **base branch**, never from a pull
request's own copy — otherwise a pull request could edit its way out of the
review it is subject to — and holds `review-gate` until each named person has
approved *the change that would land*: the head, or an earlier head whose diff
against the base is the same, so the merge line bringing an approved branch up
to date does not ask them again. An approval of an earlier commit with a
different diff does not count, nor does one a lead-only conflict resolution
carried over, which the person never saw. Logins match whatever their case. A
file it cannot read holds the gate rather than releasing it.

A pull request that changes the section itself — a line taken out or
rewritten, a heading put in, the section or `AGENTS.md` deleted — waits for
every person the base branch's section names, whatever paths it touches.
`AGENTS.md` is not one of the listed paths, and builders edit it on ordinary
work, so without this a first pull request could take a rule out on the lead's
approval alone. An edit elsewhere in `AGENTS.md` needs nobody.

Each rule is a list item (`-`, `*`, `+` or numbered) with one path, then the
logins who must approve it:

- The path is the first backticked span, or the first word; backticks are
  optional, and a leading `/` or `./` is ignored.
- A plain path is a prefix: `infra` and `infra/` both cover `infra/main.tf`,
  not `infrastructure/`, and a `*` or `**` at its end reads the same way. A
  `*` or `**` anywhere else makes it a glob, matched one folder at a time: a
  `*` stays within one folder's name and a `**` segment is any run of
  folders. `crew/skills/*/tools.yaml` covers every skill's `tools.yaml`, a new
  skill's included, and nothing else in those folders; `*.tf` is a file name
  at any depth.
- Words in parentheses, or after the logins, are a note: `` `infra/` (Terraform) @you ``.
- Sub-headings inside the section group rules; the section ends at a heading of
  its own level or higher.

A line it cannot read — two paths, a team such as `@org/team` (the gate waits
on people), logins with no path — holds the gate on every pull request in the
repository, and the repository-config card names the line and what is wrong
with it.

Naming the person is the point. The label is `review:human:<login>` and the
status says `waiting on @you`, so a path that needs one person's judgement is not
satisfied by somebody else's approval. The app creates a person's label the first
time a pull request needs it, since an automation account with triage may put a
label on but not make one; without an app key, a repository that lacks the
label goes without it, and the gate still waits on the person. Anyone a change does not need has their
automatic CODEOWNERS review request withdrawn, so a person's review queue is the
pull requests that genuinely wait on them.

Everything else `apply` touches is namespaced `openadlc:`, and a ruleset it does not
own is left alone.

**The crew never signs off its commits.** OpenADLC asks for no DCO, and a
bot cannot make that certification for a person, so its commits carry an author
and no sign-off line. A repository that enforces
a DCO check of its own must exempt the crew's accounts from it, or their pull
requests and the SRE bot's reverts fail that check and never merge.

**You do not need GitHub's merge queue**, and on most plans you cannot have it:
it is Enterprise Cloud only for private repositories, and absent entirely on a
personal one. The bridge serializes merges instead. When a pull request has its
approvals and its checks, it takes a place in that repository's line; the bridge
brings the one at the front up to date with the base branch, waits for the
checks to report on that new head, and merges it itself, as the OpenADLC GitHub
App, once `mergeDecision` holds: the lead's approval of that head, `ci` and
`review-gate` green on it, and the people AGENTS.md names for its paths. A
repository listed in the `bridgeMergeOff` setting is left to auto-merge or a
person. No bot merges — a bot that could merge could merge around a red check.

The "require branches to be up to date" rule is what makes this hold: without
it, two pull requests that each passed against an older `main` can both land and
leave it broken.

## 7. Give the bots engines

A model credential is an account, added once and shared by every bot assigned
to it. The walkthrough asks for that in two steps: **Foundation model accounts / API keys**,
then **Crew**.

An API key is pasted once on the model accounts step and verified by listing models
before it is stored. Bots sharing a subscription run at the same
time, the way several CLI windows on one laptop do, and share its rate limit
and usage allowance the same way: a busy crew reaches the plan's limit sooner
than it would on separate accounts or API keys. The
crew step proposes a default and lets any bot differ. It also says which
bots cannot run and why — a missing `claude` or `codex` command is fixed by
installing it, not by a key.

After setup, **Settings → AI models** (`/settings#models`) is where an account
is added, signed in again, checked and removed, with the models each one
offers; it is the model accounts step itself, so nothing needs the walkthrough run
again. Which bot uses which account and model is chosen on its row under
**Settings → Crew**, in one select, grouped by account. Removing an account a bot still uses is refused, naming
those bots.

The key lives in the secret store under the account. To put it there by hand
instead, once you know the account's id:

```bash
# ~/.openadlc/secrets/model-account-<id>.secret, mode 0600
printf '%s' "$ANTHROPIC_API_KEY" > ~/.openadlc/secrets/model-account-"$ACCOUNT_ID".secret
chmod 600 ~/.openadlc/secrets/model-account-"$ACCOUNT_ID".secret
```

### Subscriptions

**Use an API key unless you have checked.** An API key, or a provider's
business or team plan, is the recommended way to give the crew a model, and
what an install serving more than one person should use. A subscription is
the subscriber's personal account, under the provider's consumer terms. Those
terms may limit automated use, use by software other than the provider's own,
or sharing one sign-in across many concurrent sessions, and they change. Read
the provider's current terms and usage policies before you connect one.
Whether a subscription may drive an automated crew is between you and the
provider: OpenADLC and 620 Legal make no claim that it may, and a provider
that finds an account used against its terms may limit or suspend it, mid-task
included. This section is not legal advice.

A subscription is signed in once and every bot on the account uses that one
sign-in. Nothing needs a terminal except, for Claude, one command.

- **Claude.** On a machine signed in to the subscription, run
  `claude setup-token`. It prints a long-lived token starting `sk-ant-oat`;
  paste it into the account's token field. It is stored as the account's
  secret, like a key (`model-account-<id>`), and a session on the account gets
  it as `CLAUDE_CODE_OAUTH_TOKEN` — never with `ANTHROPIC_API_KEY` beside it,
  which Claude Code would use instead and bill to the API. A token copied out
  of a terminal that wrapped it has a line break in the middle; the field says
  so rather than storing it.
- **Codex and Grok.** Press **Sign in** on the account. hostd runs the CLI's
  own device sign-in — `codex login --device-auth` or `grok login --device-auth`
  — in a throwaway container from the bot image with a home of its own (on
  the host, under the `local` driver), and the console shows the
  link and the one-time code. Finish in your browser; the page notices within
  a few seconds. An unfinished sign-in is stopped after fifteen minutes, when
  its code has expired anyway.

Each OpenAI or xAI subscription has one login directory,
`~/.openadlc/logins/<account-id>` (`OPENADLC_LOGIN_ROOT` moves the root), 0700 and
made by hostd. A task does not get it as its home, and neither do a sign-in,
a model list, a check or an engine-update call. Under the `docker` driver
each of those gets a directory of its own, mounted at `/openadlc/login`. A
task's is `logins/.homes/<slot>`, outside the slot, and it goes when the
computer ends. The sign-in is the account's `auth.json`, shared, in a
directory of its own: `~/.openadlc/logins/<account-id>/sign-in/auth.json`.
Codex 0.155.1 writes that file in place, so it is bind-mounted at
`/openadlc/login/auth.json`. A Codex task gets no directory of the
account's. Grok renames a new file over it, and a file mount would fail that
rename with EBUSY and keep the old inode, so a Grok task has the `sign-in`
directory, and nothing else of the account's, at `/openadlc/auth`, and
`GROK_AUTH_PATH` is `/openadlc/auth/auth.json`. A refresh is the account's
file at once. A copy
per task is not used: OpenAI refresh tokens are single-use, and a hostd
crash before the copy was put back lost the refresh. Under the `docker`
driver the root has to be a path the Docker daemon can see, the same as the
work root.

The home is the CLI's whole home, not only its login, and it is empty apart
from the sign-in mount and the sealed files. A plugin, a hook, an LSP server,
a trusted-folder list or an instructions file one task writes is not in the
next task's home. `config.toml`, `managed_config.toml`, `requirements.toml`,
`AGENTS.md`, `AGENTS.override.md` and `.env` are bind-mounted read-only from
`~/.openadlc/logins/.published/<account-id>/`. A rename onto one of those
bind-mounted files fails with EBUSY, so the CLI cannot replace the mount, and
a read-only mount cannot be written in place. A writable copy is not mounted:
the task could still change that copy in place, and this task's CLI would
load it. Grok 1.0.41 reads `mcp_servers` from `managed_config.toml` and
`requirements.toml` as well as `config.toml`, and from a `plugins/` directory
a task can create; that directory is in this home only. Codex 0.155.1 loads
`$CODEX_HOME/.env` before the model, and `AGENTS.md` from its home as
instructions. A Grok task can write beside `auth.json` in the `sign-in`
directory. Nothing loads or keeps those files: the next task's home does not
include them, a sign-in, a model list, a check, an engine-update call or a
backup's restore check uses its own home, and a backup carries only the
sign-in and the published files. The `.published` directory is not
otherwise given to the container. An install upgraded from a build that kept
`auth.json` at the top of the account directory has it moved into
`sign-in/` when hostd starts.

The first time a computer starts, each published file is whatever the login
directory holds then — a `mcp_servers` table or an `AGENTS.md` already
there, included, and an empty file when the login has none. A link is not
followed. Read them before the next task runs:

```bash
cat ~/.openadlc/logins/.published/<account-id>/config.toml
cat ~/.openadlc/logins/.published/<account-id>/managed_config.toml
cat ~/.openadlc/logins/.published/<account-id>/requirements.toml
cat ~/.openadlc/logins/.published/<account-id>/AGENTS.md
cat ~/.openadlc/logins/.published/<account-id>/.env
```

Replace a published file and the next computer mounts the replacement. A
restore writes the published files again. After that, edit the published
files. A file a task creates is in its own home, and goes when the task does.

Under the `local` driver the `sign-in` directory is the CLI's home, one
shared home, config included, and every bot on one account can read what
the others sent. Only
that account: a bot on another account, or on a key, never has the directory
mounted.

The account's own data settings apply to every bot on it. Whatever the
subscriber chose for data retention and for training on their data, in a
terminal or on the provider's site, covers each bot's prompts as well: the
issues, pull requests and code of the repositories it works on. Check them
before connecting a subscription to private repositories. Grok also uploads
whole session traces to xAI when the account opts into sharing coding data;
OpenADLC turns that upload off for every Grok run
(`GROK_TELEMETRY_TRACE_UPLOAD=0`, with `GROK_FEEDBACK_ENABLED=0`), whatever the
account chose.

A mount can only be given to a container when it is created, and a task's
computer is made when the task starts. So a seat moved onto a subscription, off
one or from one to another has the change from its next task on, never in the
middle of one.

**Check it** (**check again** once it has been checked), on any subscription, sends one tiny prompt ("Reply with exactly:
OK") through the account's CLI in the bot image, holding exactly the
credential a session would get — the token, or the sign-in mounted into a
home of its own as a bot has it — and keeps the answer on the account: ✓ with when it
answered, or × with the CLI's own words. It costs one short prompt of the
subscription (Claude's runs on `claude-haiku-4-5`). Saving a token or finishing
a sign-in verifies straight away; replacing a token forgets the last check.
Removing the account deletes its token, or its login directory and the published config beside it.

A bot whose engine is unavailable **fails its task**. It does not fall back to
anything — the scripted engine is reachable only from the integration suites.
That fallback existed once: a missing binary quietly became the scripted engine,
announced in a log nobody reads, and the task produced fabricated work that
reached a real branch, a real pull request and a real review. A failed task is
visible; a fabricated one is not.

Under the `docker` driver a task's `HOME` is a folder of its own (`<slot>/home`),
not your home, so an engine CLI in the container **cannot** inherit a login from
your own machine. That is why a
subscription's credential is the token or the login directory above, and
nothing is ever signed in inside the bot image itself.

### Assignments

OpenADLC proposes an account and a model for each bot; you choose. Any bot can be
given any verified account, and any model that account offers — the builder
can think with Grok, the second reviewer with Claude, and a bot configured for
Codex can still think on an install with no OpenAI account.

- **The engine follows the account.** An Anthropic account runs the bot on
  `claude`, an OpenAI account on `codex`, an xAI account on `grok`, whatever
  `config/bots.yaml` says the bot's engine is. The bot's next task starts on
  the new engine, with the new account's credential — and, for an OpenAI or
  xAI subscription, its login mounted — without a restart. Saving with no
  account (`PATCH /v1/bots/<name>/assignment` with `"modelAccountId": null`;
  the console offers no such choice) puts a bot an account had moved back on
  the engine `config/bots.yaml` gives its seat, with the file's model unless
  one is sent, and its per-bot key if it still has one. A bot already on that
  engine keeps its engine and model. The automation bot
  (`engine: none`) takes neither an account nor a model.
- **The model must be one the account's provider serves**: `claude-…` for
  Anthropic, `gpt-…`, `o…` or `codex…` for OpenAI, `grok-…` for xAI. The
  picker lists what the account can actually call and a bot can run on
  (`GET /v1/model-accounts/<id>/models`, remembered for three minutes). An
  OpenAI key lists more than a hundred models. Only its chat, reasoning and
  codex models are offered, so speech, image, video, embedding, moderation,
  legacy completion and search models are left out. On xAI, image and video
  models are left out too. A key that lists nothing a bot can use is refused
  when it is added. A bot already set to a model that is left out keeps it in
  the picker, marked "not offered for bots", so you can change it. A model the
  account turns out not to offer fails the task, naming the ones it does,
  rather than running another. The picker puts a dated snapshot
  (`gpt-5-2025-08-07`) right after its undated name (`gpt-5`). An undated name counts as offered when
  the account lists it with a date: Anthropic lists `claude-haiku-4-5-20251001`,
  and `claude-haiku-4-5` is what the configuration, the API and the CLI use.
- **The proposal starts from `config/bots.yaml`.** Each bot is proposed the
  engine and model the file gives it — on an account of that provider, with the
  account's equivalent where it does not offer that model (a SuperGrok subscription
  offers `grok-4.7`, not `grok-4`). A bot whose provider has no account is
  proposed the closest model on another, and the second and security reviewers
  go to a provider no other reviewer is on when there is one. Every
  substitution is said. The proposal does not follow what you saved: a seat
  with nothing saved starts on the recommendation, never on an earlier
  choice.
- **A console choice survives `openadlc up`.** The file is the fresh-install
  default. A bot assigned in the console keeps its engine, model and account
  through every restart; a bot nobody assigned takes the file's engine and
  model, so an edit to the file still reaches it.
- **A family floats** (`newest:opus`, `newest:codex`, `newest:grok`): it is
  resolved when each task starts against what the account lists, and the
  ledger records the model that was called, with the family beside it. A
  family follows its base model: an id marked mini, nano, fast, lite, preview
  or non-reasoning is skipped unless the family names it (`newest:codex-mini`)
  or the account lists nothing else in the family, so `newest:codex` is never
  moved onto a cheaper variant because it was dated later. A key
  can float. So can a Claude subscription, whose token lists its models the
  way a key does, and an xAI subscription, where `newest:grok` is the model
  `grok models` calls its default. An OpenAI subscription cannot: nothing
  lists what a ChatGPT plan can call, so it is pinned to a model id and the
  bridge refuses a family there. When a subscription's list cannot be had, a
  pinned id is used as it is and a family fails the task with the reason.

`config/bots.yaml` puts the reviewers on two providers, Codex (lead and
security) and Grok (second), so the lead and the second reviewer never share a
provider's blind spot. Nothing stops you moving them onto one; that gives the
difference up.

## 8. What a task runs against

A task whose seat is marked `sidecarDb: true` in `config/bots.yaml` gets a
database of its own on the host's task database server (`openadlc-taskdb`, one
Postgres per host, published on the host's gateway only): a role and a database
named after the task, made from a template that already has `vector`,
`pgcrypto`, `citext` and `uuid-ossp`, closed to every other role, and dropped
with the task's computer. `DATABASE_URL` in the task's environment points at that
and nothing else (unless its repository has Postgres servers of its own, below),
and hostd runs the repository's `make setup` against it — so a
task's checks run on fixtures it owns, never on what the task before it left
behind and never on anything another task or the platform can see.

Give a managed repository these targets, because the platform calls them by name:

| Target | When |
|---|---|
| `setup` | At task start, against the task's own empty database or its own Postgres servers (below), for a task that has either (the `docker` driver, a `sidecarDb: true` seat) and whose tree is its own. A review that checks out a pull request does not run it: that Makefile is the pull request's, and hostd would run it outside the skill's tools with the task token. Under the `local` driver, or when the database could not be made, it does not run; a failing `setup` is logged and does not stop the task |
| `ci` | What the implement skill gets green before opening a pull request |
| `test`, `migrate` | Called by the two above; useful on their own |

The deploy path adds four more. They are in
[What a repository has to provide](#what-a-repository-has-to-provide), under
§9, because a repository can be worked in long before it is deployed from.

Bots that never run a suite — intake, the automation account — should leave
`sidecarDb` off rather than make a database nothing uses.

The `local` driver has no containers and so no task database. A task there gets no
`DATABASE_URL` at all, deliberately: the alternative is inheriting hostd's, which
points at the platform's own database.

### A Postgres server of the task's own

A database on the shared server is a plain role and one database. That is not
enough for a repository whose checks need a server of their own: migrations
that create server-wide roles through an admin connection, roles with fixed
names (two tasks making `app_rw` on one server collide), or a Makefile that
defaults to its own port. Such a repository gets one per task instead, which a
person sets in **Settings → Repositories → the repository → Postgres for its
tasks** (or `PUT /v1/repos/<name>/task-postgres`, an admin's): one or more
servers, each a port, a superuser, its password, a database and an image.
Give the repository's local-development defaults — such as `55432`, `app`,
`app`, `app_db` and `pgvector/pgvector:pg16`, as its `docker-compose.yml`
says — since only that task can reach the server. It is never a file in the
repository: whatever it names runs beside every task.

The form fills itself in from the repository's own Compose file, for a person
to check rather than type: a repository with nothing set starts filled, and
**Fill from docker-compose.yml** fills it again. The bridge reads the file
Compose would take on the default branch (`compose.yaml`, `compose.yml`,
`docker-compose.yml` or `docker-compose.yaml`, in that order) as the
automation account, through `GET /v1/repos/<name>/task-postgres/compose`, an
admin's, which saves nothing. Each service whose image is `pgvector/pgvector`
or `postgres` is one server: its image as the file writes it, the host side
of its port mapping to 5432, and its `POSTGRES_USER`, `POSTGRES_PASSWORD` and
`POSTGRES_DB`, with the image's defaults where the file sets none (`postgres`,
and the superuser's name for the database; a password has none). Variables
are read as unset, so `${PG_PORT:-55432}` is `55432`; the shell, `.env` and
an `env_file` are not read, and a value only they give is left empty with a
note saying so. The image is not pinned, since the bridge does not know what
the host already has: pinning it by digest is optional. A Postgres image the
allowlist refuses is still suggested, with the refusal Save would give.
Nothing is saved until a person presses Save, which checks the form as it
checks anything typed. A file that does not read, or that starts no Postgres
service, is said on the form.

| Use | The task's `DATABASE_URL` | When |
|---|---|---|
| `sidecarDb` alone | Its database on the shared server | The repository's checks need a database and nothing of the server's: no roles of their own, no superuser, any port |
| Postgres for its tasks, `DATABASE_URL` none | None, so the Makefile's own `?=` defaults apply | They make roles, need a superuser, or connect where the Makefile's defaults say (`127.0.0.1:55432`) |
| Postgres for its tasks, `DATABASE_URL` from one of its servers | That server's superuser's: `postgres://<superuser>:<password>@127.0.0.1:<port>/<database>` | Their suites read `DATABASE_URL`, as the repository's GitHub CI gives them a superuser's, and create and drop roles and databases of their own |
| Postgres for its tasks, `DATABASE_URL` the shared server's | Its database on the shared server, a plain role | Something besides the servers needs that database, and nothing reading `DATABASE_URL` makes roles |

What a task of a `sidecarDb: true` seat in that repository gets, under the
`docker` driver:

- Each server is a container in the task's computer's network namespace,
  listening on loopback (`127.0.0.1` and `::1`) at its port, so the task
  reaches it at `127.0.0.1:<port>` and nothing else can: it publishes no port
  and joins no network, and another task's loopback is its own. Its password is
  asked for on loopback too, as it is through the published port in the
  repository's own CI, so a wrong one in its URLs fails here as well. It has
  its own limits (1 CPU, 1 GB, 512 processes) beside the seat's, an image Docker's
  official `postgres` or `pgvector/pgvector` at a tag, a digest or both
  (`pgvector/pgvector:pg16@sha256:…` pins it; anything else is refused), and
  its data goes with it. It is removed with the task's computer, taken back
  with it when hostd restarts, and removed by the reaper if its computer went
  some other way.
- hostd starts each one and waits until it takes connections before
  `make setup`. One that cannot be pulled or brought up fails the task's start
  with what to do.
- The task is told where they are as `OPENADLC_TASK_POSTGRES`
  (`127.0.0.1:55432`, comma-separated for more than one), in `make setup`, the
  session and `make ci`.
- Its `DATABASE_URL` is the one the setting chooses, under **Each task's
  DATABASE_URL**, in `make setup`, the session and `make ci` alike. A
  `DATABASE_URL` from OpenADLC takes the place of the Makefile's own default
  (`DATABASE_URL ?= …`), so there are three choices:
  - **None**, the default: no `DATABASE_URL` from OpenADLC, so the Makefile's
    own `?=` defaults apply.
  - **Its database on the shared server**: what a `sidecarDb` seat gets
    without servers of its own, a plain role that cannot make roles.
  - **One of the servers above**, chosen by its port:
    `postgres://<superuser>:<password>@127.0.0.1:<port>/<database>`, that
    server's superuser, for suites that read `DATABASE_URL` as the
    repository's GitHub CI gives it and make roles and databases of their
    own. hostd builds it from the server's fields where it puts the task's
    environment together, each part percent-encoded, and passes it by name,
    never on a command line. The setting keeps only the port, so the
    password is in no audit row and no read-back of the setting. A computer
    hostd takes back after a restart has it again for local CI, read from
    the setting, when that server is among those found running beside it.

  Through the API it is `databaseUrl`: `"none"`, `"shared"` or
  `{ "port": 55432 }`, which must be one of the servers' ports; anything else
  is refused with what to send. A setting saved before there was a choice
  reads as it did: `sharedDatabase: true` is `"shared"`, and `false` or
  nothing is `"none"`. A body that still sends `sharedDatabase` is stored as
  the `databaseUrl` it means; one that sends both is refused. When the form
  fills itself from the Compose file and nothing was saved for the repository
  before, it offers the first server it found as the `DATABASE_URL`; a
  person still checks it and presses Save.

A repository's `db` target should start nothing when the server is there:

```make
db:
ifdef OPENADLC_TASK_POSTGRES
	@echo "Postgres is OpenADLC's: $(OPENADLC_TASK_POSTGRES)"
else
	docker compose up -d --wait postgres
endif
```

There is no Docker inside a task's computer, so a `db` target that always runs
`docker compose` fails there; with the server already listening where the
compose file would have put it, the rest of `setup`, `migrate` and `test` run
as they do on a laptop.

The `local` driver has no containers to make one in. There the setting page
says so, hostd logs it at each task start, and the task is told it has no
server of its own, nor the `DATABASE_URL` one of them would give, rather than
finding out at its first connection.

On the cloud host the image is pulled by the host's Docker daemon from Docker
Hub, as `openadlc-taskdb`'s is (`infra/gcp/cloud-init/host.yaml`).

### Installing from a private package registry

Nothing is required for a public registry: that is the default and this section
can be skipped.

If your repositories install from a private registry, name it and store the
token, and tasks will use it:

```bash
# The host is read when hostd starts, so export it in the shell that runs
# `openadlc up`, and restart (`openadlc down && openadlc up`) after changing it.
export OPENADLC_REGISTRY_HOST=npm.internal.example
# The token is read on every request, so a rotation takes effect at the next install.
printf '%s' "$REGISTRY_TOKEN" > ~/.openadlc/secrets/registry-token.secret
chmod 600 ~/.openadlc/secrets/registry-token.secret
```

Store a **read-only** token, scoped to the packages your repositories install: a
read-only npm automation token, or a deploy token that can only read the package
registry. Any running task on the install can read this token, whatever its
repository or skill, and can send it wherever its egress allows, GitHub
included. The `maxAgeSeconds` hostd sends with it is a caching hint, not an
expiry: the token works until you rotate it. A token that can publish would let
any task push a package version of its own.

Then have the repository install through the wrapper the bot image carries,
in its Makefile's `setup` and `ci` targets as well as anywhere else it
installs:

```bash
openadlc-install pnpm install --frozen-lockfile
```

The `make setup` hostd runs when a task starts and the `make ci` behind
`openadlc-ci` get the task's id, its token and hostd's address, as the
session does, so the wrapper fetches the credential there too. The builder,
conflict resolver and QA may run it; the reviewer never installs. A review
that checks out a pull request does not get that `make setup` either: the
Makefile would be the pull request's, run with the task token before the
session's tools apply.

`openadlc-install` asks hostd for the credential and gives it to the one
command it runs, in that command's environment as `OPENADLC_REGISTRY_TOKEN`.
The npmrc it points npm and pnpm at, a private file outside the worktree
removed afterwards (including when the install fails), names that variable
rather than holding the token, so the token is never written to disk. No
registry credential is in the session environment, so a task that runs for an
hour installs with what is true at minute fifty rather than what was true when it
started.

Three behaviours are worth knowing before you rely on it:

- On an install with no registry configured, hostd answers `501` and the wrapper
  runs the command unchanged. Outside an OpenADLC session — a person in
  `tmux attach` — it also runs the command unchanged.
- With a registry configured, hostd also sets `OPENADLC_REGISTRY_CONFIGURED=1`
  in the session, in `make setup` and in local CI. The flag comes from hostd's
  configuration, never the repository's. Where it is set, a wrapper missing the
  task's id, token or hostd's address **fails** and names what is missing,
  rather than taking itself to be outside a session.
- If hostd refuses or cannot be reached, the wrapper **fails** rather than
  installing. Falling back to the public registry is how a private package name
  gets resolved against a public one. That includes a registry named with no
  token stored, or an empty token file: hostd answers `503` with how to store
  one, and the install fails until you do.

Under Docker Compose, export `OPENADLC_REGISTRY_HOST` in the shell that runs
`docker compose up`, which passes it to hostd, and put the token in the compose
install's own home rather than `~/.openadlc`:

```bash
export OPENADLC_REGISTRY_HOST=npm.internal.example
home="${OPENADLC_COMPOSE_HOME:-$HOME/.openadlc-compose}/home"
printf '%s' "$REGISTRY_TOKEN" > "$home/secrets/registry-token.secret"
chmod 600 "$home/secrets/registry-token.secret"
docker compose -f infra/local/docker-compose.yml up -d
```

On an `infra/gcp` install, hostd's environment is written by the module's
cloud-init and its secret store is Secret Manager, so both go there instead.
Add the bare host name to `cloud.tfvars.json`, save it and apply; the module
adds it to the egress allowlist and hands it to hostd:

```bash
# in ~/.openadlc/cloud.tfvars.json: "registry_host": "npm.internal.example"
openadlc cloud push
openadlc cloud apply
```

Then store the token once as the Secret Manager secret `openadlc-registry-token`,
after the first apply: before it, `plan` and `apply` read an `openadlc-*`
secret in a project with no state as an earlier install's and stop. On an
install not renamed yet ([runbooks/rename-gcp-host.md](runbooks/rename-gcp-host.md)),
a `fleet-registry-token` already there is read until it is copied.

```bash
printf '%s' "$REGISTRY_TOKEN" | gcloud secrets create openadlc-registry-token \
  --project <project> --labels=openadlc=secret --data-file=-
# to rotate it:
printf '%s' "$REGISTRY_TOKEN" | gcloud secrets versions add openadlc-registry-token \
  --project <project> --data-file=-
```

Do not put the registry in `extra_allowed_domains`: that opens the proxy to it
but tells hostd nothing, and a task's install is refused for want of a
credential.

## 9. The deploy path

The deploy path (deploy, smoke, promote, revert) is new and has not yet run
against a live environment: what it relies on GitHub to do is listed, as U37 to U43,
under [Open in the unverified log](unverified.md#open). Read those rows before
you turn deploys on for a repository that matters.

Four workflows, three environments and four `make` targets. The workflows are
copied from `crew/templates/repo/` into `.github/workflows/`; they are the
repository's, so a fork edits them freely. All four are dispatch-only: OpenADLC
dispatches them as the app, or a person runs them by hand.

| Workflow | Runs on | Environment | Approval |
|---|---|---|---|
| `deploy-testing` | OpenADLC, after a merge to the default branch, with that `sha`; or a person, by hand | `testing` | none |
| `smoke-testing` | `deploy-testing` finishing green, or by hand | none | none |
| `promote-production` | OpenADLC, after a green smoke (and its soak, or a person's release from Needs you), with a `candidate` commit; or a person, by hand | `production` | **a person, once, covering the whole job**, where the plan holds a reviewer; otherwise OpenADLC's hold or soak. Always: the candidate live and smoked on testing, unless a person with admin or maintain overrides it |
| `rollback-production` | OpenADLC, when a promote's traffic shift fails; or a person, by hand, from the default branch | `production-rollback` | **none, deliberately** |

**Nothing in these workflows writes to GitHub.** They hold `contents: read` and
create a deployment, and that is all; the promote also reads the smoke's runs
(`actions: read`). The label on the pull request, the revision
URL, the card moving and the builder's verification are the bridge's work, off
the `deployment_status` the deployment produces — because an action taken with a
workflow's own token fires no further events, so a chain of workflows breaks
silently at its first link.

What the bridge does with a `deployment_status` it can act on:

| Environment | State | What happens |
|---|---|---|
| `testing` | `success` | The pull requests that commit came from get `deployed:testing` and the revision URL (`environment_url`; with none, a comment that the deploy reported none, linking the run); their issues get the label too, and the builder is started on verifying against it |
| `testing` | `failure` or `error` | An issue, the SRE's task on it, and no revert. The revision never reached testing, which still serves the previous one. The SRE reads the run and says on the issue what broke: a change that broke it goes back to build; a broken deploy workflow (`.github/workflows/deploy-*.yml`) it fixes by a pull request that closes the issue, reviewed like any change to how CI runs, so the security reviewer approves it too; only what no file fixes — a runner, a secret, the environment's settings — is left for a person, with the exact thing to do. With no deploy bot in the crew the issue is a person's. Only a red `smoke-testing` run reverts (below) |
| `production` | `success` | The pull requests get `deployed:prod` and their issues reach `adlc:done` |
| `production` | `failure` or `error` | No revert: a second change to the default branch during an incident is the last thing anybody needs. Only a promote the bridge dispatched is acted on, for the candidate its run names, by where it stopped: never ran, nothing; a red production smoke, the change goes back to build and production is left as it is; a failed traffic shift, `rollback-production` with an empty target ("before the last shift") and an issue; anything else, an issue saying to check whether traffic moved. The template's promote is one `promote` step, with no step named for a smoke or a traffic shift, so a failure there is always the last case: nothing is rolled back, and a person decides |
| anything else | any | Nothing. A preview environment is not the platform's business |

Only the repository's own runs on its default branch count. A workflow is a
file in the repository, and one named like these on a pull request's branch,
another branch or a fork runs there too, so the bridge acts on a
`deployment_status` only for a deployment of the default branch, and on a
`production` one only when its run was dispatched. It files an issue for a
failed `deploy-testing` run only when it was a push or a dispatch on the
default branch, and treats a `promote-production` run as a promote only when
it was dispatched by hand on the default branch, from the repository's own
`.github/workflows/promote-production.yml` (or the workflow its rules name).
Names are matched exactly. Anything else starts no QA run, files no issue,
rolls nothing back and finishes no pull request, and the bridge's log says
why.

A failed `smoke-testing` run opens the revert on a `system/revert-<sha>`
branch only when it ran on the default branch, not for a pull request, and
tested a commit whose `testing` deployment the bridge saw succeed. A
smoke-testing workflow on a pull request's branch, or a smoke of a commit
never deployed, reverts nothing, and the bridge's log says why.

`smoke-testing` runs only for the default branch's own `deploy-testing`: from
this repository, on its default branch, dispatched (or, in OpenADLC's own
copy, pushed). GitHub starts a `workflow_run` workflow for any run of that
name, and a fork's pull request can add one, so the job's `if` checks the
triggering run's event, repository and branch, and anything else leaves the
smoke skipped. The smoke runs in the default branch's context, with its
token: do not add secrets, an `environment:` or `id-token: write` to it
without that guard. The bridge also ignores a smoke, red or green, started
by somebody it does not act for (the run's `triggering_actor`), which covers
a repository still on the old workflow. The first
revert of a commit starts even when a monthly spending cap has been reached; see
[configuration](configuration.md#costsyaml--what-openadlc-may-spend).

### What a promote proves first

The bridge dispatches `promote-production` only for a commit that reached
testing and passed its smoke, but anyone with write access can dispatch it by
hand, crew accounts included. So the workflow proves it again itself, before it
builds, migrates or deploys anything: the candidate must have a successful
`deploy-testing <sha>` run on the default branch, the `testing` deployment that
run recorded must have reached `success` (a newer deploy may since have marked
it `inactive`), and its latest `smoke-testing of deploy-testing <sha>` run that
ran (skipped and cancelled runs are passed over) must be green. Otherwise the
job stops and says what is missing. `SMOKE_WORKFLOW` in that step names the
smoke's workflow file; keep it equal to `testing.smoke` in
`.github/openadlc.yml`.

For an emergency fix that cannot wait for testing, a person with `admin` or
`maintain` on the repository dispatches it with `emergency_override` set to the
reason:

```bash
gh workflow run promote-production -f candidate=<full sha> -f emergency_override='<why it cannot wait>'
```

The check is skipped only for such a person: a login ending in `[bot]` is
refused, and so is anyone with write or less. The run is named
`promote-production <sha> (emergency override)` and its summary records who
and why; the bridge audits it as `deploy.promote_override` and says so in the
`promote_waiting` notification. The environment still holds it as its rules
say. A crew account with admin or maintain on a repository is a blocking card
in the console, because it could use the override.

### QA before a promote

When `promote-production` is dispatched, GitHub sends `workflow_run` with
`requested` while the job waits for its approval. The bridge answers it with
the task the nightly `qa` job opens — the QA bot, against the repository's
testing URL — on the subject `<repo>#testing@<sha>`, and a `promote_waiting`
notification to the install's owner saying the readiness report will appear in
that thread. Read it before you approve.

The testing URL is `testing.url` in the repository's `.github/openadlc.yml`,
else the repository's setting in the console, else `OPENADLC_TESTING_URL`
(deprecated). The QA task is given it in a `testing.md` document, with the
commit, at its start and again whenever it resumes; the nightly run and the
builder's verification after a merge reaches testing are given it the same
way. A report where nothing ran begins `not run:` and carries no `verified`
marker. On a cloud install the URL's host has to be one the host's tasks may
reach ([What the host's tasks may reach](#what-the-hosts-tasks-may-reach)):
while the egress proxy refuses it, QA reports `not run:` naming the host, and
the `testing-egress` card says how to allow it.

**Where the plan holds a reviewer, GitHub holds the promote.** The
environment's required reviewer does: nothing in the job runs until a person
approves, and QA comes before the promote only because that person reads the
report first. Approving without reading it promotes anyway. On a repository
where GitHub will not hold environment reviewers (below), the bridge holds the
promote before it is dispatched instead: in Needs you, for a person to release,
when the rules say `approval: reviewers`, or for its soak when they say `auto`.
The notification then says the promote is running, not that it waits.

- **One QA run per commit.** A redelivery, a re-run or a second dispatch at the
  same commit is pointed at the run that exists. Only one that failed or was
  stopped is tried again.
- **Nothing to point at, nothing opened.** With no testing URL from any of the
  three, or no bot with the `qa` role, no task opens and the notification says
  which, so the approval is made knowing there is no report behind it. The
  builder's verification after a merge is not opened either; its lease is let
  go as a finished one would be, and the bridge's log says why.
- **The commit is the `candidate`.** A delivery does not carry a dispatch's
  inputs, so the workflow names each run `promote-production <candidate>` and
  the bridge reads the commit from that, which is why `candidate` must be a
  commit id, and the full 40-character one: `actions/checkout` takes only a full
  id as a commit, so the job's first step refuses a short one (`git rev-parse
  <short>` prints the full id). The QA run checks whatever testing is serving.
- **Production finishes what was promoted.** The deployment GitHub records for
  the job is at the workflow's commit, the default branch's tip, not the
  candidate. When it succeeds, the bridge labels `deployed:prod` and moves to
  Done the pull request behind the candidate the run is named for, and every
  one merged between the last promote's candidate and it, however many
  commits that is. The last promote is the one the bridge finished; before it
  has finished any, the last successful `promote-production` run on GitHub.
  With neither, the candidate's alone. The delivery only queues this: the
  bridge walks it afterwards, one promote at a time across every bridge, and
  walks a queued one again after a restart. While GitHub cannot list what a
  promote carried, it stays queued, and it and every later promote of that
  repository are tried again at the next deployment; after a day it settles
  for what GitHub did list. A pull request that cannot be finished is logged,
  and the others are still finished. Each promote run is processed once: a run
  older than the last finished promote is skipped, and so is a new promote of
  the commit already in production. A `promote-production` run whose candidate
  is an earlier commit (rolling back by promoting again) is processed. A production deployment whose run is not
  `promote-production`, or names no candidate, finishes nothing, and the
  bridge's log says so.
- **Testing is untouched.** Its deploys have no approval to wait for.

### The environments

All three are created by `openadlc github apply` (step 6), which is the only thing that
should create them — an environment made by hand is one nobody checks. What it
makes, so you can confirm it from the GitHub UI:

- **`testing`** — a custom deployment branch policy naming the default branch
  and nothing else, no reviewers, no wait timer.
- **`production`** — the same branch policy, and what the repository's delivery
  rules (`.github/openadlc.yml`, see [configuration.md](configuration.md#githubopenadlcyml--how-a-repository-ships))
  say holds it: with `approval: auto` (the default), no reviewer and a wait
  timer of `soakMinutes` (30 unless chosen otherwise); with `approval:
  reviewers`, `prevent_self_review` on and required reviewers who are people:
  the ones named when the repository was set up, else the install's `humans`,
  else the people CODEOWNERS names, by numeric user id. With nobody to name,
  the environment keeps a reviewer it already holds, or is created with its
  branch policy and no reviewer, and the apply says to choose who approves
  production. That the reviewer the apply sets on a real organization's
  repository sticks has not yet been seen ([unverified](unverified.md#open),
  U42): after the apply, check the environment's page shows the person.
- **`production-rollback`** — the same branch policy, no reviewers, no wait
  timer. Only `rollback-production` runs in it.

**Deploy credentials go in environment secrets.** The credential that deploys
and shifts production's traffic belongs only in the `production` environment's
secrets for the promote, and in `production-rollback`'s for the rollback — or
behind an OIDC trust pinned to that environment or to
`ref:refs/heads/<default branch>`. Never in a repository or organization
secret: any account with write access, every crew bot included, can push a
workflow to its own branch that reads those. An environment's secrets reach
only a job its branch policy admits.

GitHub creates an environment a job names if it does not exist, with no
protection at all. Run `openadlc github apply` after copying the workflows in,
so each one exists with its branch policy before anything runs in it.

The branch policy is what stops a deploy of anything that never went through the
default branch, and the environment is what makes "a bot never approves a
deploy; the repository's GitHub rules do" hold in GitHub rather than only in the
SRE's skill. OpenADLC dispatches the promote and never approves an environment;
the `production-rules` health check fails if a crew account is among its
reviewers. A team among them is reported for a person to confirm instead:
every member of a team may approve, and OpenADLC cannot see who is in one, so
the check names the team (`@<org>/<slug>`) and asks that no crew account be a
member rather than passing. On a
**private repository** GitHub holds an environment reviewer only on GitHub
Enterprise, whoever owns the repository: on Free, Pro and Team a required
reviewer holds only on a public repository. `openadlc github check` reports that as
*cannot be expressed* rather than passing over it. Until the repository is
public or on that plan, the bridge holds production itself: each promote of a
repository set to `approval: reviewers` waits in Needs you until a person
releases it, and one set to `auto` waits out its soak.

The policy names the default branch rather than "protected branches", because
the crew's own `agent/**` and `system/**` branches are protected by OpenADLC's
ruleset: a workflow pushed to one would otherwise be a deploy from a bot's
branch. `apply` removes any other policy it finds, and `check` and the
`production-rules` health check report as drift a policy that admits every
protected branch, misses the default branch, or admits anything else — which is
also how a renamed default branch shows up, until the next `apply` moves the
policy to it.

### Turning it on

A repository says how it ships in `.github/openadlc.yml` on its default branch
([configuration.md](configuration.md#githubopenadlcyml--how-a-repository-ships)).
`crew/templates/repo/` has that file and four dispatch-only workflows
(`deploy-testing`, `smoke-testing`, `promote-production`, `rollback-production`)
that run the repository's Makefile targets; copy them in, fill in the targets,
and run `openadlc github apply` so the `production` environment matches the
rules. `apply` does not write them itself: on Automatic, a `deploy-testing`
workflow appearing would turn deploys on in a repository nobody set up for them.
A repository that copied `smoke-testing.yml` before it checked where its
`deploy-testing` came from should copy it again: the old one runs a fork's
Makefile when the fork adds a workflow named `deploy-testing`.

The last line `make deploy-testing` and `make promote-production` print is the
deployed revision's URL. The template workflows give it to their environment
as `environment.url`, GitHub sends it on as the deployment's
`environment_url`, and the pull request gets "Live on testing: <that URL>"
(or production). A target whose last line is not an `http(s)` URL still
ships: the run carries a warning, and the pull request says the deploy
reported no revision URL and links the run as the run, never as the place the
change is live. A repository that copied these workflows before they did this
should copy them again.

A repository with no rules file ships by a choice on
Settings → Repositories → Testing deploy: **Automatic**, **Has a testing
deploy**, or **No testing deploy**. Automatic looks for a `deploy-testing`
workflow and is the default. No testing deploy means a merge goes straight to
Done, and the deploy sweep moves any issue left in Ship there, starting no
SRE task. OpenADLC does not read the Actions variable below.

The workflow itself still skips until the repository says it has somewhere to
deploy to, and the template's smoke until the repository says its smoke is
written:

```
Settings → Secrets and variables → Actions → Variables
  OPENADLC_DEPLOY_TESTING = true
  OPENADLC_SMOKE_TESTING = true
```

Until the first is set, `deploy-testing` skips. That is deliberate: a green
deploy of nothing would put `deployed:testing` on a pull request that is live
nowhere, and an issue waiting on that one would be unblocked by a deploy that
never happened. Skipped is not failed, so it starts no revert either.

Write the `smoke-testing` target together with `deploy-testing`. A red smoke
reverts the change and sends it back to build, so the Makefile's stub smoke,
which refuses, would revert every merge once only the deploy was filled in.
Until `OPENADLC_SMOKE_TESTING` is set, the template's `smoke-testing` skips,
and a skipped smoke neither promotes nor reverts: a merged change waits on
testing. OpenADLC's own `smoke-testing` reads `OPENADLC_DEPLOY_TESTING`
instead, since its deploy and smoke are written together.

### What a repository has to provide

The template workflows call four targets, each with what it acts on:

| Target | Contract |
|---|---|
| `deploy-testing` | Deploy the merged commit `SHA=<sha>` to testing. **Last line of output: the revision's URL** |
| `smoke-testing` | Exercise testing. Non-zero exit means revert |
| `promote-production` | Take `CANDIDATE=<sha>`, already live and smoked on testing, to production: build, migrate, deploy, smoke the new revision and move traffic to it, in that order, and fail without moving traffic if anything before the shift fails. **Last line of output: the revision's URL** |
| `rollback-production` | Send traffic back to `TO=<revision>`, or to whatever was serving before the last shift when it is empty. Never migrates |

The template Makefile has these four stubbed: each one stops and says what to
put there.

OpenADLC's own repository is not on the template: its `promote-production`
workflow splits the promote into `deploy-production` (deploy serving no
traffic; last two lines, the revision's tag then its URL), `smoke-production`
and `shift-traffic` (both on `OPENADLC_REVISION_TAG`), and its
`rollback-production` reads `OPENADLC_REVISION_TAG` rather than `TO`. Those
targets are stubbed there too, because it has no hosted environment of its own
yet.

Two things about the shape, which are not preferences:

- **The promote is one job.** An environment approval is granted to a job, so
  build, migrate, deploy, smoke and the traffic shift being five jobs would be
  five approvals — and a person asked to approve the same change five times stops
  reading. Traffic moves last, so everything before it is undone by doing nothing.
- **The rollback has an environment of its own, `production-rollback`, that
  waits for nobody.** An environment is not an approval — `testing` has none
  either — and a rollback that waited for one would not be a rollback. It is
  there for its branch policy, which admits the default branch alone, and for
  its secrets. Its deployment is to `production-rollback`, which the bridge does
  not act on, so it moves no card and changes no label: whoever ran it says what
  is serving, on the incident.
- **The rollback and the promote share one concurrency group,
  `production-traffic`,** so the two never shift traffic at once. GitHub runs
  one run of a group and keeps one pending, and a newly queued run cancels the
  pending one: a rollback dispatched behind a promote waiting for its approval
  would wait for that person, and the next promote dispatched would cancel it.
  So before the bridge dispatches a rollback it cancels the repository's
  promotes GitHub has not started (queued, or waiting on the `production`
  environment), which have run no step; one already running is left to finish.
  Until that rollback has succeeded, it dispatches no promote in the
  repository: the promote is held, and the deploy sweep asks again. The sweep
  reads the rollback's run: a success is recorded, and only then does a
  send-back say production was rolled back (until then, that a rollback was
  dispatched); a failure is recorded and is a blocking `deploy-dispatch` card;
  a run cancelled, or none listed ten minutes after the dispatch, is
  dispatched again and is a card until one succeeds.

Migrations are forward-only, so a rollback is a traffic decision and never a
schema one. A migration that the release before it cannot run against is a design problem
to solve before the promote, not during it.

## 10. Run more than one task at once

Each task runs in a computer of its own — a container made when it starts and
removed when it ends — so running two at once is a number, not a second seat.
What keeps two pieces of work off the same file is the lease and the
dispatcher's overlap check on the paths each issue declares.

1. **Crew → Tasks at once** on the builder's card: how many tasks it runs at
   once, 1 to 16, all as its one GitHub account (`maxTasks` in
   `config/bots.yaml` sets it from the file instead). Keep a seat whose account
   is an OpenAI or xAI subscription at 1: its CLI keeps one sign-in and
   refreshes it as it works, for every task on it.
2. **Raise Tasks at once** on the repository's settings page. It offers as many
   as its builders' tasks at once add up to.
3. **Give the host room.** A host runs `OPENADLC_HOST_CAPACITY_TASKS` tasks at
   once (four by default), each with its seat's CPUs and memory; past that a
   task waits for one to end.

A second builder seat is still how a repository gets a second GitHub account:
**Settings → Crew → Add a builder** adds the next free seat — `builder-2`, then
`builder-3` — with the engine and model `config/bots.yaml` gives the builder,
while the install runs, and `openadlc up` keeps it. Put it on an account on its
row: the crew account the builder already uses is offered, and joining it needs
no sign-in. A seat can also be declared in `config/bots.yaml` beside `builder`,
with the builder's role, so a fresh install starts with it.

A seat added from settings can be removed from its row while it has no task
running and nothing spent. Removing it takes it off its account, which stays
connected. One that has spent stays, because its usage is what the month's cap is
counted from; pause it on the Crew page instead, and nothing new is given to it.

The dispatcher places work across every bot with the owner's role and still never
gives one container two tasks. If a repository's Tasks at once is higher than
its builders' Tasks at once add up to, the dispatcher says so on every run
rather than quietly running fewer.

## 11. Operate it

```bash
openadlc status                   # processes, board, spend, crew
openadlc logs bridge              # where a service writes its log
openadlc attach <name> <session>  # take over a running session; ctrl-b d to hand it back
openadlc github sync-labels       # after editing config/labels.json; as the app, like the console's repository setup
openadlc github check             # can the automation account reach the repositories
openadlc down                     # stop the stack
```

Under the `docker` driver a bot has no computer between tasks, so there is
something to take over only while a task runs (`openadlc status` says which
bots are running one): `<session>` is that task's session, as the bot's
Terminal tab in the console names it. Only under the `local`
driver does every bot keep an idle `shell` session (`openadlc attach <name>
shell`) as well. A bot's name is its account's handle, or its seat until one
connects; `openadlc status` lists the crew by it. Take-over also works in the console's
Terminal tab, which attaches in the browser; detaching leaves the session and the
task running.

Jobs on the bridge. The timer fires them, each every `OPENADLC_JOB_<NAME>_MINUTES`
(0 turns one off); these curls run one now, on the default bridge port. The
`/internal` routes answer only a caller with the install's internal secret:

```bash
SECRET="$(cat "${OPENADLC_HOME:-$HOME/.openadlc}/secrets/internal-api-secret.secret")"
curl -X POST -H "x-openadlc-internal-secret: $SECRET" http://127.0.0.1:47311/internal/schedule/reconcile   # every 15 minutes
curl -X POST -H "x-openadlc-internal-secret: $SECRET" http://127.0.0.1:47311/internal/schedule/status      # every 15 minutes
curl -X POST -H "x-openadlc-internal-secret: $SECRET" http://127.0.0.1:47311/internal/schedule/stages      # hourly
curl -X POST -H "x-openadlc-internal-secret: $SECRET" http://127.0.0.1:47311/internal/schedule/merge       # every 10 minutes
curl -X POST -H "x-openadlc-internal-secret: $SECRET" http://127.0.0.1:47311/internal/schedule/deploy      # every 30 minutes
curl -X POST -H "x-openadlc-internal-secret: $SECRET" http://127.0.0.1:47311/internal/schedule/events      # daily: GitHub deliveries past OPENADLC_EVENT_RETENTION_DAYS
```

The `deps` job, weekly, files one "Weekly dependency update" issue in each
repository the install manages, into intake, unless the last one is still
open. Triage shapes it for Build without asking anyone, naming the
repository's manifests and lockfiles, and the crew builds, reviews and lands it
like any other issue, within the spending caps. `OPENADLC_JOB_DEPS_MINUTES=0`
turns it off.

The internal secret mints every bot's GitHub token and starts work: it never
leaves the install. A monitoring system that files alerts as issues
(`POST /internal/alerts`, deduplicated by `fingerprint`) holds the alerts secret
instead, which opens that route and nothing else:

```bash
ALERTS="$(cat "${OPENADLC_HOME:-$HOME/.openadlc}/secrets/alerts-secret.secret")"
curl -X POST -H "x-openadlc-alerts-secret: $ALERTS" -H 'content-type: application/json' \
  -d '{"fingerprint":"disk-full","title":"Disk full on web-1","repo":"site","severity":"page"}' \
  http://127.0.0.1:47311/internal/alerts
```

The body is OpenADLC's own, not Alertmanager's webhook format, so a monitor
that cannot shape its request needs a small relay in between. The bridge makes
the secret at its first start.

Reconciliation compares the board with GitHub, repairs what it safely can — a
stage label the cache disagrees with, an issue filed while the bridge was down, a
lease on a closed issue — and reports the rest where a person will see it.

An alert posted to `/internal/alerts` (`{ "fingerprint", "title" }`, and
optionally `description`, `repo`, `severity` and `url`) becomes one issue,
labelled `alert`, `adlc:intake` and `do:ai`, and another firing of the same
fingerprint finds that issue by its `alert` label instead of filing a second.
GitHub drops the labels an account without push access asks for when it files
an issue, so the bridge adds whichever it lacks afterwards, and the app makes
`alert` first in a repository that does not have it yet.

The merge job moves each repository's line along by one step. Everything it
waits for also arrives as a webhook, so this is the safety net rather than the
mechanism: a delivery that never came costs a few minutes.

The stage sweep starts the bot a staffed stage belongs to when nobody is on it.
A webhook that never arrived, a bot that was busy at the time, and a label applied
while the bridge was down all look the same from here, so an issue sitting in
Intake or Spec costs an hour rather than waiting for someone to notice.

A busy bot does not wait for the sweep. An issue its seat turned away, running
all the tasks it may at once, is recorded as waiting on that seat (a
`stage.waiting_on_seat` event), and starts as soon as the seat has room: when
one of its tasks ends (done, failed, stopped or cancelled), when its tasks at
once go up, or when its pause ends. Two waiting on one seat start by priority,
then oldest first, one each time it has room. The bridge also looks every
minute at the seats work waits on, for one that freed up without saying so,
such as a paused task's computer given back. Only what a seat turned away
starts this way: a design a person stopped, or one that failed, is left for
the sweep.

The deploy sweep looks for merged work that never received `deployed:testing`.
Every repository has delivery rules: its `.github/openadlc.yml`, else its
stored rules, else the Settings → Repositories choice. For each repository
whose rules deploy to testing, the sweep dispatches `deploy-testing` as the app
(as the automation account where the app cannot act), and only for the newest
merge, the pull request at the tip of the default branch. That merge carries
every one before it, so the older ones are reported and never deployed on
their own: deploying one would put testing back on a revision without the
newer work. Each commit is dispatched once (`deploy_runs`): a run that fails on
GitHub is not dispatched again, and a dispatch GitHub refused or did not answer
is released and tried at the next firing. The sweep also dispatches
any promote whose soak the bridge was holding (a plan with no environment wait
timer), and dispatches again a promote or rollback whose dispatch GitHub refused
or did not answer: a promote only for the repository's newest commit, and a
rollback only while no newer commit has been promoted. One still not dispatched
a quarter of an hour after it was due is a `deploy-dispatch` card. It also reads
how each dispatched rollback's run ended, first, and holds promotes behind one
that has not succeeded (see the rollback above). The `deploy-testing`
workflow remains the deploy. OpenADLC does not read
`OPENADLC_DEPLOY_TESTING`; whether a repository has a testing deploy is the choice
on Settings → Repositories. No testing deploy — and Automatic when no
`deploy-testing` workflow exists — means the sweep moves `adlc:merged` issues
to Done and starts no SRE task. The workflow still skips until that Actions
variable is set.

Things worth watching: the host heartbeat (hostd writes every ten seconds), gates
older than a day, tasks that stopped at their cap, and month-to-date spend.

Attachments — the screenshots, mockups and documents people give with a request
or a message — are rows in the database, on a local install and on Cloud SQL
alike ([ADR 0001](adr/0001-attachments-in-the-database.md)), and grow it. The
limits bound that: **10 MB a file, 20 files and 25 MB a work item** (a request,
its issue and its pull request together). An upload is kept for a day for the
person who sent it, until it is sent with something, and the hourly
`attachments` job (`OPENADLC_JOB_ATTACHMENTS_MINUTES`) removes what nobody
sent. A backup that includes history carries every sent attachment, as base64,
so an archive is about a third larger than the attachments' total size. An admin
removes one with `DELETE /v1/attachments/:id`; nothing removes them by age.

GitHub's webhook deliveries are rows in the `events` table too. The daily
`events` job (`OPENADLC_JOB_EVENTS_MINUTES`) removes processed ones older than
`OPENADLC_EVENT_RETENTION_DAYS`, 30 by default, keeping the newest; 0 keeps
them for good. A delivery for a repository the install does not manage keeps
only its type, delivery id and repository name ([security](security.md)).

## Engine updates

Settings calls this System. The tools it can move are the engine CLIs —
`@anthropic-ai/claude-code`, `@openai/codex` and `@xai-official/grok` — the
GitHub CLI and Node. pnpm, the Debian packages, uv and a repository's own
toolchain stay where they are; OpenADLC itself has a row of its own, first in
the table ([Updating OpenADLC](#updating-openadlc)). The three engine CLIs are
pinned in `infra/local/build-bot-image.sh`, and those pins are what a fresh
install starts from. Node and the GitHub CLI are pinned the same way once an
update has read them (`NODE_VERSION`, `GH_VERSION`); a build that does not
name them keeps the Dockerfile's fresh-install packages. uv, for a repository
built with it, is pinned in `infra/local/Dockerfile.bot` itself, with the
hashes of its wheels, and moves only when that file does.

A tool the image gains in a release, as uv did, reaches a running install with
its next candidate: hostd builds it from the release's own
`infra/local/Dockerfile.bot` (the service image carries it, as a checkout
does), so the next run that builds one — any tool due, on its schedule or with
**Update all now** — carries it. A run with nothing due builds nothing, and
the image in use goes without the new tool until one is. On a machine that
runs a checkout, `infra/local/build-bot-image.sh` builds it at once, with the
script's own pins (below).

What is verified, and how far. The GitHub CLI comes from GitHub's apt
repository, `cli.github.com`, and apt checks its signature against the
repository's key (itself fetched from that host over HTTPS). A named Node is
the nodejs.org tarball, checked against that release's `SHASUMS256.txt` before
it is unpacked; the list comes from the same host, so this catches a broken
or swapped download, not a compromised nodejs.org, and its GPG signature is
not checked. A fresh install's Node, with no version named, is the major from
nodesource's apt repository, `deb.nodesource.com`: apt checks its signature
against nodesource's key, and the build refuses that key unless its fingerprint
is the one `infra/local/Dockerfile.bot` names. uv is its wheel from PyPI, and
pip refuses it unless its sha256 is one of the two that file names (amd64 and
arm64), so what is installed is the file the pin was written against; a
Python uv installs for a repository that pins one the image lacks is
python-build-standalone's, checked against the hash uv carries for it, and
comes from GitHub's release downloads: the image's `/etc/uv/uv.toml` sends uv
there rather than to Astral's mirror, `releases.astral.sh`, which the cloud
host's proxy refuses. The engine CLIs come from npm.
npm's integrity hash proves only that the tarball is the one the registry
served, not that the release is safe: a malicious or compromised release of a
CLI passes it. What guards against that is the minimum release age below, and
the candidate's checks.

**Minimum release age.** An update takes an engine CLI version only once npm
says it has been published for at least the install's minimum release age:
3 days by default, any whole number of days from 0 to 90, set in Settings →
System or with `PATCH /v1/engines/updates` and `{ "minReleaseAgeDays": 7 }`
(audited as `engines.schedule_changed`). 0 takes the newest at once. When the
newest is too young, the run takes the newest stable version that is old
enough, if that is still newer than the one in use; otherwise it ends
`current` and says which newer version is out and when it becomes eligible.
A release a few days old has given the ecosystem time to notice a bad one and
pull it. If npm does not say when a version was published, that CLI stays
where it is rather than taking it unchecked. It applies to the three engine CLIs only:
Node and gh keep the lookups below.

The apt repository lists only its newest gh, so an update reads the newest gh
from that repository's index, and a candidate that is not moving gh copies the
running image's (`GH_FROM`) instead of downloading anything. That copy is a
build stage `FROM` the running image, which only Docker's own builder can see.
On a `docker-container` builder (`docker buildx create`) the script says so
and installs gh from the apt repository instead: a candidate there takes the
newest gh, or fails its version check when that is not the one in use.

After that, under the `docker` driver, OpenADLC keeps the tools current. Each
starts on the schedule the install already had: every Sunday at 18:00 in
`systemTimeZone`, which begins as the bridge process's timezone. Each tool's
row in Settings → System has its own **Update** choice — *Automatically on a
schedule*, with a day and time of its own, or *Only when I press Update* —
its own **Update now**, and its last check and how it ended. **Update all
now** moves every tool at once. A tool can be pinned to the version it is on
(a pin is a version, such as `2.1.282`; anything else is refused). The
schedule may report that a newer version is out, but does not take it. **Update now**
is what moves a pin, to the version that went in, and a pin is never a
downgrade; a tool's own **Update now** moves only that tool and its pin.
Several tools due together go in one candidate. Through the API,
`POST /v1/engines/updates` with `{ "tools": ["grok"] }` updates those tools,
and with no list every tool. A candidate that fails any check is discarded, and the
image in use is untouched.

What a run does, on hostd:

1. Reads the versions in use from the `openadlc.engines` label the script stamps
   on the image (an image built before the label, or before it named Node and
   gh, is asked with each command's `--version`), asks `npm view` for each
   engine's `dist-tags` and publish times, nodejs.org for Node and the GitHub
   CLI's apt repository for `gh`. A tool whose answer cannot be read stays on
   the version in use, its row and a card in Needs you say why, and the others
   go on
   ([An engine CLI, gh or Node does not update](troubleshooting.md#an-engine-cli-gh-or-node-does-not-update));
   the run fails only when no tool could be read.
2. Nothing newer that is old enough: the run is `current`, and that is all.
3. Otherwise builds one `openadlc-bot:candidate` for every tool that is due, with
   the same script, pinned to the newer versions of those tools and to the
   versions in use of the rest, and proves it the way a task will use it: each CLI is found
   on the PATH a session gets (`env -i`) and reports the version it was built
   with, and every distinct engine, account and model the crew is assigned is
   called once — "Reply with exactly: OK" — from the candidate, with the
   credential a task on it would present and the model a task would resolve
   (`newest:opus` is whatever it names that day). A subscription is called
   with its login mounted, as its bots have it. A bot with no credential at
   all is skipped; any other failure — a CLI missing, a refused key, a model
   the new CLI will not call — discards the candidate, and `openadlc-bot:latest`
   is untouched.
4. A candidate that passes becomes `openadlc-bot:latest`; the image it replaces
   becomes `openadlc-bot:previous`. The next task of every bot starts on it,
   since each task starts in a new container; a running task finishes on the
   image it started with, and warm computers on the old image
   (`OPENADLC_WARM_POOL`) are drained.

These are the names for `OPENADLC_BOT_IMAGE=openadlc-bot:latest`, `openadlc up`'s
default. The run names the candidate and the previous image after whatever
`:latest` image hostd's bots run, so a compose project's are
`compose-<project>-bot:candidate` and `compose-<project>-bot:previous`, and its
update and rollback never touch the image another install's bots run.

The bridge checks every five minutes whether this week's slot has passed
without a run, so a laptop asleep at 18:00 runs it when it wakes — once. It
records each outcome in the audit log: `engines.updated` with the versions
before and after, `engines.update_failed` with the reason (and the console's
attention list shows it until a later run succeeds), and `engines.rolled_back`.
A run that found nothing newer is kept only as the last check. The settings
page shows the versions in use, the last result, what it checked and the next
run.

To turn it off, or move the day, time or timezone, use Settings → System. The
switch at the top sets every tool at once only while they all share one
schedule. Once one tool has its own day, time or manual setting, the switch is
not shown and the bridge refuses a shared change, so it cannot overwrite them:
each tool's row is where it is turned off or moved. A
change of timezone is `system.timezone_changed` in the audit log. A change of
schedule counts from the next time the slot comes round. `/settings#engine-updates`
still opens the section. To go back,
press **Roll back to the previous image**: `previous` and `latest` change
places, the next task of every bot starts on the restored image, and the version that was undone is not taken
again until something newer ships. Rolling back again undoes the rollback.

A backup carries each tool's Update choice, day, time and pin, and the
timezone. It leaves out what this machine's updates did: each tool's last
check, the last result, a version a rollback held back, and the slot each
tool last ran for. Restored onto another machine, the schedules start counting
from the restore, as a new install's do.

Only an install that builds its own image is updated this way. Under the
`local` driver the bots run the host's own CLIs, and a bot image pinned to a
registry tag other than `latest` is updated where it is built. Running the
script by hand still builds its pins, which may be older than what the update
installed; the next run brings them forward again.

On the cloud host the update builds on the host itself, from the script the
service image carries, and the build's steps leave through the egress proxy
like a bot's traffic does (`OPENADLC_BOT_EGRESS_PROXY`, passed to the script as
`BUILD_PROXY`); the allowlist carries the package repositories the bot image
installs from: `cli.github.com` for gh, `nodejs.org` for Node and PyPI for
uv. The build takes nothing from GitHub's release downloads.
`release-assets.githubusercontent.com`, where they redirect, is on the list
for a task: the Python uv installs for a repository comes from there. The
registry's `bot_image` only seeds a host that has none:
after that the host's own `latest` is what the update moves, and a restart
does not pull the registry's copy back over it.

## Installing on a cloud

The GCP module stands up the whole install: a host VM with no external address
for hostd and the task containers, Cloud SQL (database `fleet_db`, user `fleet`;
names kept from before the rename) with backups and point-in-time recovery, the bridge and console on Cloud Run, Cloud NAT with the
egress allowlist, and IAP in front of the console.

**In one command:** [`infra/gcp/install.sh`](../infra/gcp/install.sh), from
Cloud Shell or any machine with gcloud, does everything below up to and
including the apply: it checks gcloud's and Terraform's sign-ins — naming the
account Terraform's Application Default Credentials belong to, and asking
before going on with one that is not gcloud's own, rather than a 403 at
`terraform init` after the images are built; an expired sign-in stops the run
with `gcloud auth login` to rerun instead of reading as a missing project —
installs
Terraform 1.6 or later into `~/.local/bin` from releases.hashicorp.com when
there is none (checked against the release's SHA256SUMS; Cloud Shell's own
`terraform` is only a placeholder that prints install instructions, and
`openadlc cloud plan` and `apply` refuse it; set `OPENADLC_TERRAFORM_VERSION`
to choose the version, or Homebrew installs it on a Mac), creates the
project on a billing account if asked (`--billing-account`), turns on the two
APIs Terraform needs before it can turn on the module's own (Cloud Resource
Manager and Service Usage), builds the bot image on Cloud Build
([`cloudbuild-bot.yaml`](../infra/gcp/cloudbuild-bot.yaml)), as a service
account of the install's own that may push to the `openadlc` repository and
read its own source bucket and nothing else, then runs `openadlc cloud
configure`, `plan` and, when you say so, `apply`. It asks before anything that
costs money or cannot be undone, and it is safe to run again. In a new Cloud
Shell session it waits for you to click Authorize on Cloud Shell's prompt
rather than sign you in again. It needs the GitHub CLI, signed in (it signs
you in if not), to find the release's images and check them. `--skip-images`
leaves out the build, `--plan-only` stops before the apply.

**The images are a release's.** The bridge, hostd and the console run the
newest [release](#releases)'s `service` and `console` images, which the
release workflow built and attested on ghcr.io. `configure` lists the
releases with `gh api`, takes the newest one an install may take, reads
each image's digest from the release's `images.json` (checked against its
`SHA256SUMS`; a release from before releases recorded them, v0.1.2 to
v0.1.4, has its tags resolved instead), finds that digest at ghcr.io's own
API (with the anonymous token ghcr.io gives anyone for a public package, so
no registry sign-in and no Docker), and checks it with `gh attestation
verify` before it writes anything, against the bundles GitHub's attestations
API gives for that digest and with no GitHub sign-in: the same signer, source
and runner as a release's archive, and the run that made it the push of the
tag. A release whose images do not check out is passed over for the one
before it, and said. A tag of the release taken that names another digest now
than the release recorded is said too, naming both, and changes nothing
taken. Cloud Run pulls only from Artifact Registry, so the module makes a
remote repository mirroring `https://ghcr.io`,
`<name_prefix>-ghcr` in the install's region, and the services and the host
pull through it, by digest: `ghcr.io/620legal/openadlc/service@sha256:…` is
`<region>-docker.pkg.dev/<project>/<name_prefix>-ghcr/620legal/openadlc/service@sha256:…`.
A tag is never what is deployed. The bot image is the exception: it holds
Claude Code, whose licence lets a person install it for their own use but not
redistribute it, so a release holds none, and every install builds its own,
as a laptop does; the host's weekly engine update rebuilds it there.

`infra/gcp/install.sh --build` instead builds all four images from the
checkout on Cloud Build ([`cloudbuild.yaml`](../infra/gcp/cloudbuild.yaml)),
as it did before releases had images, and runs `openadlc cloud configure
--build`, which names them: for a checkout that is not a release.

The settings' images are what the services and the host are made with. From
then on they run what the last update rolled: the two Cloud Run services
ignore a change to their image after they are made, so an apply never puts
the install back on the release it was made with, and hostd runs the image
`/var/lib/openadlc/hostd-image` names, which an update writes. When that file is
empty, as the host makes it, or does not name this install's release image by
digest (a crash while hostd wrote it, say), it runs the image hostd last
started on and answered from, which the host records itself, and only then
`hostd_image`. An update is self-update from Settings → System
while `self_update` is on (the default), and `openadlc cloud update` by hand
([Upgrading](#upgrading)). For it the module gives the bridge's account
updating the two Cloud Run services (a role of the module's own, which cannot
create or delete one), acting as their two service accounts, and read on the
mirror, each on that resource alone ([security](security.md#what-self-update-on-a-cloud-install-grants)); `"self_update": false`
in the settings and an apply take all three away.

`configure` asks one question: who may open the console to set the install up,
offered as the signed-in gcloud account — Enter confirms. Everything else is
answered before it is asked: the project and region from the script's flags or
gcloud's own configuration, the zone from the region, the images from the
newest release (the bot image from the registry the script just pushed it to,
and all four from there with `--build`), the first admins and operators from that
one IAP user, and the state bucket from the project id. The GitHub organization
and App are deliberately not asked at all: the console's walkthrough collects
the organization and creates the App once the install is up, and the bridge
prefers what the walkthrough stored over any install-time seed. Flags answer
anything you want differently (`openadlc cloud configure --help` lists them).

The console's domain defaults to the install's own address: the module reserves
the load balancer's IP and, when `console_domain` is empty, serves the console
on `<console_ip>.nip.io` — a public wildcard DNS that resolves any
`<ip>.nip.io` name to `<ip>` — so the managed certificate is issued and IAP
works right after the first apply, with no DNS record of yours. nip.io is
resolution only: traffic goes to the install's own address, and TLS is Google's
managed certificate for that name; but it is a third party, and if it is down
the name stops resolving, so give a production install a domain of its own —
`--domain` at install time, or set `console_domain` in
`$OPENADLC_HOME/cloud.tfvars.json` later and `openadlc cloud apply`, then
point an A record for it at `console_ip`. Changing the domain replaces the
managed certificate, which takes a while to issue (minutes to an hour); the
console is unreachable on the new name until it is.

By hand, it is:

Build and push the bot image first, and with `--build` the other three too.
`configure` uses `<region>-docker.pkg.dev/<project>/openadlc/bot:latest` for
the bot, and with `--build`
`<region>-docker.pkg.dev/<project>/openadlc/{bridge,hostd,console,bot}:latest`,
as their names unless the settings already name others, and nothing creates that Artifact Registry repository for you:
the module enables the API only during its apply, and Cloud Run needs the
images before then. Cloud Run and the host run `linux/amd64` only, so build for
it even on an Apple-silicon Mac. The bridge and hostd are one image,
`infra/local/Dockerfile.service`, pushed under both names; every build's
context is the repository's root.

```bash
gcloud services enable artifactregistry.googleapis.com --project <project>
gcloud artifacts repositories create openadlc --repository-format=docker --location=<region> --project <project>
gcloud auth configure-docker <region>-docker.pkg.dev
REGISTRY=<region>-docker.pkg.dev/<project>/openadlc
DOCKER_DEFAULT_PLATFORM=linux/amd64 IMAGE="$REGISTRY/bot:latest" infra/local/build-bot-image.sh
docker push "$REGISTRY/bot:latest"
# only for --build:
docker buildx build --platform linux/amd64 -f infra/local/Dockerfile.service \
  -t "$REGISTRY/bridge:latest" -t "$REGISTRY/hostd:latest" --push .
docker buildx build --platform linux/amd64 -f infra/local/Dockerfile.console -t "$REGISTRY/console:latest" --push .
```

Then:

```bash
gh auth login                # gh lists the releases (not needed with --build)
openadlc cloud configure     # asks who may open the console; the rest defaults, or comes from flags (--project, --region, --domain, --build, …)
openadlc cloud plan          # read it before you apply it
openadlc cloud apply
openadlc cloud output        # the console IP and URL, and the exact webhook URL
```

The account that applies the module needs permission to create a custom role
(`iam.roles.create`, which Owner and Role Administrator have): the host and the
bridge get a role of their own holding only what the secret store calls, not
Secret Manager's admin role, which would also let them change who may read a
secret.

The bridge and the host reach Cloud SQL over TLS checked against the
instance's own certificate authority (`sslmode=verify-ca`), and the instance
refuses a connection that is not encrypted. The module keeps that authority as
the secret `<prefix>-database-ca`; the bridge mounts it and the host's
cloud-init writes it to `/var/lib/openadlc/database-ca/server-ca.pem`, where the
database URL looks for it. If you replace the host's cloud-init
(`host_cloud_init`), writing that file before hostd starts is yours to do, as is
the egress allowlist.

An apply that changes the host's cloud-init, the database URL or its CA resets
the host VM: `apply` compares the `host_rollout` output before and after, and
runs `gcloud compute instances reset` itself, because Container-Optimized OS
applies cloud-init only at boot and a host that was merely restarted would run
the old start script against the new URL. It does that when the apply fails
too, once the output has already changed: Terraform can commit the new URL and
then fail on a later resource, and the host would otherwise keep the old
script and lose the database. Tasks running on the host stop with
it, as on any reboot. If the reset fails, `apply` prints the command under
"Still to do by hand" when the apply itself succeeded, and on its own when
the apply failed. The bridge rolls to a new revision in the same apply.
The first apply that turns the instance's TLS requirement on leaves the bridge
and the host without the database for the short while until both are back on
the new settings; they reconnect by themselves.

**An install made before release images.** The first apply after release
images came in resets the host: it changes the host's cloud-init (hostd's
image is chosen at each start now, from `/var/lib/openadlc/hostd-image`), and the
reset ends the tasks running there, so pause work first (Settings → Pause
work). The same apply makes the mirror and the bridge's grants, and gives the
bridge its `OPENADLC_CLOUD*`, `OPENADLC_RELEASE_*` and `OPENADLC_SELF_UPDATE`
settings, which rolls it to a new revision on the image it already runs. The
install still runs the images it was built with, and its first move onto a
release is by hand, with `openadlc cloud update --release <tag>`
([Upgrading](#upgrading)), which writes the file over IAP and restarts
`openadlc-hostd`. Self-update cannot make that move: it asks hostd to restart
onto the release (`POST /internal/restart-onto-image`), which a hostd from
before this does not have, so the bridge refuses and changes nothing. From
then on self-update takes each next release.

When `host_rollout` cannot be read back after the apply (an apply that ends in
an error writes no outputs, and `terraform output` then prints a warning where
the value would be), `apply` resets nothing and never takes that warning for
the host's name. Nor will a later apply make up for it, because it compares
only its own before and after. So when the host was known before the apply,
`apply` prints its `gcloud compute instances reset` command, in the same place
as a failed reset's, to run by hand if this apply changed the host's
cloud-init or database settings. A failed apply still needs `openadlc cloud
apply` again to finish.

Nothing about your install is written into this repository. The Terraform state
and the answers `configure` collected (`cloud.tfvars.json`, which holds the
webhook secret) live in a bucket in the install's own project. On another
machine, `openadlc cloud pull --bucket <name>` takes the install over from there;
after a change made by hand, `openadlc cloud push` saves it back. Running
`configure` again keeps the install's settings: its one question offers what
the install has, a flag changes exactly the setting it names, and the webhook
secret and everything else carry over.

Bucket names are global, and the default one can be guessed from the project
id, so `configure` and `pull` use a bucket that already exists only when it is
in the install's own project, has public access prevention enforced and
uniform bucket-level access on. They refuse anything else before uploading or
writing anything, and say why: for a bucket in another project, name a
different one; for one that is not private, they print the `gcloud storage
buckets update` command that makes it so. `configure` turns versioning on for
a bucket that lacks it. `pull` checks the bucket against the project its
settings name before it replaces this machine's.

Name where the module's alerts go with `configure --channels`: Cloud Monitoring
notification channels, as `projects/<project>/notificationChannels/<id>`
(`notification_channels`). Without any, an alert notifies nobody: it only
opens an incident in the Cloud Monitoring console. Make a channel under
Monitoring → Alerting → Edit notification channels first. The egress alert
fires on the first minute in which the refusals, the proxy's and the
firewall's together, exceed `egress_denial_rate_threshold` (default 5); see
[security](security.md).

### One install per project

Give each install a new Google Cloud project, and to start again, a new one
again. Two installs cannot share a project, whatever their `name_prefix`: the
secrets an install keeps at runtime are always named `openadlc-<ref>`, and the
host's and the bridge's service accounts read and write every secret in the
project, so each would overwrite the other's GitHub refresh tokens, App private
key and internal secret, and could read them.

Setting up in a project an earlier install was torn down from is not supported
either: Google keeps some names after deletion — a workload identity pool is
soft-deleted for 30 days and keeps its ID, a deleted Cloud SQL instance's name
stays reserved for up to a week — and the module always uses the same names.

`plan` and `apply` check first, before Terraform changes anything. When the
project still holds the pool, the database or its reserved name, the network,
or the secrets an install keeps (`openadlc-*`, `fleet-*` from an install made
before the rename, and `<prefix>-*`), and this install's
own state does not hold them, they stop with what they found:

```text
✗ Project acme-openadlc still holds an earlier OpenADLC install:
  - workload identity pool openadlc-github: deleted; Google keeps it until 2026-10-31
Setting up again in the same project is not supported.
Create a new Google Cloud project and run `openadlc cloud configure` with it.
```

A live install is never refused: what is in its own state is its own. What
`gcloud` cannot answer (not signed in, an API not enabled yet) is listed as not
checked, and the command goes on. A Terraform failure on a name that is taken
says the same thing in words after Terraform's own.

### Who may do what in the console

IAP decides who reaches the console; Settings → Users decides what they may do
there. An **admin** reaches everything. A **user** files requests, answers the
crew's questions and gates, reads the board, threads and Costs, and stops or
tries a task again; they cannot move a card between stages or change any
setting, repository, bot, model account, spending limit, backup or pause. The
bridge enforces this on every route, not only by hiding controls. Someone IAP
lets in who is not in Users sees "Ask an admin to add you", with the admins'
addresses, and nothing else.

**Adding a person takes both layers.** Settings → Users gives them a role;
whether they reach the console at all is IAP's, which admits exactly the
`console_members` the last `openadlc cloud apply` applied. The module's
binding is authoritative, so even a grant added by hand with `gcloud iap web
add-iam-policy-binding` is deleted by the next apply. Someone added in the
console whom IAP does not admit gets Google's own block page, which says
nothing about this install — so the Users page warns about such an address and
names the fix, `openadlc cloud members add them@example.com`, which appends
`user:them@example.com` to `console_members` in
`$OPENADLC_HOME/cloud.tfvars.json`, saves the settings to the state bucket and
runs the apply (`--no-apply` leaves the apply to you). `openadlc cloud
members` lists who is admitted. The warning is judged from the same
`console_members` the binding is made from (`OPENADLC_CONSOLE_MEMBERS` on the
bridge), not from the live policy: reading that would take an IAM role the
bridge does not need, and would bless hand-added grants the next apply
deletes. With a `group:` or `domain:` member the bridge cannot tell who is in
it, so it says nothing rather than warn wrongly. Someone outside the project's
Google Cloud organization can still be refused at sign-in once they are
listed; [People from outside your Google Cloud
organization](#people-from-outside-your-google-cloud-organization) is what
that takes.

A role covers the whole install, whatever the person's permission on GitHub.
A user answers every managed repository's gates, including approving a plan
change (which widens the paths a builder may write) and letting a task go on
past its cost cap. A user also stops, retries and dismisses any task, files
requests and has the crew comment on issues and pull requests in every managed
repository, and reads all of its threads and attachments, private repositories
included. Answering a gate on GitHub takes triage or more on that repository;
the console asks for no such thing. So make someone a user only if you would
trust them with every repository the install manages.

While Users is empty, the first request makes the first admins:

1. every address in `OPENADLC_ADMIN_EMAILS` (the module's `admin_emails`; `user:` in front is allowed), if it names any;
2. otherwise every `user:` in the console's IAP members (`console_members`, passed as `OPENADLC_CONSOLE_MEMBERS`).

Each is audited as `user.bootstrap_admin`, and Settings → Users says how they
became admin. After that only an admin adds, removes or changes anyone, and the
last admin can be neither removed nor demoted.

**Set `admin_emails` before the first deploy.** If neither list names a person
(access granted only to groups or a domain, or at project level outside the
module), a cloud install makes nobody admin: every visitor sees "No admin is
configured" and is told to set `admin_emails`, and each refusal is audited. Setting it
and deploying again makes those admins on the next request. The first visitor
is never made admin on a cloud install: that would hand it to whoever loaded a
page first.

`openadlc cloud configure` derives the first admins from the `user:` console
members — on a fresh install, the one person it asked about — and warns when
that names nobody (console access granted only to a `group:` or `domain:`). To
change them later, edit `admin_emails` in `$OPENADLC_HOME/cloud.tfvars.json`
and run `openadlc cloud apply`, which also saves the settings to the bucket.
The operators admitted to the terminal gateway default the same way, to the
`user:` console members, and are edited there too (`operators`).

A local install (`OPENADLC_IDENTITY_MODE=local`) makes its first visitor the admin
when neither list names anyone. Its identity is a header the bridge believes
only beside the console secret, which only the console's server and the CLI
hold, so a name it does not know is treated as an admin rather than refused:
refusing it would only lock out the CLI, which names itself `$USER`.

On a local install roles are advisory. Every console request carries one
identity, `OPENADLC_IDENTITY` or `console` when that is unset, so anyone who
reaches the console acts as an admin, and Settings → Users says so.
Demoted to a user, that identity could never open Settings again, so the bridge
refuses the change (`409 self-demote`) and says why. Removing it is allowed: a
name the install does not know is an admin. An install that is locked out
already (Settings say they need an admin) gets back in by setting
`OPENADLC_IDENTITY` to an admin's address and running `openadlc up` again.
Behind IAP the bridge allows demoting yourself, since another admin can undo
it, and the last-admin rule still holds.

**A cloud install is always behind IAP.** The module puts IAP in front of the
console and the terminal gateway and runs the bridge with
`OPENADLC_IDENTITY_MODE=iap`, and there is no setting to turn that off. It
used to have one: with IAP off, the load balancer answered anyone on the
internet and the bridge ran in local mode, so anyone, and every task session,
was an admin, `/terminal` included. A bridge started on Cloud Run in local
mode now refuses to start. A `cloud.tfvars.json` that still sets that old
variable gets a Terraform warning about an undeclared variable, and IAP is
turned on at the next apply: make sure `console_members` names you first, or
nobody is let in. IAP has not yet been seen refusing someone who is not in
`console_members` ([unverified](unverified.md#open), U21): once DNS and the
certificate are in place, open the console as an identity not on the list and
check you are refused.

### People from outside your Google Cloud organization

By default IAP signs people in with an OAuth client Google manages, and
Google's IAP documentation says that client admits only identities in the
project's own Google Cloud organization. So someone in `console_members` or
`operators` from outside it, a `@gmail.com` collaborator say, is refused at
sign-in even though the binding names them. Whether a project with no
organization at all refuses everyone this way is not known; neither has been
tried against a real project here ([unverified](unverified.md)).

To admit people from outside the organization, give IAP an OAuth client of your
own:

1. In the Google Cloud console, under Google Auth Platform → Clients, create a
   client of type **Web application**. Add the authorized redirect URI
   `https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect`,
   with the new client's id in place of `<CLIENT_ID>` (save once to get the
   id, then add the URI). If the consent screen is not set up yet, set its
   audience to **External** so outside accounts can use it.
2. Add the client's id and secret to `$OPENADLC_HOME/cloud.tfvars.json`:

   ```json
   "iap_oauth2_client_id": "<id>.apps.googleusercontent.com",
   "iap_oauth2_client_secret": "<secret>"
   ```

3. `openadlc cloud push`, then `openadlc cloud apply`.

Both backends, the console's and the terminal's, then use that client. Set both
values or neither: `plan` refuses one alone. The secret is then kept where
`webhook_secret` is, in `cloud.tfvars.json` and in the state bucket. Clearing
both values and applying puts Google's managed client back.

### Deploying from GitHub Actions

Set `deployer_repository` (`openadlc cloud configure --deployer <owner/name>`,
or added to the settings and saved with `openadlc cloud push`) to the
repository whose workflow should roll out new images, and apply. The module
creates a Workload Identity Federation provider and a service account that can
push images, update the two Cloud Run services and restart hostd over IAP. No
key is created.

The provider admits one workflow file, `deployer_workflow` (default
`.github/workflows/deploy.yml`), run from `deployer_branch` (default `main`), in
the repository whose numeric id is `deployer_repository_id` and whose owner's is
`deployer_repository_owner_id`. Another workflow in the same repository, a run
from another branch, or a repository that took the name after a rename or a
transfer is refused before it reaches IAM. `--deployer` takes GitHub's spelling
of the name and looks the two ids up; for a private repository, which GitHub
does not show without a sign-in, pass `--deployer-id` and `--deployer-owner-id`
(`gh api repos/<owner>/<name> --jq '.id, .owner.id'` prints them), and
`--deployer-workflow` for a workflow other than the default. The module
refuses to plan a `deployer_repository` without its ids.

**Whoever can run that workflow on that branch controls the install.** The
deployer can put any image under the bridge and reach the host as root, and
between them they hold every secret the install keeps; with
`deployer_reads_app_key` it is also handed the full GitHub App private key,
from which it can mint a token with every permission the app has. So:

- protect `deployer_branch`: pull requests and reviews only, no direct pushes,
  no force-pushes;
- keep a person on `.github/` in that repository's `AGENTS.md` (and
  CODEOWNERS), so no bot changes the workflow or adds one;
- never give `id-token: write` to a workflow that runs untrusted code, such as
  one started by `pull_request_target` or `workflow_run` that checks a pull
  request out.

Further hardening is yours to choose: a GitHub environment with a required
reviewer on the deploy job, and narrowing the project-wide `run.developer` and
`compute.osAdminLogin` roles to the two services and the one instance.

The workflow is yours and can live in a private repository;
`openadlc cloud output` gives the two values its auth step needs:

```yaml
# .github/workflows/deploy.yml, or whatever deployer_workflow names
permissions: { contents: read, id-token: write }
steps:
  - uses: google-github-actions/auth@c200f3691d83b41bf9bbd8638997a462592937ed # v2.1.13
    with:
      workload_identity_provider: <deployer_workload_identity_provider>
      service_account: <deployer_service_account>
  # then: build infra/local/Dockerfile.service and .console for linux/amd64, push both to
  # <region>-docker.pkg.dev/<project>/openadlc, the service image under both the bridge_image and the
  # hostd_image tag (the host pulls hostd_image as hostd starts, so a tag left behind keeps it on the old
  # release), `gcloud run services update` openadlc-bridge and openadlc-console onto them, and
  # `gcloud compute ssh <host> --tunnel-through-iap -- sudo systemctl restart openadlc-hostd`.
  # Both the bridge and the host migrate as they start: see Upgrading before a release that drops anything.
```

A host whose `/var/lib/openadlc/hostd-image` names a release image, because an
update wrote it, runs that rather than `hostd_image`, and so does one whose
`/var/lib/openadlc/hostd-image.started` does: the host falls back to the image
hostd last started on before `hostd_image`. Such a workflow removes both
(`sudo rm -f /var/lib/openadlc/hostd-image /var/lib/openadlc/hostd-image.started`)
before it restarts hostd, and turns `self_update` off, or the next
self-update moves the install back onto a release.

Moving an existing local install onto the cloud: stop the laptop's services,
`openadlc backup` on the laptop, then restore the archive in the cloud
console's walkthrough (its first step, "Start fresh or restore a backup"),
taking over the sign-ins. GitHub rotates a sign-in each time it is used, so two
installs cannot share the crew's accounts. The host runs Container-Optimized
OS and has no `openadlc` command; should the console be out of reach, the
restore can run inside hostd's container, with the archive copied under
`/var/lib/openadlc` first:

```bash
gcloud compute ssh <host> --tunnel-through-iap -- \
  sudo docker exec -it openadlc-hostd node apps/cli/bin/openadlc.mjs restore /var/lib/openadlc/<archive> --take-over-sign-ins
```

On the cloud the secret store is Secret Manager, not files: the module sets
`OPENADLC_SECRET_STORE=gcp` on the bridge and the host, and each ref is a secret
named `openadlc-<ref>` (labelled `openadlc=secret`). An install made before the
rename has them as `fleet-<ref>` (labelled `fleet=secret`) until a person
renames it ([runbooks/rename-gcp-host.md](runbooks/rename-gcp-host.md)), and
the store reads each under its new name and then its old one, writes it where
it is, and makes a new one only under the new name. A write adds a version and
destroys the ones before it, so a rotated refresh token is not left readable.
The database password is generated by the module and kept in the
`openadlc-database-url` secret; nothing puts it in instance metadata.

Bot containers on the host reach the internet only through the egress proxy
(`OPENADLC_BOT_EGRESS_PROXY`, passed to each container as `HTTPS_PROXY`). They
cannot reach the metadata server's token endpoint, which would hand them the
host's service account and with it every bot's credential, or anything in the
VPC; hostd and the proxy are reachable at `host.docker.internal`. The one
exception is DNS: they may send lookups to the metadata server, whose resolver
answers for any public name, and the proxy does not see them
([security: Egress](security.md#egress)). What they may reach beyond the
module's list is below ([What the host's tasks may reach](#what-the-hosts-tasks-may-reach)).

Three things stay manual, by design:

- **DNS, only for a domain of your own.** The default install is served on
  `<console_ip>.nip.io`, which resolves with no record of yours. Once you set
  `console_domain`, point an A record for it at `console_ip` (`openadlc
  cloud output`): the managed certificate, and with it IAP and the webhook URL,
  waits until the record resolves.
- **Connecting the accounts.** In the console's walkthrough, at its GitHub
  accounts step, connect each bot's account; seats on a shared account join it,
  as in step 4. GitHub requires a person at a browser, and the refresh tokens
  belong in that install's secret store rather than in Terraform state. Not
  `openadlc auth login` from a laptop: the cloud's secret store answers only
  the install's own service accounts.
- **The app's webhook.** An app created from the console already delivers to
  `https://<console_domain>/webhooks/github` with a secret GitHub generated and
  the console stored, and there is nothing to do; pasting `webhook_secret` into
  it would make GitHub sign with a secret the bridge does not check against,
  and every delivery would be refused. After a restore, or for an app made by
  hand, use the console's webhook step, which writes one secret to both sides,
  instead of pasting a value. Only for an app made by hand on a fresh install,
  with nothing stored yet: on the app's settings page set its webhook URL to
  the `webhook_url` the module outputs (`openadlc cloud output`), never to
  `bridge_url`, which GitHub cannot reach, and its secret to `webhook_secret`
  in `~/.openadlc/cloud.tfvars.json`. The console's webhook card shows whether
  a delivery arrived.

Then check the install on the console's health cards and its walkthrough, not
with `openadlc doctor`: the bridge and the console run on Cloud Run, so
nothing answers doctor's probes on the host or on a laptop.

Sizing: the default host is an `e2-standard-8` with 100 GB of SSD, which holds
about four tasks at once with 6 GB builders — `OPENADLC_HOST_CAPACITY_TASKS`,
four by default. Each task is a container with its seat's CPUs and memory, made
when it starts and removed when it ends, so the host is sized for the tasks it
runs at once, not for the crew; an `e2-standard-16` runs six to eight. The disk
holds one mirror per repository, each running task's clone (a full copy of the
mirror's objects, so no task can change the mirror: allow the repository's size
per task at once), each repository's package cache and the task database server. An
install runs one `hostd`: the bridge sends every task to the one at
`OPENADLC_HOSTD_URL`. When sustained CPU passes 60 percent or tasks regularly
wait for room, raise `OPENADLC_HOST_CAPACITY_TASKS` if the machine has room
for more, or move to a larger machine.

Steady-state cost, excluding what the engines charge: the VM is the largest line,
then Cloud SQL, then Cloud Run, logging and NAT. Engine spend is bounded
separately by the caps in Settings → Spending limits (`config/costs.yaml` only
seeds the two global amounts the first time OpenADLC starts).

### What the host's tasks may reach

A task on the cloud host reaches only the names on the egress proxy's lists
([security: Egress](security.md#egress)): the module's own, the operator's
`extra_allowed_domains`, and the one an admin keeps in Settings → Egress. Each
name lets through itself and every name under it.

A repository's testing environment is the usual name to add. Naming it in
`testing.url` puts it on no list, because a repository's own file never widens
what the host's tasks may reach; until a person allows it, every request QA
makes there is refused and every QA run there reports `not run:`. The
`testing-egress` check finds that: every 15 minutes it asks the proxy, through
hostd, what it would do with a task's `CONNECT` to each managed repository's
testing host, and while the proxy refuses one it is a card on the board naming
the repository and the host. Its button opens Settings → Egress with the host
in the field; Allow puts it on the list. For a host the list already lets
through, the proxy has not read the list: the section says so, and Allow saves
the list as it is, which hostd puts on the proxy again. The card clears itself on the next
run, which a save in Settings starts at once. A local install's tasks leave through no proxy, so it has no
Egress section in Settings and the check says nothing there. When hostd cannot
be asked, the section stays, says why, and saves nothing until it can.

There are two ways to allow a name:

- **Settings → Egress**, by an admin, for a name the work needs now and may
  not need later. hostd writes the list to
  `/var/lib/openadlc/egress/extra-domains` and has the proxy read it again, so
  it takes effect at once, with no apply and no restart, and each save is in
  the audit trail with who made it.
- **`extra_allowed_domains`** in `~/.openadlc/cloud.tfvars.json`, by the
  operator, for a name the install always needs, then `openadlc cloud apply`.
  That changes the host's cloud-init, so the apply resets the host and ends
  the tasks running on it.

Allow the testing host itself (`web-1234-uc.a.run.app`), not a domain above
it (`a.run.app`, which would open every Cloud Run service there is). A testing
URL given as an IP address is refused whatever the lists say: serve it on a
host name.

The proxy reads Settings' list once the host runs this release's cloud-init,
which only an apply brings: until then Settings → Egress says so and saves
nothing. The first `openadlc cloud apply` after this release resets the host
once, so pause work (Settings → Pause work) and wait for the running tasks to
finish before you run it.

Rolling hostd back to an image from before this release does not take the
list back. The file stays on the host's disk with the names last saved, the
proxy reads it at every start, and the older console has no Settings → Egress
to change it. Before rolling back, remove the names in Settings → Egress. Once
the older image is running, the only way left is to edit
`/var/lib/openadlc/egress/extra-domains` on the host and restart
`openadlc-egress-proxy`.

## Releases

A release of OpenADLC is made by a person pushing a version tag: `v` and three
numbers, such as `v0.2.0`. Nothing else makes one, and there is none for each
commit of `main`. The tag starts `.github/workflows/release.yml`, which does
nothing but call `.github/workflows/release-build.yml` as `main` has it: a tag
push runs the `release.yml` of the commit it tags, which could be any commit,
so everything that decides is in the reusable workflow, and its signature is
the one an install checks. `release-build.yml`:

1. runs `main`'s `.github/scripts/release-check.mjs`, which refuses the run
   unless it is the push of a version tag from `release.yml`; unless the person
   who pushed it (or re-ran it) is one of `RELEASERS`, which
   `release-build.yml` itself names, so no crew account releases; unless the
   tag is on one of `main`'s first parents; unless the version is above every
   release this workflow made (immutable, and passing the check below), with
   the newest of them among the tagged commit's first parents, so a release
   anybody else created is passed over rather than counted; and unless
   `ci.yml`'s own run for the push of that commit to `main` passed, having run
   the tests itself or having skipped them for a pull request's run into
   `main` that ran them, waiting up to half an hour for one still running. A
   commit a merge brought in is not a first parent; the earlier commits of a
   rebased pull request are, but have no run of `ci` on `main` of their own,
   so they are refused too;
2. builds that commit (`pnpm install --frozen-lockfile`, `pnpm build`) with a
   read-only token and no cache, and packs the built output; and, in a job of
   its own with the same read-only token, builds the two images below from
   the same commit, puts the licences of what each installs inside it, and
   saves them as files;
3. in a job that can write packages and nothing that signs, reads the images
   in, reads the tag again to see it has not moved, refuses a tag that
   already has a release, and pushes them to ghcr.io;
4. attests the archive with GitHub's artifact attestations, signed through
   Sigstore's public instance since the repository is public, and runs the
   check below on it; attests each image the same way, by the digest the push
   reported, and runs the check below on each, with `gh` signed in nowhere
   as an install's is, once it has seen that anyone can pull it; records the
   two digests in `images.json`, which `SHA256SUMS` lists beside the archive;
   reads the tag again, and only then publishes the release, which must come
   out immutable.
   Every job but `check` refuses a re-run by anyone but the person `check` let
   through, and the two that push and sign ask `RELEASERS` again. One release
   runs at a time, whatever the tag.

A tag that is refused publishes nothing, and the run says why. Cutting one is
in [development.md](development.md#cutting-a-release), and what the chain
proves is in [security.md](security.md#releases).

### What a release holds

This is the contract between the workflow and anything that takes a release,
and both follow it as written here. [Self-update](#updating-openadlc) reads
these names and formats from `packages/shared/src/self-update.ts`, whose test
pins each one, and `tests/release-workflow.test.ts` checks that the workflow
and the command under [Checking a release](#checking-a-release) use the same.

| Part | What it is |
|---|---|
| The tag | `vMAJOR.MINOR.PATCH`, three numbers without leading zeros and nothing after them: `v0.2.0`, above every earlier release. A release is never a draft or a prerelease, and is never replaced: it is an immutable release (GitHub's `immutable`), whose files and tag cannot change once it is published |
| `openadlc-<tag>.tar.gz` | The archive (`openadlc-v0.2.0.tar.gz`): a gzip-compressed tar, in pax format, of the built output at the paths it has in the repository: each `packages/<name>/dist/` and `apps/<name>/dist/`, and `apps/console/.next/` without its `cache/`, beside `openadlc-release.json` at the top. Directories and regular files only: no link of any kind, no absolute path, no `..`, nothing else. No `node_modules`: whoever takes it runs `pnpm install --frozen-lockfile` against the same commit, which builds node-pty for their own OS and architecture |
| `openadlc-release.json` | Inside the archive, one line naming what it was built from: `{"format":1,"tag":"v0.2.0","commit":"<40 hex>","tree":"<40 hex>"}`, the tagged commit and its tree |
| `SHA256SUMS` | A line a file in `sha256sum`'s format, the SHA-256 in lower-case hex, two spaces, and the name: the archive's, then `images.json`'s. A release from before releases recorded their images' digests (v0.1.2 to v0.1.4) has the archive's line alone |
| `openadlc-<tag>.tar.gz.sigstore.json` | The archive's build provenance attestation (SLSA provenance v1) as a Sigstore bundle; GitHub keeps the same attestation under the repository's attestations |
| `images.json` | The digest of each image below, as the release pushed, attested and checked it, on one line: `{"format":1,"tag":"v0.2.0","commit":"<40 hex>","images":{"service":"sha256:<64 hex>","console":"sha256:<64 hex>"}}`. What an install takes each image by. Not in a release from before it (v0.1.2 to v0.1.4) |

Beside its files, a release publishes two container images, for an install
that runs images rather than a checkout: [a cloud install](#installing-on-a-cloud)
deploys them. They are not files of the release but packages of the
repository on GitHub's container registry, named
`ghcr.io/<owner>/<repository in lower case>/<image>` and tagged with the
release's version tag and nothing else: no `latest`, nothing that moves. Each
is built for linux/amd64, the one platform Cloud Run and the host run, from
the tagged commit, by the same Dockerfiles an install would use, and its
digest has a build provenance attestation (SLSA provenance v1) from
the same workflow as the archive's, pushed to the registry beside it and kept
under the repository's attestations. Each carries the licences of what it
installs at `/usr/share/doc/openadlc/THIRD_PARTY_NOTICES`, read from the image
as built by `infra/local/third-party-notices.sh`
([Third-party notices](#third-party-notices-for-an-image-you-publish)). An
install takes each image by the digest the release recorded in `images.json`,
checks the attestation of that digest as [below](#checking-a-release), and
deploys the digest, never the tag. The tag names that digest when the release
is made, but anyone who can write the repository's packages can push it
again, and an install that resolved it then would refuse the release on every
try, since the attestation is of the digest it used to name: a tag that names
another digest than the record is reported, on Settings → System's row and by
`openadlc cloud update`, naming both, and the recorded one is still taken
while ghcr.io serves it. A release from before releases recorded their
digests (v0.1.2 to v0.1.4) has no `images.json`, and an install resolves its
tags at the registry, as it always did.

| Image | What it is |
|---|---|
| `ghcr.io/620legal/openadlc/service:<tag>` | The image the bridge and hostd both run, from `infra/local/Dockerfile.service`. Public |
| `ghcr.io/620legal/openadlc/console:<tag>` | The console's image, from `infra/local/Dockerfile.console`. Public |

There is no bot image in a release. The image each bot's container runs
holds Claude Code, whose licence lets you install it for your own use, not
redistribute it ([Third-party notices](#third-party-notices-for-an-image-you-publish)),
so a release cannot publish one: every install builds its own with
`infra/local/build-bot-image.sh`, as in [Building the bot image](#building-the-bot-image),
and its weekly [engine update](#engine-updates) rebuilds it.

The names are `releaseImageName` and `releaseImageRef` in
`packages/shared/src/self-update.ts`, the record is `RELEASE_IMAGE_DIGESTS`
and `recordedImageDigests`, and the check is `imageAttestationCheckArgs`
beside them; `tests/release-workflow.test.ts` runs the workflow's steps and
checks they push, attest, check and record under those names, in that
format, with that check.

The built output serves any install whatever its path: the console's
`.next/` was seen serving pages from a directory other than the one it was
built in, and what differs from one install to another, such as
`NEXT_PUBLIC_OPENADLC_TERMINAL_URL`, is read when the console starts
([configuration.md](configuration.md#console)).

### Checking a release

The attestation is the proof; the checksum only catches a download that went
wrong. In a clone that has the tag:

```bash
tag=v0.2.0
gh release download "$tag" --repo 620legal/OpenADLC --dir "release-$tag"
cd "release-$tag"
sha256sum -c SHA256SUMS                  # macOS: shasum -a 256 -c SHA256SUMS
commit=$(git rev-parse "$tag^{commit}")
gh attestation verify "openadlc-$tag.tar.gz" \
  --bundle "openadlc-$tag.tar.gz.sigstore.json" \
  --repo 620legal/OpenADLC \
  --cert-identity "https://github.com/620legal/OpenADLC/.github/workflows/release-build.yml@refs/heads/main" \
  --source-ref "refs/tags/$tag" \
  --source-digest "$commit" \
  --deny-self-hosted-runners \
  --predicate-type https://slsa.dev/provenance/v1
```

It passes only for an archive whose exact bytes `release-build.yml`, as `main`
had it, signed on a GitHub-hosted runner, in a run for the push of that tag
onto that commit. `--cert-identity` is the signer: a reusable workflow's
certificate names the reusable workflow and the ref it was called at (Fulcio's
`job_workflow_ref`), not the `release.yml` that called it, so an attestation a
tagged commit's own workflow made, whatever it calls itself, fails here.
`--source-ref` and `--source-digest` are the tag and the commit the run was
for, and `--deny-self-hosted-runners` refuses a run on a machine someone else
keeps. The workflow's own commit is not checked: it is `main`'s at the time of
the release, which moves. With `--bundle` the check needs no GitHub sign-in:
`gh` reads Sigstore's root of trust, not the GitHub API. It needs a GitHub CLI
whose `gh attestation verify --help` lists `--source-digest` and
`--cert-identity`. A fork's releases are its own `release-build.yml`'s, once
the fork's `release.yml` calls it rather than this repository's: put the
fork's name in place of `620legal/OpenADLC` in both places.

An image is checked by its digest, against the same signer, source and
runner. In the same directory, which `sha256sum -c` has checked
`images.json` in, read each image's digest from it, fetch that digest's
attestation bundles from GitHub, check the digest against them, and deploy
the digest you checked:

```bash
tag=v0.2.0
commit=$(git rev-parse "$tag^{commit}")
for image in service console; do
  digest=$(jq -r --arg image "$image" '.images[$image]' images.json)
  curl -fsS "https://api.github.com/repos/620legal/OpenADLC/attestations/sha256%3A${digest#sha256:}" \
    | jq -c '.attestations[].bundle' > "$image.sigstore.jsonl"
  gh attestation verify "oci://ghcr.io/620legal/openadlc/$image@$digest" \
    --bundle "$image.sigstore.jsonl" \
    --repo 620legal/OpenADLC \
    --cert-identity "https://github.com/620legal/OpenADLC/.github/workflows/release-build.yml@refs/heads/main" \
    --source-ref "refs/tags/$tag" \
    --source-digest "$commit" \
    --deny-self-hosted-runners \
    --predicate-type https://slsa.dev/provenance/v1
done
```

It passes only for the image at that digest which `release-build.yml`, as
`main` had it, pushed and signed in the run for that tag's push onto that
commit. A release from before releases recorded their digests (v0.1.2 to
v0.1.4) has no `images.json`: resolve its tag instead, `digest=$(docker
buildx imagetools inspect "ghcr.io/620legal/openadlc/$image:$tag" --format
'{{json .Manifest}}' | jq -r .digest)`. Don't for a later one: its tag
names the recorded digest only until someone pushes it again. Nothing in it
signs in: both images are public, GitHub's
attestations API answers a public repository's without a token, and with
`--bundle` `gh` reads Sigstore's root of trust rather than the GitHub API, as
for the archive. The API gives every attestation the digest has, one bundle
a line in the file, and `gh` checks the one `--predicate-type` names. The
same attestations are in the registry beside each image, where the release
also pushed them. An install runs the same command with `--format json`, and
also reads back that the run behind every attestation was the push of the
tag (`buildTrigger` is `push`) started by `release.yml` at it
(`buildConfigURI` is `https://github.com/620legal/OpenADLC/.github/workflows/release.yml@refs/tags/<tag>`),
which `publish` checks too before the release exists, with `gh` signed in
nowhere, as an install's is. GitHub allows 60 requests an hour without a token
to an address, and both runners and Cloud Run share theirs, so a throttle
there would stop a release after its images were pushed, or a cloud install's
self-update at its check. So `publish` sends its job's token with the one
request for the bundles, and the bridge sends the token it reads GitHub with
(the automation account's); `gh` itself is given none in either. `openadlc
cloud configure` and `cloud update` ask from the operator's own address,
without one.

### How long releases are kept

Every release is kept. Each is about 6 MB, most of it the console's `.next/`,
and GitHub does not count release files against a repository's storage or
bill for them, nor limit their downloads. The archive also passes from the
build to the job that publishes it as a workflow artifact, kept for one day,
which counts toward the repository's Actions storage for that day, and so do
the two images, which pass from `images` to `publish` as files the same way.
Each image is kept as a version of its package, one a release, and GitHub
does not charge for a public package's storage or downloads. A release cannot
be changed once it is
published; one that should not be taken is followed by a higher version,
which every install takes over it.

Anyone who can push to the repository can push a tag, and a tag push runs
whatever `release.yml` the tagged commit has. What a person relies on is that
only `release-build.yml` as `main` has it can sign a release installs accept,
and that it refuses a tag on anything but a releaser's push onto a
first-parent, ci-green commit of `main`. The tag ruleset and immutable
releases in [development.md](development.md#once-per-repository) narrow who can
push or move a `v*` tag at all; `openadlc github apply` sets neither.

## Updating OpenADLC

Settings → System has a row for OpenADLC itself, first, above the tools it
runs: the commit in use (and its release, when it is one), the release an
update would take or why there is none, the run in flight or how the last one
ended, and the next run. It has the same choice as an engine's row,
*Automatically on a schedule* (every Sunday at 18:00 in `systemTimeZone`
unless moved) or *Only when I press Update*, and **Update now**. An install
from before this has the same weekly default; its first look claims this
week's slot without running, so its first update is the next Sunday at 18:00.
Only an admin can press Update now, Check again or change the schedule (`GET`,
`POST` and `PATCH /v1/self-update`, and `POST /v1/self-update/check`).

**A tag is a deploy.** On the schedule, the default, every release a code
owner tags is taken by every install that updates itself at its next run,
within the week, with nobody there pressing anything; the row says so. Set it
to *Only when I press Update* to choose when.

What follows is an install that runs from a git checkout. A Google Cloud
install updates from the same releases, by rolling their images instead:
[Updating a cloud install](#updating-a-cloud-install).

It takes only [releases](#releases): the newest version of the checkout's
`origin` (as GitHub spells its name, which the certificate carries, whatever
case the remote has) that has all three files and that GitHub holds
immutable, never a
commit of `main` without one. It updates only an install that runs from a git
checkout on `main`, with no changes of its own, still at the commit the
services started on, able to fast-forward to the release, and that no other
running install runs from too: `openadlc up` notes each install's home in the
checkout's `.openadlc/installs/` (ignored by git), and an update refuses while
another one's services are running from it, since it would change the files
under them. Running means a pid file naming that service's keeper, by its
command line, so one a reboot left behind does not count; the refusal names
how to stop the other (`OPENADLC_HOME=<its home> openadlc down`) or drop a
note it left. Give each install its own clone; a scratch install of a
developer's checkout is one such second install. Anything else and it does
nothing, and the row says why: it never stashes, merges over, resets or
discards what a person changed. A checkout ahead of the newest release is current.
What an update would take is asked again whenever the commit in use changes, not
only every quarter hour, so the row after an update names the next release after
the new one. The row says when it last looked, in `systemTimeZone` ("on
v0.1.16, the newest release (looked Oct 26, 21:02)"), since a release published
since is not seen until the next look. **Check again** looks at once, at most
once a minute; a second press within the minute is refused with the seconds
left, and two presses together ask GitHub once. A run's own look at the
releases, from Update now or the schedule, becomes what the row says an update
would take when it chose a release or found none newer, so the row agrees with
the run once it ends, whether it passed or failed; a run that could not read
the releases leaves the last look as it was. While a run goes, the row says
"taking <tag>", the release that run is taking. It needs a GitHub
CLI where the bridge runs whose `gh attestation verify` has the flags
[Checking a release](#checking-a-release) uses; without one the row says so.

A run has three phases.

1. **Prepare, at once, while tasks run.** It fetches `main` and the release's
   tag into the checkout, which writes only refs (a tag the checkout already
   has on another commit is refused, not moved), and checks that the tag's
   commit is one of `main`'s first parents. It downloads the three files into
   `$OPENADLC_HOME/self-update/<tag>/download/`, checks the archive against
   `SHA256SUMS`, then its attestation with the command in
   [Checking a release](#checking-a-release), with `--format json` added so it
   can also check, from the certificate, that the run was the push of that tag
   by `release.yml` at it. A release that fails any of this is passed over for
   the next older one (up to five, each in the audit log as
   `openadlc.release_refused`), so one bad release, or one made by hand, does
   not stall every update after it. Only then does it open the
   archive, reading every entry against [the contract](#what-a-release-holds):
   a link, an absolute path, `..` or anything that is not built output
   refuses the whole archive, and its manifest must name the tag's commit and
   that commit's tree. Then it adds a detached worktree of the commit at
   `$OPENADLC_HOME/self-update/<tag>/tree`, unpacks the output into it, runs
   `pnpm install --frozen-lockfile` there, which builds node-pty for this
   machine, with an environment of its own and none of the services' (no
   database URL, no secret), and checks that the release's CLI starts. A failure at any step
   removes the worktree and the downloads and records the step and why;
   nothing the services run from was touched.
2. **Wait for the tasks.** No new work starts: leases, requests and intake
   wait behind the same hold a restore takes, and a review, a fix round or any
   other start is refused as busy, as when its seat is full, and comes back
   the way busy work does, after the restart. A paused task
   stays paused and does not hold the restart, since a question can stay open
   for days; one answered meanwhile goes on after it. Once two looks thirty
   seconds apart find no task queued or running and no engine update (hostd
   not answering counts as one), it restarts. No engine update starts
   meanwhile. System names the tasks it is waiting for. There is no cancel: to
   end the wait sooner, stop a task.
3. **Restart.** A detached `openadlc self-update apply`, run from the
   release's own CLI in the worktree, stops the services and checks that each
   one's keeper has gone, fast-forwards the checkout to the release's commit,
   writes the release's built output (each `dist/` and `apps/console/.next/`)
   over the checkout's, file by file and in place, flushed, keeping each file
   it writes over and moving aside each the release no longer has, runs `pnpm install --frozen-lockfile --offline` from the store the
   worktree just filled, applies the migrations, and runs the checkout's
   `openadlc up`, the release's now, which leaves out its console sign-in link
   since its output goes to a log. It writes to `run/self-update.log` and
   leaves `run/self-update-result.json`, which the bridge that comes up
   records.

   In place, because a paused task's computer goes on: it bind-mounts the
   skill runner's bundle, one file of `apps/hostd/dist`, and a file moved
   aside and replaced would leave that computer running the old runner under
   the new hostd. Written over, the same file has the new runner when the task
   resumes. The `gh` and `git` it mounts from `apps/hostd/bin` change in place
   with the fast-forward.

   Before it stops anything it writes `run/self-update-applying.json`, and
   `.openadlc/applying.json` in the checkout for any other install that runs
   from it, and removes both once the checkout is one release again. If the restart dies
   partway, `openadlc up` refuses while that file is there and says how to
   finish or go back
   ([troubleshooting](troubleshooting.md#openadlc-does-not-update-itself)).
   A resume under way counts as a running task in the wait, since its row
   stays paused until hostd has the task's computer ready. Work only an event
   starts (a fix round after changes requested, the check after a deploy, a
   revert, the SRE on a failed deploy) that comes during the wait is recorded
   with the restart's words, and the merge sweep starts it once the restart is
   done and its spending cap allows it, as it starts work a cap held. Work a
   cap holds, or that its seat cannot do yet, is recorded in those words
   instead, and work on a card a person held is not started, as at any other
   time.

If a service will not stop, nothing is changed and the services are started
again. If the fast-forward, the swap or the install fails, the restart puts
back what was there (`git reset --keep` to the commit it started from, each
file it wrote over written back, each it added removed, each it moved aside
moved back, `pnpm install` against the old lockfile) and starts the services again: the install is as it
was, after a few minutes down. Once migrations may
have run it does not go back, since they are forward-only: a failed migration
or start leaves the checkout on the release, and says so
([troubleshooting](troubleshooting.md#openadlc-does-not-update-itself)).

The checkout stays the install, as after a `git pull` by hand: the `openadlc`
on your PATH, `config/`, and the skills, roles and `gh` each task's computer
mounts from it move together. Each run is in the audit log, as
`openadlc.updated`, `openadlc.update_failed` with its step, or
`openadlc.update_checked` for one that found nothing to take or could not run,
with who or what started it, the commit it started from and the one the
install ended on. A failure is a card in Needs you, under System, until a
later run updates or finds the install current. A backup carries the
Schedule or Manual choice, the day and the time, and leaves out the slot, the
run in flight, the last result and the last look at the releases. Why it works
this way is [ADR 0007](adr/0007-self-update-follows-verified-releases.md).

### Updating a cloud install

A Google Cloud install ([Installing on a cloud](#installing-on-a-cloud)) runs
no checkout. Its bridge and console are Cloud Run services and hostd runs on
the host, each from a release's image by digest, pulled through the install's
mirror of ghcr.io. The cloud module tells the bridge so (`OPENADLC_CLOUD=gcp`,
with the project, the region, the two services' names, the mirror and
`OPENADLC_RELEASE_REPO`), and the same row in Settings → System updates it:
the release in use, the release a run would take or why there is none, the
schedule, Update now, the run in flight and the last result. A run is the one
above up to the restart (the releases, the schedule, the wait for the tasks
with new work held, the audit entries, the card in Needs you), except here:

- **What is in use.** The release whose `service` image is the digest the
  bridge's own Cloud Run revision runs, found by the digest each release
  recorded in `images.json`, or by resolving its tag at ghcr.io for a release
  from before releases recorded them, and then checked: that digest's
  attestation must pass the check below for that tag, or the release in use
  is not known. A bridge on any
  other image, one built from a checkout with `--build` or one deployed by
  tag, runs no release: the row says so, and it is moved onto one by hand with
  `openadlc cloud update --release <tag>`.
- **The next release, never a skip.** A cloud install takes the first release
  above the one in use, whatever is newer. Its bridge and its host each
  migrate the database as they start ([Upgrading](#upgrading)), so each
  release has to run beside the one before it, and only that one. When the
  newest is further ahead the row says it takes the next release, not the
  newest, and the run after takes the one after. The next is counted over
  every published version tag, so one it cannot take (not immutable, or
  without its files) or whose images do not check out is not passed over, as
  a checkout passes over a bad one: the install stays where it is, and the row
  and the failure say why, until a person rolls it past that release by hand.
- **Checking, in place of preparing.** For `service` and `console`, the
  digest is the one the release recorded: its `SHA256SUMS` and `images.json`
  are downloaded from the release, with no credential, and the record must be
  the file `SHA256SUMS` gives, of that tag and its commit; then ghcr.io must
  serve the digest, asked with an anonymous pull token and checked against the
  manifest's own bytes. A release that lists `images.json` is taken by it or
  not at all, never by its tags. For a release from before releases recorded
  their digests, the tag is resolved to a digest at ghcr.io the same way, as
  it was. The digest's attestations are read from GitHub's
  attestations API (`GET /repos/<repo>/attestations/sha256:<digest>`), with
  the automation account's token on that request alone, since Cloud Run's
  egress shares Google's addresses and GitHub allows 60 requests an hour
  without one to an address (one GitHub refuses is dropped for an anonymous
  ask); written one bundle a line
  to a file under `$OPENADLC_HOME/self-update/<tag>/`, and checked with `gh
  attestation verify oci://ghcr.io/620legal/openadlc/<image>@<digest> --bundle
  <that file>` and the flags of [Checking a release](#checking-a-release),
  with `--format json` read back as for the archive. gh runs with no GitHub
  credential and an empty config of its own; `--bundle-from-oci` would have
  needed a sign-in. Nothing rolls unless both check out,
  and only the digest is ever deployed, as
  `<mirror>/620legal/openadlc/<image>@<digest>`, never the tag. The bridge's
  image carries the GitHub CLI for this (`infra/local/Dockerfile.service`).
- **A tag pushed again.** A tag of the release in use or of the next that
  names another digest at ghcr.io now than the release recorded is said on
  the row, naming both, from the look at the releases every quarter hour and
  from the run's own check, which also writes `openadlc.release_tag_moved` to
  the audit log. It changes nothing taken: the recorded digest is checked and
  rolled, and runs. Someone who can write the repository's packages pushed
  the tag, and is worth finding.
- **The roll, once no task runs.** First it reads what the console, the bridge
  and hostd run, and asks hostd whether a task is running or starting on the
  host (a task paused on a person is not); if one is, or any of it cannot be
  read, it stops with nothing changed. (a) The console's Cloud Run service,
  read as it is and sent back with only its image changed, naming the
  revision template as the one field it sets, and with its etag, so a
  change made meanwhile refuses the update; the run waits until the new
  revision is ready and takes the traffic. A revision that fails is noticed
  from the service's Ready condition, not waited out. (b) hostd, asked to
  restart onto the `service` digest (`POST /internal/restart-onto-image`, with
  the install's secret): it refuses while a task runs, takes only
  `<mirror>/<repository>/service@sha256:…`, writes it to
  `/var/lib/openadlc/hostd-image`, flushed, answers, and exits with code 75; the
  host's `openadlc-hostd` unit pulls and starts the image the file names, or its
  own `hostd_image` when the file is missing or malformed, and tells hostd
  which as `OPENADLC_HOSTD_IMAGE`. The run waits up to half an hour for a
  hostd that started since to report the new image. On a fresh install the
  host runs `hostd_image` by tag, which is what it would go back to. (c) The
  bridge's own service, last. The run is written down first, since this
  bridge is replaced: the bridge that comes up on the release records the
  result and the audit entry, from that record and the image it runs, once
  its own revision serves; the one it replaced holds new work until it goes,
  or records the failure if the new revision never serves. The two services
  ignore later changes to their image, so an `openadlc cloud apply` does not
  put back what a roll deployed.
- **Where it stops.** A failure before (a) changes nothing, and says so. A
  service whose new revision fails is put back on the image it ran, so the
  install is as it was and the next run sends a real update. A failure after
  a step records which parts run the release and which do not, `openadlc cloud
  update --release <tag>` to finish, and the image each rolled part ran
  before, with how to put it back. A bridge that restarts partway through a
  roll waits for the tasks again and goes on from the part it had reached,
  rolling none twice.
- **The bots' image is not a release's.** It holds Claude Code, which a release
  may not redistribute, so the host builds its own and the weekly
  [engine update](#engine-updates) keeps it current, as on any install; the row
  says so.
- **Turning it off.** `self_update = false` in the cloud module sets
  `OPENADLC_SELF_UPDATE=off` and gives the bridge none of the rights a roll
  needs. The row then says self-update is off, and that `openadlc cloud update
  --release <tag>` rolls the install by hand. What the bridge holds while it is
  on is in [security.md](security.md#what-self-update-on-a-cloud-install-grants).

## Upgrading

An install that runs from a git checkout of `main` updates itself from
releases ([Updating OpenADLC](#updating-openadlc)), and so does a cloud
install that runs release images, below. By hand, or on any other install, it
is the steps below.

```bash
git pull && pnpm install && pnpm build
openadlc down && openadlc up
```

Under the `docker` driver, rebuild the bot image too when an upgrade changes
the engine CLIs pinned in `infra/local/build-bot-image.sh` — Grok Build is one:
an image built before it has no `grok`, and a bot that runs Grok reads "the
`grok` command is not on this host" until the image is rebuilt with that script.
Each task starts in a new container, so the next task of every bot runs the
rebuilt image, and warm computers on the old one are drained; nothing has to
be removed by hand.

**The first start with work items** (migration `0146`,
[ADR 0009](adr/0009-work-items.md)) reads each managed repository's whole
history of issues and pull requests from GitHub, as the automation account,
to give each a work item number. It costs about 2 calls per 100 issues and
pull requests, and makes no GitHub write. It saves its place after each page,
so a restart or a rate limit resumes it rather than starting over. The bridge
looks at it every 15 minutes, and its last error, if any, is in the table's
`last_error`. The reconciler, webhooks and dispatcher run as before while it
reads. Nothing is numbered until every repository is read, and the board keeps
today's keys until then. `select numbered_at from work_item_backfill where
repo_id is null` says when it finished. A repository added later is read the
same way, and numbered after what is already numbered.

Migrations are applied by `openadlc up` and are forward-only. Take a database backup
first; the platform database (`openadlc_db` locally, `fleet_db` on Cloud SQL)
holds the leases, ledger and audit trail, and nothing else reconstructs them.
Locally it lives in the Docker volume `openadlc-db-data` (`<install>-db-data`
for an install with an id of its own), which outlives the `openadlc-db`
container; a container made before that volume keeps its data in an anonymous
one, which removing the container orphans. Back it up before removing the
container: `docker exec openadlc-db pg_dump -U openadlc openadlc_db > openadlc_db.sql`.

**Upgrade a cloud install one release at a time.** Its bridge and its host each
apply migrations as they start — the bridge's revision before it serves, the host
on every `openadlc-hostd` restart — so whichever rolls first changes the schema under
the other while it still runs the previous release. A migration that drops
something is safe only when no release still running reads it. The first is
`0019_drop_bot_teams.sql`, which drops `bots.teams`: take it only once a release
that no longer reads or writes that column runs on both the bridge and the host. Skipping straight to it from an older release leaves one side
failing every query that names the column until it is replaced. `openadlc up` on one
machine restarts everything together and needs nothing extra.

**A cloud install made before the rename to OpenADLC** keeps its old names on
the host (`fleet-hostd`, `/var/lib/fleet`, the firewall's tag `fleet-host`)
and in Secret Manager (`fleet-<ref>`, labelled `fleet=secret`), and a card in
Needs you says so (`cloud-names`). Self-update and `openadlc cloud update`
take it onto this release as they are: the secret store reads either name,
hostd finds its files where its unit says, and `cloud update` picks the
host's names on the host. The first `openadlc cloud apply` from this release's
module renames the host and resets it, moving `/var/lib/fleet` to
`/var/lib/openadlc` at the first boot; with `deployer_reads_app_key` it stops
at the deployer's grant until the app key has its new name, with the old
grant in place. Rename it on purpose, with no task running, by
[runbooks/rename-gcp-host.md](runbooks/rename-gcp-host.md): copy the secrets,
apply, check, and delete the old ones. A later release reads only the new
names.

A cloud install that runs release images ([installing on a
cloud](#installing-on-a-cloud)) updates itself from Settings → System's
OpenADLC row while the module's `self_update` is on, which is the default: it
takes the next release, checks its images, and rolls the console, then hostd,
then the bridge. With `"self_update": false` in the settings, and always for
the first move of an install made before releases had images (its hostd has
no way yet to be told to restart onto a release, so self-update refuses and
changes nothing), the same rollout runs from a machine with the install's
settings:

```bash
git pull && pnpm install && pnpm build # this checkout's CLI and module, as the release has them
gh auth login                          # the CLI lists the releases with gh
openadlc cloud apply                   # the first move only: the mirror, and a host that reads the image file
# Settings → Pause work, and wait for the running tasks to end
openadlc cloud update                  # the release after the one the bridge runs
openadlc cloud update --release v0.3.0 # or a release by name: the same one again, never an older one
# Settings → Resume work
```

It reads which release the install runs from the bridge's serving revision,
whose image is a release's `service` image by digest, the one the release
recorded or, from before releases recorded them, its tag's, and takes the
next one,
counted over every published version tag as self-update counts it, never a
later one: when the next one cannot be taken (not immutable, or without its
files) or its images do not check out it stops with nothing rolled rather
than skip it, since the skipped release's migrations would run under code
that never had them. An install whose bridge runs images
built with `--build` names its first release with `--release`: the one after
the commit it was built from. It checks the release's `service` and `console`
images as `configure` does, by the digests the release recorded, says any tag
of it that names another digest now, with both, asks, then:

1. updates the console's Cloud Run service onto the console image
   (`gcloud run services update <prefix>-console --image <digest>`);
2. on the host, over IAP (`gcloud compute ssh <host> --tunnel-through-iap`,
   which needs OS Login's admin role, as Owner has), pulls the service image,
   so a pull that fails changes nothing, then writes
   `/var/lib/openadlc/hostd-image` and restarts `openadlc-hostd`, whose unit
   migrates and starts hostd on it, and checks hostd answered on it;
   restarting hostd ends the tasks running there, so pause work first
   (Settings → Pause work);
3. updates the bridge's service onto the service image, last.

Before the first of them it checks the mirror is there and the host's
cloud-init knows the file, and stops with nothing rolled when either is
missing: `openadlc cloud apply` makes both. It also reads what the console's
serving revision runs and the image hostd last started on, and leaves a part
already on the release as it is, so hostd is restarted, and its tasks ended,
only when it is not on it yet. What it rolled it writes back into the
settings (`console_image`, `hostd_image`, `bridge_image`) and saves them to
the bucket, so a service made again, or `configure` run again, starts from
the release in use; the next `openadlc cloud apply` then resets the host once,
since `hostd_image` is in its cloud-init, and it comes back on the same
image.

A roll from Settings → System moves the same three without this machine.
`openadlc cloud plan` and `apply` read the images the install runs into the
settings before Terraform runs, and say so: each service's serving revision,
and, when those show a roll the settings have not seen, the image hostd last
started on over IAP. Only a release image by digest is written. When the host
cannot be read, the note says so and `hostd_image` stays what it was: a host
made again (a new disk has no record of what hostd ran) would then start on
that older release, under a database newer ones have migrated, until
`openadlc cloud update --release <tag>` moves it.

The bot image is left alone: it is no release's, and the host's weekly engine
update rebuilds it. A roll that stops partway says which parts run which
release, prints the commands that are left, and the image each rolled part ran
before with the command that puts it back; running `openadlc cloud update`
again finishes the same release, because the bridge, which it reads the
release from, is rolled last. One release at a time: when several are out, run
it once for each.
