-- What an engine call cost, and the tokens it used, are never negative and
-- never NaN. A task's session reports its own usage, and the bridge wrote what
-- it was sent: -1000 cancelled the spend every cap sums, and NaN, which
-- Postgres sorts above every number, left the month's budget stopped for good.
-- The bridge refuses those reports now (`TaskService.recordUsage`); this is the
-- same rule at the row, for a caller that forgets.
--
-- `not valid`, as in 0008: rows written from here on are checked, and the rows
-- already there are not, so an install holding a bad one still migrates
-- inside `fleetadlc up`. Ledger rows are never updated. A task row is, when
-- usage is added to it, and a bad one then fails that update until a person
-- puts its cost right.

alter table ledger drop constraint if exists ledger_cost_counted;
alter table ledger
  add constraint ledger_cost_counted check (cost_usd >= 0 and cost_usd <> 'NaN') not valid;

alter table ledger drop constraint if exists ledger_tokens_counted;
alter table ledger
  add constraint ledger_tokens_counted check (tokens_in >= 0 and tokens_out >= 0) not valid;

alter table tasks drop constraint if exists tasks_cost_counted;
alter table tasks
  add constraint tasks_cost_counted check (cost_usd >= 0 and cost_usd <> 'NaN') not valid;
