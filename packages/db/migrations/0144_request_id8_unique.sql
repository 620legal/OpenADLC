-- A request is known to the crew by `request:<the first eight characters of
-- its id>`, and found again by that prefix (`findRequestByPrefix`). Ids are
-- random, so by 10,000 requests there is about a 1% chance two share a prefix,
-- and from then on neither can be found: their triage is briefed with
-- nothing, and they are never filed. The index below refuses the second one,
-- and `createRequest` tries again with a fresh id.
--
-- A pair that is already here keeps its ids: tasks, threads, gates and
-- attachments name a request by its subject, so a new id would orphan them.
-- Every row but the oldest of each pair is marked instead and left out of the
-- index, so building it cannot fail `fleetadlc up`. The oldest stays in, so a
-- new request that collides with either is still refused.
alter table requests add column if not exists id8_shared boolean not null default false;

update requests set id8_shared = true
where id in (
  select id from (
    select id, row_number() over (partition by left(id::text, 8) order by created_at, id) as nth
    from requests
  ) prefixed
  where prefixed.nth > 1
);

create unique index if not exists requests_id8 on requests (left(id::text, 8)) where not id8_shared;
