-- Routines: console requests that file themselves on a schedule (#369,
-- docs/adr/0090-a-routine-files-a-console-request-as-its-owner-from-a-claimed-slot.md).
--
-- A routine is a repository, request text and details, a kind, and a
-- cadence — daily, weekly on an ISO weekday, or monthly on a day — at a time
-- of day in an IANA time zone. The bridge's `routines` job claims a due
-- routine's slot by moving `next_run_at` with a conditional update, then
-- files one console request as its owner or records why it skipped.
--
-- The owner is the approver who last created or edited it: their console
-- identity, which the request is filed as, and the GitHub account linked to
-- them, whose Approves is read at each firing.
--
-- `next_run_at` is null exactly when the routine is paused. A repository
-- taken out of the install takes its routines with it; a routine deleted
-- keeps the requests it filed and clears their pointer.
--
-- One new table and one nullable column on `requests`: nothing is
-- back-filled, and every request already here reads `routine_id` null.

create table if not exists routines (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  text text not null check (length(btrim(text)) > 0),
  details text,
  kind text not null check (kind in ('feature', 'defect', 'chore', 'question')),
  cadence text not null check (cadence in ('daily', 'weekly', 'monthly')),
  cadence_day smallint,
  time_of_day text not null check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  time_zone text not null check (length(btrim(time_zone)) > 0),
  paused boolean not null default false,
  owner_identity text not null,
  owner_login text not null,
  owner_github_id bigint not null,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_request_id uuid references requests(id) on delete set null,
  last_outcome text check (last_outcome in ('filed', 'skipped', 'failed')),
  last_skip_reason text,
  -- `is not null` said outright: `null between 1 and 7` is null, which a
  -- check lets through, so a weekly routine with no day was accepted.
  constraint routines_cadence_day check (
    case cadence
      when 'daily' then cadence_day is null
      when 'weekly' then cadence_day is not null and cadence_day between 1 and 7
      when 'monthly' then cadence_day is not null and cadence_day between 1 and 31
      else false
    end
  ),
  constraint routines_paused_next_run check (paused = (next_run_at is null))
);

create index if not exists routines_due on routines (next_run_at) where not paused;

alter table requests add column if not exists routine_id uuid references routines(id) on delete set null;
