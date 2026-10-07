-- How production ships, recorded per repository when it is set up: after a
-- named person approves (`reviewers`, with who), or automatically after a
-- soak on testing (`auto`). It fills what `.github/fleetadlc.yml`, or the
-- stored rules, leave out (`production.approval`, `production.soakMinutes`),
-- before the schema's default does.
--
-- The default was `reviewers`, and nothing asked who the reviewers were: on a
-- default install the production environment was written with none, and a
-- promote ran with nobody approving it. The default is `auto` now, with a
-- 30-minute soak. Every repository here before this migration keeps the rule
-- it had: `reviewers` and no soak, recorded explicitly, removed ones too, so
-- no running install changes mode in silence. A repository added after it
-- starts with no choice recorded until its setup asks.

alter table repos add column if not exists production_approval text
  check (production_approval in ('auto', 'reviewers'));
alter table repos add column if not exists production_soak_minutes integer;
alter table repos add column if not exists production_reviewers text[] not null default '{}';

update repos set production_approval = 'reviewers', production_soak_minutes = 0 where production_approval is null;
