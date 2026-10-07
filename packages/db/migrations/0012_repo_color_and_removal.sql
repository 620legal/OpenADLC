-- A colour for each repository, and a way to stop working in one.
--
-- The console shows every repository's cards on one board, and a card said
-- which repository it was in only by the name before its number. A colour
-- tells them apart at a glance. It is stored rather than worked out from the
-- name, so that it stays put when another repository is added or one is
-- removed, and so that a person can change it.
--
-- It is a name from the palette in `packages/shared/src/repo-colors.ts`, never
-- a value: the console decides what each looks like in its dark mode and its
-- light one. Every repository already here gets one in the order it was added,
-- the same order a repository added from now on is given the next.
--
-- `removed_at` is a repository Fleet no longer works in. Removing one deletes
-- nothing — its issues, tasks, threads and costs are history, and GitHub is
-- not touched — so the row stays and says when it stopped. Nothing new starts
-- in it and the board no longer shows it; adding it again clears this, and it
-- comes back with its settings — and its colour, unless another repository
-- was given that colour while it was gone.

alter table repos add column if not exists color text;
alter table repos add column if not exists removed_at timestamptz;

with ordered as (
  select id, row_number() over (order by created_at, name) as position
  from repos
  where color is null
)
update repos
set color = (array['blue', 'amber', 'pink', 'teal', 'violet', 'orange'])[((ordered.position - 1) % 6) + 1]
from ordered
where ordered.id = repos.id;

-- Only after every row has one. The store always gives a new row its colour;
-- the default is for a row written some other way, which would otherwise fail.
alter table repos alter column color set default 'blue';
alter table repos alter column color set not null;
