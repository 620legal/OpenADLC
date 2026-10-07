-- What became of a production rollback the bridge dispatched.
--
-- A rollback was dispatched and nothing looked at it again. It shares the
-- `production-traffic` concurrency group with the promote, so it could sit
-- behind a promote waiting hours for a person's approval, or be cancelled by
-- the next promote dispatched, while the issue already said production was
-- rolled back. The deploy sweep now reads its run:
--
-- - `rollback_conclusion`, `rollback_at`: `success` or `failure`, once the
--   run ended. A promote waits while a rollback owed has none.
-- - `rollback_trouble`: why the last dispatch did not run — its run was
--   cancelled, or never appeared — for the board's card. The dispatch is
--   given back and sent again; a success clears it.
--
-- Nullable: an existing row has nothing to backfill.

alter table deploy_runs add column if not exists rollback_conclusion text;
alter table deploy_runs add column if not exists rollback_at timestamptz;
alter table deploy_runs add column if not exists rollback_trouble text;
