-- `assist` is no longer a stage mode. Nothing ever read it differently
-- from `autonomous`: the bot did the stage's work either way, and the board's
-- badge promised a person in the loop that nothing put there. A repository
-- that has it is set to what it always did, and a new one no longer gets it.
-- The store maps it on read as well (`normaliseStageModes`), for a row a
-- restore brings back.
update repos
   set stage_modes = (
     select jsonb_object_agg(key, case when value = '"assist"'::jsonb then '"autonomous"'::jsonb else value end)
       from jsonb_each(stage_modes)
   ),
       updated_at = now()
 where stage_modes::text like '%"assist"%';

alter table repos
  alter column stage_modes set default
    '{"intake":"autonomous","spec":"conditional","build":"autonomous","review":"autonomous","merged":"autonomous","done":"autonomous"}';
