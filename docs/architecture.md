# How OpenADLC works

The parts of OpenADLC, how they talk, and what happens to one request on its way
to Done. The design and its decisions are in
[platform-plan.md](platform-plan.md); this is the system as the code has it.

## The parts

```
   GitHub  ──webhooks──▶  bridge  ◀──HTTP──  console (Next.js)  ◀──  you
     ▲                    │  ▲                                     │
     │ REST, as the       │  │ /internal: tokens, task state,      │ take-over:
     │ crew's accounts    ▼  │ usage, gates                        │ WebSocket to
     └──────────────────  hostd :47312  ◀──────────────────────────┘ /terminal
                            │  └─▶  a task's container: tmux session
                            │        └─ skill runner ─▶ engine CLI (Claude, Codex, Grok)
                            ▼
              Postgres (fleetadlc_db)    task database server (fleetadlc-taskdb)
```

| Part | Runs as | Job |
|---|---|---|
| **bridge** (`apps/bridge`) | one process, :47311 | The event loop. Takes GitHub's webhooks and the console's requests; decides what a stage change means; opens tasks; keeps gates, the review gate, the merge line and the health checks; mints short-lived GitHub tokens; runs the scheduled jobs and the dispatcher |
| **dispatcher** (`apps/dispatcher`) | a library, in the bridge | Decides which issues may start and leases each to a free builder, holding back work whose files another change in flight holds, by the repository's path policy |
| **hostd** (`apps/hostd`) | one process per host, :47312 | Gives each task a computer of its own — a container under the docker driver, made when the task starts and removed when it ends; a folder and tmux sessions under the local one — and runs the task in it: a clone, a session, the skill runner. A seat is a task's GitHub identity, never its computer |
| **skill runner** (`apps/hostd/src/skill-runner.ts`) | inside the session | Builds the prompt from the skill and the task's context, drives the engine, reports usage and questions to the bridge, and says how the task ended |
| **console** (`apps/console`) | Next.js, :47300 | The board, the bots' threads, gates, costs, settings and onboarding. It holds nothing: every read is the bridge's, and the bridge leaves out every issue labelled `fleetadlc:ignore` and its pull request (`ignoredSubjects`) |
| **cli** (`apps/cli`) | `fleetadlc …` | Sets an install up, starts and stops it, checks it; each service runs under a keeper that restarts it |
| **Postgres** | `fleetadlc-db`, :47432 | The platform's own state. GitHub stays the record of the work |
| **Task database server** | `fleetadlc-taskdb`, :47433, one per host, on the host's gateway address only (docker driver) | A database of its own for each task whose seat has `sidecarDb`, dropped with the task's computer |

GitHub is the system of record: an issue's stage is its `adlc:*` label, a
decision is a comment, a change is a pull request. OpenADLC's database holds what
GitHub cannot: the bots and the record of their sign-ins (the tokens and keys
themselves are in the secret store), leases, tasks and sessions, the cost
ledger, threads and gates, and the console's settings.

## How the parts trust each other

- **Console → bridge.** On a local install the bridge takes the console user
  from a header, and serves `/v1` only beside the console secret
  (`console-api-secret`), which only the console's server and the CLI hold; a
  browser signs in to the console with a link `fleetadlc up` and `fleetadlc
  console-link` print. In the cloud it verifies Google IAP's signed assertion
  (`FLEETADLC_IDENTITY_MODE=iap`). A request from a browser on another origin is
  refused.
- **bridge ↔ hostd.** Both hold the internal secret (`internal-api-secret` in the
  secret store). A task's session gets a token that speaks for that task only.
- **Browser → hostd.** Take-over's WebSocket goes from the person's browser
  straight to hostd's terminal gateway (`/terminal`, on :47312 unless
  `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL` says otherwise), admitted by its Origin
  (`FLEETADLC_CONSOLE_URL`) and a one-minute, one-use attach token that hostd
  mints when an admin asks the bridge, sent as a subprotocol and never in the
  query string.
- **OpenADLC → GitHub.** The crew works as the GitHub accounts the operator
  connected, each once with the device flow: seats in a group may share one
  account (the crew's, or the reviewers'), and a reviewer never shares the crew
  account, since GitHub won't let an account approve its own pull request; OpenADLC keeps a refresh token and mints a user token for each
  task. The GitHub App's installation token is used where only the app may act.
- **GitHub → OpenADLC.** A delivery is taken only when it is signed with the
  webhook secret, names a repository OpenADLC works in by owner and name, and was
  written by somebody with access to it, or by the crew
  ([security.md](security.md#who-openadlc-acts-for)).

## One request, start to finish

1. **Asked.** A person writes what they want in the console's New request —
   a line, the details, and any screenshots, mockups or documents, which are
   kept in OpenADLC's database and never posted to GitHub
   ([ADR 0001](adr/0001-attachments-in-the-database.md)) — or opens an issue. A console request is not an issue yet: it is a request row,
   and an intake task runs on the subject `request:<id8>`; it shows in the
   Intake column while it does. `<id8>` is the first eight characters of the
   request's id, and it is unique per install: the database refuses a second
   request with the same eight (migration 0144), and the store draws a fresh
   id. Two requests that shared them before that migration stay ambiguous;
   their triage is told to have the request sent again. A request sent while the intake bot is
   running another triage is `queued` (`POST /v1/requests` answers 202 with
   its place in line) and starts by itself, oldest first, when intake ends
   that triage or pauses it on a question (`apps/bridge/src/request-queue.ts`).
   A request whose intake cannot start is passed over with the reason kept on it, and
   tried again after 1, 2, 5 and 10 minutes, five times in all. After that
   the queue gives up on it: it leaves the line (no place, not intake's next,
   no Queued card on the board) and shows in Needs you with the reason its
   start was refused and Try again. A request that hostd refused, or that was refused because the
   health checks say hostd is down or intake cannot sign in to GitHub, stops
   the queue without counting against any request, and the queue tries again
   a minute later. "Try again" on a request's triage goes through the same queue.
   A request nobody wants any more is abandoned: from the Abandon on its
   failed-triage card in Needs you (`POST /v1/requests/:id/abandon`), or by
   cancelling it (`POST /v1/items/request:<id8>/cancel`). Its triage stops,
   its questions close, and nothing starts it again, a queued one included:
   the queue starts only a request still `queued`. Dismiss on that card hides
   it until a later triage of it ends.
2. **Intake.** The intake bot (skill `triage`) reads the request, the files
   given with it, the repository and the open issues, and clarifies everything
   the issue needs — outcome and scope, acceptance criteria and edge cases,
   what it should look like, data, verification, what is out of scope — one
   question at a time, the most decisive first. A question opens a
   **gate**: the task pauses, and the question waits in Needs you (and on the
   issue, for an issue). The answer resumes the task. Each request is a **work
   item** of its own (`apps/bridge/src/items.ts`): the conversation about it is
   every thread about the request, the issue it becomes and that issue's pull
   request, whichever seat said it, labelled by the role that said it
   (`GET /v1/items/:subject`, any member's subject opening the same item). A
   message written on an item answers the question the person picked, or the
   one question open on it; never a question about another item. Otherwise it
   goes to the seat that last spoke on the item (in the role of the tab it was
   written on), else the seat whose task is running on it, else the seat that
   staffs its stage, and is posted as that seat's GitHub account: on the pull
   request for a reviewer, on the issue for anyone else, in the request's
   thread before there is an issue, and kept in OpenADLC, not posted, for a
   subject GitHub has no page for (a deploy of a commit). The item's view
   carries that route for each tab (`routes`), worked out by the same
   function, and the line above the message box says it. When it has everything, it shows the person the issue
   it would file and asks them to agree to it; then it files it — outcome,
   acceptance criteria, priority, expected paths, dependencies, verification,
   the files by name and a link to the item in the console, never the files —
   and labels it `adlc:build`, or `adlc:spec` when the repository's spec rule
   says it needs a design first. Triage is told the rule in `open-issues.md`
   (the spec mode and the labels that call for a design, such as
   `touches:schema` or `size:large`) and puts on those that fit. When its task
   ends, on an issue opened on GitHub or one filed from a console request
   alike, the bridge applies the rule to those labels and moves the issue to
   Design or Build itself (`StageHandoff.afterIntake`); an issue it moves into
   Build gets `start:now`, or `blocked` while a dependency has not shipped.
   The bridge applies the same rule as soon as intake's stage label comes in,
   so an issue is never left in a Design the rule does not ask for. Any other
   stage label a crew account sets, forward or back, is put back and audited
   (`stage.forward_refused`, `stage.backward_refused`): the bridge moves work
   on when its stage ends.
3. **Design** (sometimes). The system engineer writes the design on the issue and
   stops on the choices a person must make. It reads what intake learned
   (`intake.md`: the request, its detail, its files and every answer, whole),
   which the issue only summarises, and the repository's **design memory**
   (`design-memory.md`): what it has decided before. Design is the one stage
   with memory ([ADR 0002](adr/0002-design-memory.md)). Its comment ends with a
   `design_memory` marker proposing what to remember. Only that comment
   proposes: its last marker, in a comment whose signature verifies to the
   issue's design task, whatever the attribution mode, so a builder's or a
   reviewer's comment, a marker quoted further up, or the bridge's echo of a
   person's words proposes nothing. An entry is accepted when a person answers
   that design's question, credited to them, or when the issue moves to build,
   credited to the design's seat. One that supersedes an accepted entry is
   said on the issue and on the board, and a person reverts it in Settings →
   Repositories → Design memory. A decision is written as an ADR under
   `docs/adr/` by the build, in the pull request.
4. **Build.** The dispatcher runs whenever something changes, and every five
   minutes besides. It starts an issue when it is in Build with `start:now`,
   says enough to be built, has its dependencies shipped, does not overlap files
   another change in flight holds — an exclusive path until that change merges,
   any other path only while it is being built, a shared path never, as the
   repository's `paths:` in `.github/fleetadlc.yml` says — and a builder has room — a seat runs
   up to its tasks at once, each in a computer of its own. It **leases** the
   issue to that builder — the issue, the bot, the declared paths, an expiry —
   and the bridge opens an `implement` task. hostd clones the repository's
   mirror for the task, on a branch
   named `agent/<bot>/<n>-issue-<n>`, and the builder writes the change inside
   the declared paths, commits, and runs `fleetadlc-ci`: the session asks the
   bridge, the bridge asks hostd, and hostd runs `make ci` in the worktree with
   the task's own database once it has proved the worktree is the commit's own
   tree (in a clean checkout of the commit when it cannot, such as an index
   entry hidden from `git status`), checks HEAD did not move and the tree
   stayed clean, and reports the result to the bridge with the install's
   secret, which
   records it for that commit (`local_ci_runs`, `apps/hostd/src/local-ci.ts`).
   OpenADLC's `git` refuses to push a commit with no recorded pass and its `gh`
   refuses to open or ready a pull request on one; the builder opens it ready,
   never as a draft, and never turns auto-merge on. Those are guards: the
   bridge itself reviews nothing a crew account pushed with no pass on its
   head — `review-gate` says so, and the work goes back to build.
5. **Review.** The bridge asks the reviewer seats `config/review.yaml` lists
   and triggers — a second reviewer on another model, the security reviewer by
   label, path or sample, the SRE for workflow, runbook and infrastructure
   changes — and the lead last.
   Every seat but the lead reviews at once, without CI, and posts a comment
   with its verdict and lens in its marker; OpenADLC's `gh` refuses an advisory
   seat an approval or a request for changes (`FLEETADLC_REVIEW_MODE`). Once every
   other seat asked has posted on this diff, the lead is asked, with all of
   their reviews in front of it, and decides: approve, or one request for
   changes with every finding that stands. Each round of reviews records
   `review.round_opened` `{subjectRef, sha}` before any seat is asked, and
   that is when the diff began. A seat that was busy, or could not work, when
   a round opened is started by the gate sweep once it can: only a review
   under way or one opened since the round began counts as its review of this
   diff, never one from an earlier round. The lead likewise: a lead task under
   way, or one opened since the later of the round's start and the last other
   seat's post, is that review; otherwise the sweep asks the lead again. A
   pull request only the lead reviews (a revert no other seat's trigger asks
   for) gets the
   lead's review in every round this way. A seat marked `blocking` approves
   or requests changes itself, before the lead. The bridge publishes
   `review-gate` on the head commit: pending while a seat has not posted on
   this diff, while the lead has not, until the lead and every blocking
   seat approved and each person `AGENTS.md` names for the paths it touches
   approved, and while it is held (`needs-human` or `fleetadlc:paused`). The lead's request for changes sends the work back to build
   (below): the card moves to Build and a patch round opens for the builder,
   up to `maxRounds`; a loop that does not agree stops and asks a person. A
   failed `ci` run is run again once, as the app (it needs "Actions: write");
   a second failure after the lead approved sends the work back to build too.
   Only a crew branch (`agent/…`: a build, a QA suite change, an ADR) needs a
   recorded local CI pass for the lead to approve it. Any other pull request —
   the SRE's revert, a person's own branch — has no crew author to run one:
   the lead's `local-ci.md` says so, and it is reviewed against GitHub's
   `ci`, which runs on such a branch at once and which the merge waits for. When the lead asks for
   changes on a pull request no builder holds, the bridge comments, labels it
   `needs-human` and records `review.stalled`, once for each head, so it shows
   as a stalled review.
6. **Merge.** A pull request whose `review-gate` passes joins the **merge line**:
   one repository at a time, the bridge brings the front one up to date with
   the base branch, with the builder's credential, and waits for `ci` and
   `review-gate` on the new head. GitHub's CI on a crew pull request (an
   `agent/` branch) runs only with `adlc:ci` on it (`.github/workflows/ci.yml`
   and the template's): once the front one is up to date with no `ci` run, the
   bridge puts the label on as its app and audits `ci.requested`, and puts it
   on again when no run appears within ten minutes. So CI runs once, on the
   head that lands, after the lead approved; a branch update re-runs it while
   the label stays. A failed run is run again once; a second failure takes the
   label off, takes the pull request out of the line and sends the work back
   to build with the run. `adlc:ci` put on by anyone else but a person who can
   write is taken off and audited. A person's pull request runs CI as it
   always did.

   Before it lands a crew pull request, the bridge compares every file it
   changes, a rename's old name included, with the paths OpenADLC's lease for
   its issue declared (widened only by an approved plan change, never by an
   edit of the issue), plus `tests/`, `docs/`, `AGENTS.md` and tests beside
   declared modules (`mergeDecision`). One that strays leaves the line and goes
   back to build with the stray files named; its patch round is briefed with
   the lease's paths alone. `scope:cross-cutting` lets it through only when the
   app, the automation account or a person put it on. One that closes no
   issue waits for a person.

   A branch that conflicts with the base leaves the line for a short
   **resolution round** (`apps/bridge/src/conflict-round.ts`), not a whole
   round back in build. The conflicted files are those the pull request
   changes that the base also changed since the branch left it. The builder
   holding the issue gets a `patch` task with the `resolve-conflict` skill,
   which may write only those files. It merges the base in, keeps both sides'
   intent, runs `fleetadlc-ci` and pushes. The bridge records
   `conflict.resolving` `{repo, pr, issue, files, review, head, prFiles, base, at}`.
   How the push is reviewed depends on the files:
   - If every conflicted file is shared (`paths.shared` in
     `.github/fleetadlc.yml`; the defaults are the Makefile, `README*`,
     `CHANGELOG*`, `docs/**/index*`, `package.json`, `.gitignore` and
     `AGENTS.md`), only the lead is asked again. Its task is told to check the
     resolution alone (`resolution-check.md`), whatever lead reviews it did
     before the push; a lead busy at the push is asked again by the gate
     sweep, with the same brief, until a lead task opened since the push
     exists. The other seats' approvals still count for the new head:
     `MergeFacts.carriedFrom` holds the earlier heads that lead-only resolutions
     started from, followed back through each one.
     The lead's does not: the review gate stays pending, and `mergeDecision`
     refuses, until the lead approves the resolution head itself, or a head
     with its diff. A person's approval never carries. This holds only while
     the push changes nothing but the conflicted files and what the base
     brought, as the base has it; a push that rewrites any other file, even
     one the pull request already changed, or one GitHub cannot compare, is a
     full review.
   - A conflict in a file that can decide how CI runs (anything `changesCi`
     names, a `package.json` or `tsconfig*.json` at any depth) or in
     `AGENTS.md` is always reviewed in full, whatever `paths.shared` says. So
     is any conflict when `.github/fleetadlc.yml` cannot be read (anything but
     a 404, which gets the defaults) or does not parse.
   - Otherwise the approvals are dismissed and the reviews run again in full.

   While a round is open, every push to the pull request is the round's,
   even one whose diff against the base is unchanged, so a resolution is
   always re-checked.

   Each push records `conflict.resolved`
   `{repo, pr, issue, files, review: 'lead-only' | 'full', from, to, at}`. A
   full review, or a round that could not be opened (no builder holds the
   issue, or the files cannot be told), also records `conflict.sent_back`
   `{repo, pr, issue, files, why, at}`. The second case also falls back to
   the whole send-back.

   A builder that is busy (it runs one task at a time by default), or held by
   a health check or a spending cap, does not send the change back: the
   round waits. Its `conflict.resolving` carries `pending: 'busy'` or
   `pending: 'blocked'`, nothing is said on the pull request, and the pull
   request stays out of the merge line instead of conflicting again on every
   sweep. A busy round is started by the gate sweep once the builder is free.
   A held one is a failed task with Try again, which the recovery runs again
   when the check passes. A round run again, by a person or the recovery,
   keeps its `resolve-conflict.md` brief and may write only the conflicted
   files, and the recovery runs it again while the card is in Review.

   **Landing.** The bridge merges the pull request at the front of the line
   (squash) as the GitHub App, never with a bot's token, when every rule
   holds on that head (`mergeDecision` in `apps/bridge/src/automation.ts`):
   - it is the repository's own branch, not a fork's, onto the default branch;
   - it carries neither `needs-human` nor `fleetadlc:paused`;
   - the lead's latest verdict, and each blocking seat's, is an approval, of
     this head or of an earlier one whose diff against the base is the same,
     with seats on one account told apart only by a signature that checks for
     that review, in audit mode as well as enforce; the other seats are
     advisory, and the lead read them. "The same diff" covers both sides of
     every file the pull request changes: what it was at the merge base and
     what it is at the head. A merge of the base that kept the pull request's
     side of a file the base also changed is a changed diff, and the reviews
     run again; one that brought in only files the pull request does not
     touch is not;
   - each person `AGENTS.md` names for the paths it touches has approved it
     the same way, nobody asked on GitHub is still to review (including a
     request taken away by someone who cannot decide that), and nobody who
     can write to it still asks for changes;
   - if it changes how CI runs, the security reviewer has also approved this
     diff, in a review whose signature checks; without that seat or
     signatures, or in a repository listed in `ciMergeByPerson`, a person
     merges it ([security.md](security.md));
   - `ci` is GitHub Actions' run of the `ci` workflow on the head, never a
     commit status; `review-gate` as OpenADLC published it is green; no check is
     red;
   - it is not a draft, and GitHub says it can merge.

   Anything it cannot read in full (more files than GitHub lists) refuses. A
   diff too long to compare carries no approval over from an earlier head, so
   the head that lands must be approved itself.

   Each merge is audited as `merge.landed`, with every approval it landed on,
   and said on the pull request. OpenADLC's `gh` refuses a bot's merge, and
   where GitHub enforces rulesets the main ruleset requires the reviews. On a
   private repository whose plan refuses rulesets a crew account's token can
   still merge through the API: the bridge detects that merge
   (`merge.unreviewed`), flags it and holds its testing deploy until a person
   moves the card to Merged or reverts it. The install setting `bridgeMergeOff` (`PATCH /v1/install`,
   repository names, comma-separated) leaves a repository's merges to
   auto-merge and the branch's rules, or to a person. A pull request it
   leaves for a person — a change to how CI runs in a repository listed in
   `ciMergeByPerson`, say — is a Needs you card that links to it, and its
   board card says it is waiting for you rather than merging.

   **Stacking** (`apps/bridge/src/stacking.ts`) applies to an issue whose one
   unshipped dependency is in review with its pull request open, and only
   to one the dispatcher would lease itself: in build, not marked
   `do:human`, `needs-human` or `needs-triage`, ready to route, under the
   attempt limit, overlapping no other work in flight but its dependency,
   and within the repository's concurrency. Nothing is stacked while work
   is paused, in that repository or install-wide, or while nothing
   dispatches:
   - It is leased to that pull request's builder, and its build starts from
     the dependency's branch rather than waiting for the merge.
   - Which issue it was built on is a row of its own (`stacks`), written
     before its build starts, which does not start without it, and read with
     no time window. Its own pull request does not join the line until the
     dependency has merged, however long that takes; while the stack cannot
     be read, it does not join either. The line then merges the base into its branch itself, through
     GitHub's merges endpoint, which answers with the commit it made. The
     approvals stand only for a push to that exact SHA, whose first parent is
     the head the line read, and only once (`stack.updated`). Any other push,
     even one from the same head touching only files it already changed, is
     reviewed as any push is. When the update conflicts, the line records
     that it made nothing, and the builder's resolution goes to a resolution
     round with that round's re-review.
   - If the dependency is sent back to build, or closed without merging, the
     stacked issue is held (`fleetadlc:paused`) with a note, for a person to
     resume or redo, once per stacking (`stacks.paused_at`).
   - It is one level only, and on unless the repository sets
     `stacking: false`. It records `stack.started`, `stack.updating` (the
     head about to be updated), `stack.made` `{repo, pr, from, to, at}` (the
     commit the update made, `to: null` when it conflicted, failed or landed
     on a head that had moved), `stack.updated` and `stack.paused`.
7. **Ship.** By the repository's rules, `.github/fleetadlc.yml` on its default
   branch (`apps/bridge/src/delivery-rules.ts`): a merge dispatches the testing
   deploy as the app (or as the automation account where the app cannot act
   on the repository); only a merge into the default branch moves its issue
   and starts it, and one into any other branch, `release/1.x` say, leaves
   the issue, its lease and testing alone; a green smoke on testing
   dispatches the promote; the
   `production` environment holds it for its required reviewers or its wait
   timer, which `fleetadlc github apply` writes from the same rules. Where
   GitHub's plan cannot hold either, the bridge holds the soak itself
   (`deploy_runs.promote_after`), and a promote the rules say a person
   approves waits in Needs you (`deploy_runs.promote_held_at`) until a person
   releases it or switches the repository to automatic delivery
   (`apps/bridge/src/deploy-routes.ts`). A bot never approves a deploy; the
   repository's GitHub rules, or a person's release, do. A red smoke reverts the
   change and sends it back to build. A failed production deploy is acted on
   only when it is a promote the bridge dispatched, and by where its run
   stopped: a red production smoke sends the change back to build and leaves
   production as it is; a failed traffic shift dispatches the rollback, whose
   empty target means "before the last shift", and files an issue; anything
   else files an issue and rolls nothing back; a promote that never ran does
   nothing (`apps/bridge/src/deploy-pipeline.ts`, each step once per commit in
   `deploy_runs`). `testing: none` ships by merging,
   straight to Done. A repository with no rules file follows Settings →
   Repositories' **Automatic**, **Has a testing deploy** or **No testing
   deploy** as those rules. OpenADLC does not read the `FLEETADLC_DEPLOY_TESTING`
   Actions variable.
8. **Done.** The issue is closed, the lease is let go, and its files are free
   for the next change.

### Sending work back

Any stage can send its work back to the stage before it with a reason
(`apps/bridge/src/send-back.ts`). A task's session ends a message with a
`send_back` marker; the skill runner posts it to
`POST /internal/tasks/:id/send-back` with the task's token and the session
ends. The bridge works out where it goes from the issue's recorded moves
(`stage_moves`, `previousStage` in `packages/shared/src/stages.ts`) — build goes
back to design only when the issue had a design pass since it last entered
intake — and refuses any other stage, and any send-back past the limits in
`config/review.yaml`, which puts `needs-human` on the issue instead. A
send-back closes the task's questions, says it on the issue as the automation
account (a `send_back` marker there is only ever a record), moves the card,
and, leaving build, lets go of the lease and makes an open pull request a
draft again, out of the merge line. The stage it went to is started when the
task ends, and reads why in `sent-back.md`; the next build goes on from the
pull request's branch. A stage nobody staffs, or nothing staffed on the way
back, is a card in Needs you.

Review to build is the review loop: changes requested, or CI that fails again
after its rerun, moves the card to Build and opens the builder's patch round,
keeping its lease; the next push that changes the diff moves it to Review.
Closing a crew pull request unmerged releases its lease and stops its
reviews; reopening it takes the lease again for the same builder and paths
(`lease.reacquired`), moves the issue to Review and asks the reviewers again,
as when it first became ready (a draft waits until it is ready). A send-back
that finds nothing holding the issue — the pull request was reopened, or the
reconciler let the lease go — takes the lease the same way first. It takes
none for an issue no longer on the board or outside Review and Build, a
builder no longer in the crew, or paths another lease holds now; then the
bridge logs why and records `review.stalled` with that reason, and the board
shows the stopped review with it. A
person moves a card anywhere from the console (back with a reason) or by its
label on GitHub; the work of a later stage still running is stopped. A
person's move from Review back to Build takes an open pull request out of the
merge line and takes `adlc:ci` off it, and opens the builder's patch round with
the person's reason, under the same `maxRounds`. The merge line lands an
issue's pull request only while the issue is in Review: one let in after such
a move is dropped from the front, and a green review gate does not put it
back. A crew account that moves a stage label back is put back.

## Keeping the story straight

- **Webhooks are idempotent.** Each handler works out what should be true from
  the delivery and the current state, so a duplicate does nothing twice.
- **The reconciler** (every 15 minutes) compares GitHub with the board and
  repairs what a missed delivery left wrong: an issue never heard of, a stage
  changed by hand, a merge whose delivery never came (the issue GitHub closed
  moves to Merged or Done, not off the board; one labelled `fleetadlc:ignore`
  is left where it is, its labels only kept up to date), a lease on a closed issue, a
  lease a question paused whose task has since ended, a task recorded half an
  hour ago that no host ever started. It reads at most 5000 open issues and
  pull requests of a repository; past that it skips the repository, says so
  under "Needs a person" on each pass, and its board follows GitHub's webhooks only.
- **Failed deliveries are redelivered.** GitHub does not send a delivery again
  by itself when the bridge is down, its tunnel is, or the machine sleeps. When
  the bridge starts, and on every reconcile, it asks GitHub for the app's
  recent deliveries and has it send again each one that got no answer or a
  5xx, up to three times each and within GitHub's three days
  (`redeliverFailedSince`, `packages/github/src/app-hook.ts`). A gate answered
  on GitHub during an outage is taken once the bridge is back.
- **The scheduler** runs the rest on timers: the budget, the review-gate sweep,
  the merge line, stalled stages, credentials, engine updates, nightly QA.
- **Health checks** (`apps/bridge/src/health/`) prove what a person was asked to
  do actually happened — a permission granted, a sign-in approved, a webhook
  arriving — by its effect. A failing one is a card in Needs you with the thing
  to do, and it clears itself.

## Glossary

| Term | Meaning |
|---|---|
| **Seat** | A place in the crew, such as `builder` or `lead-reviewer` (`config/bots.yaml`). A bot is the seat until an account connects, then the account's handle |
| **Role** | What a seat is accountable for: `intake`, `spec`, `implement`, `review_lead`, `review_second`, `review_security`, `deploy`, `qa`, `automation`. Its playbook is `crew/roles/<role>.md` |
| **Skill** | What a task does, step by step: `crew/skills/<name>/SKILL.md`, with the commands and files it may use in `tools.yaml` |
| **Delivery rules** | How a repository ships: `.github/fleetadlc.yml` on its default branch — what deploys on merge, what holds production (`approval: reviewers` or `auto` with a soak), and the workflows OpenADLC dispatches. See [configuration.md](configuration.md#githubfleetadlcyml--how-a-repository-ships) |
| **Stage** | Where an issue is: intake, spec, build, review, merged (Ship), done. It is the `adlc:*` label |
| **Stage mode** | How much a stage may do without asking, per repository: `autonomous`, `conditional` (Design only), `untouched` (Intake and Design only; a repository's bots are stopped with Pause work) |
| **Send-back** | A stage returning its work to the stage before it, with a reason the receiving stage works from; recorded in `stage_moves` and on the issue |
| **Task** | One bot's run of one skill on one subject, with a dollar cap: queued, running, paused, then done, failed or stopped |
| **Design memory** | What the design stage is told a repository has decided: decisions, constraints, conventions and terms (`design_memory`, migration 0030), proposed only by the design task's own signed comment, accepted by a person's answer to it or the move to build, a supersede said on the issue and revertible, curated in Settings → Repositories. A summary of the repository's ADRs, which are the record ([ADR 0002](adr/0002-design-memory.md)) |
| **Work item** | One piece of work as a person means it: a console request, the issue it became and that issue's pull request. Its key is `<repo>#<issue>` once the issue exists, `request:<id8>` before; any other subject (a deploy of a commit) is an item of its own. Its conversation is every thread about any of its subjects, each labelled by the role and seat it was with (kept on the thread when it was opened, migration 0028), so seats sharing one GitHub account are still told apart |
| **Lease** | The record that an issue is being built by a bot, with the paths it may touch and an expiry |
| **Gate** | A question that holds a task until a person answers. A **plan change** is one: a task asks to add paths to its lease, and a person approves or refuses ([development.md](development.md#plan-changes)) |
| **Marker** | A line such as `<!-- fleetadlc:{"event":"review_posted"} -->` that ends a bot's comment, so the bridge learns what it did rather than guessing |
| **review-gate** | The gate the bridge publishes on a pull request's head: a check run by OpenADLC's App when it holds Checks: write (what `fleetadlc github apply` pins), with a commit status of the same name beside it. It is green once every seat asked has reviewed this diff, the lead last; the lead and every blocking seat have approved; each person `AGENTS.md` names for the touched paths has approved the head; and neither `needs-human` nor `fleetadlc:paused` is on the pull request |
| **Lead reviewer** | The seat that reviews last: it reads every other seat's review and decides for the round; the others are advisory unless marked `blocking` |
| **Merge line** | The order approved pull requests are brought up to date and landed in |
| **Expected paths** | The files an issue says its change touches; the lease is granted them, and the merge line holds a crew pull request to the lease's paths, sending one that strays back to build |
| **Dependencies** | An issue's `### Dependencies` section; it does not start until those have shipped |
| **Model account** | An engine credential, a key or a subscription, that bots are assigned to |
| **Driver** | How hostd gives a task a computer: `docker` or `local` |
| **Computer** | Where a task runs: under `docker` a container of its own (`task-<id8>`), with its own folder, its repository's cache, and a database of its own when its seat runs checks |
| **Scripted install** | One whose engines follow a script instead of a model; what the integration suites run against |
