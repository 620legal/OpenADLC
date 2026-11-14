# 0065. The line writes a bridge commit as the app, and only for the pull request it stacked

- **Status:** accepted
- **Date:** 2026-11-14

Amends [0052](0052-a-stacked-pull-request-waits-on-its-base-in-the-line-and-is-replayed-onto-main.md)
and [0041](0041-a-stacked-pull-request-is-brought-up-to-date-when-its-base-merges.md).

## Context

ADR 0052's bridge commit is written through GitHub's git-data API
(`POST /repos/{repo}/git/commits`). `MergeLine.stackedUpdate` wrote it with the
updater's client, which is a crew account's user token. GitHub signs a commit
made through that API only when a GitHub App's installation token makes it.
So the bridge was `unsigned`. The `/merges` commit made after it is signed
either way.

On #330 (stacked on #325) the bridge `fcde39f` was the one unsigned commit on
the branch, and main requires signed commits. The branch can't be repaired:
the `agent/**` ruleset refuses a force-push, and the approvals carry by the
first parent. So the pull request could never land.

#334 was rebuilt for #329 on a fresh branch from main, never stacked. It got a
bridge commit too (`1125b34`, also unsigned). The `stacks` row is kept per
issue, `(repo, issue)`. #329's row was written for #330 and still applied to
#334. `replayFrom` then answered `mergeBase(#325 head, #334 head)`, the main
commit #325 had branched from. That commit was already in main, so the bridge
replayed nothing. It only wrote an unsigned commit.

`asAutomation` is also a crew account (`actors.asBot`), not the app. The app's
client is `AppGate.client`, and the line reaches it through `Automation`, as
it already does for `mergeAsApp`.

## Decision

**The line writes its bridge commit as the app, or not at all.**
`Automation.createCommitAsApp` writes the commit with `AppGate.client`, and
answers null when there is no app client. `MergeLine.stackedUpdate` writes the
bridge only through it, never through the updater's `createCommit`. When it
answers null, the line takes the plain merge and warns why. When it throws,
the line takes the plain merge and warns with GitHub's error.
`mergeIntoBranch` stays with the updater, since its commit is signed already.

**A stack row applies to a pull request only when its head descends from the
row's `onHeadSha`.** `Stacking.updating` checks
`mergeBase(onHeadSha, head) === onHeadSha`. When that fails, it answers null
and writes no `stack.updating` note, and the line updates the pull request as
any other (`updateBranch`). It applies the check only when the row records
`onHeadSha`. When the read fails, the pull request stays stacked, so a GitHub
error never turns a real stacked update into one that carries nothing. The
check is sound because a real stacked branch only grows from `onHeadSha`: the
ruleset refuses a force-push, and patch rounds and line updates merge rather
than rewrite.

**The line never writes a bridge to a commit already in the base.**
`Stacking.replayFrom` answers null when its computed point is already in the
base branch (`mergeBase(from, base) === from`). The branch then holds nothing
of the dependency's that the base lacks, so the update is the plain merge. This
is the backstop for rows with no `onHeadSha` and for an ancestry read that
failed.

## What this rules out

- **Writing the bridge with the crew's token or the automation account's.**
  GitHub leaves the commit unsigned, and on a base requiring signed commits
  nothing can take it out.
- **Falling back to a crew-written bridge when there is no app.** An unsigned
  commit that can never land is worse than a plain merge that may conflict
  (#271). A conflict goes to the resolution round.
- **A `pr_number` column on `stacks`.** It needs a migration, and the row is
  written before the pull request exists. It would also need a hook wherever a
  pull request is opened for a stacked build. Git ancestry already answers
  whether the branch was built on the stack, including for older rows.
- **Removing the stack row when a pull request closes, or when an unstacked
  build starts.** `waitingOn`, the holds and `baseInLine` read that row. A
  rebuild that does start from the dependency's branch would lose it too.
- **Repairing bridge commits already written unsigned** (`fcde39f`,
  `1125b34`). The ruleset refuses the force-push. Those pull requests are
  rebuilt from main, and with this change the rebuilt ones update plainly.

## What would make this worth revisiting

- GitHub signing git-data API commits made with a user token.
- The ruleset allowing the line to force-push a crew branch.
- A stack bound to its pull request by the schema, for instance once the pull
  request exists when the stack is recorded.
- `waitingOn`, the holds or `baseInLine` misjudging a replacement pull request
  built from main. They still read the stack per issue, and are inert today
  only because such a replacement is dispatched after its dependency shipped.
