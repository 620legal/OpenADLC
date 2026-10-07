-- The GitHub Actions minutes each workflow run in a managed repository took.
--
-- The model's spend was counted to the cent and capped; the CI runs the crew's
-- work set off were not counted at all, and they are the repository's own bill.
-- An install of this project ran past its Actions spending limit in an hour
-- of crew branches, and nothing here had said it was close. The bridge reads a
-- run's jobs when GitHub says the run completed (`ci-usage.ts`) and writes one
-- row per attempt.

create table if not exists ci_usage (
  repo_id uuid not null references repos(id) on delete cascade,
  run_id bigint not null,
  run_attempt int not null default 1,
  workflow text not null,
  event text,
  head_branch text,
  pr_number int,
  conclusion text,
  -- Each job's time rounded up to a whole minute, as GitHub bills it, times
  -- its runner's rate (Linux 1, Windows 2, macOS 10).
  minutes int not null,
  -- Whether the minutes are billed: a public repository's standard runners are free.
  billed boolean not null,
  completed_at timestamptz not null,
  primary key (repo_id, run_id, run_attempt)
);

create index if not exists ci_usage_completed_at on ci_usage (completed_at);
