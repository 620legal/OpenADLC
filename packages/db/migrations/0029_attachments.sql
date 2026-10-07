-- Files a person gives the crew with a request or a message — a screenshot of
-- what the page should look like, a PDF of the requirements — and images
-- written into an issue on GitHub, read by intake and design.
--
-- Kept in the database, not under FLEETADLC_HOME: a cloud bridge runs on Cloud
-- Run, which has no disk that outlives a revision, and Cloud SQL is the one
-- store both installs share, already covered by backups. The store reads them
-- through `store/attachments.ts`, so a bucket can stand behind it later
-- (docs/adr/0001-attachments-in-the-database.md).
--
-- An upload is written before the request or message it goes with exists, so
-- it starts unclaimed (`subject_ref` null) and is claimed when that is sent; an
-- upload nobody sent within a day is swept. The same file twice on one subject
-- is one row.
create table attachments (
  id uuid primary key default gen_random_uuid(),
  subject_ref text,
  repo_id uuid references repos(id) on delete set null,
  request_id uuid references requests(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  source text not null check (source in ('console', 'github')),
  source_url text,
  name text not null,
  media_type text not null,
  size_bytes int not null,
  sha256 text not null,
  content bytea not null,
  uploaded_by text not null,
  created_at timestamptz not null default now(),
  unique (subject_ref, sha256)
);

create index attachments_subject on attachments (subject_ref, created_at);
create index attachments_unclaimed on attachments (created_at) where subject_ref is null;
