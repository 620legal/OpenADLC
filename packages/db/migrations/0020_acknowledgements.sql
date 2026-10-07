-- A person's "Dismiss" on a Needs-you card that has nothing to fix.
--
-- Such a card is about something that happened — a crew post that was not
-- signed by Fleet — and stays up for as long as its check keeps finding it.
-- Acknowledging it hides what the card showed: `covers` is every occurrence
-- dismissed so far (each post on the card), so a card comes back only for
-- one nobody has seen, never because a newer one was resolved and an older,
-- already dismissed one is the newest again. `occurrence` is the one the card
-- led with at the last press. Kept apart from `health_checks`, which the
-- bridge rewrites whole on every run.
create table if not exists acknowledgements (
  -- What was acknowledged: a health row's id, `unattributed-post`.
  id text primary key,
  occurrence text not null,
  covers text[] not null default '{}',
  acknowledged_by text not null,
  acknowledged_at timestamptz not null default now()
);

-- A post recorded as not signed by Fleet that checks after all, under the
-- rules as they are now: the attribution check re-reads each one it lists
-- and resolves the ones that verify, so a false positive from an older rule
-- (a quoted seat tag misread, since fixed) clears itself instead of standing for a day.
alter table unattributed_posts add column if not exists resolved_at timestamptz;
