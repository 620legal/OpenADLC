-- A repository's Postgres servers of their own for its tasks, as a person set
-- them in Settings → Repositories: one or more of { port, superuser,
-- password, database, image }, and whether a task also gets its database on
-- the shared task server (`TaskPostgresSetting`, packages/shared/src/
-- task-postgres.ts). hostd reads it at each task start and runs each server
-- in the task's computer's network namespace (apps/hostd/src/drivers/
-- task-postgres.ts).
--
-- A column rather than a line in config/repos.yaml or the repository's own
-- files: those are the crew's to propose, and an image or a port the crew
-- chose would run beside every task. Empty is "none", which every repository
-- starts as.

alter table repos add column if not exists task_postgres jsonb;
