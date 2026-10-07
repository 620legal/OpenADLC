-- Every stage an issue was moved to, and how: forward by the stage that
-- finished, back by a send-back, or anywhere by a person.
--
-- Where a send-back goes is read from this, not from a fixed map: build goes
-- back to design only when the issue had a design pass this time round, and
-- the limits on send-backs (`review.sendBack` in config/review.yaml) count
-- these rows. The issue's own comments stay the record a person reads; this is
-- what the bridge counts, since a comment on GitHub can be edited by anyone
-- who can write there.
--
-- 0028 to 0030 are left for another change in flight; migrations apply by
-- name, so the gap is harmless.

create table if not exists stage_moves (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  issue_number int not null,
  pr_number int,
  -- Null when the issue had no stage before: the first one it was filed into.
  from_stage text check (from_stage in ('intake','spec','build','review','merged','done')),
  to_stage text not null check (to_stage in ('intake','spec','build','review','merged','done')),
  kind text not null check (kind in ('forward', 'send_back', 'person')),
  -- A bot's name, a person's login or email, or `fleetadlc` for the bridge.
  actor text not null,
  task_id uuid references tasks(id) on delete set null,
  reason text,
  -- The comment on the issue that records it, for a send-back.
  comment_url text,
  created_at timestamptz not null default now()
);

create index if not exists stage_moves_issue on stage_moves (repo_id, issue_number, created_at);
