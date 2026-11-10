# 0047. A merge outside the merge line is recorded

- **Status:** accepted
- **Date:** 2026-11-10

## Context

On 2026-11-10 a person merged a crew pull request over a red `ci`, on a plan
with no branch rules. It deployed to testing three minutes later, and nothing
on the audit log, the pull request or the board said who had merged it (#276).
The bridge's watch on merges, `noticeUnreviewedMerge`, spoke only when the
merger was a crew account and `review-gate` was not green. A person's merge was
not recorded at all.

The merge line merges only through `Automation.mergeAsApp`, so GitHub names
the app's bot (`<slug>[bot]`) as `merged_by` for its merges. That includes a
person's merge from the console (ADR 0037). The line's own audit,
`merge.landed`, is written after `mergeAsApp` returns, and the `closed`
delivery can arrive before it.

## Decision

- Every merged pull request whose `merged_by` is not the app's bot login
  (`appGate.botLogin()`, compared with `sameLogin`) is audited as
  `merge.outside_line` by `noticeMergeOutsideLine`. This covers a person's
  merge, a crew account's merge and a merge into any base. An app login that
  cannot be read counts as outside.
- The entry records what GitHub showed on the head when it landed:
  - `merger`, `sha` (the head), `mergeCommit` and `base`;
  - `method`, read from the merge commit's parents: two is `merge`, one is
    `squash_or_rebase`, unreadable is null;
  - `reviewGate`, as OpenADLC published it (`publishedGate`);
  - `ci`, the newest of GitHub Actions' check runs named `ci`, with its
    `verdict` (`green`, `red`, `pending`, `missing`, or null when it could not
    be read), its `conclusion` and its `url`. A commit status named `ci` is
    ignored, as `mergeDecision` ignores it.
- When `ci` was red, still running or never ran, the automation account posts
  one comment on the pull request. It gives the short head, what was red and
  where the run is, and `review-gate`'s state. It doesn't name the merger.
  When `ci` is green, or could not be read, nothing is posted: the audit holds
  it, and a comment on a guess would be noise.
- It runs from the merged delivery, before `noticeUnreviewedMerge`, and from
  the reconciler's `mergeUnheard`. One head gets one entry: a redelivery, or
  the reconciler after the delivery, writes and says nothing more.
- Nothing after the merge changes. The deploy, the card and the lease go on
  as they did. A crew account's unreviewed merge is still `merge.unreviewed`,
  with its comment, `needs-human` and the testing deploy held, and is also
  recorded as `merge.outside_line`.

## What this rules out

- **Telling the line's merge by its `merge.landed` audit.** It is written
  after the merge call returns, and the delivery can come first, so the line's
  own merges would have been recorded as outside it.
- **Holding the deploy on a red `ci`.** The issue keeps what happens after
  the merge unchanged. Holding is a policy for a separate decision.
- **Telling squash from rebase.** GitHub doesn't report a pull request's merge
  method, and a single-parent commit can't be told apart without guessing.
- **Naming the merger in the comment.** The audit records who merged it. The
  pull request says what was red, without blaming anyone.

## What would make this worth revisiting

The merge line merging as something other than the app's bot, or GitHub
starting to report the merge method on a pull request. Either one changes
how the line's merge is recognised, or what `method` can say.
