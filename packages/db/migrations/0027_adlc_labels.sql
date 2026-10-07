-- FleetADLC renamed the pipeline's labels: stage labels went from `sdlc:` to
-- `adlc:`, and `fleet:ignore` became `fleetadlc:ignore`.
--
-- GitHub keeps whatever an issue carries until label sync renames the label in
-- place (`labelStep` in @fleetadlc/shared), and every reader accepts both names
-- until then. This brings the board's own copy of each issue's labels to the
-- new names at once, so the board, the routable query and the stage strip all
-- see one name rather than whichever the last delivery happened to carry. The
-- reconciler puts back what GitHub really has if label sync has not run yet.

update issues
set labels = array(
  select case
    when label like 'sdlc:%' then 'adlc:' || substr(label, 6)
    when label = 'fleet:ignore' then 'fleetadlc:ignore'
    else label
  end
  from unnest(labels) with ordinality as l(label, position)
  order by position
)
where labels && array['fleet:ignore']::text[]
   or exists (select 1 from unnest(labels) as label where label like 'sdlc:%');
