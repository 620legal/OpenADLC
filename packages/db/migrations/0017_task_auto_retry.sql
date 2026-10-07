-- A task Fleet ran again by itself, once its cause was fixed.
--
-- A task that failed because a bot could not sign in to GitHub, was not in the
-- repository, or hostd did not answer is started again when the health check
-- that explains it passes. `auto_retried_at` is what makes that once: it is set
-- on the failed task when the retry is taken, in one statement, so two runs of
-- the recovery cannot both start it — and on the task the retry started, so a
-- retry that fails again waits for a person instead of looping.
alter table tasks add column if not exists auto_retried_at timestamptz;
