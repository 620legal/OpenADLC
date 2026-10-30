-- What GitHub last said of each issue labelled `openadlc:ignore`: open or
-- closed, and why it closed (`ignoredIssues`, packages/db/src/store/ignored-issues.ts).
--
-- An ignored issue is a person's, built outside the crew, and the board keeps
-- no row for one in intake, spec or no stage at all. An issue that named one
-- under Dependencies waited on it for good: `dependencyIsSatisfied` read no
-- row as never shipped, and the card said "not on the board" after it had
-- closed as completed. Nothing here puts an ignored issue on the board; the
-- rule reads this record beside the row; see
-- docs/adr/0020-an-ignored-dependency-counts-once-closed-as-completed.md.
--
-- Written by the issues webhook and by reconcile, which also looks up a
-- dependency nothing has recorded. No rows are written here: reconcile fills
-- in one that closed before this change within a pass.

create table if not exists ignored_issues (
  repo_id uuid not null references repos(id) on delete cascade,
  number integer not null,
  state text not null check (state in ('open', 'closed')),
  -- GitHub's state_reason as given: completed, not_planned, duplicate, reopened, or null.
  -- Only 'completed' with state 'closed' counts as shipped (dependencyIsSatisfied).
  state_reason text,
  closed_at timestamptz,
  seen_at timestamptz not null default now(),
  primary key (repo_id, number)
);
