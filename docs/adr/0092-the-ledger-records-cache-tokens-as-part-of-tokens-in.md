# 0092. The ledger records cache tokens as part of tokens in

- **Status:** accepted
- **Date:** 2026-11-26

## Context

A Costs page (#368) needs to split a run's tokens by kind and estimate what
the provider's cache saved. Until #367 the ledger stored only `tokens_in` and
`tokens_out`, and `tokens_in` already meant the whole input the model
processed, cached input included: every cap, report and backup reads it that
way. The engines already knew the cache counts. Claude Code and Grok Build
report cache read and cache write on each message, and Codex reports its
cached input, but none of them reached the ledger.

## Decision

`ledger.tokens_cache_read` and `ledger.tokens_cache_write` (migration 0171)
are a **breakdown of `tokens_in`**, not tokens added to it. `tokens_in` keeps
its meaning, and uncached input is `tokens_in − cache_read − cache_write`.

- The counts are named `cacheRead` and `cacheWrite` on every hop: the
  engine's `usage` event, hostd's `/internal/tasks/:id/usage` report,
  `TaskService.recordUsage`, `costs.recordUsage`, `LedgerEntry`, and
  `ArchivedLedgerEntry` in a backup. The engine event's old `cachedTokensIn`
  is gone.
- A count that is left out is 0 on every hop. An older hostd, bridge or backup
  keeps working, and a row written before 0171 reads 0 in both, which means
  "all input uncached, no savings".
- Both the bridge (`usageProblem`, `costs.recordUsage`) and the row
  (`ledger_cache_tokens_counted`) refuse a negative count, or a pair whose sum
  is above `tokens_in`. The row's check is `not valid`, as in 0040, so an old
  row is never checked.
- Codex reports no cache write. Its cached input is reported as `cacheRead`,
  held within its input so a malformed line cannot produce a report the
  bridge refuses.
- Pricing, caps, `billed` and the leasing budget are untouched: they read
  `tokens_in`, `cost_usd` and `billed` exactly as before.

## What this rules out

- **Storing uncached input in its own column, or changing `tokens_in` to mean
  uncached input.** Either would change a column that every cap, report and
  backup reads, and a row's meaning would depend on when it was written. Keeping
  `tokens_in` whole and adding its parts beside it changes nothing that already
  reads the ledger.
- **Back-filling old rows.** No record of their cache split exists. 0 is the
  honest value, and it reads as no savings rather than as made-up savings.
- **A validated check.** 0040 left old rows unchecked, so an install can still
  hold a row with a negative `tokens_in`. A validated check would fail on that
  row inside `openadlc up`.

## What would make this worth revisiting

A provider whose cache counts are not parts of the input it reports, for
example one that bills cached input on top of an uncached `input_tokens`
without saying a total. Its adapter would then have to add the counts up
itself, and if that cannot be done, the "part of `tokens_in`" rule would no
longer hold for every engine.
