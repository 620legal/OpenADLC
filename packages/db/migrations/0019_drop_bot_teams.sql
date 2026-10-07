-- `bots.teams` held the org teams config/bots.yaml said granted each seat its
-- repository role. Nothing read it: Fleet invites each bot as a collaborator
-- with the role its seat needs, and needs no organization or team. The release
-- before this one stopped reading and writing it but kept the column, because
-- every earlier release selects it by name, and on a cloud install the bridge
-- and the host each migrate as they start, while the other may still run the
-- previous release. So this is safe only once a release with that change
-- runs on both, one release at a time (docs/self-hosting.md, Upgrading).
alter table bots drop column if exists teams;
