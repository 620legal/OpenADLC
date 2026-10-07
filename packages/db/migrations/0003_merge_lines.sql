-- The order pull requests land in, per repository.
--
-- GitHub's merge queue is not available on a private repository outside
-- Enterprise Cloud, and not at all on a personal one, so the bridge serializes
-- merges itself: one pull request at a time is brought up to date with main and
-- re-tested, and branch protection lands it. Without this, two pull requests
-- that each passed against an older main can merge into a broken one.
--
-- A `revert` goes to the front. When testing is broken, the change that fixes it
-- is the only one that matters.

create table merge_lines (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  pr_number int not null,
  -- Lower lands first. A revert enters below every ordinary pull request.
  position int not null,
  state text not null default 'waiting'
    check (state in ('waiting', 'updating', 'testing', 'merging', 'failed', 'merged')),
  head_sha text,
  -- Why it is where it is, in words a person can act on.
  detail text,
  entered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A pull request holds one place in the line, however many events arrive.
create unique index merge_lines_one_per_pr on merge_lines (repo_id, pr_number);
create index merge_lines_open on merge_lines (repo_id, position)
  where state in ('waiting', 'updating', 'testing', 'merging');
