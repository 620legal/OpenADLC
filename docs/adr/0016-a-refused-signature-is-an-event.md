# 0016. A refused signature is an event

- **Status:** accepted
- **Date:** 2026-10-28

## Context

OpenADLC's `gh` sends every body a task's session posts to the bridge's stamp
route (`POST /internal/tasks/:id/stamp`). When the route refuses to sign one,
the shim posts it unsigned. The `unattributed-post` card then said that someone
had used the account around OpenADLC, and offered "This was me".

On 620legal v0.1.22, a revert task (subject `www@20b84446`, branch
`system/revert-20b84446`) had every post on its own pull request,
620legal/www#12, refused. The route allowed a task to sign only on the numbers
its subject names, and `repo@sha` names none (#203). The board blamed the
account for a gap in OpenADLC's own rules.

The card has to know which unsigned posts OpenADLC refused, and when the cause
of a refusal has gone. Under ADR 0015, a fact with no row of its own reaches
Needs you as an event. `events` is indexed by `(type, at)` (migration 0134), and
the cards look back only one day.

## Decision

- **A refusal is an event.** Any 4xx from the stamp route for a known task with
  a bot records `attribution.stamp_refused`. Its payload is:
  - `taskId`, `taskKind`, `subjectType` and `subjectRef`;
  - `seat` and `login`, the bot's name and GitHub login;
  - `repo`, `number`, `kind` and `status`;
  - `reason`, in the route's own words;
  - `bodySha256`, the sha256 of the body.

  If recording fails, the failure is logged and the refusal is still answered.
- **A refusal matches an unsigned post by repository, login, number and body
  hash.** Repository and login are compared without case. A refusal with no
  number matches any number. A refusal recorded after the post never matches
  it (`refusalFor`).
- **"A task of that kind" means `(kind, subjectType)`.** A successful stamp
  records `attribution.stamp_signed` only when a refusal of the same shape was
  recorded in the last 25 hours. The first such event after a refusal clears
  it. Without the subject type, a deploy task on an issue that signs would
  clear a card about a revert, whose cause would still be there.
- **A refused post never returns to the "This was me" card.** It leaves
  `unattributed-post` whether or not its refusal has been cleared. While the
  refusal is open, the post is shown by its own check, `unsigned-refused`. That
  card names OpenADLC and the reason. It has no `dismissLabel` and carries
  `dismissable: false`: `attentionItems` offers no acknowledge for it, and
  `/v1/health/:id/acknowledge` answers 409. It clears when the refusal is
  cleared, or a day after the post.
- **A `repo@sha` task's targets are the pull requests from its own branch.**
  `targetsOfTask` gives such a task the numbers `pullsFromBranch(repo,
  task.branch)` returns. If GitHub cannot be read, or the branch has more pull
  requests than the client reads, the task gets none. Reviews are still refused
  to any task that is not a review of its subject.

## What this rules out

- **A `stamp_refusals` table.** It needs a migration and a store module to hold
  a fact that the check reads for a day. `listEventsOfType` already gives that.
- **Clearing a refusal by joining `attributions` to `tasks`.** `attributions`
  has no index on `created_at` or `task_id`, so every run of the check would
  scan every signed post. The small `stamp_signed` event answers the same
  question with an indexed read, and it is written only while a refusal of
  that shape is open.
- **A second result of `unattributed-post`.** `attentionItems` folds the
  failing rows of one check into one card with one acknowledgement. The
  refused posts would have shared "This was me" with the account's.
- **Making the gh shim refuse to post when the stamp route refuses.** That
  changes what an agent can do mid-task, and it is its own issue.
- **Widening what other tasks with no number in their subject may sign**
  (`request:…` beyond its filed issues, `repo#testing`).

## What would make this worth revisiting

- An unsigned post's body stops being the body that was sent to be signed. For
  example, the shim rewrites a refused body before it posts it. The body hash
  would then match nothing, and the account would be blamed again.
- Refusals become common enough that reading a day of them on every run costs
  more than a table would.
