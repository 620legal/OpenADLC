-- How the testing deploy the bridge dispatched for a merged commit ended.
--
-- A dispatch was recorded and nothing looked at its run again. On
-- OpenADLC#72 the run of deploy-testing finished skipped — the template's job
-- runs only where the repository sets OPENADLC_DEPLOY_TESTING — so no
-- deployment came, no verification ran, and the verification's end was the
-- only thing that let the merged change's lease go. The deploy sweep said
-- "a testing deploy was already started (running)" until the lease ran out.
--
-- - `testing_conclusion`: the run's conclusion, from its `workflow_run`
--   delivery or the deploy sweep's look at it; `not_started` when no run of
--   it appeared within a bound of the dispatch. `skipped`, `cancelled` and
--   `not_started` deployed nothing: the lease is let go then, and `detail`
--   says why.
-- - `testing_at`: when it was recorded.
--
-- Nullable: an existing row has nothing to backfill, and is looked at again
-- by the deploy sweep while it is recent.

alter table deploy_runs add column if not exists testing_conclusion text;
alter table deploy_runs add column if not exists testing_at timestamptz;
