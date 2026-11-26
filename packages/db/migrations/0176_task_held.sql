-- A task can end `held`: its model account hit a usage or spend limit, which
-- is the account's state, not the task's failure (#395,
-- docs/adr/0096-a-model-accounts-usage-limit-is-a-health-row-and-its-tasks-end-held.md).
--
-- On 2026-11-25 a shared Claude account's spend limit failed 32 tasks on 12
-- issues in an hour, and three leases each parked nine issues `needs-triage`.
-- A held task is not counted toward parking, and the recovery starts it again
-- once a check of the account passes; the hold itself is the health row
-- `model-limit:<accountId>`, so no table is added.
--
-- Only the check constraint from 0001_init.sql is widened. No data changes:
-- tasks that failed on that limit stay `failed`.

alter table tasks drop constraint if exists tasks_state_check;
alter table tasks add constraint tasks_state_check
  check (state in ('queued', 'running', 'paused', 'stopped', 'done', 'failed', 'held'));
