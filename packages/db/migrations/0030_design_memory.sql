-- What the design stage remembers about a repository between issues: the
-- decisions taken, the constraints and conventions it works within, and the
-- words it uses.
--
-- GitHub is the record: a decision is written as an ADR under docs/adr/ in the
-- repository, in the pull request that builds it. This is a curated summary of
-- that record, small enough to give the design stage on every task and
-- editable by people in Settings, kept here because an ADR file is the long
-- form and nothing else holds the short one (docs/adr/0002-design-memory.md).
--
-- An entry is proposed by the design comment that names it, accepted when a
-- person answers the design's question on that issue or the issue moves on to
-- build, and stays until a person retires it or a later entry supersedes it.
create table design_memory (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  kind text not null check (kind in ('decision', 'constraint', 'convention', 'glossary')),
  title text not null,
  body text not null,
  state text not null default 'proposed' check (state in ('proposed', 'accepted', 'superseded', 'retired')),
  supersedes uuid references design_memory(id) on delete set null,
  source_subject text,
  source_url text,
  adr_path text,
  proposed_by text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index design_memory_repo on design_memory (repo_id, state, created_at desc);
create index design_memory_source on design_memory (source_subject);
