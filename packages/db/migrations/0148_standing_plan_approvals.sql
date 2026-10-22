-- A person's standing approval of a builder's plan changes on one issue (#77).
--
-- On 2026-10-22, #27 and #45 each asked for several paths beyond their lease,
-- one after another, and each waited on a person to answer the same kind of
-- question again. "Approve, and any more paths for #N" on a plan-change card
-- turns this on: later plan changes on that issue are approved as they are
-- asked, except a path under `## Human review` in AGENTS.md, which always asks
-- a person (`Gates.open`, `plan-changes.ts`). Each still posts its record on
-- the issue and writes an audit row naming this approval and who set it.
--
-- One row per time it was turned on. It ends when its pull request merges or
-- closes, the issue closes, or a person turns it off: `ended_at`, by whom, and
-- why. At most one is on per issue.
--
-- A new table: nothing existing changes, and nothing reads it until a person
-- turns one on.

create table if not exists standing_plan_approvals (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  issue_number int not null,
  set_by text not null,
  set_at timestamptz not null default now(),
  -- The plan-change question it was turned on from.
  gate_id uuid references gates(id) on delete set null,
  ended_at timestamptz,
  ended_by text,
  ended_why text
);
create unique index if not exists standing_plan_approvals_on on standing_plan_approvals (repo_id, issue_number) where ended_at is null;
