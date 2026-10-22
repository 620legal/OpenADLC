-- Work items (docs/adr/0009-work-items.md): the install's own number for every
-- issue, pull request and console request it has seen, and the links that
-- group the work that belongs together. Tables only; no existing column
-- changes, and nothing reads these until the first numbering commits.

-- A number is drawn with nextval, which never rolls back, and an item's row
-- is never deleted (merged or emptied, it keeps `merged_into`), so no number
-- is ever handed out twice.
create sequence if not exists work_item_number_seq;

create table if not exists work_items (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique,
  -- Set when it was merged into another, or when its last link moved away.
  merged_into uuid references work_items(id),
  created_at timestamptz not null default now()
);

create table if not exists work_item_links (
  -- The order things were linked in: the lowest id of an item's issues is its first.
  id bigserial primary key,
  work_item_id uuid not null references work_items(id),
  kind text not null check (kind in ('issue', 'pull', 'request')),
  repo_id uuid references repos(id) on delete cascade,
  number int,
  request_id uuid references requests(id) on delete cascade,
  -- Null when OpenADLC linked it; a person's login when they did. Automatic
  -- linking never moves a person's.
  linked_by text,
  -- What the board shows, as last seen.
  title text not null,
  state text not null check (state in ('open', 'closed', 'merged')),
  url text,
  opened_at timestamptz not null,
  seen_at timestamptz not null default now(),
  check ((kind = 'request') = (request_id is not null)),
  check ((kind = 'request') = (repo_id is null)),
  check ((repo_id is null) = (number is null))
);
-- Issues and pull requests share one number space per repository.
create unique index if not exists work_item_links_thing on work_item_links (repo_id, number) where repo_id is not null;
create unique index if not exists work_item_links_request on work_item_links (request_id) where request_id is not null;
create index if not exists work_item_links_item on work_item_links (work_item_id);

-- How far the history read has got: one row per repository, and the
-- install's (repo_id null), whose numbered_at is when live numbering began.
create table if not exists work_item_backfill (
  id bigserial primary key,
  repo_id uuid unique references repos(id) on delete cascade,
  -- The next page to read of each listing.
  issues_page int not null default 1,
  pulls_page int not null default 1,
  read_at timestamptz,
  numbered_at timestamptz,
  caught_up_at timestamptz,
  last_error text
);
create unique index if not exists work_item_backfill_install on work_item_backfill ((repo_id is null)) where repo_id is null;

-- What the read found and has not numbered yet; deleted once numbered.
create table if not exists work_item_backfill_rows (
  repo_id uuid not null references repos(id) on delete cascade,
  number int not null,
  kind text not null check (kind in ('issue', 'pull')),
  title text not null,
  state text not null,
  url text not null,
  opened_at timestamptz not null,
  head_ref text,
  head_repo text,
  base_ref text,
  closes int[] not null default '{}',
  primary key (repo_id, number)
);
