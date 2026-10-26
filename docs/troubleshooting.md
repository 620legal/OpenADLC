# Troubleshooting

Organized by what a person sees: a card on the board, a line from `openadlc doctor`,
a task that stopped, a page that will not load. Each entry says what it means and
what to do, and names the code that decides it. `openadlc` below is
`node apps/cli/bin/openadlc.mjs`, run from the checkout the install runs from.

## Start with two commands

```bash
openadlc status    # which install, what is running, the board, spend, the crew
openadlc doctor    # what would break, with the health checks run now
```

`openadlc status` opens with `Install at <path>`, the `OPENADLC_HOME` it read, and
everything after that line is about that install. It says whether each service
is running, answering on its port but started by something else, or not running,
and when each scheduled job last ran. `never run` means no run of that job is
recorded yet. Each job first runs one interval after the bridge starts
(engines and releases 5 minutes, merge 10, reconcile and status 15, budget, deploy and
stages within the hour, credentials 12 hours, qa and events a day, deps a
week), and every restart starts that wait again: a young install, or one
restarted more often than a job's interval, shows the long ones as `never
run`. A job set to 0 with `OPENADLC_JOB_<NAME>_MINUTES` never runs.

`openadlc doctor` checks the tools, hostd's authentication, the database, the GitHub
accounts, the webhook secret and the last delivery, then has the bridge run every
health check now and prints each failure with what to do and where. Its last
line counts what it printed: `✓ no problems found` only when it printed no `✗`
and no `!`, `! 2 warnings, no problems` when it printed only warnings, and
`✗ 1 problem, 2 warnings` (or `✗ 1 problem needs attention`) when anything
failed. It exits non-zero on any problem, a blocking health check among them,
and not on a warning (`apps/cli/src/commands/doctor.ts`).

| What | Where |
|---|---|
| A service's log, and how it last ended | `~/.openadlc/run/<service>.log`; `openadlc logs bridge` prints the path |
| The driver, the ports, the database, the checkout that runs | `~/.openadlc/install.json` |
| Sign-ins, keys and the internal secret | `~/.openadlc/secrets/*.secret`, mode 0600 |
| OpenAI and xAI subscription sign-ins | `~/.openadlc/logins/<account id>` |
| A task as it runs | `openadlc attach <bot name> <session>`, where the session is the one the console shows after `<bot>/` (`<skill>-<first 8 characters of the task id>`, e.g. `openadlc attach builder implement-3f2a9c1e`), or the console's Terminal tab; ctrl-b d hands it back |

## How a problem reaches you

Most of what goes wrong is found by a health check in `apps/bridge/src/health/`
before a task runs into it. A check proves something by its effect — GitHub's own
list of deliveries, the keys GitHub lists for an account — never by a setting
that says it was done. It runs when the bridge starts, on its own interval, and
soon after something it is about happens. A failing check is a card in the
board's **Needs you** row with the thing to do and a button to where it is done,
and it clears itself when the check passes. A blocking failure that lasts five
minutes is also sent to `OPENADLC_NOTIFY_WEBHOOK` (or the bridge's log without one),
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
| `hostd` | 2 min | OpenADLC’s host service is not answering | `openadlc up` on the machine OpenADLC runs on |
| `hostd-driver` | 10 min | Tasks run on this machine as your user, not in containers (a warning) | `infra/local/build-bot-image.sh`, then `openadlc init --driver docker` and `openadlc down && openadlc up` |
| `webhook` | 5 min | GitHub is not sending events to OpenADLC, and five others | [Webhooks do not arrive](#webhooks-do-not-arrive) |
| `app-installed` | 15 min | The OpenADLC app is not installed on `<repo>` — or is private, so it cannot be; is suspended there; or is not given `<repo>` | The step on the card: install it on the account, make it public first ([more than one account](self-hosting.md#repositories-under-more-than-one-account)), unsuspend it, or add the repository on the installation's page |
| `app-selection` | 60 min | The OpenADLC app is given all of `<organization>`’s repositories (a warning) | Choose **Only select repositories** on the installation's page and pick the ones the crew works in; set the organization's base permission to No permission and keep the bots out of teams ([more than one account](self-hosting.md#repositories-under-more-than-one-account)) |
| `app-permissions` | 10 min | The OpenADLC app does not have “`<permission>`” | [GitHub answers 403](#github-answers-403-resource-not-accessible-by-integration) |
| `device-flow` | 60 min | Device Flow is off in the OpenADLC app | Tick Enable Device Flow on the app's settings page |
| `token-expiry` | 30 min | The OpenADLC app’s user tokens never expire (a warning) | Tick Expire user authorization tokens, then reconnect each bot |
| `app-client-secret` | 60 min | Each task’s GitHub token reaches every repository its bot can, or GitHub refuses the app’s client secret (a warning) | Generate a client secret on the app’s settings page and paste it into Settings → GitHub → App client secret |
| `bot-sign-in` | 10 min | `<bot>` cannot sign in to GitHub · signs in to GitHub as `<actual>`, not `<expected>` · has been renamed on GitHub to `<login>` (the account OpenADLC recorded, under a new login) | Reconnect its account in Settings → GitHub → Connected accounts, signed in as the account the card names; for a rename, reconnecting records the new login |
| `bot-access` | 30 min | `<bot>` is not in `<repo>` yet · `<bot>` is not signed in to `<org>`’s single sign-on · `<org>`’s IP allow list refuses `<bot>` · `<bot>` has admin (or maintain) on `<repo>` | **Let the crew in**, on the walkthrough's access step · sign in to GitHub as the bot and authorize it on the organization's SSO page, then reconnect it · add the host's address to the organization's IP allow list · lower the account to write (triage for intake or automation in an organization) on the repository's collaborators page, which the card opens; if it is a person's account, put the seat on an account of its own. A rate limit is not a card: the check waits for the next run |
| `signing-key` | 15 min | `<bot>` has no signing key on its GitHub account · `<login>` has a signing key OpenADLC did not register (a warning) | Reconnect the bot once the app has “SSH signing keys”; blocking only where a branch requires signed commits · the card offers **Revoke** (deletes it from the account as the bot, where its sign-in may) and **Dismiss** (it is somebody's on purpose; the check stops counting it, with an undo on the card), both an admin's; or remove it by hand on the account's SSH and GPG keys page |
| `commit-email` | 60 min | `<login>`’s own email address is on commit `<sha>` in `<repo>` (a warning, saying when GitHub wrote it) | Signed in as that account, open github.com/settings/emails: if Keep my email addresses private is not ticked, tick it and Block command line pushes that expose my email. Commits already written keep their address, so **Dismiss** the card whether it was ticked or not; it clears by itself once GitHub writes a newer commit for the account with its noreply address, and comes back only for a newer one that still carries the address. If one written after the box was ticked does, make the account’s primary email an address that is fine to publish |
| `model-account` | 30 min | The xAI subscription is signed out | [A model account is signed out](#a-model-account-is-signed-out-or-refused) |
| `repo-rules` | 60 min | Nothing the crew builds can land in `<repo>` | Apply the rules on the walkthrough's last step, or `openadlc github apply` |
| `repo-config` | 30 min, and when a pull request merged into a default branch changes one of the files it reads | `<owner/repo>`’s AGENTS.md doesn’t say who approves its human-review paths yet — line N still has the template’s `@owner` · `<login>` is named as a reviewer in `<repo>`’s AGENTS.md, but there is no such GitHub account · … but `<login>` is an organization, not a person · … but cannot review: `<login>` is not a collaborator on `<repo>` (or has triage or read there) · `<login>` is one of this install’s people (OPENADLC_HUMANS), but there is no such GitHub account (a warning) | [A named reviewer does not exist or cannot review](#a-named-reviewer-does-not-exist-or-cannot-review) |
| `repo-owner` | 15 min | Nothing builds in `<repo>`: no bot owns it | Set its `owner` in config/repos.yaml to a seat (`builder`) and run `openadlc seed`; a repository not listed there gets the builder when it is added again in Settings → Repositories |
| `deploy-dispatch` | 5 min | `<repo>`: `<workflow>` of `<sha>` has not been dispatched (a warning for a promote, blocking for a rollback) | Fix what GitHub said, shown on the card; the deploy sweep dispatches it again, or run the workflow from the repository's Actions. See [A merge did not deploy](#a-merge-did-not-deploy-or-production-did-not-wait) |
| `cloud-names` | 60 min | This cloud install still has the names from before the rename to OpenADLC (a warning) | Rename it, with no task running, by [runbooks/rename-gcp-host.md](runbooks/rename-gcp-host.md): copy each `fleet-` secret to its `openadlc-` name, apply the module, which resets the host, check it, then delete the old secrets, which clears the card. Only on an install whose secrets are in Secret Manager |
| `idle-lease` | 5 min | Never fails: lets go of a lease held 15 minutes with nothing working under it and no pull request | Nothing |
| `dispatcher` | 5 min | The dispatcher isn’t running: nothing will start building | `openadlc down && openadlc up` (on Cloud Run, `openadlc cloud apply`); see [Stopping new work while you look](#stopping-new-work-while-you-look) |
| `github-accounts` | 10 min | The GitHub sign-in for `<login>` stopped working · Only one GitHub account is connected · No GitHub account is connected | Connect or reconnect an account on the walkthrough's GitHub accounts step; it needs two that still sign in |
| `production-rules` | 60 min | A crew account can approve `<repo>`’s production deploy · `<repo>`’s production deploys wait for nobody · … wait for a person its rules do not ask for · … can come from more than `<branch>` (the last three warnings) | Remove the crew from the production environment's reviewers on the repository's Settings → Environments; for the others, choose how production ships on the walkthrough's Protect step, or `openadlc github apply` |
| `unattributed-post` | 5 min | A review on `<repo>#<n>` by `<login>` is not signed by OpenADLC | [runbooks/unsigned-post.md](runbooks/unsigned-post.md). **This was me** dismisses it until a newer post fails the signature check; each run reads the posts again and clears those that verify now |

A task that fails gets a **Needs you** card — its own, or a line on the card of
others that failed the same way: why it stopped in a sentence, the one thing to
press besides **Try again**, and the reason as it arrived behind **Details**
(`apps/bridge/src/failure-words.ts`).

**Stop**, beside **Try again** on the card and in the bot's thread, ends the
work for good instead: the task is recorded stopped, the stop is audited
(`task.stopped`), and the card goes (`POST /v1/tasks/:id/stop`); then hostd's
cancel ends whatever is left of its session and the task's lease is released.
If hostd does not answer, the thread says so and the lease is kept, since
what the session had not pushed is kept only as it ends; hostd ends it on its
own once it sees the task has ended. The idle-lease check then lets the lease
go (the reconciler, for a task that was waiting on a question; a lease with an
open pull request stays while it is open). **Stop** works on a task waiting on a
question too: its question is closed unanswered and leaves Needs you, the
bot is not resumed (an answer already on its way when the stop lands resumes
nothing), and `needs-human` comes off its issue or pull request as an answer
would take it off. When no question it closed recorded putting the label on
(the bot labelled the issue itself before it asked, or asked nothing at all),
it comes off when GitHub's timeline says the task's own account put it on
last, after the task started. It stays when no question is left open on the
subject but a person, another crew account (the automation account's holds:
**Hold this PR**, a send-back past its limit) or an earlier task put it on;
on an issue with a `do:` label other than `do:ai`, which triage gives it on
purpose because a person owes the work; on one labelled `openadlc:ignore`;
while another question waits on the subject; on a task an answer ended that
keeps the label on purpose (a refused plan change, a hand-off or abandon at
the cost cap), so the issue is not leased again to ask the same; and when a
question the task asked, answered since, recorded putting it on, which
leaves it to that question's rule. Accounts are compared by the id GitHub
gives where both sides have one, and each GitHub call a Stop makes is given
up after five seconds. The audit row says when it came off
(`needsHumanRemoved`). The question's card offers **Stop**: on the card itself
for a question with no choices, and under **Show more** for one with choices,
whose face holds the choices. Stopping the triage of a console request abandons the request, as **Abandon**
does: nothing starts it again.

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
  closed and its repository has no testing deploy: `.github/openadlc.yml` or
  Settings says none, or Automatic finds no `deploy-testing` workflow. A
  repository that deploys to testing, or whose setting could not be read,
  keeps the card with Try again. `OPENADLC_TESTING_URL` decides only for a
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
- **The bridge ended it.** When a pull request merges or closes, or an issue
  closes or is abandoned, the bridge stops the work left on it itself. Its reason says so and why (`stopped by the bridge: its
  pull request merged`), and the audit log has it as `task.stopped` by
  `bridge`, never as a person's Stop. Nothing starts it again: no answer
  resumes it and the deploy sweep leaves it. The bot's thread on the crew page
  reads **Stopped work on #N** and offers neither **Try again** nor **Stop**,
  as for a person's; but `GET /v1/bots` says `stoppedByTheBridge`, not
  `stoppedByAPerson`. A row recorded before the bridge said its own stops,
  `stopped by a person from the console (bridge): …`, is read as the bridge's too.
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
refused with `already landed`; a failed task the sweep finds refused this way
is stopped as `already landed` too, so it is not asked about again. No review is started on a pull request that has
closed or merged, whatever asked for it: a delivery the bridge works through
late, a pull request merged while its round was being opened, a review posted
after the merge, the gate sweep or the lead's turn. Each start reads it just
before the task is recorded: the bridge's own record of the merge, which the
merge's delivery writes first, and GitHub otherwise. The bridge log says `<ref>
is closed; <seat>'s review of it is not started`, and the audit log has it as
`review.start_refused`, with the seat, why, and whether the bridge's record or
GitHub said so. A delivery worked through after its pull request closed opens no
round at all: no reviewers are asked, no labels or gate are set, the log
says `<owner/repo#n> has closed since this delivery was sent; no review round
is opened`, and it is audited the same way, with the delivery in place of the
seat. Closing or merging one stops the reviews queued, running or paused on it,
a review whose task was recorded a moment before the close's delivery came
included. A start's read and its task are one step the close's stop waits for,
however close behind the `opened` delivery the `closed` one comes: the stop
finds the task, or the start reads the merge. A review stopped while its
context is read is not started on a host; its thread says `pr-review was not
started: it was stopped before hostd was asked to start it`. A task paused on a question stops itself when its issue closes: when an
issue or pull request closes, merged or not, heard by webhook or found by the
reconciler after downtime, every task paused on it or on the issue's pull
request is stopped, deploy and QA included. The exception is a task of the
account that closed it. Its question closes, its computer is taken down, and
the thread says so once, as a merge only when GitHub could say it merged;
nothing is written on an issue labelled `openadlc:ignore`. A deploy or QA task
started *after* the close is not stopped, even by a delivery that arrives late
or is sent again: the merge is where its work starts. A task left paused on an
issue that closed before this existed is not swept; stop it from its question's
card. A stage move of a closed issue is refused too,
except to Merged or Done, which is how a merge records itself. The bot's
thread card shows such work as landed: a last task that failed, or was stopped
by anything but a person or the bridge, on an intake, design, build, fix or review whose
issue is at Merged or Done or that ended `already landed`, reads
**Landed #N …** with its links and cost, and offers neither **Try again** nor
**Stop** (`landed` on `GET /v1/bots`). A deploy or QA task on a merged issue
keeps **Could not finish** and both buttons: the merge is where its work
starts.

| The card says | What to do |
|---|---|
| OpenADLC’s host service did not answer, so the work could not run | `openadlc up`, then **Try again** |
| OpenADLC stopped while `<bot>` was working · The computer `<bot>` was working on restarted | **Try again**: nothing starts the work again on its own |
| GitHub refused a commit by `<bot>`: it was not signed with a key its account has | Reconnect the bot, so GitHub learns its signing key |
| GitHub no longer accepts the sign-in of `<bot>` | Reconnect the bot |
| GitHub did not answer when OpenADLC refreshed the sign-in of `<bot>`, so the work did not start. OpenADLC tries again on its own after `<time>` UTC (retry N of 6), or at its next sweep once that time has passed | Nothing: it starts by itself once GitHub answers. The card's button opens GitHub's status page |
| … and OpenADLC has stopped trying on its own | **Try again** once GitHub answers |
| `<bot>` waits for GitHub to go on with … (an answered question) | Nothing: it resumes by itself once GitHub answers, until the time the card says |
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
is no longer in Build or is closed on GitHub, it carries `openadlc:ignore`, or
GitHub cannot be asked. A continuation also waits for what the dispatcher
checks before it starts a build: the issue carries none of `needs-human`,
`needs-triage` or a `do:` label other than `do:ai`, the repository has room
under its concurrency, and no build in flight declares the same files. Passed
over, it is not claimed, and a later sweep continues it once nothing holds it. Only builds that ended since the bridge started, and
within a lease's length (`OPENADLC_LEASE_HOURS`), are looked at, so restarting or
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
  bridge settles the gates then, and the scheduler's sweep does again if it missed). An install run with `OPENADLC_SCRIPTED_ENGINES=1` has no GitHub
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

**A GitHub outage costs time, not work.** Every task's GitHub token comes from
the bridge, which refreshes the bot's sign-in with GitHub when the token it
holds would not outlast the task (`TokenBroker`, `packages/github/src/token-broker.ts`).
How a refresh that did not work is read (`refreshFailure`):

| GitHub's answer | Read as | What happens |
|---|---|---|
| A 5xx (a 503 page included), a 429, or `server_error` / `temporarily_unavailable` | GitHub busy | Asked again three more times over about seven seconds, then **not answering** |
| A timeout, an abort, or no connection | No answer | **Not answering** at once: GitHub may have taken that refresh and rotated the token, so the same one is not sent again within the request |
| An OAuth refusal such as `bad_refresh_token`, or a 401 | Refused | The sign-in is marked revoked, and the card says to reconnect. The stored token is read again first: when another refresh stored a newer one meanwhile, that one is sent instead |
| Anything else: a 403, a 404, a 200 with no token | Neither | Fails as it is, with the reason on the card; nothing is marked revoked and nothing is retried on its own |

When GitHub is **not answering**:

- **The sign-in is not asked again for a minute**: every ask meanwhile fails at
  once, so a sweep does not wait on GitHub once per task. A call the bridge
  makes for itself is handed the token from the last refresh that worked,
  while it has a minute left; a task is not, since a token that expires part
  way fails the task at the end, where its work is. Nothing is marked revoked.
- **A task that could not start fails with words that say so**:
  `<bot> has no GitHub token yet: GitHub did not answer the refresh of
  <sign-in>'s sign-in (…)`. The bridge's token service answers hostd `503`
  for it, where a refused sign-in is `409`.
- **The merge job's sweep starts it again by itself** (`retryAfterRecovery`
  and `githubRetry`, `apps/bridge/src/scheduler.ts` and `attention.ts`) at
  least 2, 5, 10, 20, 30 and then 60 minutes after each try ended, the sweep
  being every ten minutes. Each retry is audited as `task.auto_retried` by
  `health-recovery` with the cause `github-unanswered`, and the task it starts
  can be run again the same way, as the next retry. The card names the time
  of the next retry and which one it is, or says the next sweep once that
  time has passed; after the sixth it says OpenADLC has
  stopped trying, and the work waits for **Try again**. The retries count the
  starts of the work that failed this way in a row, so a restart of the
  bridge changes nothing, and a start that got going, or failed for any
  other reason, ends the run. Only a start that never ran counts: a task
  that ran and then failed is not started again this way. Once a seat's
  retry is not answered again, the rest of its work waits for the next sweep.
  A claim the sweep took on a retry that never started — the bridge stopped
  in between — is taken back after fifteen minutes. Neither a claim nor its
  taking back holds once a later task of the work exists, asked in the same
  statement, so the work is never started twice. A health run that sees
  a check pass does not run these; the sweep alone does, and holds them back
  for what it holds any run again for: a person's pause, `openadlc:ignore`, a
  full seat, a card moved on. A console request's triage is tried again by
  its queue instead, as any start hostd refused is.
- **An answered question whose resume failed this way stays paused**, with the
  answer recorded and nothing taken down: hostd asks for the token before it
  ends the paused session. A card, *`<bot>` waits for GitHub to go on with …*,
  says so with **Stop** and GitHub's status, and the bot's thread says so once.
  The bridge's sweep of answered tasks (when it starts, and on the merge job)
  tries the resume again each time, for two hours from the answer; then the
  task fails as any refused resume does, with **Try again** on its card. A
  resume no answered question explains (a plan change approved) fails at
  once, since that sweep would not come back for it.

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
`openadlc restore`, when the bridge next starts. Each pause and
resume is audited (`work.paused`, `work.resumed`; one a restore made names it
as the `source`), and while it lasts the board says who paused it and why.

Settings → Pause work is the way to pause. Don't restart the bridge with
`OPENADLC_DISPATCH_IN_BRIDGE=0` to stop work: that is only for the integration
suites and scripted engines. A bridge without the dispatcher leases nothing,
but intake, reviews and deploys still start from GitHub's events, and Pause and
Resume don't change it. So that it is not missed, the board shows a blocking
card, "The dispatcher isn’t running: nothing will start building", Settings →
Pause work says the dispatcher isn't running, and a Build card ready to start says "Waiting: the
dispatcher isn’t running". To clear it, set `OPENADLC_DISPATCH_IN_BRIDGE=1` and
restart the bridge (`openadlc down`, then `openadlc up`, which sets it). In the cloud
install, Terraform sets it (`infra/gcp/main.tf`), so run `openadlc cloud apply`
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

A work item's page has its own controls, each an admin's and audited. Each
is audited under the item's key (`W-4`, or `<organization>-4`), as linking,
unlinking and merging are, with the subjects it acted on as `subjects` in the
payload: the issue and its pull request for a pause or a resume, the issue and
the one it took next from, every subject of the item for a cancel. Before the
install is numbered there is no key, and the item's subject (`api#12`) is used.
Each answers with that key as `item`, beside the `subject` it acted on.

- **Pause work** (`POST /v1/items/:subject/pause { reason? }`, `item.paused`) puts
  `openadlc:paused` on the issue and its pull request. What is running
  finishes. Nothing new starts on it: the dispatcher skips it ("held by a
  person"), the bridge refuses a new task on it in words naming who held it,
  and the merge line leaves its pull request alone. Who held it and why are
  kept in the `heldItems` setting; the board card and `GET /v1/items/:subject`
  say so as `held: {by, at, why}`. A label a person puts on by hand on GitHub
  holds only what reads it. On the issue, it stops the dispatcher and new
  tasks, and the board shows the item as held; on the pull request, it stops
  the merge line. Put `openadlc:paused` on both, or use **Pause work** here, which
  does. To stop only a merge, put `needs-human` on the pull request.
- **Resume work** (`POST /v1/items/:subject/resume`, `item.resumed`) takes the label
  off both and starts what the hold kept back: a dispatcher pass, the stage
  sweep, and the merge line.
- **Do next** (on a card, the icon titled *Do #N next*; **Next up · undo** once
  set; `POST /v1/items/:subject/next { on }`, `item.next`) puts
  `openadlc:next` on the issue. The dispatcher looks at it first in its
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

To keep an issue out, label it `openadlc:ignore`. An issue intake cannot shape
— two intake runs in a week that each left it in intake — is not tried again:
the bridge records `intake.stalled` once, and Needs you shows **Intake could
not shape …**. Answer what intake asked on the issue, move it on the board
yourself, or label it `openadlc:ignore`.

An unlabeled issue whose author OpenADLC does not act for — a stranger, or an
old crew account with no access left — is not sent on its own. Each pass writes
them down (`unownedIssues`), Needs you shows one card per repository, **`<repo>`:
n issues OpenADLC won't take on its own**, and an admin chooses: **Send to
intake** (their say-so stands in for the author's access), **Ignore** (labels
them `openadlc:ignore`) or **Close** (closed as not planned, with a comment
saying who closed it, by name and never by address, and the reason they gave).
Until then intake's overlap check leaves them out, as it does any issue labelled
`openadlc:ignore`.

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
| `<login>` is one of this install’s people (OPENADLC_HUMANS) … | Correct the list where it is kept. A list saved in the console (the Protect the repositories step's approvers) wins over `OPENADLC_HUMANS`, and Settings has no field for it yet: as an admin, send `PATCH /v1/install {"humans": "<login>,…"}`; an empty value clears it, and `OPENADLC_HUMANS` applies again. Without a saved list, fix `humans` in `install.json` or `OPENADLC_HUMANS` and restart the bridge. Then fix any `AGENTS.md` or `CODEOWNERS` that names the old login |

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
session of the bot that was refused (the console's Terminal tab, or `openadlc
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
  `openadlc-login-<account id>` container from the bot image — and shows the link
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
`OPENADLC_CONTAINED`, which the base environment of every container session sets to
`1` (`packages/engines/src/codex.ts`, `apps/hostd/src/drivers/base-env.ts`).

**What to do.** Under the `docker` driver, a session without `OPENADLC_CONTAINED=1`
runs an old build: `git pull && pnpm install && pnpm build`,
then `openadlc down && openadlc up`. The `local` driver never sets it: Codex keeps its
own sandbox there, and on a Linux host that cannot make a user namespace it
fails the same way.

## Webhooks do not arrive

**What you see.** The board lags GitHub by up to a quarter of an hour — how often
the reconcile job reads it — and bots start late or not at all. `openadlc doctor`
may say “GitHub has never delivered anything to this install”, or how many hours
ago the last delivery was.

**What it means.** On a laptop, GitHub reaches the bridge through a cloudflared
quick tunnel the bridge runs itself (`apps/bridge/src/tunnel.ts`). A quick tunnel
is a new hostname every time one starts, and its address dies with the process
that raised it. So at every start the bridge raises a new one and points the
GitHub App's webhook at it, keeping the secret — when the stored address is a
quick tunnel the bridge raised, `cloudflared` is on the PATH, and OpenADLC holds
the app's private key (`resume()` in `apps/bridge/src/webhook-setup.ts`). Who
raised it is the `webhookMode` setting beside the address: `tunnel`, or
`address` for one you gave, a quick tunnel of your own among them, which is
never replaced. An install from before the mode was stored has none, and its
quick tunnel's address is taken for the bridge's own; give a tunnel of your
own on the webhook step once more to store `address`. The bridge's log says
`tunnel back up at https://….trycloudflare.com` when it worked. The tunnel
reaches a gateway that forwards only `POST /webhooks/github`, never the bridge
itself (`apps/bridge/src/webhook-gateway.ts`).

A quick tunnel's address can also die while the bridge and cloudflared go on
running. A Mac that slept woke with cloudflared still up and `GET /v1/webhook`
saying it served its address, while every delivery GitHub made got a 502 and
was lost. So the bridge watches the tunnel it raised — only that one: a quick
tunnel of your own, given on the step as a fixed address, is left alone —
and tries its address from this machine: a `GET` of `/webhooks/github`, which
the gateway answers with a 404 and never passes on. Every five minutes, and at
once on waking, so one that stopped is noticed within about six minutes;
every minute only to confirm a first failure, and through a new tunnel's
first ten minutes.

When an address that answered before has failed two tries a minute apart,
GitHub answers, the app's hook still points at that address, and GitHub's
newest delivery to it (if there is one) failed too, the bridge raises a new
tunnel, points the app at it with the secret it already has, and has GitHub
send again the deliveries that failed (`watchTunnel` in
`apps/bridge/src/webhook-setup.ts`). It does the same when no tunnel runs
behind the address: cloudflared ended, or a raise or a repoint failed. The log
says `… stopped reaching this bridge; raised a new tunnel at
https://….trycloudflare.com`, and the audit log records `install.tunnel_revived`.

It does not do it in a loop. After each new tunnel it waits twice as long
before raising another — half an hour, an hour, two, up to eight — and back to
half an hour once GitHub delivers to the new address. When it would not go
ahead — GitHub did not answer, the hook points elsewhere, GitHub still
delivers there — it looks again after a minute, then two, four, up to half an
hour. It never raises one for an install taken off the internet from the
webhook step, or for a fixed address, and never replaces an address that has
not once answered from this machine, since it then cannot tell. A take-down,
a Configure or the bridge stopping while it raises one wins: that tunnel is
stopped and the app is not pointed at it. While the address fails,
`GET /v1/webhook` says `cloudflared is running, but … has not reached this
bridge since …`; its `unreached` is GitHub's newest delivery when that never
arrived, and its `watch` says what the watch knows and will do next. The
bridge's webhook route answers no more than 500 for a failure of its own, so a
502 or more means the delivery never reached it.

The `webhook` check reads GitHub's own list of what it delivered, beside what
happened on GitHub that nothing was delivered for. Its step is
`/onboarding?step=webhook`.

| Its card says | What to do |
|---|---|
| GitHub is delivering to a tunnel that has stopped | Raise a new one on the webhook step; OpenADLC points the app at it. For a tunnel OpenADLC raised, the card says when it raises the next itself, and why the last try failed |
| GitHub cannot reach this bridge through its tunnel | GitHub's newest delivery got a 502 or no answer: the address is dead though cloudflared runs, as after a sleep. The card says what OpenADLC will do — raise a new one and when, or not, because the address never answered from this machine or still does — and to raise one on the webhook step if it stays |
| GitHub cannot reach this bridge | The fixed address GitHub delivers to does not reach the bridge. Put right whatever serves it, or give the bridge another address on the step |
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
`openadlc doctor` also says when no webhook secret is configured, so every delivery
is refused, and when the database, `install.json` and `OPENADLC_WEBHOOK_SECRET`
differ.

## A service stopped, or keeps stopping

**What it means.** The console once went offline overnight with nothing in its
log, because a service that died stayed dead. `openadlc up` now runs hostd, the
bridge and the console each under a keeper (`apps/cli/src/keep-running.ts`) that
writes how the service ended to its log and starts it again, waiting a second,
then twice as long each time, up to thirty. Five exits in a row, each within ten
seconds of starting, will not be fixed by a sixth start, so the keeper stops:

```
[openadlc] bridge exited with code 1 after 3m; starting it again in 1s
[openadlc] bridge exited with code 1 5 times in a row, each within 10s of starting; not starting it again. Run `openadlc up` once whatever stops it is fixed.
```

**What to do.**

```bash
tail -n 50 "$(openadlc logs bridge)"   # how it ended, and what it said before
openadlc down && openadlc up          # restart everything; `up` alone starts only what is not running
```

**Rebuilding restarts nothing.** `pnpm build` rewrites the code on disk; each
running service keeps what it loaded, and `openadlc up` leaves a running service
alone (`already running (pid …)`). The console shows it plainly: `next start`
goes on serving the build it started with, the rebuild has replaced the files
that build refers to, and pages fail with `ChunkLoadError` until it restarts.
After a build, `openadlc down && openadlc up`.

**`bridge was not running (stale pid file removed)`.** `openadlc up` writes each
keeper's pid to `run/<service>.pid` under `OPENADLC_HOME`, and the keeper removes
it when it exits. A reboot or a killed keeper leaves the file behind, and by
then its number may be some other program's. OpenADLC takes a pid for a service
only while its command line is that service's keeper (`keep.js bridge …`); any
other pid file is removed, never signalled, and `openadlc down` says so with
this line. Nothing needs doing: `openadlc up` starts the service as usual.

## The install's database isn't answering

**What you see.** Every console page says **The install's database isn't
answering**, with the bridge's line for it; `/healthz` answers 503 with the
same line in `database`; `openadlc doctor` fails with it and says the
container is stopped:

```
the install's database (openadlc-db) isn't answering on 127.0.0.1:47432: start it with `docker start openadlc-db`, or run `openadlc up`
✗ the install's database (openadlc-db) isn't answering on 127.0.0.1:47432: openadlc-db is stopped
```

**What it means.** The bridge keeps everything in Postgres, so it can do
nothing without it. Locally that is the container `openadlc up` keeps
(`openadlc-db`).
`openadlc up` creates it with `--restart unless-stopped`, so it comes back by
itself when Docker or the machine restarts, and gives one made before that
the same policy (`docker update`), saying so once. A container that has never
been through a newer `openadlc up` has no policy: after OrbStack or Docker
Desktop restarts it stays down, while hostd's `openadlc-taskdb` comes back.
The bridge names the container only when `openadlc up` told it which one it is
(`OPENADLC_DATABASE_CONTAINER`); otherwise the line says where it looked, and
for a server on another machine, to check that it is running.

**What to do.** Start it, then reload the console. `openadlc up` does the same
and gives the container its restart policy:

```bash
docker start openadlc-db
openadlc up
```

A line that says the database `answered the bridge with an error` is a server
that is running and refused: a password it does not take, or a database it
does not have. Starting it again changes nothing; `openadlc doctor` and the
bridge's log say more.

## OpenADLC does not update itself

**What it means.** The OpenADLC row in Settings → System says why in its own
words ([Updating OpenADLC](self-hosting.md#updating-openadlc)): the checkout
has changes, is not on `main`, moved since the services started, cannot
fast-forward, another running install runs from the same checkout (give each
its own clone, or stop the other), the newest release is not immutable (turn
immutable releases on, [development.md](development.md#once-per-repository)),
or this machine's GitHub CLI cannot check an attestation. Those
change nothing and need a person to decide. A run that failed is a card under
System in Needs you, with the step it failed at; the audit log has it as
`openadlc.update_failed`.

**What to do.**

- **Before the restart** (`download`, `checksum`, `attestation`, `archive`,
  `worktree`, `unpack`, `install`, `check`): the install is as it was and the
  worktree is gone. A failed `checksum` or `attestation` means the files are
  not the release's, or `gh` could not reach Sigstore: check the release by
  hand ([Checking a release](self-hosting.md#checking-a-release)) before
  pressing Update now again, and do not unpack it yourself if it fails there.
  A failed `install` is usually the toolchain node-pty needs on Linux
  (`build-essential`, python3).
- **Waiting for ever.** It waits only for tasks queued or running, and System
  names them; a paused one never holds it. Let them finish, or stop one from
  its card. An engine update on hostd holds it too, until that ends.
- **During the restart.** Read `$OPENADLC_HOME/run/self-update.log`. A
  failed `stop` (a service that would not stop) changed nothing and started
  the services again. A failed `merge`, `output` or `install` put the old
  commit, output and install back and started the services: the card says
  `put back on <sha>`.
  A failed `migrate` or `start` left the checkout on the release; fix what the
  log names, then `openadlc up`.
- **The restart itself died** (power lost, the process killed, out of
  memory): the services are down, no card came, and the checkout may hold the
  release's source with part of its built output and the old dependencies.
  The restart wrote `$OPENADLC_HOME/run/self-update-applying.json`, and the
  same in the checkout's `.openadlc/applying.json`, before it stopped
  anything, and `openadlc up` refuses while either is there, for this install
  and for any other that runs from the same checkout. It prints the ways out:
  finish onto the release (`git merge --ff-only <release commit>`, then
  `pnpm install --frozen-lockfile && pnpm build`) or go back (`git reset
  --keep <commit before>`, then the same), each in the checkout. If git
  refuses either, because the restart died inside it, remove
  `.git/index.lock` if it is there and use `git reset --hard` to the one you
  want: the checkout had no changes of its own when the restart began. Then
  remove the files it names and run `openadlc up`. Rebuilding is what makes
  the built output one release's again; starting the mix would run it, and the
  release's migrations.

To finish one by hand, or to update without it, see
[Upgrading](self-hosting.md#upgrading). What a run left under
`$OPENADLC_HOME/self-update/` is removed when the next bridge records it;
`git worktree prune` in the checkout clears a worktree whose folder is gone.

## An engine CLI, gh or Node does not update

**What it means.** Each tool's row in Settings → System says how its last run
ended ([Engine updates](self-hosting.md#engine-updates)). A run asks npm for the
three engine CLIs, nodejs.org for Node and the GitHub CLI's apt repository for
gh which version is newest. A tool whose answer cannot be read stays on the
version it has, and its row says `Failed` and why: which tool, which source,
and for an answer that could not be read, its size and what the parser said,
never the answer itself. The other tools still update, in the same candidate,
and the run's own result ends with `codex was not checked: …`. Needs you has a
card for it under System, titled with the tool and the version it stays on
(`Codex's newest version could not be read; it stays on 0.155.1`), until a
later run checks every tool it asks about. Only a run that could read no tool
at all fails as a whole, and its card says the update did not go in (`newest`
and `execute` in `apps/hostd/src/engine-updates.ts`, `engineUpdateAttention`
in `apps/bridge/src/engine-updates.ts`).

On 2026-10-22 every engine update failed, every row showing the tail of a JSON
document as its reason: npm's answer about `@openai/codex` had grown to 337 KB
(5,578 versions, most of them per-platform alphas), hostd kept only the last
256 KB of a command's output, and that cut off `dist-tags` at its start.
nodejs.org's index of releases, at 335 KB, was cut the same way. An answer that
is parsed is now read whole from its start, up to 8 MB (`ANSWER_MAX`), and a
command that goes on past that is stopped there; a build's log is still kept
from its end, where it says why it failed.

On 2026-10-23 the cloud host's Node and gh rows said `spawn curl ENOENT`: hostd
asked nodejs.org and the GitHub CLI's apt repository with curl, and a release's
service image has none (`Dockerfile.service` purges it once gh is installed).
hostd now asks both with Node's own fetch, through the install's proxy
(`NODE_USE_ENV_PROXY`), within 60 s and up to the same 8 MB; a failure says
`HTTP <status>`, why the connection failed, or that the source did not answer
in time.

**What to do.** Read the row's reason, then ask the same source from the
machine hostd runs on (on the cloud host, from the hostd container, through
the egress proxy):

| The row says | What to look at |
|---|---|
| `could not ask npm which <package> is newest: …` | npm's own error: the network, a proxy, the registry `.npmrc` names. `npm view <package> dist-tags --json` |
| `could not read npm's answer about <package> (<size>) as JSON: …` | Something other than npm answered, such as a proxy's or a captive portal's page, or the answer stopped short. `npm view <package> dist-tags time --json \| head -c 300` |
| `npm's answer about <package> (<size>) names no latest version` | The registry has no `latest` dist-tag for it: a mirror that is not npm's |
| `could not read when npm published <package> <version>, …` | npm did not say, so that version is not taken without its minimum release age. The next run asks again |
| `… is over the 8 MB hostd reads` | An answer some twenty times its size in 2026, or something else answering at length. Check it as above, and open an issue if it is the real answer |
| `could not ask nodejs.org which Node is newest: …`, `could not read nodejs.org's index of Node releases …` | `curl -fsSL https://nodejs.org/dist/index.json \| head -c 300`; on the cloud host, where the hostd container has no curl, `docker exec openadlc-hostd node -e 'fetch(process.argv[1]).then(async (r) => console.log(r.status, (await r.text()).slice(0, 300)))' https://nodejs.org/dist/index.json`, and `nodejs.org` in the egress allowlist |
| `nodejs.org's index of Node releases (<size>) lists no stable Node <major>` | The index has no release of the major the image is on |
| `could not ask the GitHub CLI's apt repository which gh is newest: …`, `… package index (<size>) lists no gh package` | `curl -fsSL https://cli.github.com/packages/dists/stable/main/binary-amd64/Packages \| head` (`binary-arm64` on an arm64 host); on the cloud host, the `docker exec openadlc-hostd node -e …` above with that address, and `cli.github.com` in the egress allowlist |
| `nothing was built: the image does not say which <tool> it has, …` | The image in use has no `openadlc.engines` label, its CLI did not say its version, and npm's newest could not be read either, so a candidate had nothing to pin it to. Fix the lookup, or rebuild the image with `infra/local/build-bot-image.sh` |

A tool that was not checked is asked again at its next scheduled run, or when
its **Update now** is pressed.

## The console is a blank page under a LAN name or a tunnel

**What it means.** The console and the bridge answer only under names the
install is served under: loopback, an address, and the configured URLs. Any
other name gets `421 Misdirected Request` with no body, on every path, so a page
on a name rebound to this machine learns nothing. Opened as
`http://mybox.lan:47300`, the console is a blank page, and its log says why,
once per name:

```
[console] refusing requests for Host "mybox.lan:47300": not a name this install is served under. If people do open the console under it, add it to "allowedHosts" in install.json (OPENADLC_ALLOWED_HOSTS) and restart.
```

**What to do.** If people do open OpenADLC under that name, add it to
`allowedHosts` in `~/.openadlc/install.json` and run
`openadlc down && openadlc up`. Otherwise open the console at the address
`openadlc status` gives. See [security.md](security.md#a-page-on-another-origin).

## A port is already in use

**What you see.** `openadlc up` ends with `OpenADLC is partly up` after one of these,
and `openadlc status` says the service is answering but not started by this install:

```
✗ bridge: something is already serving http://127.0.0.1:47311/healthz that this install did not start
✗ bridge exited but http://127.0.0.1:47311/healthz still answers, so another process holds the port
```

**What it means.** A new service beside an old one dies of `EADDRINUSE` while the
old one passes its health check, and the install would report itself up having
started nothing. So `openadlc up` asks 47300 (console), 47311 (bridge) and
47312 (hostd) before starting each service, and confirms afterwards that the
process it started is the one answering (`apps/cli/src/commands/up.ts`).
Postgres is not asked: it is reached at `install.json`'s `databaseUrl` (47432
by default), and a server there that is not this install's ends `openadlc up`
with `cannot reach postgres`. Under the docker driver hostd also publishes its
task database server (`openadlc-taskdb`) on 47433, which no setting moves; a
conflict there shows in hostd's log as `task … gets no database`.

**What to do.** Find what holds the port. It is usually the same services,
started under another `OPENADLC_HOME`, and `openadlc down` there stops them:

```bash
lsof -nP -iTCP:47311 -sTCP:LISTEN               # what is listening
OPENADLC_HOME=/path/to/other openadlc down    # stop the install that owns it
```

To move instead, change `ports` in `install.json` and run `openadlc down && openadlc up`:
every service, the console included, reads its addresses when it starts, and
links in notifications follow the console's port. One thing does not follow
on its own: take-over connects the browser to hostd at
`NEXT_PUBLIC_OPENADLC_TERMINAL_URL`, or port 47312 when that is empty. The
console reads it when it starts, so when hostd moves, start the console with
it set:

```bash
export NEXT_PUBLIC_OPENADLC_TERMINAL_URL=ws://127.0.0.1:<hostd port>
openadlc down && openadlc up
```

It is not kept in `install.json`, and neither is `OPENADLC_CONSOLE_URL`:
export them in every shell that runs `openadlc up`.

When take-over cannot connect, the Computer tab names the address it tried.

Moving Postgres means changing the port in `databaseUrl` as well as
`ports.postgres`: `install.json` keeps the two apart. The database's data does
not follow either. The container `openadlc up` made (`openadlc-db`) still
publishes the old port, and `up` stops and says so; to keep using it, set both
back to the port it publishes. Removing it makes the next `up` start a new,
empty database.

## OpenADLC is looking at a different install

**What you see.** Services that answer but were not started by this install, or
an exported setting that changes nothing.

**What it means.** An install is everything under `OPENADLC_HOME`, `~/.openadlc` by
default: `install.json`, `secrets/`, the pid files and logs in `run/`, the bots'
`work/` and the subscriptions' `logins/`. A stale `OPENADLC_HOME` in the environment
is an invisible way to talk to another install, which is why `openadlc status` names
the one it read first, and `openadlc up` and `openadlc down` say `state under <path>`.
`install.json` also decides two things a shell cannot:

- **The services' settings.** `openadlc up` lays the file's values over the
  environment for what `serviceEnv` writes (`apps/cli/src/install.ts`: the
  database, the ports and URLs, the driver and the like), so an exported
  `OPENADLC_HOSTD_DRIVER`, `DATABASE_URL` or port never reaches a service.
  Change the file, or run `openadlc init --driver docker`. Any other
  `OPENADLC_*` you export — `OPENADLC_CONSOLE_URL`, `OPENADLC_BOT_PREFIX`,
  `OPENADLC_BOT_IMAGE`, `OPENADLC_JOB_<NAME>_MINUTES` — still reaches them, so
  check `env | grep -E '^(OPENADLC_|DATABASE_URL)'` first and unset what
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
  no matter which checkout `openadlc` was run from, so building another checkout changes
  nothing that runs.

```bash
openadlc status                                                       # Install at <path>, then the database it opens
grep '"repoRoot"' "${OPENADLC_HOME:-$HOME/.openadlc}/install.json"   # the checkout that runs
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
  beside quotes, which every `openadlc:` marker has. So a skill writes the body to a
  file with its file tool and passes the file,
  `gh issue create --body-file .openadlc-scratch/issue.md`. Triage's
  `write_within` names `.openadlc-scratch/**`, which is what gives it a file
  tool (`crew/skills/triage/tools.yaml`).
- **A chain.** Grok runs `a && b` only when every part is allowed, and refuses
  `$(…)`, subshells, loops and `bash -c` whole.

## `openadlc-ci` times out in a stand-in's test, or aborts with exit 134

**What it was.** A builder of OpenADLC itself could not pass `openadlc-ci` in
its task's computer, though the same `make ci` passed in a clean container.
hostd runs `make ci` with the session's PATH, OpenADLC's `git` and `pnpm` from
`/opt/openadlc/bin` first. Four tests in `apps/hostd/src/worktree.test.ts` put
a stand-in `git` first on PATH and have it run the git they found there before,
which in a task's computer was OpenADLC's. OpenADLC's `git` took the first git
on PATH that was not itself, the stand-in, and the two exec'd each other for
good: the tests timed out at 30 seconds, with `ENOTEMPTY` on
`…/mirrors/acme__widgets.git.making`. Run in the builder's own session, where a
skill's rules are set, each pass started one more `git-check.mjs`, until the
computer's 4096 processes were used up: the engine died of SIGABRT
(`pthread_create: Resource temporarily unavailable`), and every later `make
ci` there hung or aborted at `pnpm -r typecheck` with exit 134. OpenADLC's
`git` and `pnpm` now take only the real tool after them on PATH, and hostd ends
every process a `make ci` started once it ends (see
[development.md](development.md), the `make ci` item).

**How to tell.** A computer in that state is near its process limit:

```bash
docker stats --no-stream --format '{{.Name}} {{.PIDs}}' task-<id8>      # near 4096
docker top task-<id8> -eo pid,etime,args | grep -c git-check.mjs       # hundreds
```

**What to do.** Update OpenADLC, then clear the computer without taking the
task's work down. `docker exec` needs a process slot of its own, so give it
one for a moment, end the chain, and put the limit back:

```bash
docker update --pids-limit 8192 task-<id8>
docker exec task-<id8> sh -c 'for p in /proc/[0-9]*; do case "$(tr "\0" " " < $p/cmdline 2>/dev/null)" in "node /opt/openadlc/bin/git-check.mjs"*) kill -KILL "${p#/proc/}";; esac; done'
docker update --pids-limit 4096 task-<id8>
```

Then have the builder run `openadlc-ci` again. A `make ci` that started while
the computer was full can hang in `pnpm -r typecheck` for good, and the next
call joins it rather than starting another until it reaches its limit, an hour
by default. Not to wait, end it: its `timeout` leads a process group that
holds the run, so end that group, and hostd records the run as one stopped at
its limit.

```bash
docker exec task-<id8> sh -c 'for p in /proc/[0-9]*; do case "$(tr "\0" " " < $p/cmdline 2>/dev/null)" in "timeout --kill-after"*) kill -KILL "-${p#/proc/}";; esac; done'
```

A run that a hostd with this change started is then gone, whatever left the
group, because hostd ends the rest of its session. One that an older hostd
started can leave running what left the group, a detached child or a test's
own `timeout`: list what the computer runs, and end by its pid each process
of the run's (vitest, tsc, git, a test's `sleep`), never the engine, tmux or
`bot-init`.

```bash
docker exec task-<id8> sh -c 'for p in /proc/[0-9]*; do echo "${p#/proc/} $(tr "\0" " " < $p/cmdline 2>/dev/null)"; done'
docker exec task-<id8> kill -KILL <pid>
```

## A card is stuck in a column

Every card has one status line, made from live state — the tasks on it, the
question open on it, its place in the line to merge — never from a setting
(`apps/console/src/lib/card-status.ts`). What needs a person comes first.

| Status line | What it means | Where the reason is |
|---|---|---|
| Waiting for your answer | A bot asked | **Needs you**, or the question's comment on GitHub |
| Could not finish · needs you · Review failed · needs you | The last task failed and nothing ran it again | Its **Needs you** card, and the bot's thread |
| Stopped after N rounds · needs you | Reviews did not converge within `maxRounds` (`config/review.yaml`) | The pull request: a person decides |
| Waiting for `<seat>` · busy with #N · 32 min | Every slot of the seat that staffs its stage (`bots.max_tasks`, Crew → tasks at once) is taken by the queued or running tasks it names; a task paused on a person's answer takes none. Since when: when the seat turned it away (a `stage.waiting_on_seat` event), or when its row or last task last changed | The task it names; or raise the seat's tasks at once on Crew |
| Not started · `<seat>` is free · starts within a minute | Its seat turned it away while full and has room now; it starts within about a minute (`StageRunner`) | Nothing to do; if it turns to Stuck, the bridge log's `stages,` lines |
| Not started · `<seat>` is free · next sweep in 24 min | The seat has room and nothing tried it since: a webhook that never came, or a task that was stopped or failed. The hourly stage sweep starts it | The bridge log; Start it now from its Needs you card once it is stuck |
| Next up · `<builder>` is free | Ready to build and first in line; the dispatcher leases it on its next look | The bridge log's dispatch lines |
| Waiting its turn, after #N | Its seat has room, and the cards before it in line take it | The card it names |
| Waiting for #N to let go of `<path>` | Another change in flight holds a file it declared (`paths:` in `.github/openadlc.yml`) | That card |
| Waiting: `<repo>` builds 1 at a time · busy with #N (waiting for your answer) | The repository's concurrency is reached. A build paused on a person counts, and its card says "Waiting for your answer · holds `<repo>`'s build slot" | Answer that build's question; or Settings → Repositories |
| Leased to `<builder>` · its build hasn’t started · paused after its task ended · held for pull request #N · held by merged #N until its verification ends · its build ended, waiting for its pull request | In Build, its own issue holds a lease with nothing running under it, and the dispatcher never leases an issue a lease holds: the lease's state says what it waits for (`leased`, `paused`, `in_task` with or without its pull request). Since when: the lease's last change, or the card's, whichever is later. Never stuck for it, so Needs you has no Start it now for it | With no pull request, a lease is let go by the idle-lease check a quarter of an hour after its build failed or stopped (or was never started), and one whose build finished when it runs out; a paused one by the reconciler; one for a pull request when it closes, or once its merge's verification ends |
| Waiting for a host with room (4 of 4 running) | Nothing else holds it: its seat has room and it is first in line, but the live hosts run all the tasks they have room for (each host's `OPENADLC_HOST_CAPACITY_TASKS`; a paused task with its computer kept counts). Not stuck while they are full | The tasks running; or give a host more with `OPENADLC_HOST_CAPACITY_TASKS` |
| Waiting for `<seat>` · paused on Crew · Waiting: `<seat>` cannot sign in to GitHub | Its seat is paused, or a check holds it back | Crew; the check's card in **Needs you** |
| Held at the spending cap · Nobody staffs `<stage>` · `<stage>` is left to a person in `<repo>` | The month's cap stops new work; no bot has the role; the repository's stage mode is `untouched` | Settings → Spending limits; Crew; Settings → Repositories |
| Stuck · `<seat>` is free and nothing started it | It has waited three minutes (`STUCK_AFTER_MS` in `apps/bridge/src/waiting.ts`) with its seat free and nothing started. Its dot is the alarm colour and still, and **Needs you** has a system card, "Nothing has started #N for … min, and `<seat>` is free", which says why and goes once the work starts | That card's **Start it now** (the stage sweep for intake and design, a dispatch for a build); then the seat's thread and the bridge log |
| Waiting for intake · Waiting for a design pass | From a bridge older than the waiting reasons: nobody is on it yet | The hourly stage sweep; the bridge log |
| Not ready to build yet | No `start:now` label | The issue's labels |
| Waiting for triage | Sent back: it lacks a priority, an area, one `do:` label, one of its four sections or an expected path, or three builds ran and produced no pull request. Only builds that started and ended on their own count: a lease the bridge refused, one whose task never started, and a build that was stopped (by a person, or by its host going away) do not. Once the issue says what it wants, take `needs-triage` off and put `start:now` back: it gets three fresh attempts | The issue, and its "Not routable yet" comment |
| Waiting on #N (what #N is doing) | A dependency named in the issue has not shipped; in brackets, what is happening on it now: its bot and step, "waiting for your answer", what it waits for itself | That issue |
| Next up · Waiting its turn (no time after it) | From a bridge older than the waiting reasons: routable, and no builder has taken it | The bridge log's dispatch lines |
| Waiting: the dispatcher isn’t running | Routable, but the bridge was started without `OPENADLC_DISPATCH_IN_BRIDGE=1`, so nothing leases it | The `dispatcher` card on the board; see [Stopping new work while you look](#stopping-new-work-while-you-look) |
| Approved · 2nd in line to merge · Catching up with main… | The merge line | A `repo-rules` card, if nothing lands |
| Approved · waiting for you to merge it | Only a person can land it | Its **Needs you** card says why; see [A green pull request waits for a person](#a-green-pull-request-waits-for-a-person) |
| Checks running before it merges | CI on its head, or the merge line held at the GitHub Actions minutes cap | The pull request's checks; Costs, and [the cap](#a-pull-request-waits-on-github-actions-minutes-this-month-reached-the-cap) |
| Waiting for the reviewers | A review seat asked has not posted on this diff | The pull request, and the reviewer's thread |
| Live on testing · waiting for production | The production environment's required reviewer, or its soak timer | The repository's deployments page; Settings → Repositories |
| Waiting until `<repo>` is resumed | The repository is paused | Settings → Pause work |
| Merged · waiting to deploy | No `deployed:testing` yet, in a repository that has a testing deploy | Settings → Repositories: how it ships, and where the rules came from; the bridge log's `dispatched deploy-testing` or `not dispatched` line |
| No merge to deploy · move it to Done by hand | In Ship, and its issue records no pull request, in a repository that has a testing deploy: no deploy carries it, and nothing that finishes a merge moves it. Move it to Done once its change has shipped, or back to the stage its work is in | The deploy sweep's `is merged with no pull request recorded` line |
| Merged · ships with the next release | The repository ships by release (`testing: on: release`): no deploy is coming, and the card goes to Done when a published release, not a draft or a prerelease, contains its merge | Settings → Repositories → Ships by release; the deploy sweep's `in Ship until a published release contains` line; the `ships-by-release` card, when the app is not subscribed to Release events |
| Abandoned … (in Done) | Closed without merging: it is labelled `openadlc:abandoned`, nothing shipped, and it is not in "N this week" | The issue on GitHub; see [Closed, but still on the board or in Needs you](#closed-but-still-on-the-board-or-in-needs-you) |

A repository whose delivery rules say `testing: on: none` does not sit on that
line. That is set in its `.github/openadlc.yml` or, without that file, by
Settings → Repositories → Testing deploy (**No testing deploy**, or
**Automatic** with no `deploy-testing` workflow). The deploy sweep moves its
`adlc:merged` issues to Done and starts no SRE task. With the file present,
the Settings choice is not read: change the file by a pull request. Settings →
Repositories shows which source the rules came from. OpenADLC does not read
the `OPENADLC_DEPLOY_TESTING` Actions variable.
In a repository that does have a testing deploy, a closed issue stays in Ship:
GitHub closes the issue at `Closes #N` before the deploy has run. One whose
`deploy-testing` run was skipped, or ran no job, goes to Done all the same:
that merge had nothing to deploy, and shipped by merging. So does an older
merge the newest one's skipped run carries, whether or not a deploy of its own
was ever dispatched. One whose issue records no pull request stays, and its
card says to move it to Done by hand: OpenADLC cannot tell what merged for it,
so no deploy says it shipped. Where merging ships, the sweep moves it with the
rest.

A merge moves every issue the pull request finishes: the one its branch was cut
for (`agent/<bot>/<issue>-…`) and each one it closes, as GitHub lists them — a
`Closes`, `Fixes` or `Resolves #N` in its body, or an issue linked in its
sidebar. So a pull request from any branch moves its issue. An issue is moved
only when OpenADLC already tracks it and it is not labelled `openadlc:ignore`,
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
repository's `paths:` in `.github/openadlc.yml` says which are which (see
[configuration](configuration.md)). A stage whose bot could not be started says why:

```bash
grep 'dispatch, for' "$(openadlc logs bridge)" | tail -n 20    # leased or skipped, and why
grep 'not staffed for' "$(openadlc logs bridge)" | tail -n 5   # why a stage's bot did not start
```

Every staffed stage is swept hourly, and a builder that failed before opening a
pull request has its lease let go after fifteen minutes. A lease a question paused
is let go when its task ends, or put back to wait for its pull request when one is
open or the task finished; the reconciler sweeps any left paused with no task
still going under it. A question still open on a task that has already ended is
closed then, since answering it would resume nothing. To sweep now:

```bash
SECRET="$(cat "${OPENADLC_HOME:-$HOME/.openadlc}/secrets/internal-api-secret.secret")"
curl -X POST -H "x-openadlc-internal-secret: $SECRET" \
  http://127.0.0.1:47311/internal/schedule/stages   # or reconcile, merge, deploy
```

## Closed, but still on the board or in Needs you

An issue closed on GitHub without its change merging goes to Done, labelled
`openadlc:abandoned`, and its card says "Abandoned". That covers an issue a
person closed, one a Projects board closed, and one in Review whose own pull
request a person closed unmerged; the bridge then closes that issue as not
planned, with a comment saying why and what each way back does. Reopening the
pull request brings both back, to Review; reopening only the issue brings the
card back to Build, for a new pull request. The lease is let
go, every task still going on the issue or its pull request is stopped (`its
issue was closed without merging`) but a deploy task and the closing account's
own, it is left out of Insights' merges, and its Needs you cards clear: its
questions, failed tasks, review stalls, send-backs and held merges. A review
stall on a pull request GitHub says is closed clears too, within ten minutes
(`ClosedSubjects`), even when the board has no row for its issue. See
[architecture](architecture.md#closing-without-merging).

When a closed card is still in its old column:

- **A merge closed it.** GitHub closes an issue at the merge that says
  `Closes #N`, and the merge's delivery is what moves the card to Ship or
  Done. If the issue's own pull request merged, or GitHub's timeline says a
  merged pull request or a commit closed it, it is not abandoned; with that
  delivery missed, the reconciler moves it within 15 minutes (a commit with no
  pull request here to Done, without the label). One taken for abandoned
  before its merge was handled loses the label when the merge is.
- **GitHub could not be asked.** Whether it merged is read from GitHub, and a
  read that fails moves nothing. The reconcile report says `whether it merged
  could not be read from GitHub; kept until GitHub answers`.
- **The label could not be put on.** The bridge log says `closed without a
  merge, and was left in <stage>` and why. On a repository set up before the
  label existed, the app makes it first; without an app key it cannot, and the
  fix is Settings → Repositories → set up again. Then reconcile.
- **It is labelled `openadlc:ignore`.** Nothing moves it.
- **Its pull request was closed, and the issue was not.** Only a person's
  close of the pull request the card names, with the card in Review, takes the
  issue along. Closing an older round's draft after a send-back, closing it
  while the card is in Build, and a crew account's or an app's close leave the
  issue where it is: close the issue itself.

An issue that waits on an abandoned one under `## Dependencies` stays
`blocked`, and Needs you has a card: "#N waits on #M, which was closed without
merging". Drop or change #M in #N's Dependencies, or reopen #M, and the card
goes; the dispatcher then unblocks #N as usual.

Reopening the issue takes the label off and brings the card back to the stage
its label names, or to the stage it was abandoned from, or to Build; to Build
rather than Review while its pull request stays closed. A card moved out of
Done from the board reopens the issue and stays where it was moved.

```bash
grep -E 'closed without a merge|was reopened' "$(openadlc logs bridge)" | tail -n 20
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
  `paths.shared` in `.github/openadlc.yml`, or the defaults (`README*`,
  `CHANGELOG*`, `docs/**/index*`, `.gitignore`, and others). The other
  approvals stand for the new head, but the lead's does not: the pull request
  waits in review, with `review-gate` pending, until the lead approves the
  resolution head itself. To have a file always reviewed in full after a
  conflict, leave it out of `paths.shared`.
- **Every reviewer was asked again.** A conflicted file is not shared; or it
  is one that can decide how CI runs (the Makefile, a `package.json`, a
  `tsconfig*.json`, anything under `.github/`) or `AGENTS.md`, which are
  always reviewed in full whatever `paths.shared` says; or
  `.github/openadlc.yml` could not be read or does not parse; or the
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
- **It is held (`openadlc:paused`) with a note.** The dependency was sent back
  to build, so what it was built on is changing. It goes on by itself once the
  dependency is approved again (its gate green on its new head) or merges:
  the issue and its timeline say `Let go`, and its reviews start on that
  sweep. If the dependency's change touched files this one changes, its
  builder first brings it up to date with a patch round. While it waits on
  the dependency, the gate sweep says once that its reviews wait for the hold,
  rather than trying them every ten minutes. To let it go sooner, resume it
  from its card, or cancel it and let it be built again from main.
- **It is held for a person, with a card in Needs you.** Its builder could
  not take the patch round (the card says why), or the dependency **was
  closed without merging**: its commits are in this branch and will not land.
  Bring the branch up to date yourself and press Resume, resume it once that
  work lands another way, or cancel it and redo it from main. A dependency
  reopened and approved lets it go by itself; one that merged is never a
  reason to hold it.
- **Turning it off.** Set `stacking: false` in the repository's
  `.github/openadlc.yml`; the issue then waits for its dependency to ship, as
  before.

```bash
grep -E 'resolution round|waits for #|stacked on|let go|held for a person|once the hold goes' "$(openadlc logs bridge)" | tail -n 20
```

## An approved plan change waits on another issue

A builder that asks to add paths to its lease (`plan_change`) and is approved
while another issue's lease or work in build or review holds an overlapping
path stays paused, and its question stays open ([development.md](development.md#plan-changes)).
Needs you shows it as waiting, not as the question again: "The builder (…)
waits for #71 to let go of the approved paths", naming who approved it, the
paths, and each issue that holds them with its pull request, with a button to
open it. Its face has nothing that answers it; **Refuse** is under **Show
more**, and drops the change and stops the task, beside **Turn off approve
all** while approve all is on for the issue. The bot's thread and the item
view offer only **Refuse** on it too. Its card on the board says the same:
"Approved · waits for #71 to let go of the paths".

- **It goes on by itself.** When that work merges, closes or lets go of the
  paths, the paths are added and the task resumes, and the card goes with its
  question. Nothing needs pressing.
- **What it waits on waits on you.** When the holder has its own card in Needs
  you (a question, a failed task, a stalled review), the waiting card says so:
  settle that one, and this one follows.
- **Two wait on each other.** When each holds a path the other asked for, both
  cards say neither goes on: refuse one of the changes, or edit one issue's
  Expected paths.
- **The paths were free, but adding them failed.** The builder is not
  connected to GitHub, say. The card is the question again, "The paths …
  approved could not be added", with the reason and **Approve** and
  **Refuse** on its face; the thread says so once for each reason. Fix what
  it says, then **Approve** again, or let the next work that ends try it.
- **Approving again posts nothing.** An `Approve` on GitHub tries again at
  once: it is granted if the paths are free, and while the same issues hold
  them it changes nothing and writes nothing on the issue. The issue is told
  again only when what it waits on changes, and two approvals at once tell
  it once.

```bash
grep -E 'could not apply the plan change' "$(openadlc logs bridge)" | tail -n 20
```

## A green pull request waits for a person

At the front of the line, up to date with its base and green, a pull request
OpenADLC does not merge waits for a person. Its **Needs you** card, the merge
line's detail ("OpenADLC did not, because …") and a comment on the pull request
say why, in `mergeDecision`'s words (`apps/bridge/src/automation.ts`). When the
reason is GitHub's — it will not land the pull request as it stands — the
words say what holds it, from what the merge already read and, when GitHub
says only `blocked`, from the rules GitHub applies to the base branch
(`GET /repos/<repo>/rules/branches/<base>`) and, when those require signed
commits, the pull request's commits as GitHub verified them (the first 250,
as many as GitHub lists). Those are read only then, a few seconds each at
most, and a read that fails leaves the words as they were for that head, so a
GitHub blip posts no new comment. The words change nothing about what lands:
a pull request GitHub does not call `clean`, `unstable` or `has_hooks` does
not. While GitHub says `unknown`, as it does for a moment after each push or
update of the base, the line says nothing and leaves its detail as it was;
it reads the pull request again on its next pass, and says what GitHub
worked out only when that is a new reason. After ten minutes of `unknown` at
one head it says so, once, as below.

| It says | What it means | What to do |
|---|---|---|
| its commits are not signed (`abc1234`, `def5678`), and main requires signed commits | A ruleset on the base requires signed commits, and these carry no signature. `not verified as signed (abc1234: unknown key)` is a signature GitHub cannot tie to the author's account | Sign them and push again; a commit made in GitHub's web editor or through its API is signed by GitHub. Or have the crew build it: each bot signs with its own key |
| main requires `<check>` to pass, and it has not reported on the head · has not passed on the head | A check the base's rulesets require has no check run or status of that name on the head, or none that passed | Run what reports it, or take it out of the ruleset; for one that has not passed, its run says why |
| `<check>` failed on the head | A check or status besides `ci` and `review-gate` is red | Its run says why |
| `@<login>` still asks for changes | A request for changes stands from someone who can write. GitHub holds the merge for it from an advisory seat too, though OpenADLC waits only on the lead and blocking seats | They approve, or someone with write access dismisses that review |
| main requires a code owner's approval, and `@<login>` is asked for a review on GitHub and has not given one · main requires N approving reviews, and it has M | The base's pull request rule is not met | The person asked reviews it; for approvals, as many people who can write approve it as the rule asks |
| it conflicts with main | GitHub's `dirty` | Merge main into its branch and resolve the conflict |
| it is behind main, and main requires a branch to be up to date | GitHub's `behind` | Update it from main |
| GitHub has not yet worked out whether it can be merged | GitHub has said `unknown` at this head for ten minutes; it usually works it out within seconds of a push | Nothing, usually: the line reads it again on each pass. If it stays, the merge box on the pull request's GitHub page says whether it can merge |
| GitHub says it is blocked, and did not say why | Nothing OpenADLC read explains it. It names what the rules also require that it did not check (every conversation resolved, a code owner's approval, a deployment), or says no ruleset applies to the base, which leaves a branch protection rule (Settings → Branches), which only an admin can read | The merge box on the pull request's GitHub page lists what is missing |

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
`.github/openadlc.yml`, and says what it did in the log: `dispatched
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
  did not answer for `.github/openadlc.yml` (a 5xx, a rate limit, the network),
  or the repository's stored rules could not be read. The bridge waits rather
  than act on the fallback, which may promote a repository that soaks, or deploy
  one that ships by merging: it keeps the last rules it read where it has them,
  and otherwise takes the step once a read works. Stacking skips that
  repository for the pass, and says so.
- **A promote ran with nobody approving it** — the `production` environment has
  no required reviewer though the rules say `approval: reviewers`. The
  `production-rules` card says so and opens the walkthrough's Protect step:
  choose how production ships there, naming who approves it, or ship
  automatically after testing (`openadlc github apply --production reviewers
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
  automatic rollback. Where `.github/openadlc.yml` sets the rules, set
  `production.approval: auto` there; the card opens the file.
- **A crew account can approve a production deploy** — the `production-rules`
  card, blocking. Take the crew out of the environment's required reviewers in
  the repository's Settings → Environments → production. A bot never approves a
  deploy; the repository's GitHub rules do.
- **`@<org>/<slug>` is a team among its production reviewers** — the
  `production-rules` check has no answer, rather than passing: any member of a
  reviewer team may approve, and OpenADLC cannot see who is in it. Confirm on
  the organization's Teams page that no crew account is a member.
- **`deploy-testing run <id> was skipped`** — the run was dispatched and its
  job did not run: the template's runs only where the repository sets the
  `OPENADLC_DEPLOY_TESTING` Actions variable to `true`. The bridge dispatches
  it all the same, since only the run says what a workflow did, and reads the
  skip as a deploy of nothing ([below](#a-stacked-issue-waits-after-its-base-merged)):
  the merge ships by merging, and its card goes to Done, its timeline saying
  `Moved to Done: merging shipped it`. Settings → Repositories says the same
  of the repository while its newest testing deploy had nothing to deploy.
  If the repository has no testing environment, say so in its rules too
  (`testing: on: none`, or Settings → Repositories → **No testing deploy**):
  merging then ships without a dispatch. If it ships as a release instead,
  tick Settings → Repositories → **Ships by release** (`testing: on: release`):
  its cards then wait in Ship for the release that contains them.
- **A release was published and its cards are still in Ship** — the release
  is a draft or a prerelease, which ship nothing; or its tag's commit does not
  contain their merge (it was cut before they merged); or no `release`
  delivery came, and the deploy sweep moves them at its next run, saying
  `moved to Done: released in vX.Y.Z`. The `ships-by-release` card says when
  the app is not subscribed to **Release** events: tick it on the app's
  Permissions & events page, and releases move cards as they are published. A
  card with no pull request recorded has no merge to compare: move it by hand.

## A stacked issue waits after its base merged

An issue stacked on another, or one whose files overlap it, waits while the
base's lease holds those files. After the base merges, its lease is kept until
the builder has verified the change on testing, and the end of that
verification lets it go. Its approved `plan_change` waits the same way: the
bridge says `#N holds paths that overlap them`, and approving it again changes
nothing while the lease is held.

No deployment, no verification. So the lease is also let go when:

- **The testing deploy deployed nothing.** The `deploy-testing` run the bridge
  dispatched finished `skipped` (the repository sets no
  `OPENADLC_DEPLOY_TESTING`), was `cancelled` with no later deploy to carry
  it, failed to start (`startup_failure`, which is also filed as a failed
  testing deploy that did not start: most often a workflow file GitHub could
  not run), or no run of it appeared within 10 minutes of the dispatch. The
  run's `workflow_run` delivery settles it at once; the deploy sweep looks up
  any whose delivery never came. The commit's `deploy_runs` row records how it
  ended (`testing_conclusion`) and why (`detail`), the audit log has
  `deploy.testing_deployed_nothing`, and the deploy sweep says `its testing
  deploy deployed nothing (…), so its lease was let go` instead of `a testing
  deploy was already started (running)`. A run that was skipped, or that
  GitHub calls a success and ran no job, had nothing to deploy: its cards go
  to Done (`deploy.shipped_by_merging` in the audit log, and the reason on the
  stage move and in each card's timeline), and the deploy sweep moves any
  still in Ship, settled before it did this. That run, when it is the newest
  merge's (the tip of the default branch), carries every older merge still in
  Ship, and the sweep moves those too, each with `merging shipped it: carried
  by the testing deploy of <repo>#<pr>, the newest merge: …`: one with no
  testing deploy of its own (a merge whose delivery never came), or one whose
  own run was cancelled or never started. One whose own deploy is still
  running, failed or deployed stays, and the sweep says the older merges
  `stay in Ship until a later deploy carries them or a person moves them to
  Done`. Any other run that deployed nothing keeps its card in Ship: move it
  to Done, or turn the repository's testing deploy off as above. A run that
  failed lets nothing go: it is filed as a failed deploy, and the deploy that
  fixes it is verified as usual.
- **Not a cancelled run a later merge's deploy carries.** deploy-testing's
  concurrency group cancels a waiting run when a newer merge's queues, and the
  newer deploy finishes both. That run is recorded `superseded`, and its
  lease waits for the newer deploy's verification; if the newer deploy
  deploys nothing too, both are let go then, and if it had nothing to deploy,
  both go to Done.
- **The sweep waits on a run it cannot place.** A commit's run is found by the
  whole commit id in its name (`deploy-testing <sha>`). While any run of the
  workflow since the dispatch names none — a short id, or a workflow of the
  rules' own that names its runs otherwise — the sweep does not take the
  dispatch for one that never started: it says so, and asks again, for a week.
- **The card reaches Done.** The bridge's own moves let the lease go. So does
  a person's `adlc:done`, from its delivery or, on a closed issue, from the
  next reconcile, which repairs the board and lets the lease go in that pass —
  but only for a change that merged (the card was in Ship, or its pull request
  merged), and not while a verification or deploy task is still going on its
  pull request. `adlc:done` on a card in Review keeps its lease: the change is
  still open, and overlapping work would start beside it.
- **A day passes** with the issue merged and no verification started: the
  reconciler lets it go then, `merged, and its verification on testing never
  started within a day`.

Wherever a lease is let go — one of these, a lease that ran out, one the
reconciler releases, a task's end, a pull request closing — the approved plan
changes held on paths are tried again, and the tasks they were for resume.
Every reconcile pass (a quarter of an hour) tries them as well, for a lease
let go where nothing looks at once.

```bash
grep -E 'deployed nothing|released the lease|reached Done|merging shipped it|released in' "$(openadlc logs bridge)" | tail -n 20
```

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
| OpenADLC's labels (off by default) | Every label named in `config/labels.json`, and the older names of renamed ones (`sdlc:*`), is deleted, which also takes it off every issue and pull request. Generic names the repository may have had first (`blocked`, `deps`, `safety`, `revert`, `breaking`, `incident`, `needs-triage`, `needs-human`), and labels that only start like OpenADLC's (`priority:high`), are listed apart and deleted only when that is ticked too | `repo.labels_removed` |

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
