-- A time-boxed hands-off window on one repository (#383).
--
-- Long runs stalled on gates a person would approve anyway: a plan change
-- with no path under Human review, or a question whose answer the bot had
-- already recommended. A person with Approves on, after a fresh device-code
-- sign-in, turns this on for 1 hour, 8 hours, 24 hours or until turned off.
-- While it is on, `Gates.open` answers those gates as they are asked
-- (`apps/bridge/src/hands-off.ts`), and every answer names this window and
-- who set it. Nothing else reads it: merges, held approvals, releases,
-- deploys, promotes, host checks, labels and settings never do
-- (docs/adr/0093-a-hands-off-window-answers-routine-gates-and-never-the-excluded-ones.md).
--
-- One row per time it was turned on, at most one open per repository. It
-- ends when its time runs out, when a monthly cap is reached, or when a person
-- turns it off: `ended_at`, by whom, and why, with the cap's words for a cap.
--
-- A new table: nothing existing changes, and nothing reads it until a person
-- turns one on. It is not backed up, so a restore starts with every window off.

create table if not exists hands_off_windows (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  -- The console identity that turned it on.
  set_by text not null,
  -- The GitHub account its device-code sign-in proved.
  set_by_login text not null,
  set_by_github_id bigint not null,
  duration text not null check (duration in ('1h', '8h', '24h', 'until_off')),
  set_at timestamptz not null default now(),
  -- Null: until turned off.
  ends_at timestamptz,
  ended_at timestamptz,
  ended_by text,
  ended_why text check (ended_why in ('expired', 'cap', 'turned_off')),
  -- The cap's words, when a cap ended it.
  ended_note text
);
create unique index if not exists hands_off_windows_open on hands_off_windows (repo_id) where ended_at is null;
