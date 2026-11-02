-- When the bridge was last running, and what its absence cost
-- (`bridgeGaps`, packages/db/src/store/bridge-gaps.ts).
--
-- Only hostd kept a heartbeat (`hosts.last_seen_at`). A bridge that came back
-- after a crash or a long stop could not say how long it had been away, and
-- the tasks it resumed or ended as orphaned at start went by in its log, read
-- by nobody. The board now says so until a person dismisses it; see
-- docs/adr/0022-the-bridge-keeps-its-own-heartbeat-and-gap-report.md.
--
-- Both times are the database's `now()`, never the bridge's clock, so a beat
-- and the start after it are measured on one clock. No rows are written here:
-- the first start after this change finds no beat and reports nothing.

create table if not exists bridge_heartbeat (
  -- One row.
  id boolean primary key default true check (id),
  seen_at timestamptz not null
);

create table if not exists bridge_gaps (
  id uuid primary key default gen_random_uuid(),
  -- The last beat before the latest gap, and the start that ended it.
  last_up_at timestamptz not null,
  back_at timestamptz not null,
  -- [{taskId, subject, outcome: 'resumed' | 'orphaned', why, backAt}]: what
  -- every gap merged into this row resumed or ended, kept across them.
  tasks jsonb not null default '[]',
  created_at timestamptz not null default now(),
  dismissed_at timestamptz,
  dismissed_by text
);

-- One report open at a time: a new gap merges into it rather than stacking.
create unique index if not exists bridge_gaps_one_open on bridge_gaps ((true)) where dismissed_at is null;
