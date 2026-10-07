-- fleet_db core schema.
-- GitHub stays the system of record for issues, PRs, reviews and labels.
-- These tables hold what GitHub cannot: the bots' computers, leases, sessions,
-- the cost ledger, and the console's read model.

create extension if not exists "pgcrypto";

create table hosts (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  zone text,
  driver text not null default 'local' check (driver in ('docker', 'local')),
  capacity_bots int not null default 8,
  status text not null default 'unknown' check (status in ('up', 'down', 'unknown')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table bots (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  display_name text not null,
  role text not null check (role in ('intake','spec','implement','review_lead','review_second','review_security','deploy','qa','automation')),
  engine text not null check (engine in ('claude','grok','codex','none')),
  model text not null,
  -- Each bot owns a real GitHub user account, connected by the OAuth device flow.
  github_login text unique,
  teams text[] not null default '{}',
  host_id uuid references hosts(id) on delete set null,
  container text not null,
  status text not null default 'stopped' check (status in ('running','stopped','restarting')),
  skills text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Device-flow authorization state per bot account. Secret material (the refresh
-- token, the SSH signing key) lives in the secret store; this table holds only
-- the reference and the freshness metadata the console and `fleet doctor` show.
create table bot_credentials (
  bot_id uuid primary key references bots(id) on delete cascade,
  github_login text not null,
  github_user_id bigint,
  secret_ref text not null,
  scopes text[] not null default '{}',
  token_expires_at timestamptz,
  refresh_expires_at timestamptz,
  signing_key_id bigint,
  authorized_at timestamptz,
  status text not null default 'unauthorized' check (status in ('unauthorized','active','expired','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table repos (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  full_name text unique not null,
  owner_bot_id uuid references bots(id) on delete set null,
  concurrency int not null default 1 check (concurrency > 0),
  stage_modes jsonb not null default '{"intake":"autonomous","spec":"conditional","build":"autonomous","review":"autonomous","merged":"assist","done":"autonomous"}',
  spec_required_labels text[] not null default '{touches:schema,touches:contract,touches:migration,size:large,safety}',
  human_review_paths text[] not null default '{}',
  default_branch text not null default 'main',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table issues (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  number int not null,
  title text not null,
  stage text not null check (stage in ('intake','spec','build','review','merged','done')),
  labels text[] not null default '{}',
  declared_paths text[] not null default '{}',
  url text,
  pr_number int,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (repo_id, number)
);

create table leases (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  issue_number int not null,
  bot_id uuid not null references bots(id) on delete cascade,
  declared_paths text[] not null default '{}',
  state text not null check (state in ('leased','in_task','paused','released','expired')),
  expires_at timestamptz,
  pr_number int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active lease per issue; released and expired rows stay as history.
create unique index leases_one_active on leases (repo_id, issue_number)
  where state in ('leased','in_task','paused');

create table tasks (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  repo_id uuid references repos(id) on delete set null,
  kind text not null check (kind in ('intake','spec','implement','patch','review','deploy','qa','request')),
  subject_type text not null check (subject_type in ('issue','pr','merge','request')),
  subject_ref text not null,
  lease_id uuid references leases(id) on delete set null,
  state text not null default 'queued' check (state in ('queued','running','paused','stopped','done','failed')),
  skill text,
  worktree text,
  branch text,
  tmux_session text,
  cost_cap_usd numeric(10,4) not null default 15,
  cost_usd numeric(10,4) not null default 0,
  round int not null default 0,
  started_at timestamptz,
  ended_at timestamptz,
  exit_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_bot_state on tasks (bot_id, state);
create index tasks_repo_created on tasks (repo_id, created_at desc);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  name text not null,
  cmd text not null default '',
  state text not null default 'idle' check (state in ('working','idle','paused','stopped')),
  pid int,
  last_line text,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id, name)
);

create table session_log (
  id bigserial primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  seq bigint not null,
  line text not null,
  at timestamptz not null default now()
);

create index session_log_session_seq on session_log (session_id, seq desc);

create table threads (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  repo_id uuid references repos(id) on delete set null,
  subject_ref text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id, subject_ref)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id) on delete cascade,
  kind text not null check (kind in ('sys','bot','you','gate','procs','draft')),
  author text not null,
  text text not null,
  note text,
  payload jsonb,
  -- The GitHub comment this row mirrors. GitHub is written first; this is the view.
  github_url text,
  at timestamptz not null default now()
);

create index messages_thread_at on messages (thread_id, at);

create table gates (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete set null,
  thread_id uuid references threads(id) on delete set null,
  question text not null,
  options text[] not null default '{}',
  state text not null default 'open' check (state in ('open','answered','expired')),
  answer text,
  answered_by text,
  answered_at timestamptz,
  addressed_to text,
  github_comment_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index gates_open on gates (state) where state = 'open';

create table requests (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  context text,
  repo_id uuid references repos(id) on delete set null,
  kind text,
  requested_by text not null,
  issue_number int,
  state text not null default 'draft' check (state in ('draft','questions','filed','abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ledger (
  id bigserial primary key,
  task_id uuid references tasks(id) on delete set null,
  bot_id uuid not null references bots(id) on delete cascade,
  engine text not null,
  model text not null,
  prompt_hash text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric(10,4) not null default 0,
  at timestamptz not null default now()
);

create index ledger_at on ledger (at);
create index ledger_task on ledger (task_id);

create table budgets (
  period text primary key,
  cap_usd numeric(12,2) not null,
  spent_usd numeric(12,4) not null default 0,
  state text not null default 'ok' check (state in ('ok','warning','stopped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target text not null,
  payload jsonb,
  at timestamptz not null default now()
);

create index audit_at on audit (at desc);

create table events (
  id bigserial primary key,
  source text not null check (source in ('github','platform','alert','console','schedule')),
  type text not null,
  delivery_id text,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  at timestamptz not null default now()
);

create index events_unprocessed on events (at) where processed_at is null;
