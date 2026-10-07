-- The repository's checks (`make ci`), run on a builder's exact head before it
-- opens or updates a pull request.
--
-- GitHub's CI ran on every push of every crew pull request, reviewed or not,
-- and its minutes are paid for. The builder now runs the checks where it
-- works, and GitHub's CI runs once, on the head about to land. A session's
-- word that it ran them is not a record: hostd runs `make ci` in the task's
-- worktree itself, checks that HEAD did not move and the tree stayed clean
-- before and after, and only then does the bridge write a row. The session's
-- token can start a run and read whether a head passed; it can never write
-- one. `gh pr create`, `git push` and the bridge's pull request handler read
-- these rows.

create table if not exists local_ci_runs (
  id uuid primary key default gen_random_uuid(),
  -- hostd's id for the run, so a result reported twice is written once.
  run_id text not null unique,
  task_id uuid references tasks(id) on delete set null,
  repo_id uuid not null references repos(id) on delete cascade,
  branch text,
  head_sha text not null,
  ok boolean not null,
  exit_code int,
  duration_ms int,
  -- The end of what `make ci` printed, for the lead reviewer and a person.
  log_tail text,
  created_at timestamptz not null default now()
);

create index if not exists local_ci_runs_head on local_ci_runs (repo_id, head_sha, created_at);
