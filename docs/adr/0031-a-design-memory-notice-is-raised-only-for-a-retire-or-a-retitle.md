# 0031. A design memory notice is raised only for a retire or a retitle

- **Status:** accepted
- **Date:** 2026-11-04

## Context

[ADR 0002](0002-design-memory.md) says a supersede is said on the issue and
that "the board shows a notice that holds no work". In practice that notice
was a card on Needs you for every supersede, counted in the work badge, with
no way to dismiss it: it left only when it aged out of the 7-day window. Most
supersedes were a design restating an entry in other words under the same
title, and their card read "“X” replaces “X”", with nothing for a person to
decide. The card also ended with the free-text `by`, which is the email of the
person who answered the design's question, so it read as if they had edited
the memory.

#243 asked for Needs you to show only what needs a person. The person settled
the policy in its conversation. A card is raised only when an entry is retired
or replaced by one that does not restate it, and the bridge decides that from
the titles alone, with no new marker from the design stage.

This refines ADR 0002's "the board shows a notice" for a supersede. ADR 0002
is not otherwise changed.

## Decision

- **The title rule, decided by the bridge.** A supersede's pair is shown when
  its new entry has no title (a retire) or a title that differs from the old
  one after trimming, collapsing whitespace and lowercasing (`sameTitle`,
  `attention.ts`). An event with no pair left raises no card. Its issue
  comment and its `design_memory.superseded` event are still written, because
  filtering happens only when the board reads it. Each pair reads
  `“<old>” was replaced by “<new>”` or `“<old>” was retired`.
- **A system-group notice, dismissed through `acknowledgements`.**
  `design_memory_superseded` is in the `system` group, in the bridge's `GROUP`
  and the console's copy, so the work badge and the board's by-state count
  leave it out. Its Dismiss (`dismiss_notice`) posts to
  `POST /v1/repos/:name/design-memory/notices/dismiss` with
  `{ issue, occurrence }`. The route has role `user`, like the bridge gap's
  dismiss, and writes `acknowledgements` under `design-memory:<repo>#<issue>`
  with the event's `at`. A dismissed event stays away for everyone after a
  reload. A newer supersede on the issue has a new `at` and shows again.
  Dismissing forgets `design-memory:` acknowledgements older than the window,
  as `dismissTask` does for `task:`. The dismissal is audited as
  `design_memory.notice_dismissed`.
- **The event says how it took effect.** `design_memory.superseded` carries
  `how`. It is `answered` when a person answered the design task's question,
  whether that answer was passed in or found on the task's gate, and
  `unopposed` when the supersede was accepted at the move to build. The card
  reads `how` only, never `by`: "accepted when you answered <repo>#<issue>'s
  design question" or "unopposed at the move to build". An event recorded
  before `how` existed shows no clause.

## What this rules out

- **A `restates` marker from the design stage.** The person turned it down in
  intake. The bridge decides from titles, with no new field on a design entry
  and no change to the spec skill.
- **A dismissal kept in the browser (localStorage).** It would not reach a
  second browser or a second person, and the issue asks for a dismissal to
  hold after a reload for everyone.
- **Reusing the health acknowledge route by registering the event as a check
  row.** The route accepts only health-check rows. Registering the event as
  one would make a design memory event pretend to be a health check, and it
  would show in `openadlc doctor`.
- **A new table for dismissals.** `acknowledgements` (an id and the
  occurrences seen) is already that table.
- **Reading the free-text `by` to tell how a supersede took effect.** It is
  the comment's wording, and it is an email when a person answered.

## What would make this worth revisiting

Designs that change what an entry says while keeping its title, so that a
rule is weakened with no card raised. If that happens, the title alone is the
wrong signal, and the design stage would have to say whether an entry
restates the one it replaces.
