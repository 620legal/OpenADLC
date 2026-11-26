-- Discover runs and the proposals they store (#370,
-- docs/adr/0089-a-discover-run-is-an-intake-task-whose-proposals-hostd-checks-against-its-snapshot.md).
--
-- A run is one read-only pass of the `discover` skill over a repository's
-- default-branch snapshot, run as an intake-seat task on `discover:<id8>`.
-- Its proposals reach this table only from the session's own marker, through
-- hostd, which keeps a `file:line` only when it exists at `commit_sha`; the
-- bridge checks them again before it writes them (`discover.ts`).
--
-- One run per repository may be live: a partial unique index holds it, so
-- two starts at once cannot both open a task. A repository taken out of the
-- install takes its runs and proposals with it.
--
-- The fingerprint is sha256(lens || '\n' || key): the session is given the
-- last done run's keys to reuse for the same thing, so a later run, and
-- issue 2's dismissal, recognise a proposal by `(repo_id, fingerprint)`.
--
-- Two new tables: nothing existing changes, `tasks` included, and nothing
-- is back-filled.

create table if not exists discover_runs (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  task_id uuid null references tasks(id) on delete set null,
  lenses text[] not null,
  state text not null check (state in ('running', 'done', 'failed')),
  commit_sha text null check (commit_sha ~ '^[0-9a-f]{40}$'),
  proposal_count int not null default 0,
  dropped_count int not null default 0,
  note text,
  reason text,
  started_by text not null,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists discover_runs_one_running on discover_runs (repo_id) where state = 'running';
create index if not exists discover_runs_task on discover_runs (task_id);
create index if not exists discover_runs_repo on discover_runs (repo_id, created_at desc);

create table if not exists discover_proposals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references discover_runs(id) on delete cascade,
  repo_id uuid not null references repos(id) on delete cascade,
  lens text not null,
  key text not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  title text not null,
  description text not null,
  status text not null check (status in ('missing', 'partial', 'already there')),
  -- [{file, line}], each checked against the run's commit.
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, fingerprint)
);
create index if not exists discover_proposals_seen on discover_proposals (repo_id, fingerprint);
