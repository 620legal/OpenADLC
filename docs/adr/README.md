# Decisions

One file per decision that would otherwise be re-argued: `NNNN-short-title.md`.

A decision record says what was decided, what it rules out, and what would make
it worth revisiting. It is written once and not edited afterwards — a decision
that changed is a new record that supersedes the old one, because the point of
the file is the reasoning available at the time.

The template is `0000-template.md`.

The decisions OpenADLC was built on so far are the D-table in
[platform-plan.md](../platform-plan.md#12-decisions), one row each. A decision
taken from here on is a record in this folder; the plan's table links to one
only where it changed a decision the table already had (0003, from D5 and D12;
0004, from D7). The records:

- [0001](0001-attachments-in-the-database.md): attachments live in the database
- [0002](0002-design-memory.md): the design stage remembers, in ADRs and a summary of them
- [0003](0003-per-task-containers.md): a computer per task, and several tasks per seat
- [0004](0004-design-always-by-default.md): Design is Always by default; `conditional` is a repository's opt-out (supersedes D7)
- [0005](0005-ruleset-bypass-is-the-app-or-a-person.md): a ruleset bypass is OpenADLC's app or a person who is not a crew account
- [0006](0006-abandoned-is-a-label.md): an issue closed without merging is Done, labelled `openadlc:abandoned`, and not shipped
- [0007](0007-self-update-follows-verified-releases.md): self-update takes only verified releases, prepared beside the install, and the checkout stays the install
- [0008](0008-a-close-stops-the-tasks-paused-on-it.md): a close stops every task paused on the issue or its pull request, at the close only, and a person's Stop ends a task waiting on a question
- [0009](0009-work-items.md): every issue, pull request and request gets a work item number of the install's own, never reused, numbered in opened order from history and linked automatically
- [0010](0010-console-name-and-logo.md): the console's name and logo are two settings, the logo a checked data URL kept out of every request's read, read by every role and drawn only through `<img>`, served sandboxed
- [0011](0011-a-request-is-answered-once-saved.md): a console request is answered once it is saved, with a prediction (`starting`, or its place in line), and its triage starts after; a failed start is said on its thread
- [0012](0012-a-request-files-one-issue-per-repository.md): a console request files one issue per managed repository it concerns, recorded in `request_issues`; an issue joins it only while its triage runs, and its triage signs for the managed repository it posts to, only on its request's issues
- [0013](0013-dependencies-across-repositories.md): a dependency may name an issue in another managed repository as `owner/name#N`; `parseDependencyRefs` replaced `parseDependencies`, one outside the install never ships, and stacking stays same-repository
- [0014](0014-the-bots-image-is-stamped-with-its-recipe.md): the bots' image carries `openadlc.recipe`, the digest of the files it is built from; an image behind its recipe is rebuilt with the versions it has, and the bridge starts that run once per recipe
- [0015](0015-a-wait-on-a-person-is-recorded-where-the-gate-is-settled.md): what the review gate waits on reaches Needs you as an event recorded where the gate is settled, once per head (`review.person_asked_again`, `review.person_awaited`), and is never read live from GitHub by the attention read
- [0016](0016-a-refused-signature-is-an-event.md): a stamp the bridge refuses is an `attribution.stamp_refused` event, matched to the unsigned post by repository, login, number and body hash; such a post is `unsigned-refused`'s, never the account's "This was me" card, and clears when a task of the same kind and subject type signs again (`attribution.stamp_signed`); a `repo@sha` task signs on the pull requests from its own branch
- [0017](0017-intake-ends-with-its-labels.md): an issue leaves intake only with its `priority:`, `area:` and one `do:` label, checked by `missingLabels` when intake's stage label comes in and when its task ends; a retry for a missing one counts toward intake's tries
- [0018](0018-a-sign-off-is-posted-with-a-token-kept-for-one-post.md): a reviewer-only pull-request command is posted with a device-flow token held for that one post and revoked; a person's GitHub account is proved by their own sign-in and kept as a login and an id; a command anyone may send is posted as the app
- [0019](0019-a-merge-of-the-base-stands-on-its-parents-local-ci.md): a crew head with no local run of its own that GitHub committed as a two-parent merge of the base into a head whose newest run passed (walked back through up to five such merges) stands on that run in the lead's `local-ci.md`; no row is written to `local_ci_runs` for it, and it is told by the commit's shape, not by `merge_line.branch_updated`
- [0020](0020-an-ignored-dependency-counts-once-closed-as-completed.md): a dependency labelled `openadlc:ignore` counts as shipped once GitHub says it closed as completed, read from `ignored_issues`, which the webhook and reconcile keep; closed for any other reason, open, or not found, it holds; reconcile looks up a dependency nothing has recorded, in a managed repository only
- [0021](0021-board-events-are-read-from-the-tables-they-happen-in.md): the board event feed behind `openadlc watch` (`GET /v1/board/events`) is polled from the tables events happen in (`tasks`, `gates`, `stage_moves`, the merge line, `pull.held` audit rows), from the database's now with a 10 s overlap deduplicated by event id, never emitted by writers; `GET /v1/board/tasks` is the live-task read behind `openadlc ls`
- [0022](0022-the-bridge-keeps-its-own-heartbeat-and-gap-report.md): the bridge beats into `bridge_heartbeat` every 30 s and twice on a clean shutdown (before its drains and at its end), on the database's clock; a start more than one beat after the last records one open gap report in `bridge_gaps`, merged and not stacked, with the tasks it resumed and the orphans one reconcile pass at start ended; a person dismisses it for everyone by its `backAt`; the live refresh probes the bridge before it refreshes and keeps the page under a banner when it gives no answer
- [0023](0023-a-wait-is-followed-to-its-root-in-both-reads.md): a waiting card's wait is followed to one root in both the board's read and the Needs-you read, from the same `readWaitFacts` and the same `followWaits`; a root names its Needs-you item by id, keeps person > dead > deep > self, and is stored nowhere
- [0024](0024-needs-you-alerts-are-raised-by-the-open-page.md): needs-you alerts (the tab's count and dot, a sound, a desktop notification) are raised by an open console tab from its live refresh, which keeps reading while hidden; the switches are per browser in `localStorage`, for every role; new is per document load, claimed across tabs; no service worker, push or bridge change
- [0025](0025-the-hosts-page-reads-what-reconcile-judges.md): Settings → Hosts (`GET /v1/hosts`, admin) judges a host `live`, `silent` or `never_seen` with reconcile's `HOST_SILENT_MS` rule on the bridge's clock; per-host load is `taskLoad`'s predicate grouped by `host_id`, with unclaimed queued tasks apart; what a silence cost is read from `tasks` (`exit_reason`, `ended_at >= last_seen_at`) and never stored; `hosts.cpus` and `memory_bytes` are what hostd saw at its last registration, null until reported
- [0026](0026-notifications-are-configured-in-settings-and-proved-by-their-last-send.md): where owner notifications go is `notifyTransport` in settings with its target (a Slack or webhook URL, or the ntfy topic) only in the `notify-target` secret, shown masked; each kind has a switch in `notifyKinds`; every send and test is a `notify.delivery` event; the `notifications` health check is a warning that reads the newest delivery since the transport was set and never sends; merge-waiting and review-stopped are read from Needs-you items every minute, once per `id@since`, with a baseline on an install's first look
