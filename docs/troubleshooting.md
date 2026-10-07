# Troubleshooting

Organized by what a person sees: a card on the board, a line from `fleetadlc doctor`,
a task that stopped, a page that will not load. Each entry says what it means and
what to do, and names the code that decides it. `fleetadlc` below is
`node apps/cli/bin/fleetadlc.mjs`, run from the checkout the install runs from.

## Start with two commands

```bash
fleetadlc status    # which install, what is running, the board, spend, the crew
fleetadlc doctor    # what would break, with the health checks run now
```

`fleetadlc status` opens with `Install at <path>`, the `FLEETADLC_HOME` it read, and
everything after that line is about that install. It says whether each service
is running, answering on its port but started by something else, or not running,
and when each scheduled job last ran. `never run` means no run of that job is
recorded yet. Each job first runs one interval after the bridge starts
(engines 5 minutes, merge 10, reconcile and status 15, budget, deploy and
stages within the hour, credentials 12 hours, qa and events a day, deps a
week), and every restart starts that wait again: a young install, or one
restarted more often than a job's interval, shows the long ones as `never
run`. A job set to 0 with `FLEETADLC_JOB_<NAME>_MINUTES` never runs.

`fleetadlc doctor` checks the tools, hostd's authentication, the database, the GitHub
accounts, the webhook secret and the last delivery, then has the bridge run every
health check now and prints each failure with what to do and where. It exits
non-zero on any blocking failure (`apps/cli/src/commands/doctor.ts`).

| What | Where |
|---|---|
| A service's log, and how it last ended | `~/.fleetadlc/run/<service>.log`; `fleetadlc logs bridge` prints the path |
| The driver, the ports, the database, the checkout that runs | `~/.fleetadlc/install.json` |
| Sign-ins, keys and the internal secret | `~/.fleetadlc/secrets/*.secret`, mode 0600 |
| OpenAI and xAI subscription sign-ins | `~/.fleetadlc/logins/<account id>` |
| A task as it runs | `fleetadlc attach <bot name> <session>`, where the session is the one the console shows after `<bot>/` (`<skill>-<first 8 characters of the task id>`, e.g. `fleetadlc attach builder implement-3f2a9c1e`), or the console's Terminal tab; ctrl-b d hands it back |

## How a problem reaches you

Most of what goes wrong is found by a health check in `apps/bridge/src/health/`
before a task runs into it. A check proves something by its effect — GitHub's own
list of deliveries, the keys GitHub lists for an account — never by a setting
that says it was done. It runs when the bridge starts, on its own interval, and
soon after something it is about happens. A failing check is a card in the
board's **Needs you** row with the thing to do and a button to where it is done,
and it clears itself when the check passes. A blocking failure that lasts five
minutes is also sent to `FLEETADLC_NOTIFY_WEBHOOK` (or the bridge's log without one),
and again a day later. A check that cannot get an answer neither raises a card
nor clears one.

Every item is on **`/needs-you`**, in two tabs: **Work**, what the crew needs to
go on (a question, a task that failed or stopped, a review that stalled, a
request whose triage failed), and **System**, what the install needs (the
health checks below, and engine updates). The bridge sets each item's `group`.
The board shows only the three most pressing, and the header's badge says both
counts, "3 need you · 10 system". A card shows two lines; **Show more** opens
the rest beside it.

**Needs you** holds only what waits on a person, and the count beside it counts
only that (`apps/bridge/src/attention.ts`):

- **One card per cause.** Failing rows of the same check and severity — the same
  sign-in failing for three bots, the crew kept out of two repositories — fold
  into one card that lists each of them. For failed tasks and failed triage, a
  fix they share is at the top; a fix that is one bot's own, such as
  reconnecting it, stays on that bot's line. A folded health-check card offers
  **Check again** at the top and keeps each row's fix on its own line, behind
  **Show more**. A failed task folds the same way with others of its kind that failed for the
  same reason once the bot's name is taken out of it; one that stopped with no
  reason at all is never folded, since an unknown cause is not a shared one.
- **Recoveries fold away.** A check that passes again, or something OpenADLC fixed
  itself, is not a card and is not counted. They sit behind one line, *N things
  recovered in the last day*, which opens to a list grouped by bot with one
  **Clear all**. Each one leaves on its own after a day, and one cleared does not
  come back until it happens again: the check fails and recovers, or OpenADLC fixes
  the same thing once more.

`<bot>` below is how OpenADLC names a bot everywhere a person reads: its role and
the GitHub account it acts as, "the second reviewer (janedoe-reviews)", or its
role alone before it has one (`botInWords`, `packages/shared/src/bot-words.ts`).

| Check | Every | Its card says | What fixes it |
|---|---|---|---|
| `hostd` | 2 min | OpenADLC’s host service is not answering | `fleetadlc up` on the machine OpenADLC runs on |
| `hostd-driver` | 10 min | Tasks run on this machine as your user, not in containers (a warning) | `infra/local/build-bot-image.sh`, then `fleetadlc init --driver docker` and `fleetadlc down && fleetadlc up` |
| `webhook` | 5 min | GitHub is not sending events to OpenADLC, and five others | [Webhooks do not arrive](#webhooks-do-not-arrive) |
| `app-installed` | 15 min | The OpenADLC app is not installed on `<repo>` — or is private, so it cannot be; is suspended there; or is not given `<repo>` | The step on the card: install it on the account, make it public first ([more than one account](self-hosting.md#repositories-under-more-than-one-account)), unsuspend it, or add the repository on the installation's page |
| `app-selection` | 60 min | The OpenADLC app is given all of `<organization>`’s repositories (a warning) | Choose **Only select repositories** on the installation's page and pick the ones the crew works in; set the organization's base permission to No permission and keep the bots out of teams ([more than one account](self-hosting.md#repositories-under-more-than-one-account)) |
| `app-permissions` | 10 min | The OpenADLC app does not have “`<permission>`” | [GitHub answers 403](#github-answers-403-resource-not-accessible-by-integration) |
| `device-flow` | 60 min | Device Flow is off in the OpenADLC app | Tick Enable Device Flow on the app's settings page |
| `token-expiry` | 30 min | The OpenADLC app’s user tokens never expire (a warning) | Tick Expire user authorization tokens, then reconnect each bot |
| `app-client-secret` | 60 min | Each task’s GitHub token reaches every repository its bot can, or GitHub refuses the app’s client secret (a warning) | Generate a client secret on the app’s settings page and paste it into Settings → GitHub → App client secret |
| `bot-sign-in` | 10 min | `<bot>` cannot sign in to GitHub · signs in to GitHub as `<actual>`, not `<expected>` · has been renamed on GitHub to `<login>` (the account OpenADLC recorded, under a new login) | Reconnect its account in Settings → GitHub → Connected accounts, signed in as the account the card names; for a rename, reconnecting records the new login |
| `bot-access` | 30 min | `<bot>` is not in `<repo>` yet · `<bot>` is not signed in to `<org>`’s single sign-on · `<org>`’s IP allow list refuses `<bot>` · `<bot>` has admin (or maintain) on `<repo>` | **Let the crew in**, on the walkthrough's access step · sign in to GitHub as the bot and authorize it on the organization's SSO page, then reconnect it · add the host's address to the organization's IP allow list · lower the account to write (triage for intake or automation in an organization) on the repository's collaborators page, which the card opens; if it is a person's account, put the seat on an account of its own. A rate limit is not a card: the check waits for the next run |
| `signing-key` | 15 min | `<bot>` has no signing key on its GitHub account · `<login>` has a signing key OpenADLC did not register (a warning) | Reconnect the bot once the app has “SSH signing keys”; blocking only where a branch requires signed commits · remove the key on the account's SSH and GPG keys page if nobody here added it |
| `commit-email` | 60 min | `<login>`’s email address is public on its commits in `<repo>` (a warning, naming the commit) | Signed in as that account, tick Keep my email addresses private and Block command line pushes that expose my email at github.com/settings/emails. Commits already written keep their address, so **Dismiss** the card; it comes back only for a newer commit that still carries it |
| `model-account` | 30 min | The xAI subscription is signed out | [A model account is signed out](#a-model-account-is-signed-out-or-refused) |
| `repo-rules` | 60 min | Nothing the crew builds can land in `<repo>` | Apply the rules on the walkthrough's last step, or `fleetadlc github apply` |
| `repo-config` | 30 min, and when a pull request merged into a default branch changes one of the files it reads | `<owner/repo>`’s AGENTS.md doesn’t say who approves its human-review paths yet — line N still has the template’s `@owner` · `<login>` is named as a reviewer in `<repo>`’s AGENTS.md, but there is no such GitHub account · … but `<login>` is an organization, not a person · … but cannot review: `<login>` is not a collaborator on `<repo>` (or has triage or read there) · `<login>` is one of this install’s people (FLEETADLC_HUMANS), but there is no such GitHub account (a warning) | [A named reviewer does not exist or cannot review](#a-named-reviewer-does-not-exist-or-cannot-review) |
| `repo-owner` | 15 min | Nothing builds in `<repo>`: no bot owns it | Set its `owner` in config/repos.yaml to a seat (`builder`) and run `fleetadlc seed`; a repository not listed there gets the builder when it is added again in Settings → Repositories |
| `deploy-dispatch` | 5 min | `<repo>`: `<workflow>` of `<sha>` has not been dispatched (a warning for a promote, blocking for a rollback) | Fix what GitHub said, shown on the card; the deploy sweep dispatches it again, or run the workflow from the repository's Actions. See [A merge did not deploy](#a-merge-did-not-deploy-or-production-did-not-wait) |
| `idle-lease` | 5 min | Never fails: lets go of a lease held 15 minutes with nothing working under it and no pull request | Nothing |
| `dispatcher` | 5 min | The dispatcher isn’t running: nothing will start building | `fleetadlc down && fleetadlc up` (on Cloud Run, `fleetadlc cloud apply`); see [Stopping new work while you look](#stopping-new-work-while-you-look) |
| `github-accounts` | 10 min | The GitHub sign-in for `<login>` stopped working · Only one GitHub account is connected · No GitHub account is connected | Connect or reconnect an account on the walkthrough's GitHub accounts step; it needs two that still sign in |
| `production-rules` | 60 min | A crew account can approve `<repo>`’s production deploy · `<repo>`’s production deploys wait for nobody · … wait for a person its rules do not ask for · … can come from more than `<branch>` (the last three warnings) | Remove the crew from the production environment's reviewers on the repository's Settings → Environments; for the others, choose how production ships on the walkthrough's Protect step, or `fleetadlc github apply` |
| `unattributed-post` | 5 min | A review on `<repo>#<n>` by `<login>` is not signed by OpenADLC | [runbooks/unsigned-post.md](runbooks/unsigned-post.md). **This was me** dismisses it until a newer post fails the signature check; each run reads the posts again and clears those that verify now |

A task that fails gets a **Needs you** card — its own, or a line on the card of
others that failed the same way: why it stopped in a sentence, the one thing to
press besides **Try again**, and the reason as it arrived behind **Details**
(`apps/bridge/src/failure-words.ts`).

**Stop**, beside **Try again** on the card and in the bot's thread, ends the
work for good instead: hostd's cancel ends whatever is left of its session,
the task's lease is released, the stop is audited (`task.stopped`), and the
card goes (`POST /v1/tasks/:id/stop`). A task paused on a question is answered
instead, and is not stopped this way.

**Dismiss** takes the card off and leaves the work as it is: nothing is run
again and nothing is stopped. It is kept in `acknowledgements` as
`task:<id>` with the ending the card showed, and audited (`task.dismissed`: who,
which task, when; `POST /v1/tasks/:id/dismiss`). The card stays away until the
task ends again. On a card that stands for several tasks, **Stop all** stops
every one of them and **Dismiss all** dismisses every one of them. A task Stop
all cannot stop (someone has just tried it again, say) does not keep the rest
running: each is stopped, and the error names the ones that were not.
Dismissals older than a week are forgotten the next time a card is dismissed,
since a failure that old is no longer a card.

**A card goes by itself** when it no longer holds anything up:

- **The work landed.** A failed or stopped intake, design, build, fix or review
  task whose issue or pull request is closed on GitHub is not a card. A merged
  pull request counts as closed. For a day it is a line under "recovered"
  saying so. OpenADLC asks GitHub which subjects are closed and keeps the answer
  for a while (`ClosedSubjects`, `apps/bridge/src/attention.ts`): ten minutes
  for a closed one, two minutes for one still open, at most twenty read at once
  and a thousand kept. One GitHub cannot answer about counts as open, so its
  card stays. A reopened issue or pull request brings its card back within ten
  minutes; Answer, Try again and resume ask GitHub directly and are not delayed.
- **The deploy shipped.** A deploy or QA task's work starts at the merge, so a
  closed pull request does not clear it by itself. A deploy goes once a later
  deploy of the same repository finished. A QA task does not: a later deploy
  does not check again what QA failed on. Either goes when its pull request is
  closed and its repository has no testing deploy: `.github/fleetadlc.yml` or
  Settings says none, or Automatic finds no `deploy-testing` workflow. A
  repository that deploys to testing, or whose setting could not be read,
  keeps the card with Try again. `FLEETADLC_TESTING_URL` decides only for a
  task with no repository.
- **A person ended it.** A Stop from the card, and a Stop in the bot's thread
  that kills its session (`stopped by a person (<who>): its session was
  killed`). The same goes for an answer that ended the task: a refused plan
  change, abandoning it at its cost cap, or an answer on work that had
  already landed. And a task whose session went away (`the session was
  killed`) within an hour of its last question being answered with a stop:
  the end was the person's. The answer has to start with the stop ("stop",
  "no, stop here", "leave it unposted", "cancel", "abandon", "don't post"), and
  one that says to go on ("don't stop", "keep going", "try again") is not one.
  A task that failed on an error of its own keeps its card whatever the answer
  said.
- **The cause has gone, and the work moved on.** A failure on the model account
  (a spend limit, a sign-in, a key) is fixed once another task on the same
  account has started since, unless that task failed the same way. A failure on
  a bot's GitHub sign-in is fixed once that bot has started a task since. Nothing
  runs such a task again by itself, so the card goes only when its issue or pull
  request is also closed, or a later task on it has started. Until then it says
  the cause has been fixed and the task can be tried again.

**Work that has landed is not started again.** Answering a question on a closed
issue or pull request records the answer, says on GitHub that the task is not
resumed, and ends the task as `already landed: <ref> is closed`. A resume for
any other reason does the same: the bot is not started, the task is cleaned up,
and no card results. **Try again**, and the retry after a check passes, are
refused with `already landed`. A stage move of a closed issue is refused too,
except to Merged or Done, which is how a merge records itself.

| The card says | What to do |
|---|---|
| OpenADLC’s host service did not answer, so the work could not run | `fleetadlc up`, then **Try again** |
| OpenADLC stopped while `<bot>` was working · The computer `<bot>` was working on restarted | **Try again**: nothing starts the work again on its own |
| GitHub refused a commit by `<bot>`: it was not signed with a key its account has | Reconnect the bot, so GitHub learns its signing key |
| GitHub no longer accepts the sign-in of `<bot>` | Reconnect the bot |
| Engine claude is not available on this host | Build the bot image, `infra/local/build-bot-image.sh`; under the `local` driver, install the CLI |
| This account cannot call `<model>` — it offers … | Give the bot a model its account lists, on the walkthrough's **Crew** step or in **Settings → Crew** |

**A build that ends without its pull request is not finished**. A
builder's task ends when its session does, and a session can end one step
short: pushed, but with the pull request never opened. About two minutes
after a build ends `done`, once the pull request's webhook has had time to
arrive, and again on the merge job (every ten minutes), OpenADLC asks GitHub about
its branch (`continueBuildsWithoutPullRequest`, `apps/bridge/src/scheduler.ts`;
`apps/bridge/src/build-left.ts`):

- **A pull request from the branch** (its webhook missed, or it lacks
  `Closes #n`): nothing to do.
- **Commits and no pull request:** the build goes on from its branch, once: a
  new build task on the pushed branch, told to finish, run the checks and open
  the pull request. The issue says `Going on from branch …`. It is audited as
  `task.continued` by `bridge`, and claimed in `tasks.auto_retried_at` as the
  recovery's retries are.
- **That one also ends without its pull request:** it fails with `finished
  without opening a pull request`, and the card says *The builder finished
  without opening a pull request*, with **Open pull request** (GitHub's compare
  page for the branch) and **Try again** (on from the branch again).
- **No commits on the branch:** the task fails with `finished without pushing a
  commit or opening a pull request`, and its card has **Try again**.

A build is left alone when a later build of the issue has started, the issue
is no longer in Build or is closed on GitHub, it carries `fleetadlc:ignore`, or
GitHub cannot be asked. A continuation also waits for what the dispatcher
checks before it starts a build: the issue carries none of `needs-human`,
`needs-triage` or a `do:` label other than `do:ai`, the repository has room
under its concurrency, and no build in flight declares the same files. Passed
over, it is not claimed, and a later sweep continues it once nothing holds it. Only builds that ended since the bridge started, and
within a lease's length (`FLEETADLC_LEASE_HOURS`), are looked at, so restarting or
upgrading the bridge does not revive older ones. Nothing is looked at while nothing dispatches (the
`dispatcher` card): a continued build is work the dispatcher would hand out.
Until the sweep has looked, the bot's thread offers **Try again** on such a
build too, and a comment on the issue from someone who may answer its
questions (one of `humans`, or triage or more on the repository) starts the
same thing: its new session reads the issue again, the comment with it.

**Work waits for the check, then goes on by itself.** Three checks decide whether
a bot can work at all: `hostd`, and `bot-sign-in` and `bot-access` for that bot
and repository (`PREREQUISITE_CHECKS`, `apps/bridge/src/health/checks/crew.ts`).

- **While one fails, a task for that bot is not started.** Where something comes
  back for the work — a review, staffing a stage, the QA and deploy sweeps — nothing
  is recorded and no failed-task card is added to the health card; a request from
  the console is refused with what the card says to do (HTTP 409). Work that only
  an event starts — a patch round after changes are requested, a revert after a red
  smoke, the verification after a deploy — is recorded instead, as a failed task
  that was never started and says `<name> was not started: <why>`, so it has a card
  with **Try again** and is run again below. A review gate that waits on such a seat
  reads `waiting on the reviewer account: <name> cannot sign in to GitHub` (or
  `waiting on the host service`), and the review starts when the check passes (the
  bridge settles the gates then, and the scheduler's sweep does again if it missed). An install run with `FLEETADLC_SCRIPTED_ENGINES=1` has no GitHub
  account behind its bots and is not held. `<name>` here is the bot's name: its
  GitHub login once its account is connected, its seat (`lead-reviewer`) until
  then.
- **A task that already failed for one of them is run again once the check turns
  green.** Only a failure whose reason plainly names the check counts (GitHub
  refusing the bot's sign-in or its access to the repository, the host service not
  answering, or the words of a task recorded above); a test that failed, a model account or a missing permission waits for
  **Try again**. It is run once per task: the claim is
  `tasks.auto_retried_at`, taken before the run and given back if the run is
  refused, and the new task cannot itself be retried this way, so a cause that comes
  back is a card again. Each is an `audit` entry, `task.auto_retried` by
  `health-recovery`, and a line in the bridge's log: `[bridge] recovered: …`
  when a health run saw the check pass, or `[bridge] merge: … run again, now
  that … passes` when the merge job's sweep ran it (a merge job fired by hand
  through `/internal/schedule/merge` returns its lines instead of logging
  them). A task
  already tried again by hand, older than seven days, or whose issue is no longer
  in the stage the task was for is left alone. It also waits, unclaimed, for what
  the dispatcher checks: an issue labelled `needs-human`, `needs-triage` or a `do:`
  label other than `do:ai` is not worked on, and a build waits for room under the
  repository's concurrency and for no build in flight on the same files. A later
  sweep runs it once nothing holds it. **Try again** from the console is not held
  by these.
- **It is run on the health run that sees the check pass, and on the merge job's
  sweep** (every ten minutes). A bot runs at most as many tasks as its **Tasks at
  once** setting (on the Crew page) allows, so when one outage failed several of
  its tasks, that many are run straight away and the rest by later sweeps as the
  bot has room. The sweep runs a task only when its check passes now
  and was fixed after the task ended; a refused connection is the host service's
  only when it was the bridge's call to it (`hostd refused: fetch failed`).

When a check cannot get an answer — a rate limit, an outage, a question
GitHub will not answer as the account asking — it neither raises a card nor
clears one: the last real answer stands. A card left standing that way says
so first, with the reason and since when, so a problem you have already fixed
is not left looking current; **Check again** asks at once.

## Stopping new work while you look

**Settings → Pause work** stops anything new from starting, across every
repository, until someone presses **Resume work**. It asks you to confirm
first. While it lasts:

- the dispatcher's leases are refused;
- a build stacked on a dependency in review does not start (an issue already
  stacked is still held if its dependency is sent back);
- a console request is kept but its triage does not start; it waits in the
  queue until work resumes;
- an issue opened, edited or labelled on GitHub is put on the board, but
  its intake (or spec) does not start: it stays in its stage, each one is
  audited as `stage.deferred`, and resuming starts them by priority, then oldest first, one
  triage at a time, with the stage sweep coming back for any left over;
- **Try again** on a task or a triage is refused, and so is any retry the
  bridge would start on its own.

Each refusal gives the pause's words: who paused it, since when, why, and
where to resume (`apps/bridge/src/pause-work.ts`).

What it does **not** stop:

- work already running, which finishes;
- the stages that follow that work on its own pull request, such as reviews,
  patch rounds and deploys;
- the merge line, so **merges still land**. To stop a pull request, hold it:
  press **Hold this PR** on an unsigned post's card, or put `needs-human` on it.
  The bridge's merge line doesn't land a held pull request. Hold this PR also
  turns GitHub's auto-merge off and keeps `review-gate` pending. The
  `bridgeMergeOff` setting (`PATCH /v1/install`) takes a repository's merges
  away from the bridge, but it leaves them to auto-merge and the branch
  rules, so it doesn't stop them landing.
- answering questions.

The pause is kept in the `workPaused` setting, which only the pause and resume
routes and a restore write; `PATCH /v1/install` refuses it. So a bridge that
restarts is still paused. A bridge that cannot read the setting as it starts
stays paused, says so in its log, and reads it again every 15 seconds. A
backup carries the pause. Restored from the console, a pause in the archive
takes effect as soon as the restore (or its undo) ends; restored with
`fleetadlc restore`, when the bridge next starts. Each pause and
resume is audited (`work.paused`, `work.resumed`; one a restore made names it
as the `source`), and while it lasts the board says who paused it and why.

Settings → Pause work is the way to pause. Don't restart the bridge with
`FLEETADLC_DISPATCH_IN_BRIDGE=0` to stop work: that is only for the integration
suites and scripted engines. A bridge without the dispatcher leases nothing,
but intake, reviews and deploys still start from GitHub's events, and Pause and
Resume don't change it. So that it is not missed, the board shows a blocking
card, "The dispatcher isn’t running: nothing will start building", Settings →
Pause work says the dispatcher isn't running, and a Build card ready to start says "Waiting: the
dispatcher isn’t running". To clear it, set `FLEETADLC_DISPATCH_IN_BRIDGE=1` and
restart the bridge (`fleetadlc down`, then `fleetadlc up`, which sets it). In the cloud
install, Terraform sets it (`infra/gcp/main.tf`), so run `fleetadlc cloud apply`
again. The card clears itself at the next check after the restart.

### Pausing some repositories and not others

Pause work can also stop chosen repositories and leave the rest running.
Choose **Chosen repositories**, tick the ones to stop, and confirm. A single
repository's page (**Settings → Repositories → its name**) has its own
**Pause** and **Resume** too. In a paused repository:

- its issues are not leased: the dispatcher passes the repository over, and
  the bridge refuses a lease for it in words naming who paused it;
- no build is stacked on a dependency in review there;
- a console request for it waits in the queue while requests for other
  repositories go ahead, and its card says it waits until the repository is
  resumed;
- intake and spec are not started on its issues (`stage.deferred`);
- **Try again** on its tasks is refused, and so is the retry the bridge starts
  after a health check passes.

A request sent with no repository is triaged, since intake is what picks one.
If intake files it into a paused repository, the issue is filed but not
leased until that repository is resumed, and the request's card says so.

Each repository's **Resume** starts what that repository held: its queued
requests, its deferred intake, and a dispatcher pass. **Resume all** lets
the repositories it lists go, and no others. While the whole install is
paused, Settings still lists the repositories paused on their own, and offers
two resumes: **Resume work, keep … paused** lifts the install's pause alone,
and **Resume everything** lets them go too. With none listed, **Resume work**
lifts the install's pause alone, so a repository paused since the page last
read the pauses stays paused. Pausing a repository that is already paused
leaves its pause as it was: who paused it, when, and why.

The dispatcher in the bridge asks the bridge's pause itself, so a paused
install or repository is passed over before any lease is taken: no lease is
taken and refused, and none counts against an issue's attempts. A dispatcher
run on its own reads the stored setting, and one that cannot read it leases
in no repository until it can. The bridge does the same with a stored value
it cannot parse: it starts with all work paused, says so, and **Resume
everything** clears it. A repository's entry whose details cannot be parsed is
still taken as paused. The
board says "Work is paused in …" and marks each paused repository; a board
filtered to one repository says it only when that one is paused.

The per-repository pauses are kept in the `workPausedRepos` setting, by
repository name, which `PATCH /v1/install` refuses as it does `workPaused`.
The routes take a list: `POST /v1/work/pause { reason?, repos? }` and
`POST /v1/work/resume { repos?, keepRepos? }`, where leaving `repos` out
means every repository, `keepRepos: true` lifts only the install's pause, and
a name OpenADLC does not work in is refused with 400. Pauses and resumes run one
at a time across bridges (an advisory lock), so two people pausing different
repositories at once both keep their pause.
`GET /v1/work/pause` answers `{ paused, repos }`. Each repository's pause and
resume is audited on its own, with `repo:<name>` as the target.

### Pausing one seat

**Pause this seat** on the Crew page stops one seat taking new work while the
rest of the crew goes on — say while its model is changed or its account is
looked at. What it is doing finishes: a running task runs on, and a task
waiting on a person's answer resumes when it gets one. Nothing new starts for
it: the dispatcher leases it nothing ("… is paused by …; nothing is leased to
it until it is resumed on the Crew page"), a paused intake leaves every
request in line without counting an attempt, and a review the gate waits on
says "waiting on a paused seat". Work only an event starts — a patch round, a
revert — is recorded with the pause's words. **Resume** starts what it held:
the queue drains, the gates start their reviews, the dispatcher looks again,
and the recorded work runs again.

It is kept in the `workPausedSeats` setting, by bot name, written only by
`POST /v1/crew/:bot/pause { reason? }` and `POST /v1/crew/:bot/resume`, which
are an admin's and audited as `seat.paused` and `seat.resumed`; `PATCH
/v1/install` refuses it, as it does `workPaused`. `GET /v1/bots`
says each seat's pause as `seatPaused`.

### Holding, putting next, or cancelling one piece of work

A work item's page has its own controls, each an admin's and audited.

- **Pause work** (`POST /v1/items/:subject/pause { reason? }`, `item.paused`) puts
  `fleetadlc:paused` on the issue and its pull request. What is running
  finishes. Nothing new starts on it: the dispatcher skips it ("held by a
  person"), the bridge refuses a new task on it in words naming who held it,
  and the merge line leaves its pull request alone. Who held it and why are
  kept in the `heldItems` setting; the board card and `GET /v1/items/:subject`
  say so as `held: {by, at, why}`. A label a person puts on by hand on GitHub
  holds only what reads it. On the issue, it stops the dispatcher and new
  tasks, and the board shows the item as held; on the pull request, it stops
  the merge line. Put `fleetadlc:paused` on both, or use **Pause work** here, which
  does. To stop only a merge, put `needs-human` on the pull request.
- **Resume work** (`POST /v1/items/:subject/resume`, `item.resumed`) takes the label
  off both and starts what the hold kept back: a dispatcher pass, the stage
  sweep, and the merge line.
- **Do next** (on a card, the icon titled *Do #N next*; **Next up · undo** once
  set; `POST /v1/items/:subject/next { on }`, `item.next`) puts
  `fleetadlc:next` on the issue. The dispatcher looks at it first in its
  repository, ahead of priority, but it still waits for work it overlaps, and
  its reason says so ("next, but declared paths overlap…"). There is one per
  repository: putting another next takes the label off the first. Cards say
  it as `next: true`.
- A pause, resume or next that GitHub refuses on the issue or its pull
  request (an outage, a rate limit, an account that lost access) fails with
  the reason and what to do, and changes nothing GitHub did not take: a
  pause the pull request refused takes the issue's label off again, and the
  board's labels and the hold record stay as they were, so what the board
  shows is what the merge line sees on GitHub. A label that is already gone
  counts as taken off.
- **Cancel work…** shows first what it will do (`GET /v1/items/:subject/cancel`:
  the issue, the pull request and its branch, unfinished tasks, open
  questions), then `POST /v1/items/:subject/cancel { reason }` (`item.cancelled`)
  takes the card off the board at once, then stops the tasks, closes their
  questions, closes the pull request unmerged with a comment, takes it out of
  the merge line, deletes its branch, closes the issue as not planned with the
  reason, and releases the lease. Both comments say who cancelled it and why,
  naming the person by the part of their sign-in before the `@`, never by
  their address; the audit entry keeps the full identity. The branch is deleted only when it is the
  crew's own for this issue (`agent/<bot>/<issue>-…`) in the issue's
  repository: a pull request from a fork, from a shared branch such as
  `develop`, or one GitHub could not be asked about keeps its branch, and the
  preview names no branch for it. Each step goes on whether the one before it
  worked; the answer lists `done` and `notDone: {step, what, why}`, so a step
  GitHub refused can be finished by hand. Work whose pull request has merged,
  or whose issue is in Merged or Done, cannot be cancelled: the bridge answers
  409 and does none of the steps, and neither the board nor the item page
  offers pause, next or cancel on it. A closed issue is never built
  again, whether it was cancelled here or closed on GitHub: the bridge refuses
  a lease on it, takes `start:now` off its row, and stops a build still
  running on it. Reopen it to have it built.

## Issues nobody labelled

An issue filed before its repository was added, or while no delivery arrived,
has no `adlc:` label. Each reconcile pass
(every 15 minutes) sends the oldest such open issue in each repository to
intake, one at a time: none starts in a repository while intake is on another
of its issues there, while the install or repository is paused, or while the
intake seat is paused. Intake treats it as an issue a person filed: it keeps
their words, asks "Here's what #N will say. OK?", then labels it. A new issue
goes the same way as soon as it is opened. Only issues by an author OpenADLC
acts for are taken; pull requests are not. The job's log says each one it
sent ("sent testbed#3 to intake: it has no stage label…").

To keep an issue out, label it `fleetadlc:ignore`. An issue intake cannot shape
— two intake runs in a week that each left it in intake — is not tried again:
the bridge records `intake.stalled` once, and Needs you shows **Intake could
not shape …**. Answer what intake asked on the issue, move it on the board
yourself, or label it `fleetadlc:ignore`.

An unlabeled issue whose author OpenADLC does not act for — a stranger, or an
old crew account with no access left — is not sent on its own. Each pass writes
them down (`unownedIssues`), Needs you shows one card per repository, **`<repo>`:
n issues OpenADLC won't take on its own**, and an admin chooses: **Send to
intake** (their say-so stands in for the author's access), **Ignore** (labels
them `fleetadlc:ignore`) or **Close** (closed as not planned, with a comment
saying who closed it, by name and never by address, and the reason they gave).
Until then intake's overlap check leaves them out, as it does any issue labelled
`fleetadlc:ignore`.

## A named reviewer does not exist or cannot review

The `repo-config` check reads each managed repository's configuration on its
default branch — `AGENTS.md`, `CODEOWNERS` (at the root, in `.github/` and in
`docs/`), `.github/pull_request_template.md`, the `ci` workflow and the
`Makefile` — and asks GitHub about every login they name, as the automation
account (`apps/bridge/src/health/checks/repo-config.ts`). A login in
`AGENTS.md`'s `## Human review` or a code owner is a reviewer: it has to be an
account, and a collaborator on the repository (which includes organization
members who reach it through a team or the base permission). Any other
`@login` in their prose, or in a comment of the workflow or the Makefile, only
has to be an account, and one that is not is a warning; GitHub is asked only
whether it exists. Mentions inside HTML comments, code blocks and inline code
are not read.

The card names the file and line, and its buttons go where the fix is done:

| The card says | What to do |
|---|---|
| … doesn’t say who approves its human-review paths yet — line N still has the template’s `@owner` | Say who approves on the walkthrough's **Protect the repositories** step, which writes them into AGENTS.md, or **Open `AGENTS.md` on GitHub** at the line and replace `@owner` with the logins who must approve these paths, or remove the line. GitHub has an organization called `owner`, which can never review; nobody is to be invited |
| … but there is no such GitHub account | **Open `<file>` on GitHub**, at the line, and change or remove the name on the default branch. A typo is the usual cause |
| … but `<login>` is an organization, not a person | **Open `<file>` on GitHub** and name the people who must approve instead. An organization cannot be invited or review; in `CODEOWNERS`, a team is written `@<org>/<team>` |
| … but cannot review: `<login>` is not a collaborator on `<repo>` · … has triage (or read) on `<repo>`, and an approval counts only from write or more | **Give `<login>` write access** opens the repository's Collaborators and teams page: invite them with write and have them accept, or, for someone who already has access, raise their role to Write, Maintain or Admin. Or change the name, as above |
| `<login>` is one of this install’s people (FLEETADLC_HUMANS) … | Correct the list where it is kept. A list saved in the console (the Protect the repositories step's approvers) wins over `FLEETADLC_HUMANS`, and Settings has no field for it yet: as an admin, send `PATCH /v1/install {"humans": "<login>,…"}`; an empty value clears it, and `FLEETADLC_HUMANS` applies again. Without a saved list, fix `humans` in `install.json` or `FLEETADLC_HUMANS` and restart the bridge. Then fix any `AGENTS.md` or `CODEOWNERS` that names the old login |

A pull request needing such a reviewer does not wait in silence: its
`review-gate` fails with `<login> cannot be asked for a review: <reason>`
instead of saying `waiting on <login>` (for `@owner`: `it is the AGENTS.md
template’s placeholder; name who must approve`). When the bridge asks GitHub for a
crew reviewer and GitHub refuses (`Could not resolve user with login …`, or
not a collaborator), the others are still asked, the gate says the same, and
the bridge log and the audit (`review.request_refused`) keep GitHub's words.

GitHub's answers are kept for an hour and asked afresh by the check, so
pull requests do not each ask. When GitHub cannot be asked — a rate limit, an
outage — nothing is called missing: the check says it could not verify, the
gate keeps its usual words, and the gates do not ask about that login again
for five minutes. What GitHub refused about a crew seat is forgotten when the
crew's access changes or the `bot-access` check recovers. Once the file is
corrected or the person can write to the repository, the next run (at once when a pull request
merged into the default branch changes the file, or **Check again**) passes,
the card goes to recovered, and the gates are worked out again. A file pushed
straight to the default branch is seen at the next half-hourly run: the app is
not subscribed to `push`.
The **Protect the repositories** step also runs the check as soon as it writes.

## `review-gate` says it cannot read every file a pull request changes

`review-gate` is pending with `cannot read every file this pull request
changes` when GitHub answered an error as the bridge listed the pull request's
files, or the list stopped at GitHub's 3000. Who must review comes from the
paths it changes, so a partial or empty list could leave out a person
`AGENTS.md` names, and the gate holds rather than go green on the bots'
approvals alone. When it happens as the pull request opens, the people's
review requests and `review:human:*` labels are left as they are.

An error is usually GitHub having a bad moment: the gate is worked out again at
the next sweep, review or push, and clears once the list reads. A pull request
with more than 3000 files never clears; split it into smaller ones. The merge
line refuses such a pull request too.

Whether someone can review is asked as the app, by their permission on the
repository (`/collaborators/<login>/permission`): that counts an organization's
owners, teams and base permissions, and write or more can approve. Triage and
read cannot, and the card and the `review-gate` say which they have: raise
their role to Write, Maintain or Admin on the repository's Collaborators and
teams page.

## GitHub answers 403 "Resource not accessible by integration"

**What it means.** The OpenADLC GitHub App lacks a permission. The message reads like
a limit of app tokens and is not one: GitHub names the permission it wanted in
the `x-accepted-github-permissions` header of the same response, and with that
permission granted the identical call succeeds. Measured on a bot accepting its
own repository invitation (`packages/github/src/invitations.ts`):

```
PATCH /user/repository_invitations/<invitation-id>
403  {"message":"Resource not accessible by integration"}
x-accepted-github-permissions: administration=write
```

**What to do.** Read the `app-permissions` card. It compares what GitHub says the
app holds with what this version of OpenADLC asks for (`MANIFEST_PERMISSIONS` in
`packages/shared/src/app-manifest.ts`) and names a missing one the way the app's
page does: “SSH signing keys”, under Account permissions. Add it on the page the
card opens. GitHub then asks the account that installed the app to accept the
change, and until it does the installation works without it — a second card,
“The OpenADLC app’s new permissions are waiting to be accepted on …”. An Account
permission reaches a bot only when it reconnects.

“Checks” is the exception: it is optional. With it, `review-gate` is a check
run only the app can set; without it, the same gate is a commit status the
app sets, and the merge line reads that status, by the app's own login, and no
one else's. Where both exist on a head, it reads the more restrictive of the
two. It matters only where GitHub holds a required check, so it is raised, as an amber
notice rather than a stop, only when at least one repository enforces
rulesets: a public one, or a private one on a paid plan. On an install whose
repositories are all private on a plan that refuses rulesets, nothing is
raised for it. Which repositories enforce rulesets is read from the last
repository plan (`RepoSetup.enforcesRules`), not asked of GitHub again.

OpenADLC's REST client keeps the header on a 403, and the card names the
permission (`packages/github/src/client.ts`, `apps/bridge/src/failure-words.ts`).
A card that says the app lacks “a permission this needs” without naming one
came from a refusal whose text had no header, such as a `gh` command in a bot's
session or a GraphQL error. Repeat that call and read the header. Run it in a
session of the bot that was refused (the console's Terminal tab, or `fleetadlc
attach <bot name> <session>`), where `$GH_TOKEN` is that bot's token:

```bash
curl -sD- -o /dev/null -X PATCH -H "authorization: Bearer $GH_TOKEN" \
  https://api.github.com/user/repository_invitations/<id>   # prints the headers
```

Your own `gh auth token` or a personal token gets a different answer. Never
refresh a bot's token by hand: GitHub rotates the refresh token on every use,
and the bot is disconnected until it signs in again.

Without `Administration: read and write` the app cannot invite a bot, a bot
cannot accept its own invitation, and the repository's rules cannot be applied.

## A model account is signed out or refused

**What you see.** A `model-account` card — “The xAI subscription is signed out”,
“No token is stored for the Anthropic subscription”, “OpenAI refuses the key” —
or a failed task whose card says the account its bot thinks with is signed out.
All of it is fixed in **Settings → AI models** (`/settings#models`), or on the
walkthrough's **Foundation model accounts / API keys** step, `/onboarding?step=models`, which is the same
screen. There **check again** sends one short prompt through the account's
CLI, holding exactly the credential a session would get, and each verified
account says which models it offers.

- **Claude: the token is refused when it is saved.** `claude setup-token` prints
  one line starting `sk-ant-oat`. Copied out of a terminal that wrapped it, it
  has a line break in the middle, and stored like that it would fail every task
  with an error that says nothing about why — so the field refuses it (“that has
  a space or a line break in it”). Copy it again as one line
  (`apps/bridge/src/model-accounts.ts`). A session gets it as
  `CLAUDE_CODE_OAUTH_TOKEN` and never with `ANTHROPIC_API_KEY` beside it, which
  Claude Code would use instead and bill to the API
  (`apps/hostd/src/session-env.ts`).
- **Codex or Grok: the sign-in expired.** **Sign in** runs the CLI's own
  `login --device-auth` — under the `docker` driver in a throwaway
  `fleetadlc-login-<account id>` container from the bot image — and shows the link
  and the code. The code lasts fifteen minutes, and hostd stops an unfinished
  sign-in then: “the sign-in was not finished within 15 minutes, so its code has
  expired”. **Sign in again** gets a new code. “the CLI printed no sign-in link”
  means none came within 45 seconds; the CLI's last words follow it
  (`apps/hostd/src/logins.ts`).
- **Grok: signed out on the first ask.** `grok models` refreshes an expired
  sign-in while it answers, and answers from before the refresh: it prints “You
  are not authenticated.” and exits 0, and its own log records the refresh a
  moment later. A task start once refused a seat that was signed in, and the
  account's card went red and green with nobody touching it. hostd now asks
  twice before it believes it (`listCliModels` in `apps/hostd/src/logins.ts`);
  signed out after two asks is signed out, and needs **Sign in again**.
- **A key: refused.** The check lists what the key can call, with the key. A 401
  is the provider refusing it; replace it.

## Codex fails with "bwrap: No permissions to create a new namespace"

**What it means.** Codex sandboxes each command with bubblewrap, which needs a
user namespace an unprivileged container cannot make, so every command a Codex
reviewer runs fails and it gives up without reviewing. In a bot's container the
container is the sandbox: Codex runs there with `--sandbox danger-full-access`,
and keeps its own sandbox beside hostd. It tells the two apart by
`FLEETADLC_CONTAINED`, which the base environment of every container session sets to
`1` (`packages/engines/src/codex.ts`, `apps/hostd/src/drivers/base-env.ts`).

**What to do.** Under the `docker` driver, a session without `FLEETADLC_CONTAINED=1`
runs an old build: `git pull && pnpm install && pnpm build`,
then `fleetadlc down && fleetadlc up`. The `local` driver never sets it: Codex keeps its
own sandbox there, and on a Linux host that cannot make a user namespace it
fails the same way.

## Webhooks do not arrive

**What you see.** The board lags GitHub by up to a quarter of an hour — how often
the reconcile job reads it — and bots start late or not at all. `fleetadlc doctor`
may say “GitHub has never delivered anything to this install”, or how many hours
ago the last delivery was.

**What it means.** On a laptop, GitHub reaches the bridge through a cloudflared
quick tunnel the bridge runs itself (`apps/bridge/src/tunnel.ts`). A quick tunnel
is a new hostname every time one starts, and its address dies with the process
that raised it. So at every start the bridge raises a new one and points the
GitHub App's webhook at it, keeping the secret — when the stored address is a
quick tunnel's, `cloudflared` is on the PATH, and OpenADLC holds the app's private
key (`resume()` in `apps/bridge/src/webhook-setup.ts`). The bridge's log says
`tunnel back up at https://….trycloudflare.com` when it worked. The tunnel
reaches a gateway that forwards only `POST /webhooks/github`, never the bridge
itself (`apps/bridge/src/webhook-gateway.ts`).

The `webhook` check reads GitHub's own list of what it delivered, beside what
happened on GitHub that nothing was delivered for. Its step is
`/onboarding?step=webhook`.

| Its card says | What to do |
|---|---|
| GitHub is delivering to a tunnel that has stopped | Raise a new one on the webhook step; OpenADLC points the app at it |
| GitHub has nowhere to deliver to | Give the bridge an address on the webhook step |
| GitHub delivers somewhere other than this bridge · The app’s webhook is not set up for this bridge | Set it up again on the step, which writes the address and the secret to both sides |
| OpenADLC refuses what GitHub delivers | GitHub signs with a secret OpenADLC does not hold (401); set it up again on the step |
| GitHub is not sending events to OpenADLC | Open the app's settings and turn on **Active** under Webhook |

The last is the one switch no API reaches: an app created before the install had
an address is created with its webhook off, and everything OpenADLC can set is then
right while GitHub sends nothing. Without `cloudflared` the step says
`cloudflared is not installed`; on a Mac, `brew install cloudflared`, and on Linux,
Cloudflare's `cloudflared` package for your distribution. Or give the bridge a
public address instead.
`fleetadlc doctor` also says when no webhook secret is configured, so every delivery
is refused, and when the database, `install.json` and `FLEETADLC_WEBHOOK_SECRET`
differ.

## A service stopped, or keeps stopping

**What it means.** The console once went offline overnight with nothing in its
log, because a service that died stayed dead. `fleetadlc up` now runs hostd, the
bridge and the console each under a keeper (`apps/cli/src/keep-running.ts`) that
writes how the service ended to its log and starts it again, waiting a second,
then twice as long each time, up to thirty. Five exits in a row, each within ten
seconds of starting, will not be fixed by a sixth start, so the keeper stops:

```
[fleetadlc] bridge exited with code 1 after 3m; starting it again in 1s
[fleetadlc] bridge exited with code 1 5 times in a row, each within 10s of starting; not starting it again. Run `fleetadlc up` once whatever stops it is fixed.
```

**What to do.**

```bash
tail -n 50 "$(fleetadlc logs bridge)"   # how it ended, and what it said before
fleetadlc down && fleetadlc up          # restart everything; `up` alone starts only what is not running
```

**Rebuilding restarts nothing.** `pnpm build` rewrites the code on disk; each
running service keeps what it loaded, and `fleetadlc up` leaves a running service
alone (`already running (pid …)`). The console shows it plainly: `next start`
goes on serving the build it started with, the rebuild has replaced the files
that build refers to, and pages fail with `ChunkLoadError` until it restarts.
After a build, `fleetadlc down && fleetadlc up`.

**`bridge was not running (stale pid file removed)`.** `fleetadlc up` writes each
keeper's pid to `run/<service>.pid` under `FLEETADLC_HOME`, and the keeper removes
it when it exits. A reboot or a killed keeper leaves the file behind, and by
then its number may be some other program's. OpenADLC takes a pid for a service
only while its command line is that service's keeper (`keep.js bridge …`); any
other pid file is removed, never signalled, and `fleetadlc down` says so with
this line. Nothing needs doing: `fleetadlc up` starts the service as usual.

## The console is a blank page under a LAN name or a tunnel

**What it means.** The console and the bridge answer only under names the
install is served under: loopback, an address, and the configured URLs. Any
other name gets `421 Misdirected Request` with no body, on every path, so a page
on a name rebound to this machine learns nothing. Opened as
`http://mybox.lan:47300`, the console is a blank page, and its log says why,
once per name:

```
[console] refusing requests for Host "mybox.lan:47300": not a name this install is served under. If people do open the console under it, add it to "allowedHosts" in install.json (FLEETADLC_ALLOWED_HOSTS) and restart.
```

**What to do.** If people do open OpenADLC under that name, add it to
`allowedHosts` in `~/.fleetadlc/install.json` and run
`fleetadlc down && fleetadlc up`. Otherwise open the console at the address
`fleetadlc status` gives. See [security.md](security.md#a-page-on-another-origin).

## A port is already in use

**What you see.** `fleetadlc up` ends with `OpenADLC is partly up` after one of these,
and `fleetadlc status` says the service is answering but not started by this install:

```
✗ bridge: something is already serving http://127.0.0.1:47311/healthz that this install did not start
✗ bridge exited but http://127.0.0.1:47311/healthz still answers, so another process holds the port
```

**What it means.** A new service beside an old one dies of `EADDRINUSE` while the
old one passes its health check, and the install would report itself up having
started nothing. So `fleetadlc up` asks 47300 (console), 47311 (bridge) and
47312 (hostd) before starting each service, and confirms afterwards that the
process it started is the one answering (`apps/cli/src/commands/up.ts`).
Postgres is not asked: it is reached at `install.json`'s `databaseUrl` (47432
by default), and a server there that is not this install's ends `fleetadlc up`
with `cannot reach postgres`. Under the docker driver hostd also publishes its
task database server (`fleetadlc-taskdb`) on 47433, which no setting moves; a
conflict there shows in hostd's log as `task … gets no database`.

**What to do.** Find what holds the port. It is usually the same services,
started under another `FLEETADLC_HOME`, and `fleetadlc down` there stops them:

```bash
lsof -nP -iTCP:47311 -sTCP:LISTEN               # what is listening
FLEETADLC_HOME=/path/to/other fleetadlc down    # stop the install that owns it
```

To move instead, change `ports` in `install.json` and run `fleetadlc down && fleetadlc up`:
every service, the console included, reads its addresses when it starts, and
links in notifications follow the console's port. One thing does not follow
on its own: take-over connects the browser to hostd at
`NEXT_PUBLIC_FLEETADLC_TERMINAL_URL`, or port 47312 when that is empty. The
console reads it when it starts, so when hostd moves, start the console with
it set:

```bash
export NEXT_PUBLIC_FLEETADLC_TERMINAL_URL=ws://127.0.0.1:<hostd port>
fleetadlc down && fleetadlc up
```

It is not kept in `install.json`, and neither is `FLEETADLC_CONSOLE_URL`:
export them in every shell that runs `fleetadlc up`.

When take-over cannot connect, the Computer tab names the address it tried.

Moving Postgres means changing the port in `databaseUrl` as well as
`ports.postgres`: `install.json` keeps the two apart. The database's data does
not follow either. The container `fleetadlc up` made (`fleetadlc-db`) still
publishes the old port, and `up` stops and says so; to keep using it, set both
back to the port it publishes. Removing it makes the next `up` start a new,
empty database.

## OpenADLC is looking at a different install

**What you see.** Services that answer but were not started by this install, or
an exported setting that changes nothing.

**What it means.** An install is everything under `FLEETADLC_HOME`, `~/.fleetadlc` by
default: `install.json`, `secrets/`, the pid files and logs in `run/`, the bots'
`work/` and the subscriptions' `logins/`. A stale `FLEETADLC_HOME` in the environment
is an invisible way to talk to another install, which is why `fleetadlc status` names
the one it read first, and `fleetadlc up` and `fleetadlc down` say `state under <path>`.
`install.json` also decides two things a shell cannot:

- **The services' settings.** `fleetadlc up` lays the file's values over the
  environment for what `serviceEnv` writes (`apps/cli/src/install.ts`: the
  database, the ports and URLs, the driver and the like), so an exported
  `FLEETADLC_HOSTD_DRIVER`, `DATABASE_URL` or port never reaches a service.
  Change the file, or run `fleetadlc init --driver docker`. Any other
  `FLEETADLC_*` you export — `FLEETADLC_CONSOLE_URL`, `FLEETADLC_BOT_PREFIX`,
  `FLEETADLC_BOT_IMAGE`, `FLEETADLC_JOB_<NAME>_MINUTES` — still reaches them, so
  check `env | grep -E '^(FLEETADLC_|DATABASE_URL)'` first and unset what
  belongs to another install.
- **The database the CLI's own commands open.** `doctor`, `status`, `auth`,
  `backup`, `restore`, `seed` and `github` connect from the CLI's process. An
  exported `DATABASE_URL` that differs from the file's `databaseUrl` would
  have them act on another database than the services', so they refuse it:
  `✗ DATABASE_URL in this shell is <url>, but the install at <path> uses
  <url>. Run: unset DATABASE_URL`. Run `unset DATABASE_URL` and the command
  again. Without an `install.json` (the compose stack, the cloud host) the
  exported one is used, as those set it.
- **The checkout that runs.** Services start from the file's `repoRoot`,
  no matter which checkout `fleetadlc` was run from, so building another checkout changes
  nothing that runs.

```bash
fleetadlc status                                                       # Install at <path>, then the database it opens
grep '"repoRoot"' "${FLEETADLC_HOME:-$HOME/.fleetadlc}/install.json"   # the checkout that runs
```

## A task stops on "This command requires approval"

**What it means.** A task runs headless, and nobody is there to approve anything.
Claude Code and Grok Build are given the skill's `crew/skills/<skill>/tools.yaml` as
permission rules, each allowed command as `Bash(<command>:*)`, and refuse what is
not listed: Claude Code says “This command requires approval”, Grok “denied by
prompt policy (tool not pre-approved)” (`packages/engines/src/claude.ts`,
`grok.ts`). Codex takes no list; a skill that allows any command gets a sandbox
that can run commands (`codex.ts`). Every refusal is a turn paid for — a triage
bot once tried `git rev-parse HEAD` seven times — so the task's brief names the
commands it may run and the files it may write before it starts (`buildPrompt` in
`apps/hostd/src/skill-runner.ts`).

**What to do.** If the skill should run the command, add it to `allow.shell` in
its `tools.yaml`; the next task reads it, and nothing has to restart. If not, the
skill needs another way to do the work. A listed command can still be refused
for its shape:

- **A body on the command line.** Claude Code's own shell checks refuse a quoted
  argument with a line starting `#`, which every Markdown heading is, and braces
  beside quotes, which every `fleetadlc:` marker has. So a skill writes the body to a
  file with its file tool and passes the file,
  `gh issue create --body-file .fleetadlc-scratch/issue.md`. Triage's
  `write_within` names `.fleetadlc-scratch/**`, which is what gives it a file
  tool (`crew/skills/triage/tools.yaml`).
- **A chain.** Grok runs `a && b` only when every part is allowed, and refuses
  `$(…)`, subshells, loops and `bash -c` whole.

## A card is stuck in a column

Every card has one status line, made from live state — the tasks on it, the
question open on it, its place in the line to merge — never from a setting
(`apps/console/src/lib/card-status.ts`). What needs a person comes first.

| Status line | What it means | Where the reason is |
|---|---|---|
| Waiting for your answer | A bot asked | **Needs you**, or the question's comment on GitHub |
| Could not finish · needs you · Review failed · needs you | The last task failed and nothing ran it again | Its **Needs you** card, and the bot's thread |
| Stopped after N rounds · needs you | Reviews did not converge within `maxRounds` (`config/review.yaml`) | The pull request: a person decides |
| Waiting for intake · Waiting for a design pass | Nobody is on it yet | The hourly stage sweep; the bridge log |
| Not ready to build yet | No `start:now` label | The issue's labels |
| Waiting for triage | Sent back: it lacks a priority, an area, one `do:` label, one of its four sections or an expected path, or three builds ran and produced no pull request. Only builds that started and ended on their own count: a lease the bridge refused, one whose task never started, and a build that was stopped (by a person, or by its host going away) do not. Once the issue says what it wants, take `needs-triage` off and put `start:now` back: it gets three fresh attempts | The issue, and its "Not routable yet" comment |
| Waiting on #N | A dependency named in the issue has not shipped | That issue |
| Next up · Waiting its turn | Routable, and no builder has taken it | The bridge log's dispatch lines |
| Waiting: the dispatcher isn’t running | Routable, but the bridge was started without `FLEETADLC_DISPATCH_IN_BRIDGE=1`, so nothing leases it | The `dispatcher` card on the board; see [Stopping new work while you look](#stopping-new-work-while-you-look) |
| Approved · 2nd in line to merge · Catching up with main… | The merge line | A `repo-rules` card, if nothing lands |
| Approved · waiting for you to merge it | Only a person can land it | Its **Needs you** card says why |
| Checks running before it merges | CI on its head, or the merge line held at the GitHub Actions minutes cap | The pull request's checks; Costs, and [the cap](#a-pull-request-waits-on-github-actions-minutes-this-month-reached-the-cap) |
| Waiting for the reviewers | A review seat asked has not posted on this diff | The pull request, and the reviewer's thread |
| Live on testing · waiting for production | The production environment's required reviewer, or its soak timer | The repository's deployments page; Settings → Repositories |
| Waiting until `<repo>` is resumed | The repository is paused | Settings → Pause work |
| Merged · waiting to deploy | No `deployed:testing` yet, in a repository that has a testing deploy | Settings → Repositories: how it ships, and where the rules came from; the bridge log's `dispatched deploy-testing` or `not dispatched` line |

A repository whose delivery rules say `testing: on: none` does not sit on that
line. That is set in its `.github/fleetadlc.yml` or, without that file, by
Settings → Repositories → Testing deploy (**No testing deploy**, or
**Automatic** with no `deploy-testing` workflow). The deploy sweep moves its
`adlc:merged` issues to Done and starts no SRE task. With the file present,
the Settings choice is not read: change the file by a pull request. Settings →
Repositories shows which source the rules came from. OpenADLC does not read
the `FLEETADLC_DEPLOY_TESTING` Actions variable.
In a repository that does have a testing deploy, a closed issue stays in Ship:
GitHub closes the issue at `Closes #N` before the deploy has run.

A merge moves every issue the pull request finishes: the one its branch was cut
for (`agent/<bot>/<issue>-…`) and each one it closes, as GitHub lists them — a
`Closes`, `Fixes` or `Resolves #N` in its body, or an issue linked in its
sidebar. So a pull request from any branch moves its issue. An issue is moved
only when OpenADLC already tracks it and it is not labelled `fleetadlc:ignore`,
the branch's own included; the bridge log says `closes …, which OpenADLC does
not track`, `not moved: …` or `was not moved to …` for the rest. The pull request is recorded on each one
moved, which is how the deploys after the merge label it and production moves
it to Done. When GitHub cannot list them, the bridge log says `GitHub could not
say which issues … closes, so they were read from its body`, and the body's keywords outside code and quotes are used
instead, on a pull request into the default branch only. An issue left in its
old column after a merge was named in none of these; move it by hand.

The dispatcher logs why it passed work over: a builder that cannot sign in, one
whose signing key GitHub does not know in a repository that requires signed
commits (`apps/dispatcher/src/hold.ts`), paths that overlap work in flight, or
the month's spend at its cap. An overlap says whether it holds because the
other change is being built (`, being built`) or because the path is exclusive
(`, an exclusive path in review`); a shared path never holds anything, and the
repository's `paths:` in `.github/fleetadlc.yml` says which are which (see
[configuration](configuration.md)). A stage whose bot could not be started says why:

```bash
grep 'dispatch, for' "$(fleetadlc logs bridge)" | tail -n 20    # leased or skipped, and why
grep 'not staffed for' "$(fleetadlc logs bridge)" | tail -n 5   # why a stage's bot did not start
```

Every staffed stage is swept hourly, and a builder that failed before opening a
pull request has its lease let go after fifteen minutes. A lease a question paused
is let go when its task ends, or put back to wait for its pull request when one is
open or the task finished; the reconciler sweeps any left paused with no task
still going under it. A question still open on a task that has already ended is
closed then, since answering it would resume nothing. To sweep now:

```bash
SECRET="$(cat "${FLEETADLC_HOME:-$HOME/.fleetadlc}/secrets/internal-api-secret.secret")"
curl -X POST -H "x-fleetadlc-internal-secret: $SECRET" \
  http://127.0.0.1:47311/internal/schedule/stages   # or reconcile, merge, deploy
```

## Work moves slowly: reading Insights

**Insights** (`/insights`, `GET /v1/insights?repo=&days=7|30`) says, for each
repository or all of them, over the last 7 or 30 days:

- **Merged** and per day, and the median time from a request (or an issue's
  first stage) to its merge.
- **Time in each stage** at the median — intake, design, build, review, and the
  merge line — over the stays that ended in the period. The stage that
  dominates is where to look.
- **What work waited on**: each file an issue waited on because another issue
  in flight touched it, how many builds it held up and for how long, split by
  why (a file only one change may touch at a time, or one being built). A file
  that held up three or more builds is suggested for splitting — a Makefile
  into `mk/*.mk`, a README into per-feature pages — so each change adds a file
  rather than editing a shared one.
- **Conflicts at merge** — resolved with the lead re-checking, reviewed again in
  full, or sent back to build — and **send-backs** by the stage they left.
- **Builds at once**: the most at one moment, and the average while any ran. A
  maximum of 1 with work waiting is a repository whose `concurrency`, or whose
  files, keep it to one build.

Waiting and conflicts are read from the `overlap.*` and `conflict.*` events the
dispatcher and the merge line write; an install older than them shows none.

## A pull request conflicts with main, or waits on another one

A branch that conflicts with the base at the front of the merge line leaves
the line and gets a **resolution round**. The pull request says which files
conflict, and the builder resolves only those (`resolve-conflict`). It does not
go back to Build.

- **Only the lead reviewed it again.** Every conflicted file was shared:
  `paths.shared` in `.github/fleetadlc.yml`, or the defaults (`README*`,
  `CHANGELOG*`, `docs/**/index*`, `.gitignore`, and others). The other
  approvals stand for the new head, but the lead's does not: the pull request
  waits in review, with `review-gate` pending, until the lead approves the
  resolution head itself. To have a file always reviewed in full after a
  conflict, leave it out of `paths.shared`.
- **Every reviewer was asked again.** A conflicted file is not shared; or it
  is one that can decide how CI runs (the Makefile, a `package.json`, a
  `tsconfig*.json`, anything under `.github/`) or `AGENTS.md`, which are
  always reviewed in full whatever `paths.shared` says; or
  `.github/fleetadlc.yml` could not be read or does not parse; or the
  resolution changed something beyond the conflicted files and what the base
  brought, as the base has it, such as a file the pull request already
  changed; or GitHub could not compare the two heads. The
  `conflict.sent_back` event says which (`why`).
- **It went back to Build after all.** No builder held the issue's lease, or
  GitHub's comparison could not name the conflicted files. The round falls back
  to the whole send-back and records `conflict.sent_back` with the reason.

An issue whose one unshipped dependency is in review is **stacked**: it is
built from that pull request's branch rather than waiting. Its card then
behaves like this:

- **It was approved, but does not join the line.** It waits for the
  dependency to merge, however long it stays in review; the bridge log says
  `waits for #N, which it was built on, to merge`. While the bridge cannot
  read what it was built on (the `stacks` table), it waits too, and the log
  says `whether it was built on another pull request could not be read`; the
  gate sweep asks again every ten minutes. The line then brings it up to date, and its approvals stand
  for the merge commit the line made, and for no other push.
- **Its update conflicted, and it was reviewed again.** The line's own merge
  of the base conflicted, so it made nothing and the pull request got a
  resolution round like any other. The builder's resolution is reviewed as
  that round says (above): by the lead alone, or by every reviewer again.
- **It is held (`fleetadlc:paused`) with a note.** The dependency was sent back
  to build, so what it was built on is changing. Resume it from its card once
  the dependency is settled, or cancel it and let it be built again from main.
  The note says instead that the dependency **was closed without merging**
  when its issue was closed with its pull request unmerged: the dependency's
  commits are in this branch and will not land, so redo it from main, or
  resume it once that work lands another way. A dependency that merged is
  never a reason to hold it.
- **Turning it off.** Set `stacking: false` in the repository's
  `.github/fleetadlc.yml`; the issue then waits for its dependency to ship, as
  before.

```bash
grep -E 'resolution round|waits for #|stacked on' "$(fleetadlc logs bridge)" | tail -n 20
```

## A pull request waits on "GitHub Actions minutes this month reached the cap"

The card in Review reads "Checks running before it merges" though no CI run
has started on GitHub, and Costs shows the month's minutes against the cap,
reached. Somebody set a monthly cap on GitHub Actions minutes (Costs → GitHub
Actions minutes → Monthly cap), and the repositories billed that many this
month. The merge line asks for no new CI run until the cap is raised, cleared
(empty) or the month turns; a run it already asked for finishes, and nothing
else stops: builds and reviews go on, and their pull requests wait at the front
of the line.

The minutes are counted from each completed workflow run's jobs as GitHub bills
them, each job rounded up to a whole minute, a Windows minute counted as two
and a macOS minute as ten; a public repository's runs are counted and not
billed. The dollars beside them are an estimate at GitHub's Linux list price
($0.006 a minute on 2026-10-04, `USD_PER_LINUX_MINUTE` in
`apps/bridge/src/ci-usage.ts`), before what your plan includes. A run whose jobs could not be read (the automation account
disconnected) is not counted, and the bridge log says which.

## A merge did not deploy, or production did not wait

The bridge dispatches each deploy workflow as the app, or as the automation
account where the app cannot act on the repository, by the repository's
`.github/fleetadlc.yml`, and says what it did in the log: `dispatched
deploy-testing`, or `not dispatched (…); the deploy sweep tries again`.
Settings → Repositories shows the rules it read and where they came from — a
file that did not parse is said there, with its error, and the fallback is
used instead.

A dispatch GitHub refuses or does not answer is given back, and the deploy
sweep dispatches it again every few minutes: the testing deploy of the newest
merge, a promote once the smoke passed (only for the repository's newest
commit, and by the rules as they are then — none if they no longer promote, a
soak if the bridge holds one), and a rollback a failed traffic shift owes
(not once a newer commit has been promoted). One still not dispatched a
quarter of an hour after it was due is a **`deploy-dispatch`** card with the
repository, the commit, the workflow and GitHub's reason: a warning for a
promote, blocking for a rollback. It goes once the step is dispatched. The
issue a failed traffic shift files says the rollback was dispatched only when
it was; otherwise it says why not, and that the sweep tries again.

- **`not dispatched … Workflow does not have 'workflow_dispatch' trigger`** —
  the workflow the rules name cannot be dispatched. Give it a
  `workflow_dispatch` trigger with the input the rules send (`sha` for testing,
  `candidate` for production); the templates in `crew/templates/repo/` have them.
- **`neither the app nor the automation account can act here`** — install the
  app on the repository, or connect the automation account.
- **`its delivery rules could not be read (…); nothing dispatched`** — GitHub
  did not answer for `.github/fleetadlc.yml` (a 5xx, a rate limit, the network),
  or the repository's stored rules could not be read. The bridge waits rather
  than act on the fallback, which may promote a repository that soaks, or deploy
  one that ships by merging: it keeps the last rules it read where it has them,
  and otherwise takes the step once a read works. Stacking skips that
  repository for the pass, and says so.
- **A promote ran with nobody approving it** — the `production` environment has
  no required reviewer though the rules say `approval: reviewers`. The
  `production-rules` card says so and opens the walkthrough's Protect step:
  choose how production ships there, naming who approves it, or ship
  automatically after testing (`fleetadlc github apply --production reviewers
  --reviewer <login>` from a terminal). Running the apply again without
  naming anybody changes nothing: it never writes an empty reviewer list. If
  apply says it `could not resolve <login> to a GitHub user`, that login is
  not a person's GitHub account (a typo, an organization, a bot): correct it
  and apply again; to add a reviewer by hand, open the repository's Settings →
  Environments → production → Required reviewers. On a private
  repository below GitHub Enterprise, GitHub holds no reviewer at all, so
  OpenADLC holds each promote itself: it waits in Needs you, and nothing goes
  to production until an admin presses **Release to production** or **Switch
  to automatic delivery**.
- **A promote waits in Needs you** — that hold. Release it once you have
  looked at testing (the QA run's readiness report, if there is one). If you
  want production to follow testing on its own, switch the repository to
  automatic: a soak of at least 30 minutes on testing, the smoke, and an
  automatic rollback. Where `.github/fleetadlc.yml` sets the rules, set
  `production.approval: auto` there; the card opens the file.
- **A crew account can approve a production deploy** — the `production-rules`
  card, blocking. Take the crew out of the environment's required reviewers in
  the repository's Settings → Environments → production. A bot never approves a
  deploy; the repository's GitHub rules do.
- **`@<org>/<slug>` is a team among its production reviewers** — the
  `production-rules` check has no answer, rather than passing: any member of a
  reviewer team may approve, and OpenADLC cannot see who is in it. Confirm on
  the organization's Teams page that no crew account is a member.

## Something is left after removing a repository

**Settings → the repository → Remove from OpenADLC** opens a review step first. It
lists what OpenADLC has going there now: running, queued and paused tasks with the
question a paused one waits on, the claims (leases) on its issues, the crew's
accounts that are collaborators or invited, OpenADLC's labels, and whether the
GitHub App still reaches it. Nothing changes until you confirm.

Removing it then, in order:

| Step | What happens | Audited as |
|---|---|---|
| Mark it removed | Nothing new starts there, and it leaves the board and Needs you | `repo.removed`, with every step's outcome |
| Stop its work | Each queued, running or paused task is stopped the way Stop on its card stops one, and a question it waited on is closed | `task.stopped`, reason `repository removed from OpenADLC by <who>`; `gate.expired` |
| Close its questions | Any other question still open there | `gate.expired` |
| Release its leases | Every claim on its issues | `lease.released` |
| The crew's access (on by default) | The crew's accounts come off its direct collaborators, and their invitations are cancelled | `repo.crew_removed` |
| OpenADLC's labels (off by default) | Every label named in `config/labels.json`, and the older names of renamed ones (`sdlc:*`, `fleet:ignore`), is deleted, which also takes it off every issue and pull request. Generic names the repository may have had first (`blocked`, `deps`, `safety`, `revert`, `breaking`, `incident`, `needs-triage`, `needs-human`), and labels that only start like OpenADLC's (`priority:high`), are listed apart and deleted only when that is ticked too | `repo.labels_removed` |

Its CI, deploy workflows, environments and Actions variables are never touched,
nor are its issues, pull requests and branches. **Add a repository** brings it
back with its settings, and the crew's access and the labels are set up again
as when it was first added.

A step that fails does not stop the others, and the repository is removed all
the same. The dialog then lists what is left, why, and what finishes it; the
`repo.removed` audit entry lists the same under `notDone`:

- **A task still running or paused**, or a question or lease still held: hostd
  did not answer, or the database refused. **Remove from OpenADLC again** in the
  same dialog does what is left; it is safe to run on a repository already
  removed.
- **An account still a collaborator:** GitHub refused, usually because the app
  lacks `Administration: read and write`. Remove it on the repository's
  **Settings → Collaborators** page, which the line links to.
- **An invitation still pending:** GitHub lets only an admin of the repository
  list invitations, so OpenADLC finds their ids through `gh` signed in as you on
  the machine running OpenADLC. Without it, cancel the invitation on the same page.
- **The GitHub App still reaches it:** the app is installed on all of the
  account's repositories. OpenADLC cannot narrow that; choose **Only select
  repositories** on the installation's page, which the line links to.

What a past removal did is in the audit log, which the bridge serves to an
admin at `GET /v1/audit`, under the actions in the table above.
