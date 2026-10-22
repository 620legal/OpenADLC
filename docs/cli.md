# The openadlc command

`openadlc` is `node apps/cli/bin/openadlc.mjs` in a checkout, or `pnpm openadlc`. It
needs the checkout built (`pnpm build`), and says so when it is not.

Every command acts on the install `OPENADLC_HOME` points at, `~/.openadlc` by
default. A flag's value may follow it after a space or after `=`
(`--out /x` or `--out=/x`). A command refuses a flag it does not read rather
than ignoring it, and exits 2 for that and for an `auth` or `github` subcommand
it does not have. A subcommand takes only its own flags: `github apply --repo`
is refused, since only `sync-labels` reads `--repo`. A single-dash argument is
refused the same way, and so is any argument to a command that takes none
(`up`, `down`, `status`, `console-link`, `doctor`, `seed`, `config`).
`openadlc COMMAND --help` (or `-h`) prints what that command does and runs
nothing; `openadlc help` prints every command, even when `install.json` cannot
be read, and so does `openadlc config`, which prints that file's path.

## Setting up

| Command | What it does |
|---|---|
| `openadlc init [--driver local\|docker] [--database-url URL]` | Writes the driver and the database to `install.json`. With no `--driver` and none in `install.json` yet, it chooses `docker` when Docker answers and the bot image is built, `local` otherwise, and says why. It makes sure there is a webhook secret, which is never printed. The rest of setup happens in the console at `/onboarding` |
| `openadlc auth login --bot NAME` | Connects one bot's GitHub account with the device flow: a code to enter at github.com/login/device. `NAME` is a seat, the bot's current name, or its account's login. The running bridge connects it as the console does, so seats in a group may share one account: a seat joins an account another seat of its group is on. A reviewer can never share the crew account, nor a crew seat the reviewers'. The stack has to be up (`openadlc up`) first; with the bridge down nothing is stored |
| `openadlc auth login --all` | Each bot in turn |
| `openadlc auth status` | Which seats have an account connected |

## Running

| Command | What it does |
|---|---|
| `openadlc up [--no-seed]` | Starts the install: the database (reusing it if it answers), migrations, the seed from `config/` (skipped with `--no-seed`), then hostd, the bridge and the console, each under a keeper that restarts it. It makes the console secret if the install has none and gives it to the console alone, and prints the console as a sign-in link (`http://127.0.0.1:47300/signin?token=…`) that works for an hour. With `OPENADLC_SCRIPTED_ENGINES=1` exported it starts a scripted install, which is for the integration suites and is started through `tests/scratch.sh up`, never by hand: under the default `OPENADLC_HOME` it would be the real install |
| `openadlc down` | Stops the console, the bridge and hostd, in that order, and exits 1 if one would not stop. Each is asked to stop and forced after a grace period: up to 60 seconds for hostd, which stops its running tasks first, 20 for the bridge, 5 for the console. The database and the bots' containers are left running |
| `openadlc console-link` | Prints a fresh sign-in link for the console of the install `OPENADLC_HOME` points at, alone on the line: `OPENADLC_CONSOLE_URL` when set, else the port in `install.json`, else `127.0.0.1:47300`. Each link works for an hour; the browser it signs in stays signed in for thirty days |
| `openadlc status` | What is running, the board's counts, what has been spent against the cap, open gates and leases, and the crew |
| `openadlc doctor` | Checks what breaks an install: Node, git, tmux, Docker, hostd's authentication, the database, the App, each bot's credential, the webhook secret and the last delivery, the health checks, the budget. Exits 1 when something is wrong |
| `openadlc logs [SERVICE]` | Prints the path of a service's log, `bridge` by default |
| `openadlc attach BOT SESSION` | Opens a bot's tmux session in this terminal, through the same one-use token the console's take-over uses |
| `openadlc seed` | Loads `config/` into the database again |
| `openadlc config` | Prints the path of `install.json` |
| `openadlc self-update apply --checkout DIR --staging DIR --tag TAG --from SHA --to SHA` | What Settings → System runs, detached, to restart onto a release it has prepared and checked, once no task runs: stops the services, fast-forwards the checkout, swaps in the built output, installs offline, migrates and starts. It refuses to stop anything unless the checkout is clean, on `main` and at `--from`, and puts back what was if a step before the migration fails. Not for running by hand ([self-hosting](self-hosting.md#updating-openadlc)) |
| `openadlc attribution rotate [--drop-old]` | A new key for signing the crew's posts, made by the running bridge through `POST /v1/attribution/rotate` (an admin's route), which signs with it at once and records the rotation in the audit log by key id. The old key keeps checking posts signed before it for 30 days. After a leak, `--drop-old` stops the old key and every earlier one checking at once; with signatures enforced, crew reviews already posted under them stop counting toward a merge ([security](security.md#secrets)). Take a new backup afterwards: an older one restores the old key. Exits 1 when the bridge does not answer |

`openadlc status`, `doctor`, `attach` and `attribution rotate` ask the bridge's `/v1`, which a local
install serves only beside the console secret; they read it from the secret
store, as they read the internal secret, so they need nothing set.

A service that exits on its own is started again after a second, then two,
doubling to thirty. Five exits in a row within ten seconds of starting and the
keeper gives up and says so in the service's log; `openadlc up` starts it again
once the cause is fixed.

## The repositories on GitHub

| Command | What it does |
|---|---|
| `openadlc github sync-labels [--repo NAME] [--file PATH]` | Creates and updates OpenADLC's labels (`config/labels.json`) on every repository or the one `--repo` names, as the OpenADLC app with a token for each repository, as the console's repository setup does; as the automation account only when this machine holds no app key, which fails on an organization's repository where it has triage. Each repository's heading says which. A repository the app is not installed on fails with what to do, and the rest go on. `--file` writes another label file instead, a path relative to the checkout, such as `config/labels-openadlc.json` for OpenADLC's own component areas. It never deletes one |
| `openadlc github check` | Takes no flags. Reads, and changes nothing: the account, access to each repository, its rules, its templates, the crew. Triage is the automation account's access on purpose: it may apply labels, and creating or renaming labels and applying rules are done as the app (a warning when no app key is held). Exits 1 on anything missing |
| `openadlc github apply [--production auto\|reviewers] [--soak MINUTES] [--reviewer LOGIN]` | Applies the rules, environments and code owners the repository's plan supports, and adds the templates it lacks, as the OpenADLC app when this machine holds its key (else as the automation account, and the heading says which), read from the checkout the command belongs to, whatever folder it is run in. A template it could not write is a warning and exit 1. The console's repository setup does the same with a list of the changes first. For each repository with no recorded production choice and no `.github/openadlc.yml` that sets `production.approval`, it asks how production ships when run at a terminal; otherwise it uses the automatic default and says so. `--production auto [--soak MINUTES]` or `--production reviewers --reviewer LOGIN[,LOGIN]` records the choice for every repository whose file does not set it; `--production reviewers` without `--reviewer` is refused. Production is never written with an empty reviewer list: with nobody to name, it keeps a reviewer GitHub already holds, or is made bare and skipped with what to do |

## Backup and restore

| Command | What it does |
|---|---|
| `openadlc backup [--out PATH] [--unencrypted]` | An encrypted archive of the install: settings and the App's key, repositories, the crew and their sign-ins, model accounts. It asks for a passphrase twice, at a terminal and showing nothing of what is typed (a piped one is refused), or makes one when the first prompt is left empty and prints it once; it warns about one under 12 characters and still uses it; and it refuses a path inside the checkout or one that exists. `--unencrypted` writes the same in plain text, with no passphrase: the App key, signing keys, webhook secret, the package registry token, bot tokens, API keys, Claude subscription tokens, and the subscription and GitHub sign-ins and history when chosen |
| `--without install,repositories,crew,accounts`, `--bots SEAT,…`, `--accounts ID,…` | Only part of it |
| `--history` | Threads, the audit log, costs and requests too |
| `--sign-ins`, `--no-sign-ins` | Whether sign-ins come along, both the crew's GitHub sign-ins and the model accounts' subscription sign-in folders: yes for a whole install, no for part of one |
| `openadlc restore PATH [--dry-run] [--take-over-sign-ins]` | Shows what it would change and asks for `overwrite` before it does. `--dry-run` shows the plan and stops: nothing is written and no sign-in is used. Every sign-in in the archive is checked first, and an expired or refused one is never restored; a working key or sign-in this install lacks is restored. A GitHub or subscription sign-in can only be checked by using it, and using it takes it over from the install it came from, since GitHub rotates them. On a clean install those are taken over without asking; on one already set up, only with `--take-over-sign-ins`, and otherwise they are left as this install has them |

## The cloud

| Command | What it does |
|---|---|
| `openadlc cloud configure` | Asks what a Google Cloud install needs, generates its webhook secret the first time, and saves the answers to `$OPENADLC_HOME/cloud.tfvars.json` and to a bucket in the install's own project (created if it is not there). Run again, it offers the install's settings (this machine's, else the bucket's) as the defaults, and keeps the webhook secret, the name prefix and any setting it does not ask about. A new install's bridge, hostd and console images are the newest release's, by digest through the install's mirror of ghcr.io, once `gh attestation verify` has checked each; the bot image is the install's own (`infra/gcp/install.sh` builds it), since a release holds none. `--build` names the images `infra/gcp/install.sh --build` builds from the checkout instead. An install that has images keeps them: `cloud update` moves it ([installing on a cloud](self-hosting.md#installing-on-a-cloud)) |
| `openadlc cloud pull --bucket B [--prefix P]` | Takes over an existing install's settings on this machine, from its bucket |
| `openadlc cloud push` | Saves this machine's settings back to the bucket |
| `openadlc cloud plan`, `openadlc cloud apply` | `terraform plan` and `apply` in `infra/gcp`, with the state in the install's bucket; `apply` saves the settings there too. Both first stop if the project still holds an earlier install ([one install per project](self-hosting.md#one-install-per-project)), and on an install that has a host first read the release images its services and host run into the settings, saying so, so a self-update from Settings → System is not undone by a service or host made again ([upgrading](self-hosting.md#upgrading)) |
| `openadlc cloud update [--release vX]` | Rolls the install onto the release after the one its bridge runs, counted over every published version tag, never a later one: checks the release's images, the mirror and the host's cloud-init first, then updates the console's Cloud Run service, pulls the service image on the host over IAP, writes hostd's image file and restarts hostd (ending the tasks running there), and updates the bridge's service last, leaving any part already on the release as it is. `--release` names the release, the same one again included, never an older one. Nothing is rolled if a check fails; a roll that stops partway says what runs what and prints the commands that are left, and the image each rolled part ran before with the command that puts it back. What it rolled is written back into the settings and saved to the bucket. Needs `gh` signed in, to list the releases ([upgrading](self-hosting.md#upgrading)) |
| `openadlc cloud output` | `terraform output` |
| `openadlc cloud members` | Lists `console_members`, who IAP admits to the console, from the install's settings (this machine's, else the bucket's) |
| `openadlc cloud members add EMAIL [EMAIL…] [--no-apply]` | Lets someone through IAP: appends `user:EMAIL` to `console_members`, keeps every other setting, saves the settings to the bucket and runs the same apply as `openadlc cloud apply`. An address already listed, in any case and with or without `user:`, is not added twice; then nothing changes, it exits 0 and points to `openadlc cloud apply` in case the earlier change never went out. `--no-apply` saves without applying. A grant added by hand with `gcloud` does not last: the next apply removes it ([who may do what](self-hosting.md#who-may-do-what-in-the-console)) |
| `openadlc cloud validate` | Initialises the module without a backend and validates it |

Every `cloud` command takes `--provider`, the module under `infra/` it works
with. `gcp` is the default and, for now, the only one. Only `pull` takes
`--bucket` and `--prefix`; the others use the bucket `configure` or `pull` saved.
Only `configure` takes `--build`, and only `update` takes `--release`.

## The keeper

`node apps/cli/dist/keep.js NAME --log PATH -- COMMAND…` is what `openadlc up` runs each
service under. It leads the service's process group, so `openadlc down` stops the
whole group; its pid is the one in `run/<service>.pid`, and `down` signals it only
when that pid's command line is this service's keeper. It writes the service's
output to `run/<service>.log`, which past 20 MB becomes `run/<service>.log.1`.
