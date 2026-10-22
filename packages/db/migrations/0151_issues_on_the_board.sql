-- What the board reads of the issues: every one not in Done, and those in
-- Done that changed in the week Done shows (`boardIssues`,
-- packages/db/src/store/issues.ts).
--
-- The board read every issue row there had ever been, twice, every fifteen
-- seconds for each person looking, and the tasks of every one, though Done
-- shows a week. These keep the read to the live issues and the week's,
-- however many went to Done before it.
--
-- - `issues_live`: the issues not in Done, by repository.
-- - `issues_done`: the issues in Done by repository and when they last
--   changed, read from the start of the week for each repository. On plain
--   columns, so the planner has their statistics (0150's note).

create index if not exists issues_live on issues (repo_id) where stage <> 'done';
create index if not exists issues_done on issues (repo_id, updated_at) where stage = 'done';
