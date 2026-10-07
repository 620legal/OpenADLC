# Configuration

Every setting OpenADLC reads, where it lives, and which one wins. For installing
and operating an install, see [self-hosting.md](self-hosting.md); for the
commands, [cli.md](cli.md).

## Where settings live

| Place | Holds | Written by |
|---|---|---|
| `$FLEETADLC_HOME/install.json` | This machine's install: driver, database, ports, the App's client id, the humans, the webhook secret | `fleetadlc init`, `fleetadlc up` (the database password), or by hand. The console's walkthrough writes the settings table instead |
| The `settings` table | What the console set: organization, client id, automation bot, humans, operator email, public URL, install name, the engine update schedules and time zone, attribution mode, which repositories a person merges for (`bridgeMergeOff`, `ciMergeByPerson`), testing deploys, the CI minutes cap, pauses and holds. The closed list is `SETTING_KEYS` in `packages/db/src/store/settings.ts`. No credential: the webhook secret, the App's private key and its client secret, set through the console, go to the secret store | the console |
| `config/*.yaml` | The crew, the repositories to seed, the caps, the review rules | you, in git |
| Environment variables | Everything else, per service | you, or `fleetadlc up` |
| `$FLEETADLC_HOME/secrets/` | Refresh tokens, signing keys, model keys, the App's private key and client secret, the webhook secret, the internal secret | OpenADLC, never by hand |

What wins:

- **Services get install.json.** `fleetadlc up` starts every service with the
  environment it was run in plus the values from install.json, and
  install.json's win. Exporting `FLEETADLC_BRIDGE_PORT` in a shell does not move a
  bridge whose install.json says otherwise.
- **The console's settings win over the environment** for `organization`,
  `githubClientId`, `automationBot`, `humans` and `publicUrl`, and the secret
  store's webhook secret wins over `FLEETADLC_WEBHOOK_SECRET`
  (`apps/bridge/src/effective-config.ts`). An older install kept the webhook
  secret in the settings table; the bridge moves it into the secret store
  when it starts.
- **`.env` is loaded only by Next.js and Compose.** No OpenADLC service loads
  a dotenv file itself, but the console's Next.js server loads
  `apps/console/.env`, `.env.local` and `.env.production` when it starts (and
  `next build` inlines `NEXT_PUBLIC_*` values from them), and `docker compose`
  reads a `.env` beside the compose file. Keep those files absent, or treat
  them as configuration. The environment variables a service reads are the
  tables on this page.

`FLEETADLC_HOME` itself defaults to `~/.fleetadlc`, and every `fleetadlc` command reads it.
Setting it is how a second install lives on the same machine; see
[development.md](development.md).

## install.json

| Key | Default | What it is |
|---|---|---|
| `driver` | `docker` when Docker answers and the bot image is built, else `local` | `docker` gives each task its own container. `local` runs each task as a tmux session on the host as your user: it can read the secret store (the App's private key, every bot's sign-in, the model keys) and this file (the database password, the webhook secret), and run anything on the machine; use it only with a throwaway App, accounts and repositories. With no `driver` here, `fleetadlc init` chooses by that rule and writes it down, and `fleetadlc up` chooses at each start; a driver written here is never changed for you |
| `organization` | `''` | The GitHub account the repositories belong to, organization or user |
| `githubClientId` | `''` | The OpenADLC GitHub App's client id, for the crew's device-flow sign-in |
| `databaseUrl` | `postgres://fleetadlc:<password>@127.0.0.1:47432/fleetadlc_db` | The platform database. The password is generated for each install by its first `fleetadlc up`, which replaces an older install's `fleetadlc` the same way; this file is the only place it is kept |
| `ports` | console 47300, bridge 47311, hostd 47312, postgres 47432 | Where each service listens |
| `humans` | `[]` | GitHub logins that approve changes to the paths AGENTS.md reserves for a person, answer the crew's questions and gates, approve plan changes, and are the required reviewers for production deploys, in every repository the install manages. The walkthrough's approvers question ("Who approves changes to config/, infra/ and .github/?") writes it. Each login is pinned to its GitHub account id when it is saved or first used (the `humanIds` setting, written only by the bridge), and counts only from that account; a login that names another account later is a card on the board. A required person's approval lands a pull request only when GitHub says their account has write access or more to the repository |
| `repoRoot` | the checkout | Where labels, templates, skills and roles are read from |
| `publicUrl` | `''` | Where GitHub reaches the bridge's webhook; empty means a tunnel is used |
| `allowedHosts` | unset | Names people open OpenADLC under beyond loopback, an address and the configured URLs, handed to every service as `FLEETADLC_ALLOWED_HOSTS` |
| `webhookSecret` | generated by `fleetadlc init` | The secret GitHub signs deliveries with. Without one every delivery is refused |
| `automationBotName` | unset | The seat or name of the account that writes labels and statuses, when it is not the bot whose role is `automation` |

The file is mode 0600 in a 0700 directory. Services never read it; they get its
values through the environment `fleetadlc up` gives them.

## config/

A key these files do not read is refused, not ignored: `fleetadlc up`,
`fleetadlc seed` and the bridge stop, and the error names the file and the
key, for example `config/costs.yaml: monthlyCapUSD is not a setting OpenADLC
reads`. A misspelt key used to fall back to its default with nothing said.
The retired keys below that older files still carry are the exception.

### bots.yaml — the crew

One entry per seat. A seat is a bot until an account connects, and then it is
that account. Seats may share an account — a crew account and a reviewer
account are enough — and a seat on a shared account keeps its seat's name.

The file is what a fresh install seeds, and `fleetadlc up` adds and updates the
seats it names; it never removes one. A builder added from Settings → Crew
(`builder-2`, `POST /v1/crew/seats`) lives only in the database and is kept.
So does each bot's avatar color, chosen in Settings → Appearance
(`PATCH /v1/crew/:bot`): the file names none, and `fleetadlc up` leaves it alone.

| Key | Meaning |
|---|---|
| `slot` | The seat, unique: `intake`, `builder`, `lead-reviewer`, … A second builder is `builder-2` |
| `displayName` | How the console names the seat before an account connects |
| `role` | `intake`, `spec`, `implement`, `review_lead`, `review_second`, `review_security`, `deploy`, `qa` or `automation` |
| `engine` | `claude`, `codex`, `grok` or `none` |
| `model` | A model id, or `newest:<family>` to follow a family |
| `sidecarDb` | Whether each of the seat's tasks gets a database of its own, for `make setup`, on the host's task database server (docker driver) |
| `cpus`, `memoryGb` | What each of the seat's task computers is given (docker driver); default 1 and 2. Stored on the row at every `fleetadlc up` |
| `maxTasks` | How many tasks the seat runs at once, 1 to 16, each in a computer of its own and all as its one account. Left out, the row keeps what it has — 1 for a new seat, or what a person set in Crew → "tasks at once" (`PATCH /v1/crew/:bot/tasks-at-once`, admin only, audited); written here, the file wins at every `fleetadlc up`. Keep a seat on an OpenAI or xAI subscription at 1: its CLI refreshes one sign-in for every task on it |

Read but not used: `skills` (the skill follows the task). There is no `teams`
key any more: a bot's repository role comes from the collaborator invitation
OpenADLC sends it, and no organization or team is needed. A file that still has
one loads, and the key is ignored, as are `githubLogin` and a persona under
`name:` (read as the seat it was). A model chosen in the console survives a
reseed.

### repos.yaml — repositories to seed

Usually empty: repositories are added from the console, which is what the
`POST /v1/onboarding/repository` route does. Each entry has `name`,
`fullName`, `owner` (a seat), and, each optional, `concurrency` (default 1: how many builds may run in it at once, paused ones included; it is also capped by how many tasks its builders can run between them, the sum of their `maxTasks`), `defaultBranch`
(`main`), `stageModes`, and `specRequiredLabels`.

`stageModes` says how much each stage — `intake`, `spec`, `build`, `review`,
`merged`, `done` — may do without asking: `autonomous`, `conditional` (Design
only: a design pass for issues with a spec-required label; refused on any other
stage), or `untouched`
(`intake` and `spec` only: no bot staffs the stage). `untouched` is refused for
`build`, `review`, `merged` and `done`, here and by the API: nothing there reads
it. To stop a repository's bots, use Pause work (Settings → Pause work) instead.
A stored or restored repository with a later stage set to `untouched` reads it
as `autonomous`, which is what it always did. Intake's own choice of Design or
Build is routed by this rule: a spec-required issue goes to Design whatever
intake chose, and under `untouched` every issue goes to Build, never left in a
Design nobody staffs. An older file's `assist` is read as `autonomous`, which
is all it ever did; production waits for a person through the `production`
environment's required reviewers.

A repository's default branch is the branch every task starts from and every
merge lands on. A repository added from the console is stored with the
default branch GitHub reports for it, asked as the app or else the automation
account; when GitHub cannot be asked, a new one is stored as `main` and the
bridge logs that it is unconfirmed. Each reconcile compares every
repository's stored default branch with GitHub's and corrects one that
differs — one added before GitHub was asked, one renamed on GitHub since, or a
`defaultBranch` in `repos.yaml` that is not GitHub's — and says so in its
report. `PATCH /v1/repos/<name>` with `{"defaultBranch": "<branch>"}` sets it
by hand.

`humanReviewPaths` is read and not used: the paths that need a person come from
the `## Human review` section of the target repository's own `AGENTS.md`, on
its base branch.

A setting written here wins at every `fleetadlc up` and `fleetadlc seed`, over
whatever was changed in the console since; a setting left out keeps the
console's value, or the default above for a new repository, as `maxTasks` does
in bots.yaml. Stages in `stageModes` are taken one at a time: a stage the file
does not name keeps its own. The owner is always the file's. Each change the
seed makes to a repository already there is audited as `repo.seeded`, by
`fleetadlc seed`. An entry whose `name` another repository already has, under a
different `fullName`, is refused rather than rewriting that repository: the
seed names both and exits non-zero. An `owner` that names no bot is
an error: the seed names the seat it could not find and exits non-zero, and the
repository gets a `repo-owner` card until it has one, because the dispatcher
leases nothing in a repository no bot owns. `organization` is read and not used,
and may be left out.

### review.yaml — who reviews

```yaml
reviewers:
  - seat: lead-reviewer        # a seat from bots.yaml, or a bot's name
    lens: lead
    lead: true                 # exactly one
  - seat: second-reviewer
    lens: second               # trigger defaults to always
  - seat: security-reviewer
    lens: security
    trigger: { labels: [touches:security], paths: [packages/github/], samplePercent: 10 }
maxRounds: 3                   # review rounds back to build before a person is asked
sendBack: { maxPerEdge: 2, maxPerIssue: 6 }
```

`reviewers` is the list of seats asked to review, each with a `lens` (the word
its review goes by), a `trigger` (`always`, or `labels`, `paths` as prefixes,
and `samplePercent`, any of which asks it), and `lead: true` on exactly one,
which is asked on every pull request whatever its trigger and reviews last.
The others are advisory: they post a comment with their verdict in its marker,
and the lead reads them all and decides. `blocking: true` marks a seat whose
approval a merge needs besides the lead's: its request for changes holds the
merge until it approves a later diff, and the lead cannot set it aside. The
lead's brief marks its reviews `(blocking)`. Only the lead's request starts a
patch round, so if the lead approves a head the blocking seat still asks
changes on, the board shows a **Review stopped** card in Needs you naming the
seat, until a person answers it. A revert (labelled `revert`, on the deploy
skill's `system/revert-*` branch) skips the seats that are there only by
default, `always` or sampled; a seat its own label or path asks for, a
`blocking` seat, and the security seat for a change to how CI runs are still
asked. A dependency change (`deps`) gets the seats its labels ask for. Read by
`Automation.decideReviewers` in `apps/bridge/src/automation.ts`.

One lens is more than a word: the seat with `lens: security` (the first, if
more than one has it) is the security seat. It is asked on every change to how
CI runs, whatever its trigger, and its approval of that head is what lets
OpenADLC merge one (`mergeDecision`). With no seat on that lens, a person
merges every change to how CI runs. Renaming the lens, or moving it to another
seat, changes who approves those merges.

`paths` apply to every repository the install manages: one list, matched as
prefixes against each pull request's changed files, whichever repository it is
in. The shipped file's `packages/github/` and `infra/` are OpenADLC's own
repository's sensitive paths; replace them with your repositories'. A missing
review.yaml means the same rules as the shipped file (`DEFAULT_REVIEW` in
`apps/bridge/src/config.ts`); a malformed one stops the bridge at start.

`maxRounds` counts every fix round run on the pull request, by any bot and
however long ago; a round that never started does not count, and neither does
a conflict resolution (a patch with the `resolve-conflict` skill), since no
review asked for it.

`sendBack` limits how often work goes back to an earlier stage on the edges a
review round does not count: per edge (design to intake, say) and per issue.

A file in the older shape — `lead`, `second`, `security` (`bot`, `labels`,
`paths`, `samplePercent`), `workflows` (`bot`, `paths`) — is still read, as the
list it means (`legacyReviewRules` in `packages/shared/src/config.ts`).

The `needs-human` label means "a person has this": a question is open, or
someone held the work. On an issue, the dispatcher does not lease it. On a
pull request, the merge line does not land it (`mergeDecision`), and
`review-gate` stays pending while the label is on, whatever the reviews say.
**Hold this PR**, on an unsigned post's card, sets it and also turns GitHub's
auto-merge off. Take the label off to let the work go on. Answering a bot's
question takes the label off only when that question put it on and no other
question on the same issue or pull request is still open: a person's hold, or
a label that was on before the question, stays until a person takes it off.

### .github/fleetadlc.yml — how a repository ships

Not in `config/`: each repository keeps its own, on its default branch, so a
change to how it ships is a pull request. Being under `.github/`, it changes how
CI runs, so the bridge merges it only once the security reviewer approves that
diff (`changesCi`, `mergeDecision`). A person merges it where the install
setting `ciMergeByPerson` lists the repository, where no security seat is set
up, or where reviews' signatures cannot be checked; naming `.github/` in the
repository's own `## Human review` section makes a person's approval required
too. The bridge reads it (`apps/bridge/src/delivery-rules.ts`) and
does what it says (`apps/bridge/src/deploy-pipeline.ts`), dispatching each
workflow as the OpenADLC app:

```yaml
version: 1
testing:
  on: merge                    # or none: merging is shipping, straight to Done
  url: https://testing.example.com   # where the QA bot points; no default
  workflow: deploy-testing     # dispatched with the merge commit as `sha`
  smoke: smoke-testing         # green promotes; red reverts and sends back to build
production:
  on: after-testing            # or none: testing is as far as it goes
  approval: auto               # or reviewers: a named person approves each promote
  soakMinutes: 30              # minutes on testing before the promote, under auto
  workflow: promote-production # dispatched with the commit as `candidate`
  rollback: rollback-production  # dispatched when a promote's traffic shift fails
```

Every field but `testing.url`, which has none, has the default shown, so `version: 1` alone is a repository that
deploys to testing on merge and promotes after 30 minutes on testing and a green
smoke, with a failed production deploy rolled back. Where the file (or the
repository's stored rules) leaves out `production.approval` or
`production.soakMinutes`, the repository's own answer fills it before the
default does: repository setup (the walkthrough's Protect step, or `fleetadlc
github apply`) asks each repository how production ships, automatically after
testing or after a named person approves, and records it (`repos.production_*`).
"After a person approves" cannot be saved without at least one GitHub login.
Repositories that were set up before this was asked keep what they had:
`reviewers` with no soak, recorded when the install was upgraded. Where the file
sets `production.approval` itself, setup shows that rule and says the file
governs it.

A bot never approves a deploy; the repository's GitHub rules do: the
promote waits on the `production` environment, which `fleetadlc github apply`
writes as these rules say (required reviewers, or a wait timer of the soak).
Production's reviewers are the repository's named ones, else the install's
`humans`, else the people CODEOWNERS names, never a crew account or the
organization, sent to GitHub by numeric user id. When there is still nobody,
the apply never writes production with an empty reviewer list: it keeps a
reviewer GitHub already holds and writes the branch policy around it, or writes
that policy with no reviewer list and says to choose who approves production.
On a plan that holds no environment rules, the bridge holds the soak itself
before it dispatches. Where the rules say `approval: reviewers` and the
`production` environment is not holding a reviewer — GitHub's plan cannot (a
private repository on Free, Pro or Team), nobody is named, or the environment
could not be read — the bridge holds each promote for a person instead: after a
green smoke it dispatches nothing, and a Needs you card offers **Release to
production**, which dispatches that promote, or **Switch to automatic
delivery**, which records `approval: auto` with a soak of at least 30 minutes
for the repository and turns what is held into soaks. Where the rules come
from this file, the card opens it in GitHub's editor instead: the file wins
over anything the console stores. A red smoke on testing reverts the change and sends it
back to build. A failed production deploy is acted on only when it is a promote
the bridge dispatched, read from the promote run (never the deployment's own
commit), and by where the run stopped: one that never ran (rejected, or not
started) does nothing; a red production smoke sends the change back to build and
leaves production on the release it serves; a failed traffic shift dispatches
`rollback`, once per commit, with an empty target, which means "what served
before the last shift", and files an issue for a person; any other failure, or a
run whose steps cannot be placed (the template's promote is one step), files an
issue saying to check whether traffic moved and to run `rollback` if it did.
The bridge finds the steps by name (`shift traffic`, `smoke`).

A commit whose smoke on testing went red is never promoted, whichever order
its smoke runs arrive in. The red smoke drops a soak, or a hold for a person,
the bridge was keeping for it, a green re-run after it promotes nothing, and a
promote GitHub is still holding for that commit (on the wait timer, for a
reviewer, or queued) is cancelled. A promote already deploying is left to
finish; if it fails, the rollback runs as above.

A file that does not parse is not guessed around: the console shows its error
on Settings → Repositories, and the bridge falls back on the repository's
stored rules (`repos.delivery_rules`), then on the Testing deploy choice
(**No testing deploy** is `testing: none`; otherwise these defaults, with
Automatic meaning whether a `deploy-testing` workflow exists). Templates for
the file and the four workflows are in `crew/templates/repo/`, to be copied by
hand: `fleetadlc github apply` never writes them, because writing either into a
repository that had neither would turn deploys on there without anybody
deciding it.

The template's `deploy-testing` and `smoke-testing` each skip until a
repository Actions variable turns them on: `FLEETADLC_DEPLOY_TESTING = true`
once the Makefile's `deploy-testing` target is written, and
`FLEETADLC_SMOKE_TESTING = true` once its `smoke-testing` target is. Write the
two together: the stub smoke refuses, and a red smoke reverts the change. A
skipped smoke is neither green nor red, so it neither promotes nor reverts; a
merged change waits on testing until the smoke is turned on.

The same file says which changes may be built side by side when their files
overlap (`apps/dispatcher/src/overlap.ts`). The defaults, which a file that
leaves `paths` out gets:

```yaml
paths:
  # Overlap here never holds a build back; the merge line reconciles it.
  shared: [Makefile, makefile, GNUmakefile, "README*", "CHANGELOG*", "docs/**/index*", package.json, .gitignore, AGENTS.md]
  # Overlap here holds the next change back until the one in flight has merged.
  exclusive: ["**/migrations/**", "*lock*.json", pnpm-lock.yaml, yarn.lock, Cargo.lock, go.sum, "**/generated/**", "*.schema.*"]
```

A pattern without a `/` names a file at any depth; with one, a path from the
root, `*` and `**` as wildcards; one ending in `/` names that folder and
everything in it (`exclusive: [db/]`). The dispatcher and the merge line's
conflict round read patterns the same way. Overlap on any other path holds the next
change back only while the other change is being built, not while it waits in
review. Each wait is recorded as an `overlap.waited` event, and its end, with
how long it lasted, as `overlap.cleared`. Intake asks how a request fits with
an open issue only when they overlap on an exclusive path.

`stacking` (default `true`) lets a change whose one unshipped dependency is in
review start from that pull request's branch instead of waiting; it joins the
merge line once the dependency merges. `stacking: false` makes it wait, as
before. A conflict at merge on shared files only is resolved by the builder and
re-checked by the lead alone, who must approve the resolved head before it
merges; the other approvals stand. The resolution may change only the
conflicted files. Any other conflict gets a full review, and so does one in a
file that can decide how CI runs (the Makefile, a `package.json` or
`tsconfig*.json`, anything `.github/`) or in `AGENTS.md`, whatever `shared`
lists: `shared` decides what builds side by side, not what skips review
(`docs/troubleshooting.md`). A file here that does not parse gives every
conflict a full review.

The testing URL is the file's `testing.url`, else the repository's own
(`PATCH /v1/repos/:name` with `testingUrl`), else `FLEETADLC_TESTING_URL`, which is
deprecated and read only as that last fallback.

### costs.yaml — what OpenADLC may spend

| Key | Default | Effect |
|---|---|---|
| `perTaskCapUsd` | 15 | Each task's cap; hitting it stops the task and asks |
| `monthlyCapUsd` | 1500 | The month's budget |
| `warningAt` | 0.9 | The share of the budget at which it warns |
| `onCap.stopLeasing` | true | Nothing new starts once the global month total is reached. `false` lets work start past that total; a repository, bot or provider cap still stops it |

`onCap.pauseReviewsAt` and `onCap.notify` are read and not used.

`perTaskCapUsd` and `monthlyCapUsd` seed Settings the first time OpenADLC starts.
After that the saved caps win, including a repository cap and a cap per bot or
provider, and `fleetadlc doctor` points at Settings → Spending limits when the
month is already spent. That section shows the global month total and the
per-task cap, with how much of the month is spent. **Edit limits** opens
`/settings/spending`: Global for the month, the task, each bot and each
provider, and Repositories for a cap that is blank (the global one) or lower.
`warningAt` and `onCap` stay in this file.

A monthly cap stops new work; a task already running finishes up to its own
per-task cap. Going on past that per-task cap is new spend too: once a monthly
cap is reached, a `continue` on the task's cost-cap question waits, with the
question left open and the cap named on the issue and in the thread, unless
an admin gives it from the console. An admin's continue is audited as
`spending.cap_bypassed` under their name, and the task's thread says so. A
reply on GitHub never goes past a monthly cap. Work that only one event starts is not dropped at a cap: a
patch round after changes are requested, and the QA run after a deploy to
testing. Each is recorded as a failed task that names the cap, which is a
card in Needs you with Try again, and the merge sweep starts it by itself
once that cap allows it — raised in Settings or reset by a new month. Like
any failure, it is looked for while it is on the board, for a week. A
console request a cap refuses waits in line without spending one of its five
attempts, and starts once the cap allows it.

**The first revert of a commit after a red smoke test is not held by a
monthly cap.** It is safety work: held, a deploy that broke testing would stay
live until somebody raised the cap or the month rolled over. So it starts past
any monthly cap, once per commit, and only for a smoke run on the default
branch, not for a pull request, of a commit the bridge recorded reaching
testing (the `deployment_status` delivery, kept as a `deploy.testing_live`
event). The authorisation is written to the audit log as
`spending.revert_authorized`, and the start past the cap as
`spending.cap_bypassed` with the cap's words, and said in the task's thread;
its own per-task cap still applies. A second red smoke of the same commit —
a re-run, say — asks for ordinary work, which a cap holds.

The authorisation is spent only when a revert starts. What becomes of it
depends on the first attempt:

- **The deploy bot is busy and no revert task is recorded.** It is given back
  (`spending.revert_released`), so the next red smoke of that commit has it.
- **The revert task is recorded but cannot start**, because a prerequisite is
  missing. It is held for that task (`spending.revert_held`). Once the
  prerequisite passes, the recovery retries the task by itself; that retry
  spends it (`spending.revert_spent`) and starts past the cap. A retry refused
  before anything is recorded leaves it held for the task. A retry that is
  recorded without starting spends it all the same, because the recovery never
  comes back for the task its own retry made.
- **Anything else** spends it, including a start hostd may have begun before
  its answer was lost.

After that, only an admin starts a revert past a monthly cap: an admin's Try
again on a revert's card does, audited under their name. A user's Try again
runs the revert too, but waits for the cap, held authorisation or not, and the
automatic retry of any other revert waits as well. Nothing else starts past a
cap.

A task that reaches its cap, or starts with less than $0.50 of it left, asks
one question: `continue for another $N`, `hand to a person` or `abandon this
task`. N is the task cap in force — the lower of the global cap and the
repository's, when the repository has one — every time, however often the
task has been let go on, and the bridge rewrites any other amount a session
asks with. Continue
raises that task's cap by N and resumes it, unless a monthly cap is reached
(above). The other two stop the task,
release its lease and leave `needs-human` on the issue; a console request
whose triage stopped this way is marked abandoned, as one a person abandons
from its card or cancels is ([architecture](architecture.md)).

### models.yaml — prices (optional)

`models: { <model id>: { inPerMtok, outPerMtok, cachedInPerMtok, cacheWritePerMtok } }`
overrides the built-in price list in `packages/engines/src/pricing.ts`. The two
cache rates are optional. `cachedInPerMtok` is the rate for input the provider
served from its cache (Codex's cached input, Claude Code's cache reads); unset,
it is a tenth of `inPerMtok` for a `claude-*` model and `inPerMtok` for any
other. `cacheWritePerMtok` is the rate for input written to the cache (Claude
Code's cache writes); unset, it is 1.25 times `inPerMtok` for a `claude-*`
model and `inPerMtok` for any other. A Claude or Grok Build run is priced
message by message as it goes, cached input included, so the per-task cap can
stop it partway; the run's own total, on its last line, has the last word.
Tokens in, in the ledger, count all input the model processed, cached input
included. Copy
`config/models.example.yaml` to `config/models.yaml`; git ignores the copy, so
an install's own prices never end up in a pull request.

hostd and the bridge read the install's file from `FLEETADLC_CONFIG_ROOT` when
they start. A file with no `models:` map, a missing price, or a price that is
negative or not a finite number stops both, with the file's path and the
model's name; a price of 0 is allowed. hostd hands the prices to every task's
session (`FLEETADLC_MODEL_PRICES`), which is where usage is priced. A managed
repository's own `config/models.yaml` is never read: a session runs in the
repository's checkout, and nothing it carries changes what a task is charged.
The bridge refuses a usage report whose tokens or cost are negative or not a
number.

### labels.json — the labels every repository gets

A list of `{ name, color, description }`: the labels the pipeline reads and
writes — the stages (`adlc:*`), `priority:*`, `do:*`, `start:*`, `touches:*`,
`review:*`, `size:*`, `scope:*`, `deployed:*`, `blocked`, `needs-human`,
`deps`, `revert` and the rest — and one area, `area:general`. The repository
step of the setup walkthrough and `fleetadlc github sync-labels` write it to
every repository the install manages: a label it names is created, or
recoloured and redescribed to match, and one renamed since is renamed in
place. Neither ever deletes a label, so a repository's own labels, and its own
`area:` labels, stay. Triage picks an `area:` label the repository has.

`fleetadlc:ignore` is a person keeping an issue from the crew. While it is on,
nothing staffs or moves the issue, its merge included, and neither it nor its
pull request is on the console's lists: the board, Needs you, the item view,
a seat's queue and history and Insights leave both out, and count neither. Taking the label
off brings the issue back as any other, where its stage label says
([platform-plan.md](platform-plan.md) has the whole rule).

OpenADLC's own component areas (`area:bridge`, `area:console`, …) are in
`config/labels-fleetadlc.json`, which nothing writes on its own: they are for
OpenADLC's repository, where a maintainer writes them with
`fleetadlc github sync-labels --file config/labels-fleetadlc.json --repo <name>`.

## Environment variables

✔ marks what `fleetadlc up` sets from install.json. Defaults are the ones used when
nothing sets a variable.

Only these names are read. A `FLEET_*` variable, the name a setting had before
the rename to FleetADLC, is not read at all; [upgrading from
Fleet](upgrading-from-fleet.md#settings-in-the-environment) says how to rename
them.

### bridge

| Variable | Default | What it controls | fleetadlc up |
|---|---|---|---|
| `DATABASE_URL` | `databaseUrl` from `install.json`, with the install's own password | The platform database | ✔ |
| `FLEETADLC_HOME` | `~/.fleetadlc` | Where secrets are stored | |
| `FLEETADLC_CONFIG_ROOT` | `<cwd>/config` | Where the YAML above is read | ✔ |
| `FLEETADLC_REPO_ROOT` | cwd | The checkout labels and templates come from | |
| `FLEETADLC_BRIDGE_PORT` | 47311 | The port, on all interfaces, so a task's container reaches `/internal/tasks/*`; `/v1` is served only beside the console secret | ✔ |
| `FLEETADLC_HOSTD_URL` | `http://127.0.0.1:47312` | hostd | ✔ |
| `FLEETADLC_GITHUB_ORG`, `FLEETADLC_GITHUB_CLIENT_ID`, `FLEETADLC_PUBLIC_URL`, `FLEETADLC_HUMANS` | empty | install.json's values; the console's settings win | each when install.json has one, so a value exported by hand is kept otherwise |
| `FLEETADLC_WEBHOOK_SECRET` | empty | install.json's; the console's setting wins | when install.json has one |
| `FLEETADLC_AUTOMATION_BOT` | the `automation` role | The account that writes labels and statuses | when install.json names one |
| `FLEETADLC_DISPATCH_IN_BRIDGE` | unset | `1` runs the dispatcher in the bridge, shortly after anything changes and every five minutes. Leave it off only for the integration suites and scripted engines, which dispatch a pass at a time; anywhere else nothing starts building, and the board shows a blocking `dispatcher` card. It is not a way to pause: use **Settings → Pause work** | ✔, except with scripted engines, where the integration suites dispatch |
| `FLEETADLC_LEASE_HOURS` | 12 | How long a lease lasts | |
| `FLEETADLC_IDENTITY_MODE` | `local` | `local` takes the console user from a header, believed only beside the console secret (`console-api-secret` in the secret store, made at start when missing), which only the console's server and the CLI hold; `iap` verifies Google IAP's signed assertion and never reads the secret. Any other value stops the bridge at start, and so does `local` (set or unset) on Cloud Run, where `K_SERVICE` is set: there anyone who reached the bridge would be an admin | |
| `FLEETADLC_IAP_AUDIENCE` | empty | Required in `iap` mode, or the bridge will not start | |
| `FLEETADLC_ADMIN_EMAILS` | empty | Emails, comma-separated: the console's first admins, made on the first request while the install has no users. Read only then; Settings → Users decides after | |
| `FLEETADLC_CONSOLE_MEMBERS` | empty | The console's IAP members, comma-separated; every `user:` among them is a first admin when `FLEETADLC_ADMIN_EMAILS` names nobody. With neither, a cloud install refuses everyone, and a local one makes its first visitor the admin | |
| `K_SERVICE` | unset | Set by Cloud Run, never by hand. When it is set, `local` identity mode stops the bridge, and `*.run.app` names are allowed | |
| `FLEETADLC_CONSOLE_URL` | `http://127.0.0.1:` and the console's port | Links in notifications and gates, and the browser origin allowed. Set it when people open the console at another address | |
| `FLEETADLC_CONSOLE_PORT` | 47300 | The port of the links and the allowed origin when `FLEETADLC_CONSOLE_URL` is unset | ✔ |
| `FLEETADLC_TESTING_URL` | empty | Deprecated: the testing environment QA checks, for a repository whose `.github/fleetadlc.yml` and settings name none; empty and QA refuses | |
| `FLEETADLC_NOTIFY_WEBHOOK` | empty | Where notifications are posted as `{ text, link, event }`; empty logs them. `event` is one of `gate_opened` (a gate opened), `cap_warning` (the month's spend reached its warning), `promote_waiting` (a promote waits for its approval), `check_failing` (a blocking health check has failed for five minutes, and again a day later) and `check_fixed` (its all-clear) | |
| `FLEETADLC_STATUS_ISSUE` | unset | The issue the status job keeps up to date and reconcile reports drift on, as `<owner>/<name>#<number>`, in a repository the install manages. A bare number, another form, or a repository the install does not manage writes nothing, and the job's output line says what to set. The issue may be public, so its body publishes only the board counts, the month's spend and cap, the open gates and active leases, and each bot's name, role, engine and authorization with its work in that repository; a bot working elsewhere reads "working in another repository". It leaves out other repositories' subjects and host names. Reconcile's comments follow the same rule: that repository's drift, and only a count of the rest. The console's status view still shows everything | |
| `FLEETADLC_JOB_<JOB>_MINUTES` | per job | A scheduled job's interval; 0 turns it off. Any length works, a month or more included; the clock starts again when the bridge restarts. RECONCILE 15, STATUS 15, BUDGET 30, STAGES 60, MERGE 10, QA 1440, CREDENTIALS 720, DEPS 10080, DEPLOY 30, ENGINES 5, ATTACHMENTS 60, EVENTS 1440 | |
| `FLEETADLC_EVENT_RETENTION_DAYS` | 30 | How many days a processed GitHub delivery is kept in the `events` table; the daily `events` job removes older ones, keeping the newest. 0 keeps them for good. A value that is not a whole number of days stops the bridge at start. A delivery for a repository the install does not manage keeps only its type, delivery id and repository name | |
| `FLEETADLC_SCRIPTED_ENGINES` | unset | `1` makes the install a scripted one; `/healthz` says so | when exported |
| `FLEETADLC_ALLOWED_HOSTS` | empty | Names, comma-separated, a person reaches the bridge under besides loopback, an address, and the hosts of `FLEETADLC_CONSOLE_URL`, `FLEETADLC_PUBLIC_URL` and `FLEETADLC_BRIDGE_URL`, and on Cloud Run a `*.run.app` name; as names or URLs. `*` takes any. See [security.md](security.md#a-page-on-another-origin) | from `allowedHosts`, or when exported |

### hostd

| Variable | Default | What it controls | fleetadlc up |
|---|---|---|---|
| `FLEETADLC_HOSTD_DRIVER` | `local` | `docker` or `local`, in any case; hostd refuses to start on anything else rather than fall back to `local`, which isolates nothing | ✔ |
| `FLEETADLC_HOSTD_PORT` | 47312 | The API and the terminal WebSocket | ✔ |
| `FLEETADLC_CONFIG_ROOT` | `<cwd>/config` | Where `models.yaml` is read, once at start, for the prices every session is handed | ✔ |
| `FLEETADLC_BRIDGE_URL` | `http://127.0.0.1:47311` | The bridge, for tokens; sessions get it too | ✔ |
| `FLEETADLC_WORK_ROOT` | `$FLEETADLC_HOME/work` | One mirror per repository (`mirrors/`), and each task's clone and context. A clone copies the mirror's objects rather than linking them, so no task can change the mirror, and each running task's clone takes the repository's size on disk | |
| `FLEETADLC_LOGIN_ROOT` | `$FLEETADLC_HOME/logins` | Subscription sign-ins for Codex and Grok | |
| `FLEETADLC_SKILLS_ROOT`, `FLEETADLC_ROLES_ROOT` | `<cwd>/crew/skills`, `<cwd>/crew/roles` | Mounted read-only at `/skills` and `/roles` in a container | ✔ |
| `FLEETADLC_RUNNER_BUNDLE`, `FLEETADLC_GH_SHIM_DIR` | hostd's own `dist/skill-runner.bundle.mjs` and `bin/` | The skill runner and OpenADLC's `gh`, mounted into each bot; set where hostd's files are not paths the Docker daemon sees (the compose stack) | |
| `FLEETADLC_HOSTD_TASK_BRIDGE_URL`, `FLEETADLC_HOSTD_TASK_HOSTD_URL` | `FLEETADLC_BRIDGE_URL` and hostd's port, loopback rewritten to `host.docker.internal` | The bridge and hostd as a bot's container reaches them; set where those names do not resolve from a bot (the compose stack) | |
| `FLEETADLC_BOT_PREFIX`, `FLEETADLC_INSTALL_ID` | none, `default` | What this install's task containers (`<prefix>task-<id8>`), task network (`<prefix>tasks`) and database server (`<prefix>taskdb`) are named after, and the install label hostd checks before it reuses or removes one; another install on the same Docker daemon needs its own (the compose stack sets both). The default install's are `task-<id8>`, `fleetadlc-tasks` and `fleetadlc-taskdb`. Set both or neither: hostd refuses one without the other | |
| `FLEETADLC_BOT_IMAGE` | `fleetadlc-bot:latest` | The bots' image | |
| `FLEETADLC_SIDECAR_IMAGE` | `pgvector/pgvector:pg16` | The task database server's image, when `FLEETADLC_TASKDB_IMAGE` is unset | |
| `FLEETADLC_BOT_IMAGE_SCRIPT` | `infra/local/build-bot-image.sh` | What an engine update runs | |
| `FLEETADLC_TMUX_BIN` | `tmux` | The tmux the local driver and take-over use | |
| `FLEETADLC_HOST_NAME`, `FLEETADLC_HOST_ZONE`, `FLEETADLC_HOST_CAPACITY` | hostname, none, 8 | This host's row; recorded only | |
| `FLEETADLC_HOST_CAPACITY_TASKS` | 4 | How many tasks this host runs at once, whoever's; each is a computer with its seat's CPUs and memory. A start past it is answered 503 and tried again by the bridge. Written to `hosts.capacity_tasks` | |
| `FLEETADLC_PAUSED_KEEP_MINUTES` | 15 | How long a task paused on a person keeps its computer, so it can be taken over and a quick answer resumes it cheaply. Then its branch is kept in the mirror and its computer given back; anything not committed in it is lost, and the answer resumes it in a new one | |
| `FLEETADLC_LOCAL_CI_TIMEOUT_MINUTES` | 60 | How long `make ci` may run for `fleetadlc-ci`. A run past it is killed in the task's computer and fails with "make ci did not finish within N minutes", and the next `fleetadlc-ci` starts a fresh run | |
| `FLEETADLC_SETUP_TIMEOUT_MINUTES` | 30 | How long a task's `make setup` may run. One past it is killed, warned about, and the task starts without it, as after any failed setup | |
| `FLEETADLC_WARM_POOL`, `FLEETADLC_WARM_POOL_MAX` | off, 3 | `1` keeps computers made ahead of their task, so a start claims one (resized to the seat, renamed the task's) rather than waiting for a container: one for work on no repository and one per repository worked in during the last two hours, never more than the maximum or than the host has room for beside its tasks. None holds a login; a task that needs one starts cold. Drained on a replaced image, after a day, and at hostd's start. Docker driver only | |
| `FLEETADLC_TASKDB_BIND` | worked out | Where the task database server is published on the host: loopback on Docker Desktop and OrbStack, the default bridge's gateway (172.17.0.1) on Linux. Never an address the network reaches: a wildcard (`0.0.0.0`, `::`) is refused when hostd starts | |
| `FLEETADLC_TASKDB_IMAGE` | `FLEETADLC_SIDECAR_IMAGE`, then `pgvector/pgvector:pg16` | The task database server's image | |
| `FLEETADLC_PER_TASK_CAP_USD` | 15 | The cap a task gets when the bridge's request to start it names none. The bridge always names one — the lower of Settings' global and repository per-task limits — so this is a fallback for a caller that is not the bridge | |
| `FLEETADLC_SECRET_STORE`, `FLEETADLC_GCP_PROJECT` | file, the metadata server's project | `gcp` keeps secrets in Secret Manager rather than files under `$FLEETADLC_HOME/secrets`; the project is asked of the metadata server unless set. The same two are read by the bridge and the CLI | |
| `FLEETADLC_REGISTRY_HOST` | unset | A private package registry's bare host name, which a task may fetch a credential for; empty is unset. On an `infra/gcp` install set `registry_host` instead, which writes this and adds the host to the egress allowlist; under compose it is passed through from the shell ([self-hosting](self-hosting.md#installing-from-a-private-package-registry)) | |
| `FLEETADLC_BOT_EGRESS_PROXY` | unset | The forward proxy every bot's container, sign-in check and bot image build leaves through, as a container reaches it; sessions get it as `HTTPS_PROXY` and the like, with hostd bypassed. `infra/gcp` sets it to the host's egress proxy | |
| `FLEETADLC_CONSOLE_URL`, `FLEETADLC_CONSOLE_PORT` | `http://127.0.0.1:` and 47300 | The console's address, whose origin may open a take-over on the terminal WebSocket. Set it for hostd when people open the console under another name: a cloud domain, a LAN address, a tunnel | |
| `FLEETADLC_ENGINE_TELEMETRY` | off | `on` restores the engine vendors' default telemetry, error reporting and non-essential traffic in every session, sign-in and account or model check; anything else, or unset, turns them off | |
| `FLEETADLC_REMOTE_<OWNER_REPO>`, `FLEETADLC_SCRIPTED_REPO_PATH` | unset | A remote to clone instead of GitHub's, per repository or for all | |

A task's session starts under `env -i` with only what hostd gives it: the
task's identity, a short-lived GitHub token, its engine's credential, git's
signing configuration, the install's prices, and `FLEETADLC_CONTAINED=1` in a container. It never sees the
platform's `DATABASE_URL`. `apps/hostd/src/session-env.ts` is the list. Unless
`FLEETADLC_ENGINE_TELEMETRY` is `on`, it also gets the vendors' opt-outs:
`DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `DO_NOT_TRACK=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `GROK_TELEMETRY_ENABLED=0`,
`GROK_TELEMETRY_MIXPANEL_ENABLED=0`, `GROK_TELEMETRY_TRACE_UPLOAD=0`,
`GROK_FEEDBACK_ENABLED=0` and `NEXT_TELEMETRY_DISABLED=1`
(`TELEMETRY_OPT_OUTS` in `apps/hostd/src/drivers/base-env.ts`), and Codex is
run with `-c analytics.enabled=false -c feedback.enabled=false`.

### console

| Variable | Default | What it controls | fleetadlc up |
|---|---|---|---|
| `FLEETADLC_BRIDGE_URL` | `http://127.0.0.1:47311` | The bridge, read when the console starts | ✔ |
| `FLEETADLC_CONSOLE_PORT` | 47300 | `next start`'s port | ✔ |
| `FLEETADLC_CONSOLE_HOST` | `127.0.0.1` | The address `next start` listens on. `0.0.0.0` opens the console to other machines, which still sign in with a link. In the compose stack, the host address the console is published on | |
| `FLEETADLC_CONSOLE_SECRET` | unset | The console secret, which the console sends the bridge and signs its sign-in links and sessions with. `fleetadlc up` gives it to the console and nothing else; unset on a local install, the console answers every path with 503 | ✔ |
| `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL` | empty | Where take-over connects (`wss://<console domain>` in the cloud, `/terminal` added); empty is port 47312 on the console's host. Read when the console starts: the console hands it to the browser with each terminal token, and its `Host` check takes its host. A value the console was built with is used only when it starts with none | |
| `FLEETADLC_IDENTITY` | `console` | Who the console says it is when there is no IAP user | |
| `FLEETADLC_IDENTITY_MODE_EXPECTED` | unset | `iap` says the console is behind IAP: only then does it read IAP's `x-goog-authenticated-user-email` as the person, and it logs, once, which `x-` headers arrived on a request that carried no IAP assertion: the way to see what a proxy in front of it sends instead | |
| `FLEETADLC_ALLOWED_HOSTS` | empty | Names, comma-separated, the console is opened under besides loopback, an address, and the hosts of `FLEETADLC_CONSOLE_URL`, `FLEETADLC_PUBLIC_URL` and `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL`: a LAN hostname, a tunnel. `*` takes any | from `allowedHosts`, or when exported |

### cli

| Variable | Default | What it controls |
|---|---|---|
| `FLEETADLC_HOME` | `~/.fleetadlc` | Which install every command acts on |
| `DATABASE_URL` | install.json's `databaseUrl` | The database the commands that open one use. One exported that differs from install.json's stops those commands and says to unset it |
| `FLEETADLC_INSTALL_ID`, `FLEETADLC_BOT_PREFIX` | `default`, none | The database container `fleetadlc up` keeps: `fleetadlc-db` for the default install, else `<prefix>db` (`<install>-db` with no prefix) |
| `FLEETADLC_WEBHOOK_SECRET` | unset | Kept by `fleetadlc init` when the install has none; `fleetadlc doctor` warns when it differs from the stored one |
| `FLEETADLC_GITHUB_CLIENT_ID`, `FLEETADLC_HUMANS` | install.json's | Used when the console's settings name none: the App's client id for sign-in, and the people `fleetadlc github` makes reviewers |
| `FLEETADLC_CONSOLE_URL` | the console's port on `127.0.0.1` | Where the console sign-in links the CLI prints point |
| `FLEETADLC_HOSTD_URL` | `http://127.0.0.1:47312` | The hostd a restore checks a subscription sign-in through |
| `FLEETADLC_WORK_ROOT` | `$FLEETADLC_HOME/work` | Where `fleetadlc doctor` looks for leftovers of the per-seat layout |
| `FLEETADLC_BOT_IMAGE` | `fleetadlc-bot:latest` | The image `fleetadlc up` checks for under the docker driver, and that an install naming no driver must have to be given `docker` |
| `FLEETADLC_SCRIPTED_ENGINES` | unset | `fleetadlc up` starts a scripted install, with a local repository to work in |
| `NO_COLOR` | unset | Plain output |

### compose

`infra/local/docker-compose.yml` reads these from the shell it is started in,
besides the services' own variables it passes through:

| Variable | Default | What it controls |
|---|---|---|
| `FLEETADLC_COMPOSE_HOME` | `~/.fleetadlc-compose` | The one directory the stack keeps everything in, mounted into hostd and the bridge at the same absolute path; an absolute path, or `setup` refuses to start |
| `POSTGRES_PASSWORD` | none | The database's password; the stack refuses to start without it ([self-hosting](self-hosting.md#or-with-docker-compose)) |
| `COMPOSE_PROJECT_NAME` | `fleetadlc` | Docker Compose's own: what the stack's task containers, task database and bot image are named after, so a second stack beside it needs another |

### The bot image

`infra/local/build-bot-image.sh` reads `CLAUDE_CLI`, `CODEX_CLI` and
`GROK_CLI` (the engine CLIs, pinned: `@anthropic-ai/claude-code@2.1.282`,
`@openai/codex@0.155.1`, `@xai-official/grok@1.0.41`), `NODE_VERSION` and
`GH_VERSION` (unset on a fresh install; an update sets them so the candidate
keeps the Node and GitHub CLI it already runs, or moves the one this run is
for), `IMAGE` (`fleetadlc-bot:latest`) and `BUILD_PROXY` (unset: the forward proxy
the build's steps leave through, as a container sees it; hostd sets it from
`FLEETADLC_BOT_EGRESS_PROXY`).

## $FLEETADLC_HOME

| Path | What |
|---|---|
| `install.json` | This install's settings |
| `secrets/` | The secret store, one file per secret, never printed |
| `run/<service>.pid`, `run/<service>.log` | The keeper's pid, and the service's log with the keeper's. Past 20 MB the log becomes `<service>.log.1`, replacing the one before |
| `work/mirrors/` | One bare mirror per repository (`<owner>__<repo>.git`), touched only by hostd. A task's branch is kept there between its computers as `refs/fleetadlc/tasks/<task>/{head,pushed}`. When a task ends for good (done, failed or stopped) with commits it never pushed, they are kept as a set-aside, `refs/fleetadlc/unpushed/<branch>` (`unpushed/task-<task>` when it had no branch), hostd's log says where, the next task that writes that branch is told of them, and they go after 5 days like any other set-aside |
| `work/slots/` | Each task's directory (`<task>-<start>/`: its clone `wt/`, its context and its home), mounted into its computer, and beside each the record of whose it is (`<task>-<start>.json`). The record is outside the directory so the task cannot rewrite it; after a restart hostd takes a computer back only for the task whose row names it, and keeps a leftover clone's commits only under the task in that record, on the repository and branch its row has |
| `work/slots/warm-<hex>/` | A warm-pool computer's folder, made ahead of its task (`FLEETADLC_WARM_POOL`) |
| `work/cache/<repo>/` | The local driver's per-repository cache, mounted where a container has `/cache`. The docker driver keeps it in a `fleetadlc-cache-*` volume instead |
| `work/<bot>/` | Only leftovers from the per-seat layout, from before each task had its own computer: the bot's old clones, which hostd sweeps, its home, and `repos/`, its own mirrors from before there was one per repository. hostd carries paused tasks' branches out of them once; `fleetadlc doctor` says when they can be deleted |
| `logins/` | Subscription sign-ins for engines that keep them on disk |
| `cloud.tfvars.json` | `fleetadlc cloud configure`'s answers |
| `restore-undo/` | What a restore replaced, for Undo; the bridge removes it once it is a day old |
| `scripted/testbed` | A scripted install's repository |
