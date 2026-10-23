-- Every issue a console request was filed as, across repositories: one row
-- each (`requests.fileIssue`, packages/db/src/store/requests.ts).
--
-- A request pointed at one issue (`requests.issue_number` in
-- `requests.repo_id`), so when intake filed a request that spans two managed
-- repositories as an issue in each, the second was turned away: it was never
-- recorded, its design was given no `intake.md`, and the console showed only
-- the first. A table rather than the request's work item, whose links are empty
-- before the install's first numbering and change when a person unlinks or
-- merges items; see docs/adr/0012-a-request-files-one-issue-per-repository.md.
--
-- `requests.issue_number` stays, and is still written: the first issue filed in
-- `requests.repo_id`, which the work-item backfill, `firstFiledItem` and the
-- board's ignored check read, and a bridge one release behind reads.

create table if not exists request_issues (
  request_id uuid not null references requests(id) on delete cascade,
  repo_id uuid not null references repos(id),
  issue_number integer not null,
  filed_at timestamptz not null default now(),
  primary key (request_id, repo_id, issue_number)
);

create index if not exists request_issues_issue on request_issues (repo_id, issue_number);

-- A request filed before this has exactly its one issue.
insert into request_issues (request_id, repo_id, issue_number, filed_at)
  select id, repo_id, issue_number, updated_at from requests
  where issue_number is not null and repo_id is not null
  on conflict do nothing;
