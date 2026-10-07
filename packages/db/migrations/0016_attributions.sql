-- Signed posts (packages/shared/src/signature.ts).
--
-- Each signature carries a nonce, and the first post seen with it takes it:
-- the same signature on a second post is a copy. `unattributed_posts` is every
-- post by one of the crew's accounts whose signature did not check, with why —
-- what the board's card and the audit trail read.
create table if not exists attributions (
  nonce text primary key,
  seat text not null,
  task_id text,
  repo text,
  kind text not null,
  -- The post that took the nonce: `<repo>:<kind>:<id>`.
  bound_to text not null,
  created_at timestamptz not null default now()
);

create table if not exists unattributed_posts (
  id bigserial primary key,
  repo text not null,
  kind text not null,
  object_id text not null,
  login text not null,
  reason text not null,
  url text,
  seat text,
  created_at timestamptz not null default now(),
  unique (repo, kind, object_id, reason)
);
create index if not exists unattributed_posts_recent on unattributed_posts (created_at desc);
