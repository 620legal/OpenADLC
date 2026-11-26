# 0087. Security review findings are stored from the seat's signed marker

- **Status:** accepted
- **Date:** 2026-11-26

## Context

The Security page (#377, ADR 0086) lists GitHub's open alerts per repository.
The security seat's own findings sat only in its review comments, so a
finding on a pull request that merged anyway, or was closed, was lost to
anyone looking at a repository's security (#378).

The review is free text written by a model, and its marker is the only
structured part. Anyone who can comment on a pull request can write a marker,
and the attribution mode may be `audit`, where an unsigned crew post still
counts for what it did before. The seat grades findings on its own scale
(`blocker`, `major`, `minor`), and the page filters on GitHub's (`critical`,
`high`, `medium`, `low`, `none`). The bridge already keeps each pull request's
state in `work_item_links`, and the reconciler repairs it when GitHub drops a
delivery.

## Decision

- The security seat's `review_posted` marker carries an optional `findings`
  list of `{severity, summary, file, line?}`. `reviewFindings`
  (`packages/shared/src/markers.ts`) reads it:
  - `null` when the key is absent, which covers an old review and every other
    seat;
  - `[]` for an empty list;
  - the list when it is valid;
  - `'malformed'` otherwise. One bad entry rejects the whole list: a severity
    that is not one of the three lower-case words, a summary that is not 1–500
    characters after trimming, a file that is not 1–300 characters, holds
    whitespace other than a plain space or a control character, or starts with
    `/`, a line that is not a positive integer, or more than 50 entries.

  The verdict is read from the same marker as before. A malformed list never
  changes it.
- `recordSecurityReview` (`apps/bridge/src/security-findings.ts`) stores a list
  only from a `submitted` or `edited` review whose signature verifies to the
  seat with the `security` lens, on a non-fork pull request of a managed
  repository, in every attribution mode. `onReview` calls it before the gate
  work, inside a `catch`, so storing never delays or fails the review gate.
- `security_reviews` (migration 0172) holds one row per such review, keyed by
  GitHub's review id. An edit overwrites the row. The pull request's state is
  not copied: it is read from `work_item_links`.
- **The unfixed rule** (`securityReviews.unfixed`, `unfixedFrom`):
  - for each pull request, only the latest stored review counts, by
    `submitted_at` and then review id;
  - its findings are unfixed when the pull request's link row says `merged` or
    `closed`. One that is open, reopened, or has no link row lists nothing;
  - a later list that leaves a finding out clears it. A review with no list
    has no row, so it clears nothing;
  - at most 200 findings per repository, newest review first.
- On the page, blocker, major and minor file as high, medium and low, and each
  finding shows the seat's word beside the level. `critical` stays for
  GitHub's alerts (answered on #378).
- Findings are served by their own `user` route, `GET /v1/security/findings`,
  read from the database. `/v1/security/alerts` and its GitHub-only reader are
  unchanged.
- Nothing is back-filled.

## What this rules out

- **Copying the pull request's state into `security_reviews`.** The copy would
  go stale whenever a `closed` delivery is lost, while `work_item_links` is
  repaired by the reconciler.
- **Matching findings one by one across reviews** (by file and summary). The
  model rewords findings between rounds, so a reworded finding would look new
  and a fixed one could look standing. The latest list is the seat's own
  statement of what still stands.
- **Accepting unsigned markers in `audit` mode.** Anyone who can comment could
  plant findings or clear real ones with an empty list.
- **Keeping the good entries of a list with a bad one.** It would quietly drop
  a finding the seat meant to report, and under the latest-list rule a shorter
  list reads as a fix.
- **Folding findings into `/v1/security/alerts`.** It would give ADR 0086's
  GitHub-only reader a database dependency, and put findings into its 60-second
  memo.
- **Having the seat grade on the page's scale as well**, or mapping blocker to
  critical. The seat would grade twice, and the two grades could disagree.
  Critical is kept for GitHub's alerts.
- Parsing findings from free-text reviews, and changing how the merge line
  reads a review.

## What would make this worth revisiting

- The seat's findings get a stable identity across rounds, such as an id the
  seat carries forward. Matching one by one would then be safe.
- Reviews come from somewhere other than the signed seat: a second security
  seat, or a person's structured review.
- `work_item_links` stops tracking a pull request's state.
