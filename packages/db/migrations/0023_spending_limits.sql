-- Spending limits set in Settings, globally and per repository.
--
-- config/costs.yaml seeds the two global amounts on the first start only.
-- A later start does not copy the file back over what was saved: the insert
-- does nothing when the row is already there. warningAt and onCap stay in
-- the file. A null amount is no cap of that kind; a repository with no row
-- uses the global one.
--
-- month_bot is the bot row. Two bots that share one GitHub login each have
-- their own limit, because the kind carries the bot's id, not the login.

create table spending_limits (
  scope text not null,
  kind text not null,
  amount_usd numeric(12, 2),
  updated_at timestamptz not null default now(),
  primary key (scope, kind),
  check (scope = 'global' or scope like 'repo:%'),
  check (
    kind in ('month_total', 'task')
    or kind like 'month_bot:%'
    or kind like 'month_provider:%'
  )
);
