-- When a rollback became owed: a promote's traffic shift failed and the
-- repository's rules name a rollback. Set before the rollback is dispatched
-- and kept after, so a dispatch GitHub refused or never answered, given back
-- by the pipeline, is still known to be owed: the deploy sweep dispatches it
-- again, and a health card says so while it is not. Nothing else marked it,
-- and a rollback whose dispatch failed was never tried again.

alter table deploy_runs add column if not exists rollback_due_at timestamptz;
