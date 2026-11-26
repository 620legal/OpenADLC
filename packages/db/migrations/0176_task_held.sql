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
-- The check constraint from 0001_init.sql is widened, and each task records
-- the account it ran on. No data changes: tasks that failed on that limit
-- stay `failed`.

alter table tasks drop constraint if exists tasks_state_check;
alter table tasks add constraint tasks_state_check
  check (state in ('queued', 'running', 'paused', 'stopped', 'done', 'failed', 'held'));

-- The model account a task's session ran on, written as hostd marks it
-- running (`updateTaskState`). A hold is raised on this account, not on the
-- one its bot thinks with when the task ends: a seat moved from account A to
-- B while its task ran would otherwise hold B for A's limit and leave A,
-- the account at its limit, free to be leased to. Null for a task that
-- never ran, or whose bot had no account; such a task is never held.
alter table tasks add column if not exists model_account_id uuid
  references model_accounts (id) on delete set null;
