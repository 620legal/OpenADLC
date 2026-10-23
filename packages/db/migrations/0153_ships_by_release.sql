-- A repository that ships by release (`testing.on: release` in its delivery
-- rules): a merged card waits in Ship until a published release contains its
-- merge, then goes to Done saying which (apps/bridge/src/release-shipping.ts).
--
-- - `issues.shipped_at`: when a card in Done shipped, where its move to Done
--   says so: the release's publish time. The board read it from the card's
--   last deploy task, else from when its row last changed, which for a
--   release the deploy sweep found later is the sweep, not the release.
--   Cleared when the card leaves Done.
-- - `deploy_runs.merged_at`: when a merge was made. The sweep lists the
--   releases published since the oldest merge in Ship, and a merge whose
--   delivery was missed has its row written later than it was made.
--
-- Nullable: no card shipped this way before, and a merge's row is written
-- when it is made.

alter table issues add column if not exists shipped_at timestamptz;
alter table deploy_runs add column if not exists merged_at timestamptz;
