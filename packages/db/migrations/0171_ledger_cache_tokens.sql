-- The input a run read from the provider's cache, and wrote to it, as parts of
-- `tokens_in`: a Costs page splits tokens by kind and estimates what caching
-- saved from these (#367, docs/adr/0092). `tokens_in` keeps its meaning, the
-- whole input cached included, so every cap, report and backup that reads it
-- reads what it did. Rows written before this read 0 in both: all input
-- uncached.
--
-- The bridge refuses a negative count, or a pair above `tokens_in`
-- (`TaskService.recordUsage`); this is the same rule at the row, for a caller
-- that forgets. `not valid`, as in 0040: 0040 left old rows unchecked, so an
-- install can still hold one with a negative `tokens_in`, and a validated
-- check would fail on it inside `openadlc up`.

alter table ledger add column if not exists tokens_cache_read integer not null default 0;
alter table ledger add column if not exists tokens_cache_write integer not null default 0;

alter table ledger drop constraint if exists ledger_cache_tokens_counted;
alter table ledger
  add constraint ledger_cache_tokens_counted check (
    tokens_cache_read >= 0
    and tokens_cache_write >= 0
    and tokens_cache_read + tokens_cache_write <= tokens_in
  ) not valid;
