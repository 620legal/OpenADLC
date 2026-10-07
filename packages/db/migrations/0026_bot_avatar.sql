-- The avatar each crew member shows, chosen on /crew or in Settings → Appearance.
--
-- A name from `packages/shared/src/avatars.ts`: one of the four marks Fleet
-- draws for an engine family, or `initials` for the two letters every avatar
-- used to be. The bridge refuses any other name.
--
-- Null is no choice: the mark of the engine the bot thinks with, so a bot
-- moved to another engine takes that engine's. Nothing is backfilled. It sits
-- beside `color` (0024), which it would have shared a migration with had the
-- two landed together.

alter table bots add column if not exists avatar text;
