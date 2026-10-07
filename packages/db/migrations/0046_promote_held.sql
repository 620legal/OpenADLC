-- A promote held for a person, where the repository's rules say a person
-- approves production and GitHub's plan cannot hold a reviewer on the
-- `production` environment (a private repository on Free, Pro or Team).
--
-- The bridge dispatched the promote straight after a green smoke, so the job
-- ran at once and production shipped with nobody approving it. Now the
-- promote waits here, as a Needs you card, until a person releases it or
-- switches the repository to automatic delivery. `promote_released_by` is who
-- released it, written only once the dispatch went through.

alter table deploy_runs add column if not exists promote_held_at timestamptz;
alter table deploy_runs add column if not exists promote_released_by text;

create index if not exists deploy_runs_promote_held on deploy_runs (promote_held_at)
  where promote_held_at is not null and promote_dispatched_at is null;
