-- When each issue was last sent to triage.
--
-- An issue's attempts count only the leases taken since then
-- (`attemptsWithoutPullRequest`), and the dispatcher asks that for every
-- issue it could lease, every pass. The audit is the install's whole history
-- and is indexed only by time, so each of those asks read all of it.
create index if not exists audit_issue_triaged on audit (target, at desc) where action = 'issue.triaged';
