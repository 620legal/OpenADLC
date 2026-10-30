# 0020. An ignored dependency counts as shipped once it closed as completed

- **Status:** accepted
- **Date:** 2026-10-30

## Context

#214: an issue labelled `openadlc:ignore` is a person's, built outside the
crew. The bridge keeps no `issues` row for one with no stage, or in intake or
spec (`learnIssue`, reconcile). The close handler also skips an ignored row it
does have, so that row never reaches Done. Nothing stored how an issue closed,
so "completed" and "not planned" could not be told apart.

`dependencyIsSatisfied` reads a missing row as never shipped, on purpose:
"Somebody has to look". So an issue that named an ignored issue under
`Dependencies` waited for good, even after the ignored issue closed as
completed through a merged pull request. Its card said "Waiting on #18 (not on
the board)", and the only way out was for a person to edit every waiting
issue's body.

The dispatcher's unblock, the routing check, readiness (`markReadiness`),
stacking and the waiting line read only the database (ADR 0013: the platform
acts on what it has seen). A person chose between three options:
1. count the issue as shipped by asking GitHub;
2. track it without building it;
3. keep the rule, and let a person mark it met.

They chose 1 and 2 together.

## Decision

- **The record.** The state and close reason of an `openadlc:ignore` issue are
  kept in `ignored_issues` (`repo_id`, `number`, `state`, `state_reason`,
  `closed_at`). The issues webhook (`learnIssue`) writes it on every delivery,
  and reconcile writes it for every live issue it reads. It is forgotten when
  the label comes off, or when the issue is deleted or transferred. Nothing
  about an ignored issue goes on the board's columns, and nothing labels,
  moves or closes it.
- **The rule.** `dependencyIsSatisfied(issue, ignored)` checks, in order:
  1. A row labelled `openadlc:abandoned` is not met.
  2. A row in Done, or in Merged with `deployed:testing`, is met.
  3. A record that says `closed` with reason `completed` is met.
  4. Anything else is not met.

  "Anything else" covers closed as `not_planned`, closed as `duplicate`,
  closed with no reason, still open, no record, and not found. A never-seen
  issue that is not ignored still holds. Only `openadlc:ignore` tells
  OpenADLC that a person is handling the issue.
- **One answer.** `resolveDependency` returns `{ managed, issue, ignored }`.
  The dispatcher, readiness, stacking and the waiting line all pass the same
  `(issue, ignored)` pair, so they give one answer for one dependency.
  - The dispatcher reads its own repository's records once per pass, beside
    the rows it already reads.
  - Stacking treats an unmet ignored dependency as outstanding, so nothing
    stacks on a person's pull request.
- **This narrows ADR 0013 for one case.** That ADR rejected "Looking an unseen
  issue … up on GitHub". Now reconcile looks up a dependency in a managed
  repository that nothing has recorded (`unresolvedDependencies`), and keeps
  the result only if it is labelled `openadlc:ignore`.
  - A 404 or 410 records nothing, and the dependency stays unmet.
  - A repository outside the install is still never read.
  - An ignored dependency recorded as open is named too. It is in the open
    listing while it stays open, so this costs nothing. Once it closes while
    the bridge is not listening, the lookup still finds it.

  This is also the backfill for issues that closed before this change.
- **Unblocking.** It needs nothing new. Once the record says closed as
  completed, the dispatcher's next pass finds the dependency met and calls the
  unblock it already has, which swaps `blocked` for `start:now`.
  `needs-human`, `openadlc:paused` and path holds are read separately and are
  untouched.
- **The card.** It says "(ignored, open)", "(ignored, closed as not planned)"
  or "(ignored, closed)", instead of "(not on the board)".

## What this rules out

- **A person marks it met, audited (option 3).** A person would still have to
  notice every case and press a button. The card cannot say "closed" without
  the same stored state anyway.
- **Asking GitHub on every check (option 1 alone).** The dispatcher, the
  waiting line and stacking read only the database. A GitHub call on every
  board read and every dispatcher pass costs rate limit and latency, and gains
  nothing over a record.
- **Keeping the state on `work_item_links`.** That table has a state, but no
  labels and no close reason. It is about numbering, not readiness.
- **Counting any never-seen issue that closed as shipped.** Without the label,
  nothing says a person is handling it. A dependency the platform cannot place
  still holds, and a person looks.

## What would make this worth revisiting

- Ignored issues coming onto the board's columns. A row could then carry the
  state itself, and the record would be redundant.
- The crew relying on a close reason it does not set. Today `completed` is
  GitHub's reason for a close by a merged pull request, and a person's default.
  If GitHub or a team's practice stopped meaning "finished" by it, the rule
  would read the wrong thing as shipped.
