# 0019. A merge of the base stands on its parent's local CI

- **Status:** accepted
- **Date:** 2026-10-30

## Context

The lead approves a crew head (`agent/…`) only on a local CI run hostd made
on it and the bridge recorded (`local_ci_runs`): GitHub's `ci` on a crew pull
request waits for the lead. Only the builder, QA and the system engineer
record runs, on commits they push. When the merge line brings a waiting pull
request up to date, GitHub writes the merge (update-branch, committer
`web-flow`), so that head never has a run, and `local-ci.md` told the lead
not to approve it. On #213 two rounds went on nothing but a builder running
`openadlc-ci` on such merges, and the review stopped for a person at the round
cap with its code already approved. The architecture already said no local
CI is asked of the builder for the line's update; only the lead's brief said
otherwise.

## Decision

A crew head with no run of its own counts on its parent's run when it is
GitHub's merge of the base into that parent: it has exactly two parents, the
branch first; GitHub committed it (`committer.login` `web-flow`, or committer
email `noreply@github.com`); its second parent is on the pull request's base
branch (`behindBy` 0); and its first parent's newest run passed. A first
parent with no run that is itself such a merge is walked back through, up to
five, since the line updates again when the base moves while `ci` runs.
`localCiDocument` then says the head is a merge of the base into that parent,
names the parent and its run, says GitHub's `ci` runs on this head and the
merge waits for it, and tells the lead not to request changes for a missing
local run. A run recorded on the head itself, passed or failed, still decides;
a read that fails gives the stricter note.

`local_ci_runs` stays hostd's alone: no row is copied or invented for the
merge. The merge is told by the commit's shape, not by the line's
`merge_line.branch_updated` event.

## What this rules out

- **Recording a run for the line's merge**, by copying the parent's row or
  having the line run `openadlc-ci`. A row in `local_ci_runs` is evidence
  because only hostd writes one, for a run it made; a copied row is a run that
  never happened. It would also mean changing `merge-line.ts`, a Human-review
  path.
- **Letting every `web-flow` merge through, whatever its parent's run.** A
  branch whose own changes were never checked would get through on a merge of
  `main`.
- **Reading `merge_line.branch_updated`.** The line records `to` as null for
  `updateBranch`, so the event cannot name the commit, and a person's "Update
  branch" makes the same commit, with the same content and the same safety.

## What would make this worth revisiting

A merge GitHub commits can carry a person's edits: a conflict resolved in
GitHub's web editor is committed as `web-flow` too, and qualifies. That is
accepted because only someone with write access can make one, the lead still
reviews the diff, and GitHub's `ci` still has to pass on the head. It would be
the wrong call if crew merges with hand edits became common, or if the lead's
approval came to stand in for GitHub's `ci` on the head, so that the parent's
run would be the only check the merge's content ever had.
