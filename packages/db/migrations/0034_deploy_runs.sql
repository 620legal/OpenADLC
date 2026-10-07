-- What the deploy pipeline did with each merged commit: the testing deploy it
-- dispatched, the smoke that judged it, the promote it dispatched (or the soak
-- it holds before one), what production said, and a rollback or a send-back.
--
-- A merge's delivery used to be a task for the deploy bot, and a person
-- approved production. The repository's rules (`.github/fleetadlc.yml`) decide
-- it now, and the bridge dispatches each workflow as the app. Every step is
-- asked again on a redelivered event or the sweep, so each one is recorded
-- once here and never done twice for a commit.

create table if not exists deploy_runs (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  sha text not null,
  pr_number int,
  testing_dispatched_at timestamptz,
  -- `success` or `failure`, from the smoke on testing.
  smoke_conclusion text,
  smoke_at timestamptz,
  -- A soak the bridge holds itself, where the repository's plan keeps no
  -- environment wait timer: the promote is dispatched once this has passed.
  promote_after timestamptz,
  promote_dispatched_at timestamptz,
  production_conclusion text,
  production_at timestamptz,
  rollback_dispatched_at timestamptz,
  sent_back_at timestamptz,
  -- The last thing said about it, in words a person acts on.
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, sha)
);

create index if not exists deploy_runs_promote_due on deploy_runs (promote_after)
  where promote_after is not null and promote_dispatched_at is null;
