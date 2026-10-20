# Upgrading a renamed install

The project has been renamed twice: Fleet became FleetADLC, and FleetADLC
became OpenADLC when it was published under that name (October 2026). A new
install needs none of this. An install made under an old name upgrades with
the steps below: [From FleetADLC to OpenADLC](#from-fleetadlc-to-openadlc)
for one that typed `fleetadlc`, and [From Fleet to
FleetADLC](#from-fleet-to-fleetadlc) as well for one from before that.

## From FleetADLC to OpenADLC

The rename changed the names a person types and reads: the command, the
packages, the settings, the labels. An install made before it keeps working
after an upgrade, because what is already written somewhere OpenADLC does not
control is still read under its old name — and this time that includes the
two things the last rename made people move by hand: a `FLEETADLC_*` setting
in the environment is read as its `OPENADLC_*` name at every start (with one
line on stderr saying to rename it), and an existing `~/.fleetadlc` is found
on its own. The exceptions are the same two as last time: a Docker Compose
stack is carried over by hand ([A Docker Compose
install](#a-docker-compose-install-1)), and the HTTP headers OpenADLC's parts
send each other are renamed outright, so no part of the old release can talk
to a part of the new one, which is why the steps below stop all work first.

| What | Now | Before | What happens to the old one |
|---|---|---|---|
| The command | `openadlc` | `fleetadlc` | Still works: an alias runs the same CLI and says the new name once on stderr. Scripts can switch when convenient |
| The packages | `@openadlc/*`, `pnpm openadlc` | `@fleetadlc/*`, `pnpm fleetadlc` | `pnpm fleetadlc` stays as an alias; the workspace packages are renamed with the checkout |
| Settings in the environment | `OPENADLC_*`, `NEXT_PUBLIC_OPENADLC_*` | `FLEETADLC_*`, `NEXT_PUBLIC_FLEETADLC_*` | Read: every entry point adopts an old name whose new name is unset, and prints one line saying to rename it. A set `OPENADLC_*` always wins over the old spelling |
| The install's directory | `~/.openadlc` (`OPENADLC_HOME`) | `~/.fleetadlc` (`FLEETADLC_HOME`) | Found on its own: the home is `OPENADLC_HOME`, else `FLEETADLC_HOME`, else `~/.openadlc` when it exists, else `~/.fleetadlc` when it exists. Nothing is moved; to adopt the new path, stop the install and `mv ~/.fleetadlc ~/.openadlc` (optional) |
| Stage labels | `adlc:intake` … `adlc:done` | the same | Unchanged by this rename |
| The ignore, pause and next labels | `openadlc:ignore`, `openadlc:paused`, `openadlc:next` | `fleetadlc:ignore`, `fleetadlc:paused`, `fleetadlc:next` | Read as the same, and label sync renames them in place |
| Markers in comments | `<!-- openadlc:{…} -->`, `openadlc-header`, `-seat`, `-sig` | `fleetadlc:`, `fleetadlc-header`, `-seat`, `-sig` | Read in every comment, so history keeps its meaning and old signatures still verify |
| Rulesets | `openadlc: main`, `openadlc: agent and system branches` | `fleetadlc: main`, … | Found under either name, reported as drifted, and renamed by `openadlc github apply` |
| A repository's rules file | `.github/openadlc.yml` | `.github/fleetadlc.yml` | Read wherever the new path has no file. Only the new path is written or linked to; rename the file in a pull request when convenient |
| The deploy workflows' switch | repository variable `OPENADLC_DEPLOY_TESTING` | `FLEETADLC_DEPLOY_TESTING` | Both are read: the variable is set on the repository, which an upgrade cannot rename |
| The database, its container, the task database server, the bot image | `openadlc_db`, `openadlc-db`, `openadlc-taskdb`, `openadlc-bot` | `fleetadlc_db`, `fleetadlc-db`, `fleetadlc-taskdb`, `fleetadlc-bot` | An existing install keeps its database: `openadlc up` goes on starting its `fleetadlc-db` container when there is no `openadlc-db` and `fleetadlc-db` publishes the install's Postgres port (`docker rename fleetadlc-db openadlc-db` is optional, with the install stopped). hostd goes on using `fleetadlc-taskdb`, under that server's own superuser, since it restarts unless stopped and holds the waiting tasks' databases. Rebuild the bot image under the new name. The database inside the container keeps its name and user; nothing renames a database |
| Task containers and tmux sessions | `openadlc.*` labels, `openadlc__…` sessions | `fleetadlc.*` labels, `fleetadlc__…` sessions | Read: hostd recognises a container by either generation of labels, and at its start removes an idle `fleetadlc__…` shell and logs any such session still running |
| Cloud resources | `name_prefix` default `openadlc` | `fleetadlc` (or `fleet`, pinned) | Nothing is renamed: an existing install's settings pin its own `name_prefix`, and `openadlc cloud configure/plan/apply` keep it. Only an install made from nothing gets the new default |
| Terraform state | `<project>-openadlc-tfstate`, prefix `openadlc` | `<project>-fleetadlc-tfstate`, prefix `fleetadlc` | Kept: the saved backend (`cloud.backend.json`) names them. On a fresh machine, `openadlc cloud pull --bucket <project>-fleetadlc-tfstate --prefix fleetadlc`; `install.sh` looks in the old bucket on its own when the new one has nothing |
| The image registry | Artifact Registry repository `openadlc` | `fleetadlc` | Kept: an existing install's image addresses are pinned in its settings, and only a new install gets the new repository |
| Secret Manager secrets | `fleet-<ref>` | `fleet-<ref>` | Unchanged, on purpose, as in the last rename: an install's credentials live there |
| The cloud host's own names | `fleet-hostd`, `fleet-egress`, `/etc/fleet`, `/var/lib/fleet` | the same | Unchanged, on purpose: they are inside the host, rewritten from cloud-init at boot, and renaming them buys nothing an operator would see |
| Backup files | `.fleetbak`, `FLEETBAK1` header | the same | Unchanged, on purpose: archives made before the rename restore as they always did |
| Unencrypted backup files | `"format": "openadlc-backup-plain"` | `"format": "fleetadlc-backup-plain"` | Both are read (and Fleet's `fleet-backup-plain`), so an old plain backup restores; a new one says the new name |
| HTTP headers between OpenADLC's parts | `x-openadlc-internal-secret`, `-identity`, `-on-behalf-of`, `-task-token`, `-iap-assertion`, `-user` | `x-fleetadlc-internal-secret`, `x-fleetadlc-identity`, `x-fleetadlc-on-behalf-of`, `x-fleetadlc-task-token`, `x-fleetadlc-iap-assertion`, `x-fleetadlc-user`, and Fleet's `x-fleet-internal-secret`, `x-fleet-identity`, `x-fleet-on-behalf-of`, `x-fleet-task-token`, `x-fleet-iap-assertion`, `x-fleet-user` | Gone: a request with an old name is refused (401). A script or monitor that calls `/internal/*` must send `x-openadlc-internal-secret` |

### Steps

Nothing has to be renamed first. On the machine the install runs on, start in
the console: **Settings → Pause work**. Nothing new starts while work is
paused, and what is running finishes. Wait for `status` to show each bot under
Crew as `nothing running`, `idle in a shell`, or `… (waiting on a person)` —
a task that runs across the upgrade keeps the old release's runner, whose
reports the new bridge refuses. Then:

```bash
node apps/cli/bin/fleetadlc.mjs status    # again until no bot under Crew is running a task
node apps/cli/bin/fleetadlc.mjs down      # still the old release's command
git pull                                  # or check out the release
pnpm install && pnpm build
infra/local/build-bot-image.sh            # the bot image under its new name
node apps/cli/bin/openadlc.mjs up
```

`up` finds the install where it was: `~/.fleetadlc`, or wherever
`FLEETADLC_HOME` points, and the `fleetadlc-db` container it was using. Any
`FLEETADLC_*` in your shell profile or a unit keeps working; each start prints
one line naming the ones to rename, and
`sed -i.bak -E 's/(^|[^A-Za-z0-9_])(NEXT_PUBLIC_)?FLEETADLC_/\1\2OPENADLC_/g' ~/.zshrc`
renames a file's worth in one go (check the result: it renames every
`FLEETADLC_` name in the file). Last, in the console: **Settings → Pause
work**, and press **Resume work**.

Then, for each repository the crew works in, as needed:

```bash
openadlc github sync-labels    # fleetadlc:ignore → openadlc:ignore and the rest, in place
openadlc github check          # the rulesets show as drifted: named "fleetadlc: main"
openadlc github apply          # renames them
```

A cloud install pulls its settings and plans as before: the saved backend
still names the `<project>-fleetadlc-tfstate` bucket and the `fleetadlc`
prefix, and the settings pin `name_prefix`, so the first `openadlc cloud
plan` should change images and nothing else — check that it replaces nothing
before applying. Roll the release out with work paused, as the last rename
did, because the bridge and the host refuse each other's old headers until
both run it: press **Settings → Pause work**, wait for running tasks as
above, update the bridge's and the console's Cloud Run services to the new
release's images, `docker pull` the new bot image on the host, and restart
the host's hostd unit — still named `fleet-hostd`, on purpose
(`gcloud compute ssh <host> --tunnel-through-iap -- sudo systemctl restart fleet-hostd`).
Then press **Resume work**. [Deploying from GitHub
Actions](self-hosting.md#deploying-from-github-actions) has the commands.

### A Docker Compose install

As in the last rename, the compose file does not read the old names: the
project is `openadlc`, so its volumes (`openadlc_db`,
`openadlc_webhook-secret`) are new and empty beside the old ones, the default
home is `~/.openadlc-compose`, and the database's user and name are
`openadlc` and `openadlc_db`. Carry the old stack's data over exactly as [the
Fleet section](#a-docker-compose-install) shows, with the names shifted one
rename along: dump from the `fleetadlc_db` volume with user `fleetadlc`,
point the new file at the old home with
`export OPENADLC_COMPOSE_HOME="$HOME/.fleetadlc-compose"`, load the dump with
`psql -U openadlc -d openadlc_db`, and copy the `fleetadlc_webhook-secret`
volume to `openadlc_webhook-secret`. The old hostd's task containers are
removed the same way.

## From Fleet to FleetADLC

FleetADLC was called Fleet, and its pipeline an SDLC. That rename changed the
same kinds of names, and an install made before it still upgrades: what is
already written somewhere the platform does not control is read under its
Fleet name by today's OpenADLC too, as the table below says. Unlike the
FleetADLC names above, though, a `FLEET_*` variable is not read at all, so it
is renamed by hand before the upgrade ([Settings in the
environment](#settings-in-the-environment)), and `~/.fleet` is not found on
its own: set `OPENADLC_HOME=~/.fleet` to keep using it. An install upgrading
from Fleet lands on OpenADLC directly — there is no reason to stop at
FleetADLC — so the steps below name today's commands.

| What | Now | Before | What happens to the old one |
|---|---|---|---|
| The command | `openadlc` | `fleet` | Gone. Use `openadlc`, or `pnpm openadlc` from the checkout |
| Settings in the environment | `OPENADLC_*` | `FLEET_*` | Not read. Rename each one before you upgrade ([Settings in the environment](#settings-in-the-environment)): an install started with only its old names starts as a new one, with the default home and database and no secrets |
| The install's directory | `~/.openadlc` | `~/.fleet` | **Not** read on its own: set `OPENADLC_HOME=~/.fleet` to keep using it |
| Stage labels | `adlc:intake` … `adlc:done` | `sdlc:intake` … `sdlc:done` | Read as the same stage. Each stage move replaces the old label, and label sync renames it in place |
| The ignore label | `openadlc:ignore` | `fleet:ignore` | Read the same way and renamed in place by label sync |
| Markers in comments | `<!-- openadlc:{…} -->`, `openadlc-header`, `-seat`, `-sig` | `fleet:`, `fleet-header`, `fleet-seat`, `fleet-sig` | Read in every comment, so history keeps its meaning and old signatures still verify |
| The request line in an issue | `OpenADLC request: request:<id8>` | `Fleet request: …` | Both are read |
| Rulesets | `openadlc: main`, `openadlc: agent and system branches` | `fleet: main`, … | Found under either name, reported as drifted, and renamed by `openadlc github apply` |
| The database, its container, the bot image | `openadlc_db`, `openadlc-db`, `openadlc-bot` | `fleet_db`, `fleet-db`, `fleet-bot` | An existing install keeps its database: its address is in `install.json`, and `openadlc up` goes on starting its `fleet-db` container when there is no `openadlc-db` and `fleet-db` publishes the install's Postgres port. To adopt the new name, stop the install and run `docker rename fleet-db openadlc-db` (optional). The superuser from before the rename is user `fleet` with the password that release shipped with (the same word). The next `openadlc up` replaces it in place, the same way it replaces a published `openadlc` password, and keeps the new one in `install.json`. `openadlc doctor` inspects `fleet-db` when that is still the container, including where it is published. Rebuild the bot image under the new name. A cloud install's Cloud SQL database is `fleet_db` with user `fleet`, before the renames and since: renaming it would replace the database. `up` does not change a database that is not this install's own container |
| Cloud resources | `name_prefix` default `openadlc` | `fleet` | Settings written before the rename get `name_prefix = "fleet"` pinned the first time `openadlc cloud plan` or `apply` reads them, so nothing is replaced |
| Secret Manager secrets | `fleet-<ref>` | `fleet-<ref>` | Unchanged, on purpose: an install's credentials live there |
| Backup files | `.fleetbak`, with a `FLEETBAK1` header | `.fleetbak`, `FLEETBAK1` | Unchanged, on purpose: archives made before the rename restore as they always did |
| Unencrypted backup files | `"format": "openadlc-backup-plain"` | `"format": "fleet-backup-plain"` | Both are read, so a plain backup made before the rename restores; a new one says the new name |
| HTTP headers between OpenADLC's parts | `x-openadlc-*`, as above | `x-fleet-internal-secret`, `x-fleet-identity`, `x-fleet-on-behalf-of`, `x-fleet-task-token`, `x-fleet-iap-assertion`, `x-fleet-user` | Gone: a request with the old name is refused (401), as above |

### Settings in the environment

Every setting is named as it was, with `OPENADLC_` for `FLEET_`:
`FLEET_HOME` is `OPENADLC_HOME`, `FLEET_BRIDGE_PORT` is `OPENADLC_BRIDGE_PORT`,
`FLEET_JOB_RECONCILE_MINUTES` is `OPENADLC_JOB_RECONCILE_MINUTES`, and the
console's `NEXT_PUBLIC_FLEET_TERMINAL_URL` is `NEXT_PUBLIC_OPENADLC_TERMINAL_URL`.
OpenADLC reads the `FLEETADLC_*` middle generation on its own, but not
`FLEET_*`, so rename those wherever they are set — your shell profile, a
systemd unit or its `EnvironmentFile`, a launchd plist, a script that starts
a service, a Cloud Run service's variables — before you start the new
release. List what a shell still sets with
`env | grep -E '^(NEXT_PUBLIC_)?FLEET_'`, and rename them in a file in one go
(it keeps a copy as `<file>.bak`):

```bash
sed -i.bak -E 's/(^|[^A-Za-z0-9_])(NEXT_PUBLIC_)?FLEET_/\1\2OPENADLC_/g' ~/.zshrc
```

Check the result before you use it: the line renames every `FLEET_` name in
the file, another tool's too. A Cloud Run service's variables are renamed with
`gcloud run services update <service> --update-env-vars OPENADLC_X=… --remove-env-vars FLEET_X`.

### Steps

On the machine the install runs on, start in the console: **Settings → Pause
work**. Nothing new starts while work is paused, and what is running finishes.
Then:

```bash
export OPENADLC_HOME=~/.fleet              # keep the install where it is
node apps/cli/bin/fleet.mjs status         # again until no bot under Crew is running a task
node apps/cli/bin/fleet.mjs down           # still the old release's command
git pull                                   # or check out the release
pnpm install && pnpm build
infra/local/build-bot-image.sh             # the bot image under its new name
node apps/cli/bin/openadlc.mjs up
```

The export lasts for that shell. Make it permanent wherever `openadlc` runs,
in your shell's profile (`echo 'export OPENADLC_HOME=$HOME/.fleet' >> ~/.zshrc`)
or the unit that starts it: every `openadlc` command acts on the directory
`OPENADLC_HOME` names, and on `~/.openadlc` otherwise (or `~/.fleetadlc` when
only that exists), where `down` finds nothing running and `up` starts a new,
empty install on the same ports.

Wait for `status` to show each bot under Crew as `nothing running`, `idle in a
shell`, or `… (waiting on a person)`, or stop the tasks still running from
their panel on the board. A task that runs across the upgrade keeps the old
release's runner and tools, which send the old header names: the new bridge
and hostd refuse what it reports, and it carries on without its usage being
recorded. A task waiting on a person can stay as it is: nothing runs in it
while it waits, and the answer resumes it in a new session, on the new
release. Pausing also lets the reviews, patch rounds and deploys that follow
running work go on, so the wait can take a while.

If the checkout is already the new release, run `status` and `down` as
`node apps/cli/bin/openadlc.mjs status` and `down` instead; the export points
them at the install.

Last, in the console: **Settings → Pause work**, and press **Resume work**.
The pause is kept through `down` and `up`, so nothing starts until you do.

An `export` lasts only for that shell. Put `export OPENADLC_HOME=~/.fleet` in
your shell profile (`~/.zshrc`, `~/.bashrc`) too, or the next shell's
`openadlc` acts on an empty default home instead.

Under the local driver, `down` leaves the tmux sessions running, and the new
hostd looks only for sessions named `openadlc__…`; that is one more reason to
let running tasks finish, or stop them, before `down`. At its start hostd
removes an idle shell named `fleetadlc__…` or `fleet__…` and logs any such
session still running a task, which it cannot see or stop;
`tmux ls | grep -E '^(fleetadlc|fleet)__'` lists what is left, and
`tmux kill-session -t '=<name>'` removes one.

Then, for each repository the crew works in:

```bash
openadlc github sync-labels               # sdlc:* → adlc:*, fleet:ignore → openadlc:ignore, in place, as the app (or the console's repository setup)
openadlc github check                     # the rulesets show as drifted: named "fleet: main"
openadlc github apply                     # renames them
```

Deleting the old labels instead would take them off every issue, and the
board would lose its columns until each issue was labelled again. Renaming
keeps them.

A cloud install pulls its settings and plans as before. The first plan says it
pinned the old name; check that it replaces nothing before applying:

```bash
openadlc cloud pull --bucket <bucket> --prefix fleet
openadlc cloud plan
```

`--prefix fleet` is where the state of an install made before the rename
lives; a FleetADLC install's is under `fleetadlc`, and a new install's under
`openadlc`.

Roll a cloud install's new release out with work paused, because its bridge
and its host refuse each other until both run it. Press **Settings → Pause
work**, and wait for running tasks to finish as above. Then, back to back:
update the bridge's and the console's Cloud Run services to the new release's
images, and restart the host's `fleet-hostd` service, which pulls its new
image as it starts
(`gcloud compute ssh <host> --tunnel-through-iap -- sudo systemctl restart fleet-hostd`).
Before that restart, `docker pull` the new release's bot image on the host as
well: a restart does not pull it once the host has one, and a bot image built
before the rename installs packages with the old header. Then press **Resume
work**. [Deploying from GitHub
Actions](self-hosting.md#deploying-from-github-actions) has the commands for
the services and the restart.

### A Docker Compose install

A stack started from `infra/local/docker-compose.yml` was renamed with the
file, and nothing in the new file reads the old names:

- The project is `openadlc`, not `fleet`, so its volumes, `openadlc_db` and
  `openadlc_webhook-secret`, are new and empty beside the old `fleet_db` and
  `fleet_webhook-secret`.
- The default home is `~/.openadlc-compose`, not `~/.fleet-compose`, and that
  directory is the secret store, with every sign-in in it.
- The database's user and name are `openadlc` and `openadlc_db`, with the
  `POSTGRES_PASSWORD` you set, not `fleet`, `fleet_db` and `fleet`; every
  service's database url names them.
- Compose fills in `${OPENADLC_*}` itself, so a `FLEET_*` in the shell or in
  `.env` is never seen.

Started as it is after a `git pull`, the new file brings up an empty install —
no database, a webhook secret GitHub does not know, so every delivery is
refused, and no sign-ins — while the old stack, if it is still up, holds the
ports. Carry the old stack's data over instead. Pause work and wait for running
tasks as in [Steps](#steps-1), then stop the old stack from the old release's
checkout, **without** `-v`, which would delete its volumes:

```bash
docker compose -f infra/local/docker-compose.yml down
git pull && pnpm install && pnpm build
```

Copy the database out of its old volume, through a throwaway server started on it:

```bash
docker run -d --name fleet-old-db -v fleet_db:/var/lib/postgresql/data pgvector/pgvector:pg16
until docker exec fleet-old-db pg_isready -U fleet -d fleet_db; do sleep 1; done
(umask 077; docker exec fleet-old-db pg_dump -U fleet -d fleet_db --no-owner --no-privileges > fleet_db.sql)
docker rm -f fleet-old-db
```

Point the new file at the old home, which keeps its absolute paths, give the
database a password of its own, and load the copy into the new database:

```bash
export OPENADLC_COMPOSE_HOME="$HOME/.fleet-compose"
(umask 077; openssl rand -hex 32 > "$OPENADLC_COMPOSE_HOME/postgres-password")
export POSTGRES_PASSWORD="$(cat "$OPENADLC_COMPOSE_HOME/postgres-password")"
docker compose -f infra/local/docker-compose.yml up -d db
docker compose -f infra/local/docker-compose.yml exec -T db psql -q -v ON_ERROR_STOP=1 -U openadlc -d openadlc_db < fleet_db.sql
rm fleet_db.sql
docker run --rm -v fleet_webhook-secret:/from -v openadlc_webhook-secret:/to pgvector/pgvector:pg16 cp -a /from/. /to/
docker compose -f infra/local/docker-compose.yml up -d --build
```

The last line runs `setup`, which applies the new release's migrations to the
copy. Rename every other `FLEET_*` you set for compose, in the shell or in
`.env`, to its `OPENADLC_*` name, and put the two exports in your shell
profile as well, or the next `docker compose` starts from an empty home and
asks for a password again.

The old hostd's task containers and networks are named `fleet-bot-…`, and the
new one never touches them, since they belong to another install
(`compose-fleet`). Once the new stack runs, `docker ps -a --filter
name=^fleet-bot-` and `docker network ls --filter name=^fleet-bot-` list them,
and `docker rm -f` and `docker network rm` remove them; what a task pushed is
on GitHub already. Then do the repository steps above. Until you remove the old
`fleet_db` and `fleet_webhook-secret` volumes, the old release can still be
started from its own checkout to go back.

## Other changes an older install meets

### A compose stack from before installs had their own containers

The stack's hostd named its bots `bot-<name>`, the names `openadlc up`'s bots
have, and labelled them with no install, which is how `openadlc up`'s
containers are labelled too, so a `openadlc up` hostd on the same machine would
take them as its own. A hostd takes an unlabelled `bot-<name>` container as its
own only when it carries OpenADLC's marks (a `fleet.login`, `fleetadlc.login`
or `openadlc.login` label, OpenADLC's bot image, or for a `-db` sidecar the
seat's old network), and leaves any other container of that name alone, with a
line in its log saying how to remove it by hand. The compose stack does not
reuse them; remove them. If `openadlc up` has never run on this machine, every
`bot-` container is the stack's:

```bash
docker ps -a --filter name=^bot- --format '{{.Names}}'     # check what is listed first
docker ps -a --filter name=^bot- -q | xargs docker rm -f
```

If it has, remove only the stack's: its bots' work folders were under `/work`,
where `openadlc up`'s are under the install's home. List them with
`docker ps -a --filter name=^bot- -q | xargs docker inspect -f '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' | grep ' /work/'`,
and remove each one named there and its `-db` sidecar with `docker rm -f`.

### Bots named before seats

An install whose bots are still called `atlas`, `sydney` and the rest is
renamed on its next start. `openadlc up` gives each bot the seat its old name
stood for (`atlas` is `builder`, `atlas-2` is `builder-2`), and the bridge then
renames them one at a time: a bot with a connected account to that account's
handle, one without to its seat. Nothing is reconnected, and nothing has to be
moved by hand.

### Walkthrough links from before its steps were renamed

A link still opens the step that does the same thing: `where` is `owner`,
`email` is `github-accounts`, `accounts` is `models`, `assignment` is `crew`
and `finish` is `protect`. One cannot: `?step=crew` once meant creating and
connecting the GitHub accounts, and `crew` is now the step that gives each seat
its account and model. Nothing in an old link tells the two apart, so it opens
**Crew**; the accounts are **GitHub accounts**, two steps before it, ahead of
the model accounts (`?step=github-accounts`).

### The GitHub App

An app made when the platform asked for the organization's Members permission
may drop it: OpenADLC asks nothing of an organization.

`humanReviewPaths` in `config/repos.yaml` is accepted but has no effect. The
paths that need a person come from the `## Human review` section of the
managed repository's own AGENTS.md, on its base branch
([configuration](configuration.md#reposyaml--repositories-to-seed)).

### Model keys stored per bot

An install that still has a per-bot key (`engine-key-<bot>`), stored before
model accounts existed, keeps working for a bot that has no account yet. hostd
injects the right variable for the bot's engine (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` or `XAI_API_KEY`) into the task's session environment only,
and it never sets an empty one. A restore checks a per-bot key in a backup with
its engine's provider, as it checks a model account's key, and leaves out one
the provider refuses: it never replaces this install's key with it, and the
restore's summary says to give that bot a model account.
