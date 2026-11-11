# 0052. A stacked pull request waits on its base in the line, and is replayed onto main

- **Status:** accepted
- **Date:** 2026-11-11

Amends [0041](0041-a-stacked-pull-request-is-brought-up-to-date-when-its-base-merges.md).

## Context

On 2026-11-10 a stacked pull request's second and security reviews finished
at 21:57. The bridge started its lead at 21:57:55, since every other review
was in (`TaskService.openLeadReview`). Its base, approved and green, was in
the merge line, and it merged at 21:58. The squash left the stacked pull
request conflicting in nine files, it went to its builder (#271), and the
lead's review of the old head was thrown away.

The conflict was not in the stacked commits. ADR 0041's update merges the
base into the stacked branch through GitHub's merges API, which always uses
the true merge base. After a squash merge that is the old main, so the
base's changes are counted on both sides, and files both sides added
conflict, even when the stacked commits alone would replay cleanly onto
main.

A crew branch cannot be rebased: the `agent/**` ruleset refuses a force-push
(`agentBranchesRuleset`, docs/security.md), and the stacked update's approvals
carry only to a merge commit whose first parent is the head the line read
(`stack.made`, `Stacking.pushed`).

## Decision

**The lead waits while the base is in the merge line.** `openLeadReview`
starts no lead on a stacked pull request while `baseInLine`
(`apps/bridge/src/stacking.ts`) finds the dependency's current pull request,
or the stack's own, in a merge-line row in an open state (`waiting`,
`updating`, `testing` or `merging`). An open state already means approved
and not red, since the line takes in only what the gate passed and keeps a
red head out. A stack or a row that cannot be read is a wait too. The wait
is said once per base. The advisory seats are not held, and nothing new
resumes the lead: the gate sweep asks every pass. Once the base leaves the
line the lead is asked on the current head, and once it merges, on the head
the stacked update makes, which carries the advisory approvals.

**After a squash, the update replays only the branch's own changes.**
`Stacking.updating` returns `{ on, replayFrom }`, and the `stack.updating`
note carries `replayFrom`. It is set when the dependency's pull request has
merged and its head is not an ancestor of the base branch
(`mergeBase(depHead, base) !== depHead`). Its value is
`mergeBase(depHead, stackedHead)`, the newest point of the dependency the
stacked branch holds. With it, `MergeLine.stackedUpdate` writes a bridge
commit with the base branch's tree and parents `[base tip, replayFrom]`
(`createCommit`), and merges that SHA into the branch (`mergeIntoBranch`).
The merge base is then `replayFrom`, so the three-way merge applies only the
stacked branch's own changes to main. That gives the same tree a rebase onto
main gives. A clean merge is a commit whose first parent is the old head, so
`stack.made`, `branch.updated_by_line` and the carry work unchanged. A real
conflict answers 409 and opens the resolution round as before. A
`replayFrom` that cannot be read, or a bridge that cannot be written, falls
back to the plain merge. Once one update has the bridge in its history, main
holds `replayFrom`, and a later update needs no replay.

## What this rules out

- **Holding every review of a stacked pull request until its base merges.**
  ADR 0041 rules this out, and that still holds: the advisory seats run
  during the base's review. Only the lead waits, and only for the minutes the
  base spends in the line.
- **`git rebase` in a hostd worktree, force-pushed.** It needs force-push on
  `agent/**`, a ruleset and `config/` change that people review, and it
  dismisses the approvals the carry matches by first parent.
- **A merge computed locally in hostd** (`git merge-tree --merge-base`). It
  gives the same tree, but needs a computer, a checkout and a new hostd
  endpoint for what the API does in three calls.
- **A temporary branch for the bridge commit.** The commit is unreferenced
  until the merge, and garbage once a refused merge leaves it so.

## What would make this worth revisiting

- Dependencies that merge without squashing, or by rebase, so that their head
  is in the base and nothing needs replaying.
- The ruleset allowing the line to force-push a crew branch, with approvals
  carried by something other than the first parent.
- GitHub's merges API accepting a merge base.
- Stacking more than one level deep.
