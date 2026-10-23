# 0012. A console request files one issue per repository it concerns

- **Status:** accepted
- **Date:** 2026-10-23

## Context

#137: when an install manages several repositories, a request from the
console can concern more than one of them, and intake filed it as a single
issue in a single repository. A request pointed at exactly one issue:
`requests.issue_number` in `requests.repo_id`. The first issue that carried
the request's line marked it `filed`. `RequestFiling.issueOpened` then turned
away any later issue, and any issue in a repository other than
`request.repo_id`. A second issue in another repository was never recorded,
its design was given no `intake.md`, and the console showed only the first.

Two more things stood in the way. A request's task signed its posts with its
own repository, so an issue it filed in another one read as `wrong-target`.
And `/internal/tasks/:id/stamp` had no issue to hold a `request:` subject to,
so intake's edit of a sibling issue went out unsigned.

A person chose the store on the issue: a table, over the work item's links or
an array column.

## Decision

- **A request's issues are rows of `request_issues`** (migration 0153): one
  row per issue `(request_id, repo_id, issue_number, filed_at)`, across
  repositories, read with every request as `RequestRecord.issues`. The
  migration backfills one row per filed request. `requests.repo_id` stays the
  repository the person named, or, when they named none, the first one filed
  in. `requests.issue_number` stays the first issue filed in that repository,
  and null when there is none there. The readers that join on the pair keep
  their meaning. `requests.fileIssue` records an issue and marks the request
  `filed` in one transaction. `updateRequest` no longer takes an issue number.
- **An issue joins a request only while the request's triage runs, or as its
  first issue in its own repository.** In any managed repository while an
  intake task on the request is queued, running or paused, and at that task's
  end, when every managed repository is searched for issues that carry the
  line. After that, only as the request's first issue, in the repository it
  named (or any, when it named none): this is the delivery that arrives after
  the task ended. Each recorded issue is handed to Design or Build by its own
  repository's rule.
- **A request task signs for the managed repository it posts to, and only on
  its request's issues.** OpenADLC's `gh` sends `--repo`. For a `request:`
  task the bridge signs for that repository when the install manages it, and
  for the task's own repository otherwise. It signs a number only for one of
  the request's issues, or for an issue whose body on GitHub carries the
  request's line, which is filed first. Every other task signs as before.
- **A request's triage runs with a token that is not narrowed to one
  repository.** A task's token is otherwise scoped to its repository, so a
  request that named one could not file in a second. It reaches every
  repository the crew account can, as a request naming no repository already
  did. Narrowing it to exactly the managed repositories would change the token
  broker, and is left for its own issue.
- **Intake confirms every draft once, and asks before filing outside the
  chosen repository.** `request.md` lists the managed repositories with their
  GitHub descriptions, and `open-issues.md` has a section per repository, but
  only when there are several. With one, both documents are unchanged. Sibling
  issues name each other as `owner/name#N`, under `Dependencies` when one must
  ship first (ADR 0013).

## What this rules out

- **The work item as the list of a request's issues.** It is empty before the
  install's first numbering. A person's unlink or merge of items would also
  change which issues a request had filed. The person chose the table.
- **An array column on `requests`.** It is hard to query from the issue back
  to its request (`listRequestsForIssue`, which `intake.md` needs). It also
  goes against the repository's habit of using a link table.
- **Letting any issue that quotes the line join at any time.** A person
  quoting a request's line in some other repository, after its triage, would
  add an issue the request never filed.
- **Signing a request task's posts with no repository at all.** Simpler, but
  the signature would then say nothing about where intake may post.
- **The bridge writing the sibling links on GitHub.** The bridge writes no
  issue bodies, and intake already holds the drafts.

## What would make this worth revisiting

A request needing an issue added after its triage has ended. For example, a
person might ask to extend a filed request to a third repository without
re-triaging it. Or the work item becoming a list the install can trust before
numbering, and one that a person's edits do not change.
