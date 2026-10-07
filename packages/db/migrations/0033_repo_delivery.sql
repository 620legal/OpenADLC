-- How a repository ships, when it says so here rather than in its own
-- `.github/fleetadlc.yml`, and where its testing environment is served.
--
-- The file on the repository's default branch is read first: changing it is a
-- pull request, and one that touches `.github/` is merged by a person. This
-- row is for a repository with no such file. Without either, the bridge falls
-- back on Settings → Repositories' testing-deploy choice, and the testing URL
-- on FLEETADLC_TESTING_URL, which SQL cannot read: both columns start empty, and
-- an empty one is "not said here".

alter table repos add column if not exists delivery_rules jsonb;
alter table repos add column if not exists testing_url text;
