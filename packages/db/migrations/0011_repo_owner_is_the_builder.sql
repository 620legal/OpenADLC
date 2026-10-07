-- A repository's owner is its builder.
--
-- The dispatcher leases a repository's implementation to its owner and to
-- every other bot with the owner's role. The walkthrough's "which repository
-- is this install for" used to make the automation account the owner — the
-- one bot every install is sure to have — and that account thinks with no
-- model, so the first request to reach implementation was handed to a bot that
-- could not do it. A repository added that way with no automation bot to name
-- got no owner at all, and was never dispatched.
--
-- Each such repository is given the builder: the bot in the `builder` seat,
-- or else the first other bot whose role is `implement`. An install with no
-- builder is left as it is; there is nobody to give it to. A repository
-- `config/repos.yaml` describes is seeded again after this runs, so what that
-- file names still wins.

with builder as (
  select id
  from bots
  where role = 'implement'
  order by (slot = 'builder') desc, slot
  limit 1
)
update repos
set owner_bot_id = (select id from builder),
    updated_at = now()
where exists (select 1 from builder)
  and (
    owner_bot_id is null
    or owner_bot_id in (select id from bots where role = 'automation')
  );
