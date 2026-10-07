-- What GitHub's plan refused when the rules were last applied to a repository,
-- and the plan state it refused them under: whether the repository was private,
-- and whether rulesets were refused. The bridge reads a remembered refusal as
-- the plan's limit only while the repository is still in that state, so one
-- made public or moved to another plan is asked again. `fleet github apply`
-- and the console's "Apply again" clear it.
create table if not exists repo_plan_limits (
  repo_full_name text primary key,
  -- [{ "name": "environment testing", "detail": "…" }]
  limits jsonb not null,
  private boolean not null,
  rulesets_refused boolean not null,
  recorded_at timestamptz not null default now()
);
