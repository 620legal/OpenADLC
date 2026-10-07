# Upgrading a pre-release install

Only for installs made from FleetADLC's sources before it was published under
this name (October 2026). A new install needs none of it.

## From Fleet to FleetADLC

FleetADLC was called Fleet, and its pipeline an SDLC. The rename changed the
names a person types and reads: the command, the packages, the settings, the
labels and the words on the board. An install made before it keeps working
after an upgrade, because what is already written somewhere FleetADLC does
not control is still read under its old name. Settings in the environment
are not among those: a `FLEET_*` variable is not read at all, so it is
renamed by hand before the upgrade ([Settings in the
environment](#settings-in-the-environment)). Nor is a Docker Compose stack:
it is carried over by hand ([A Docker Compose
install](#a-docker-compose-install)). The last exception is the HTTP
headers FleetADLC's parts send each other: the old names are gone, so a
script of your own that sends one has to change, and no part of the old
release can talk to a part of the new one. That is why the steps below stop
all work first.

| What | Now | Before | What happens to the old one |
|---|---|---|---|
| The command | `fleetadlc` | `fleet` | Gone. Use `fleetadlc`, or `pnpm fleetadlc` from the checkout |
| Settings in the environment | `FLEETADLC_*` | `FLEET_*` | Not read. Rename each one before you upgrade ([Settings in the environment](#settings-in-the-environment)): an install started with only its old names starts as a new one, with the default home and database and no secrets |
| The install's directory | `~/.fleetadlc` | `~/.fleet` | **Not** read on its own: set `FLEETADLC_HOME=~/.fleet` to keep using it |
| Stage labels | `adlc:intake` … `adlc:done` | `sdlc:intake` … `sdlc:done` | Read as the same stage. Each stage move replaces the old label, and label sync renames it in place |
| The ignore label | `fleetadlc:ignore` | `fleet:ignore` | Read the same way and renamed in place by label sync |
| Markers in comments | `<!-- fleetadlc:{…} -->`, `fleetadlc-header`, `-seat`, `-sig` | `fleet:`, `fleet-header`, `fleet-seat`, `fleet-sig` | Read in every comment, so history keeps its meaning and old signatures still verify |
| The request line in an issue | `FleetADLC request: request:<id8>` | `Fleet request: …` | Both are read |
| Rulesets | `fleetadlc: main`, `fleetadlc: agent and system branches` | `fleet: main`, … | Found under either name, reported as drifted, and renamed by `fleetadlc github apply` |
| The database, its container, the bot image | `fleetadlc_db`, `fleetadlc-db`, `fleetadlc-bot` | `fleet_db`, `fleet-db`, `fleet-bot` | An existing install keeps its database: its address is in `install.json`, and `fleetadlc up` goes on starting its `fleet-db` container when there is no `fleetadlc-db` and `fleet-db` publishes the install's Postgres port. To adopt the new name, stop the install and run `docker rename fleet-db fleetadlc-db` (optional). The superuser from before the rename is user `fleet` with the password that release shipped with (the same word). The next `fleetadlc up` replaces it in place, the same way it replaces a `fleetadlc` password, and keeps the new one in `install.json`. `fleetadlc doctor` inspects `fleet-db` when that is still the container, including where it is published. Rebuild the bot image under the new name. A cloud install's Cloud SQL database is `fleet_db` with user `fleet`, before the rename and since: renaming it would replace the database. `up` does not change a database that is not this install's own container |
| Cloud resources | `name_prefix` default `fleetadlc` | `fleet` | Settings written before the rename get `name_prefix = "fleet"` pinned the first time `fleetadlc cloud plan` or `apply` reads them, so nothing is replaced |
| Secret Manager secrets | `fleet-<ref>` | `fleet-<ref>` | Unchanged, on purpose: an install's credentials live there |
| Backup files | `.fleetbak`, with a `FLEETBAK1` header | `.fleetbak`, `FLEETBAK1` | Unchanged, on purpose: archives made before the rename restore as they always did |
| Unencrypted backup files | `"format": "fleetadlc-backup-plain"` | `"format": "fleet-backup-plain"` | Both are read, so a plain backup made before the rename restores; a new one says the new name |
| HTTP headers between FleetADLC's parts | `x-fleetadlc-internal-secret`, `-identity`, `-on-behalf-of`, `-task-token`, `-iap-assertion`, `-user` | `x-fleet-internal-secret`, `x-fleet-identity`, `x-fleet-on-behalf-of`, `x-fleet-task-token`, `x-fleet-iap-assertion`, `x-fleet-user` | Gone: a request with the old name is refused (401). A script or monitor that calls `/internal/*` must send `x-fleetadlc-internal-secret` |

### Settings in the environment

Every setting is named as it was, with `FLEETADLC_` for `FLEET_`:
`FLEET_HOME` is `FLEETADLC_HOME`, `FLEET_BRIDGE_PORT` is `FLEETADLC_BRIDGE_PORT`,
`FLEET_JOB_RECONCILE_MINUTES` is `FLEETADLC_JOB_RECONCILE_MINUTES`, and the
console's `NEXT_PUBLIC_FLEET_TERMINAL_URL` is `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL`.
FleetADLC reads only the new names, so rename them wherever the old ones are
set — your shell profile, a systemd unit or its `EnvironmentFile`, a launchd
plist, a script that starts a service, a Cloud Run service's variables — before
you start the new release. List what a shell still sets with
`env | grep -E '^(NEXT_PUBLIC_)?FLEET_'`, and rename them in a file in one go
(it keeps a copy as `<file>.bak`):

```bash
sed -i.bak -E 's/(^|[^A-Za-z0-9_])(NEXT_PUBLIC_)?FLEET_/\1\2FLEETADLC_/g' ~/.zshrc
```

Check the result before you use it: the line renames every `FLEET_` name in
the file, another tool's too. A Cloud Run service's variables are renamed with
`gcloud run services update <service> --update-env-vars FLEETADLC_X=… --remove-env-vars FLEET_X`.

### Steps

On the machine the install runs on, start in the console: **Settings → Pause
work**. Nothing new starts while work is paused, and what is running finishes.
Then:

```bash
export FLEETADLC_HOME=~/.fleet             # keep the install where it is
node apps/cli/bin/fleet.mjs status         # again until no bot under Crew is running a task
node apps/cli/bin/fleet.mjs down           # still the old release's command
git pull                                   # or check out the release
pnpm install && pnpm build
infra/local/build-bot-image.sh             # the bot image under its new name
node apps/cli/bin/fleetadlc.mjs up
```

The export lasts for that shell. Make it permanent wherever `fleetadlc` runs,
in your shell's profile (`echo 'export FLEETADLC_HOME=$HOME/.fleet' >> ~/.zshrc`)
or the unit that starts it: every `fleetadlc` command acts on the directory
`FLEETADLC_HOME` names, and on `~/.fleetadlc` otherwise, where `down` finds
nothing running and `up` starts a new, empty install on the same ports.

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
`node apps/cli/bin/fleetadlc.mjs status` and `down` instead; the export points
them at the install.

Last, in the console: **Settings → Pause work**, and press **Resume work**.
The pause is kept through `down` and `up`, so nothing starts until you do.

An `export` lasts only for that shell. Put `export FLEETADLC_HOME=~/.fleet` in
your shell profile (`~/.zshrc`, `~/.bashrc`) too, or the next shell's
`fleetadlc` acts on an empty `~/.fleetadlc` instead.

Under the local driver, `down` leaves the tmux sessions running, and the new
hostd looks only for sessions named `fleetadlc__…`; that is one more reason to
let running tasks finish, or stop them, before `down`. At its start hostd
removes an idle shell named `fleet__…` and logs any such session still running
a task, which it cannot see or stop; `tmux ls | grep '^fleet__'` lists what is
left, and `tmux kill-session -t '=<name>'` removes one.

Then, for each repository the crew works in:

```bash
fleetadlc github sync-labels               # sdlc:* → adlc:*, fleet:ignore → fleetadlc:ignore, in place, as the app (or the console's repository setup)
fleetadlc github check                     # the rulesets show as drifted: named "fleet: main"
fleetadlc github apply                     # renames them
```

Deleting the old labels instead would take them off every issue, and the
board would lose its columns until each issue was labelled again. Renaming
keeps them.

A cloud install pulls its settings and plans as before. The first plan says it
pinned the old name; check that it replaces nothing before applying:

```bash
fleetadlc cloud pull --bucket <bucket> --prefix fleet
fleetadlc cloud plan
```

`--prefix fleet` is where the state of an install made before the rename lives;
a new install's is under `fleetadlc`.

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

- The project is `fleetadlc`, not `fleet`, so its volumes, `fleetadlc_db` and
  `fleetadlc_webhook-secret`, are new and empty beside the old `fleet_db` and
  `fleet_webhook-secret`.
- The default home is `~/.fleetadlc-compose`, not `~/.fleet-compose`, and that
  directory is the secret store, with every sign-in in it.
- The database's user and name are `fleetadlc` and `fleetadlc_db`, with the
  `POSTGRES_PASSWORD` you set, not `fleet`, `fleet_db` and `fleet`; every
  service's database url names them.
- Compose fills in `${FLEETADLC_*}` itself, so a `FLEET_*` in the shell or in
  `.env` is never seen.

Started as it is after a `git pull`, the new file brings up an empty install —
no database, a webhook secret GitHub does not know, so every delivery is
refused, and no sign-ins — while the old stack, if it is still up, holds the
ports. Carry the old stack's data over instead. Pause work and wait for running
tasks as in [Steps](#steps), then stop the old stack from the old release's
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
export FLEETADLC_COMPOSE_HOME="$HOME/.fleet-compose"
(umask 077; openssl rand -hex 32 > "$FLEETADLC_COMPOSE_HOME/postgres-password")
export POSTGRES_PASSWORD="$(cat "$FLEETADLC_COMPOSE_HOME/postgres-password")"
docker compose -f infra/local/docker-compose.yml up -d db
docker compose -f infra/local/docker-compose.yml exec -T db psql -q -v ON_ERROR_STOP=1 -U fleetadlc -d fleetadlc_db < fleet_db.sql
rm fleet_db.sql
docker run --rm -v fleet_webhook-secret:/from -v fleetadlc_webhook-secret:/to pgvector/pgvector:pg16 cp -a /from/. /to/
docker compose -f infra/local/docker-compose.yml up -d --build
```

The last line runs `setup`, which applies the new release's migrations to the
copy. Rename every other `FLEET_*` you set for compose, in the shell or in
`.env`, to its `FLEETADLC_*` name, and put the two exports in your shell
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

The stack's hostd named its bots `bot-<name>`, the names `fleetadlc up`'s bots
have, and labelled them with no install, which is how `fleetadlc up`'s
containers are labelled too, so a `fleetadlc up` hostd on the same machine would
take them as its own. A hostd takes an unlabelled `bot-<name>` container as its
own only when it carries FleetADLC's marks (a `fleet.login` or
`fleetadlc.login` label, FleetADLC's bot image, or for a `-db` sidecar the
seat's old network), and leaves any other container of that name alone, with a
line in its log saying how to remove it by hand. The compose stack does not
reuse them; remove them. If `fleetadlc up` has never run on this machine, every
`bot-` container is the stack's:

```bash
docker ps -a --filter name=^bot- --format '{{.Names}}'     # check what is listed first
docker ps -a --filter name=^bot- -q | xargs docker rm -f
```

If it has, remove only the stack's: its bots' work folders were under `/work`,
where `fleetadlc up`'s are under the install's home. List them with
`docker ps -a --filter name=^bot- -q | xargs docker inspect -f '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' | grep ' /work/'`,
and remove each one named there and its `-db` sidecar with `docker rm -f`.

### Bots named before seats

An install whose bots are still called `atlas`, `sydney` and the rest is
renamed on its next start. `fleetadlc up` gives each bot the seat its old name
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

An app made when FleetADLC asked for the organization's Members permission may
drop it: FleetADLC asks nothing of an organization.

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
