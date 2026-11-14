-- A repository's host check: a command an admin sets, such as `make host-ci`,
-- that hostd runs on the install's own machine, outside every container, as
-- an OS account of its own, on a head the crew approved (#327,
-- docs/adr/0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md).
--
-- The setting is on the repository's row, written only by the admin route
-- `PATCH /v1/repos/:name`. It is not in `config/repos.yaml`: that file is in
-- OpenADLC's own checkout, which a pull request can change, and the command a
-- host check runs must never come from a pull request.
--
-- A null command is no host check, so every repository here before this
-- migration is left as it was.

alter table repos add column if not exists host_check_command text;
alter table repos add column if not exists host_check_timeout_minutes int not null default 60;
alter table repos add column if not exists host_check_required boolean not null default true;
alter table repos drop constraint if exists repos_host_check_timeout_minutes_check;
alter table repos add constraint repos_host_check_timeout_minutes_check check (host_check_timeout_minutes between 1 and 1440);

-- Each run, per head. Only the bridge writes it, from hostd's report sent with
-- the install's secret, and the merge reads it rather than the `host-check`
-- commit status, which any crew token could set.
create table if not exists host_check_runs (
  id uuid primary key default gen_random_uuid(),
  -- hostd's id, so a report sent twice is written once.
  run_id text unique not null,
  repo_id uuid not null references repos(id) on delete cascade,
  pr_number int not null,
  head_sha text not null,
  state text not null check (state in ('running', 'passed', 'failed', 'cancelled', 'refused', 'lost')),
  -- What was run, as the settings were when it started.
  command text not null,
  timeout_minutes int not null,
  exit_code int,
  duration_ms bigint,
  log_tail text,
  -- Why it was refused, cancelled or failed without an exit, in words that say what to do.
  reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists host_check_runs_pull on host_check_runs (repo_id, pr_number, started_at desc);
create index if not exists host_check_runs_head on host_check_runs (repo_id, head_sha);
