-- Which issue a stacked issue was built on, from the moment its build starts
-- (`apps/bridge/src/stacking.ts`).
--
-- The relation was only a `stack.started` event, written after the build had
-- started and read from the last fourteen days. A dependency in review for
-- longer, an event that failed to write or a read that failed, and the stacked
-- pull request joined the merge line with the dependency's unreviewed commits
-- in it. A row here has no window, and the build does not start without it.
--
-- `paused_at` is when the stacked issue was held because what it was built on
-- changed: held once per stacking, however long ago.

create table if not exists stacks (
  repo_id uuid not null references repos(id) on delete cascade,
  issue_number int not null,
  on_issue int not null,
  on_pr int not null,
  on_branch text not null,
  -- The dependency's head when the stacked build started; null for a stack
  -- recorded before this table, whose event did not say.
  on_head_sha text,
  started_at timestamptz not null default now(),
  paused_at timestamptz,
  primary key (repo_id, issue_number)
);

-- Stacks started before the upgrade, from their events, each with the latest
-- hold since it started. Read as text throughout, so an event of another shape
-- is left out rather than failing the migration.
insert into stacks (repo_id, issue_number, on_issue, on_pr, on_branch, started_at, paused_at)
select distinct on (r.id, e.payload->>'issue')
  r.id,
  (e.payload->>'issue')::int,
  (e.payload->>'on')::int,
  (e.payload->>'onPr')::int,
  e.payload->>'branch',
  e.at,
  (
    select max(p.at) from events p
    where p.type = 'stack.paused' and p.payload->>'repo' = e.payload->>'repo' and p.payload->>'issue' = e.payload->>'issue' and p.at >= e.at
  )
from events e
join repos r on r.name = e.payload->>'repo'
where e.type = 'stack.started'
  and coalesce(e.payload->>'issue', '') ~ '^[0-9]{1,9}$'
  and coalesce(e.payload->>'on', '') ~ '^[0-9]{1,9}$'
  and coalesce(e.payload->>'onPr', '') ~ '^[0-9]{1,9}$'
  and e.payload->>'branch' is not null
order by r.id, e.payload->>'issue', e.at desc
on conflict do nothing;
