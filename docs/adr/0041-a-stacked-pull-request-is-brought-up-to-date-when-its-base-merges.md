# 0041. A stacked pull request is brought up to date when its base merges

- **Status:** accepted
- **Date:** 2026-11-10

## Context

A stacked pull request starts from its dependency's branch while the
dependency is in review (`apps/bridge/src/stacking.ts`). The dependency is
squash-merged, so its commits never become ancestors of the default branch.
Until a merge commit from the base lands on the stacked branch, the stacked
diff keeps the dependency's whole change.

The only place that made this merge was the merge line (`MergeLine.advanceOnce`).
A stacked pull request reaches the line only after the lead approves it, so
every review seat read it with the dependency's diff in it. #252 was built on
#251's branch (pull request #253, squash-merged as 44b3b07). Its pull request
#256 then showed double its own diff, and the security seat stopped at its $15
cap and was abandoned. #256 was opened at 04:56, after #253 merged at 04:24,
so updating only the stacked pull requests open at the dependency's merge
would not have caught it either.

The requester decided who makes the update: the bridge first, and the builder
only when it conflicts.

## Decision

The bridge makes the stacked update, through `MergeLine.updateStacked`. It
reuses the line's `stackedUpdate` (`mergeIntoBranch`, `stack.made`,
`branch.updated_by_line`) and runs in the line's per-repository queue, so it
never interleaves with a line step. It is made at two moments:

- **When the dependency merges** into the default branch (the merge's
  delivery, after its issues move to Merged or Done). This applies to each
  open stacked pull request built on it, by its pull request or an issue it
  closed (`Stacking.stackedOnMerged`), that is not held and has no build or
  patch round unfinished on it. A held one is updated when its let-go finds
  the dependency merged and nothing for its builder to redo.
- **Before the first round** of a stacked pull request opened, or pushed by
  its builder, after its dependency shipped. Only a head that would be
  reviewed as it is gets this: one with a local CI pass, or not a crew
  account's. The update's push is the line's, and no local CI is asked of it
  (#118).

`stack.updating` carries `carry`, which says whether the approvals stand
across the update:

- `carry: true` is the update at the dependency's merge, the let-go and the
  line. It is matched by `Stacking.pushed` and carried (`stack.updated`).
- `carry: false` is the update before a first round. It is not matched, and its
  push opens the round on the merged head.

A note with no `carry` reads true.

A conflict opens the existing resolution round (`ConflictRounds.start`). That
is the only time a builder is started for the update. A branch already up to
date (`behindBy` 0) gets no merge, so a second delivery or the line's next step
does nothing. A stack that cannot be read is left alone, and the line keeps
holding it out as before.

## What this rules out

- **GitHub's update-branch endpoint.** It answers 202 with no commit SHA, so
  the push cannot be matched to the update. Either the approvals are dismissed,
  or an unvetted push is trusted. This is why `stackedUpdate` uses
  `mergeIntoBranch`.
- **Sending the builder back to merge the base after every dependency's
  merge.** Every merge would cost a builder task, while a clean merge needs
  nobody.
- **Holding a stacked pull request's reviews until its dependency merges.**
  The stacked change would wait out the dependency's whole review, which is
  the delay stacking exists to remove. It is also a policy change.
- **Updating while the dependency is unmerged, or under a running builder.**
  The dependency's branch is the stacked build's starting point
  (`stackBrief`). A push under a running builder breaks that builder's next
  push. That push is updated before its round instead.
- **A schema change.** `carry` lives in the event's payload.

## What would make this worth revisiting

- Dependencies that merge without squashing, so that their commits become
  ancestors of the default branch and the stacked diff shrinks by itself.
- Stacking more than one level deep.
- GitHub's update-branch endpoint answering with the commit it made.
