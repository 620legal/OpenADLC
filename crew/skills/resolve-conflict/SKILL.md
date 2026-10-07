# resolve-conflict

The merge line found that your pull request's branch conflicts with the base
branch, at the front of the line, after the review approved it.
`resolve-conflict.md` names the base and the files both sides changed. Resolve
those files and nothing else: this is not a new round of the work.

## Do this, in order

1. Fetch and merge the base into your branch (`git fetch origin`, then
   `git merge origin/<base>`). Do not rebase: a rebase rewrites the commits
   the reviewers approved.
2. In each conflicted file, keep what both sides meant. Two additions to the
   same list or target are usually both kept, in a sensible order; one side
   renaming what the other added means the addition takes the new name.
3. Change no file other than the conflicted ones, and no line in them the
   conflict does not involve.
4. Commit the merge (`git commit --no-edit`). The checks run on a commit, not
   on your working tree: `fleetadlc-ci` refuses a merge that is not committed yet.
5. Run `fleetadlc-ci`. If it fails because of the resolution, fix it, commit,
   and run it again. If it fails for anything else, stop and ask (below).
6. Push. Say in your last message which files you resolved and how, one line
   each.

When every conflicted file is one many changes add to (`resolve-conflict.md`
says so), the lead re-checks and approves only your resolution, and the other
approvals stand. Anything you change beyond the conflicted files and what the
base brought makes it a full review again.

## Stop and ask when

- Resolving needs a change outside the conflicted files, or the two sides
  want contradictory things that keeping both cannot reconcile. This round
  cannot widen its files or start a new round of the work: ask whether to
  leave it to a person.
  <!-- scenario: outside-the-conflict -->
- `fleetadlc-ci` fails for something your resolution did not cause.
  <!-- scenario: ci-fails-for-something-else -->

## Asking a person

Ask one question at a time. The answer can change what you assumed, so the
next question is written after it, not before.

- Ask exactly one question per message. End the message with the question
  marker, one line of JSON that carries the question itself and its choices:

  ```
  <!-- fleetadlc:{"event":"question","question":"Keeping both sides needs src/app.js, outside the conflict. Leave it to a person?","options":["leave it to a person","resolve within the conflicted files only"]} -->
  ```

  What you write before the marker is the context: which files conflict, and
  why keeping both sides does not settle it.
- Prefer choices, even just yes or no. Put the likely or recommended answer
  first, and keep each choice to a few words.
- Ask an open question only when no set of choices could cover the answers,
  and say so in the marker instead of giving choices:

  ```
  <!-- fleetadlc:{"event":"question","question":"Which of the two test targets should stay?","open":true} -->
  ```

- Never number several questions in one message, and never put a second
  question marker in it: only the first is asked.
- Asking pauses your task, so the question is the last thing you say. When the
  person answers, you are started again with the answer: for a console request
  it is in `request.md`, and on a pull request it is in its conversation. Read
  it first. It may have changed what you assumed, so your next question, if
  you still need one, builds on it.

## Never

- Rebase, squash or force-push the branch.
- Rework the change, or fix something else you noticed.
- Merge the pull request, or review it.
