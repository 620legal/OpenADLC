# 0033. A gate stores its decision and consequences

- **Status:** accepted
- **Date:** 2026-11-05

## Context

A bot's question carried the question and its choices, and the text before
its marker as context. A person on Needs you or on GitHub saw "Approve" or
"per call" with nothing on what was being decided or what each choice would
do, and had to read the thread to answer. #246 gave the `question` marker two
optional fields: `decision`, one or two sentences on what is being decided
and why it needs a person, and `consequences`, one short line per choice in
the order of `options`.

Every place that shows a question has to show them: the Needs you card
(`listOpenGates` → `attention.ts`), the thread panel's open questions (the
`Gate` record), the thread timeline's question bubble (the gate message's
`payload`, which it reads without joining the gate), and the gate comment on
the issue. A question already open, and a bot that leaves the fields out,
has to read as it did.

## Decision

- **Columns on `gates`.** Migration `0161_gate_decision.sql` adds
  `decision text` and `consequences text[] not null default '{}'`. The gate row
  is the record; every gate `select` and `returning` in
  `packages/db/src/store/threads.ts` reads both. A row from before reads as no
  decision and no consequences.
- **Mirrored into the gate message's payload**, beside `options` and `gateId`,
  each only when it is not empty, because the thread timeline builds its
  question from that payload. The payload is a copy for the timeline, as
  `options` already is.
- **Shown only when paired one to one with the final options.**
  `parseQuestion` matches the list against the marker's `options` as written,
  and drops a consequence with the empty or repeated option `markerOptions`
  drops, so the rest stay with their own. A list of any other length, or with
  an entry that is not a string, is no list at all. `Gates.open` checks again
  against the options it actually offers, the console against the options it
  shows, and `renderGateComment` against the options it numbers.
- **Display only.** An answer, by number or by text, resolves against
  `gate.options` alone (`resolveAnswer`, unchanged). A consequence's words are
  the person's own words, never the option they describe, and the gate
  comment's embedded marker carries the options only.
- **Never on a plan change.** Its choices and context are the bridge's own, so
  `parseQuestion` and `Gates.open` drop both fields for one. The cost-cap
  question never sends them.

## What this rules out

- **The payload alone, with no migration.** Needs you and the thread panel's
  open questions read the gate row, and each would need a subquery into
  `messages` as `held` does. That holds for one display flag; for two fields
  every gate reader shows, it made `messages` a second place the gate's own
  data lives.
- **One `presentation jsonb` column.** Nothing else is planned for it, and
  `text[]` matches how `options` is stored.
- **Filtering a mismatched list to fit.** Dropping or padding entries to reach
  the options' length pairs a choice with another choice's outcome, which is
  worse than showing none.
- **Matching an answer against a consequence.** A person who types what they
  want to happen has said it in their own words, and the bot reads them as
  such.

## What would make this worth revisiting

A question needing more per-choice presentation than one line each (a link,
a risk level, a cost), at which point a structured column per choice is worth
its weight; or the thread timeline joining the gate, at which point the
payload copy has no reader.
