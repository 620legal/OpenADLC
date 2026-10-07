-- The branch a task's worktree started from, when it was not the repository's
-- default branch, and what the task was told about it.
--
-- A stacked build starts from the branch of the issue it depends on, and its
-- brief says so. Neither was kept, so a build resumed after a question started
-- again from the default branch without the dependency's code, or counted
-- every file the dependency changed as its own to write, and was not told what
-- it was built on. hostd reads both back when it resumes the task.

alter table tasks add column if not exists base_ref text;
alter table tasks add column if not exists base_context jsonb;
