-- 620legal/OpenADLC ships as a release: `v*` tags (release.yml), and an
-- install takes a change only from one. It has no testing environment, so
-- its deploy-testing skips every merge, and since #97 and #119 each card went
-- to Done at the next deploy sweep, "merging shipped it", while no install
-- had the change. Done means in a release here.
--
-- Its stored rules (`repos.delivery_rules`) say `testing.on: release`, which
-- a person changes in Settings → Repositories. It has no
-- `.github/openadlc.yml`, which would win over them. Rules already stored
-- keep everything else; none stored starts from version 1 and the defaults.
-- Only that repository, on an install that manages it: every other is left
-- as it is.

update repos
   set delivery_rules = coalesce(delivery_rules, '{"version": 1}'::jsonb)
         || jsonb_build_object('testing', coalesce(delivery_rules -> 'testing', '{}'::jsonb) || '{"on": "release"}'::jsonb),
       updated_at = now()
 where lower(full_name) = lower('620legal/OpenADLC');
