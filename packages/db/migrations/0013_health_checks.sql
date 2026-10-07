-- What Fleet knows about the things it cannot do for itself.
--
-- Each health check (apps/bridge/src/health/) proves by its effect that
-- something a person had to do was done — the app installed with every
-- permission Fleet asks for, a bot's signing key on its account, GitHub
-- delivering — and keeps proving it. One row per check and subject holds its
-- latest answer, so the bridge can tell a failure that is new from one that is
-- still there and one that has just been fixed.
--
-- A failing row is a card on the board until the check passes. `failing_since`
-- is how long a person has been waited on, `notified_at` when they were last
-- told, and `fixed_at` with `fixed_title` is what the board says once when it
-- passes again, until somebody dismisses it.
--
-- The dispatcher reads it as well: it does not hand a build to a bot whose
-- signing key GitHub does not know, in a repository that requires signed
-- commits, and says so instead.
--
-- Nothing here is worth restoring from a backup: every row is asked again at
-- the next start.
create table if not exists health_checks (
  id text primary key,
  check_id text not null,
  subject text,
  state text not null check (state in ('ok', 'failing', 'unknown')),
  severity text check (severity in ('blocking', 'warning')),
  title text,
  detail text,
  action jsonb,
  facts jsonb not null default '{}',
  waiting_for text[] not null default '{}',
  failing_since timestamptz,
  checked_at timestamptz not null default now(),
  notified_at timestamptz,
  fixed_at timestamptz,
  fixed_title text,
  fixed_dismissed_at timestamptz
);

create index if not exists health_checks_check on health_checks (check_id);
