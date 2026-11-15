-- A repository's release recipe, and each release build hostd ran of one
-- pinned commit in the release account (#343,
-- docs/adr/0070-a-release-recipe-is-an-admins-and-its-artifact-stays-with-hostd.md).
--
-- The recipe is on the repository's row, written only by the admin route
-- `PATCH /v1/repos/:name`, as the host check's command is (ADR 0064): what
-- runs as the release account is never chosen by a file a pull request can
-- change. A null command is no release, so every repository here before this
-- migration is left as it was.

alter table repos add column if not exists release_command text;
-- The file the command leaves, relative to the working folder.
alter table repos add column if not exists release_artifact text;
-- Where hostd reads the version at the pinned commit, and the key in it.
alter table repos add column if not exists release_version_file text;
alter table repos add column if not exists release_version_key text;
-- `owner/name` the release is published to; null is this repository.
alter table repos add column if not exists release_repo text;
alter table repos add column if not exists release_timeout_minutes int not null default 180;
alter table repos drop constraint if exists repos_release_timeout_minutes_check;
alter table repos add constraint repos_release_timeout_minutes_check check (release_timeout_minutes between 1 and 1440);

-- Each release build. Only the bridge writes it: `start` when it asks hostd,
-- `finish` from hostd's report sent with the install's secret. The version,
-- sha256, bytes and artifact name are hostd's own, never the account's.
create table if not exists release_runs (
  id uuid primary key default gen_random_uuid(),
  -- hostd's id, so a report sent twice is written once.
  run_id text unique not null,
  repo_id uuid not null references repos(id) on delete cascade,
  -- The commit pinned when the release was asked for: the run builds this and nothing else.
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  clean boolean not null default false,
  -- The recipe as it was when the run started.
  command text not null,
  artifact text not null,
  version_file text not null,
  version_key text,
  release_repo text,
  timeout_minutes int not null,
  -- The last release's version the run had to be above; null for none.
  previous_version text,
  state text not null check (state in ('running', 'built', 'failed', 'cancelled', 'refused', 'lost')),
  -- From hostd's report only.
  version text,
  sha256 text,
  bytes bigint,
  artifact_name text,
  exit_code int,
  duration_ms bigint,
  log_tail text,
  -- Why it was refused, cancelled or failed, in words that say what to do.
  reason text,
  requested_by_login text not null,
  requested_by_id bigint not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
-- One release building per repository, held by the database.
create unique index if not exists release_runs_one_running on release_runs (repo_id) where state = 'running';
create index if not exists release_runs_repo on release_runs (repo_id, started_at desc);
