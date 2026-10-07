-- A color for each crew member's avatar, chosen in Settings → Appearance.
--
-- Every avatar was drawn in its role's tint, so two seats of one role, two
-- builders, looked the same, and nothing a person chose was kept. It is a
-- name from the palette in `packages/shared/src/crew-colors.ts`, never a
-- value: the console decides what each looks like in its dark mode and its
-- light one, and keeps the initials on it readable in both. The bridge refuses
-- any other name.
--
-- Null is no choice: the role's tint, as every bot had before. Nothing is
-- backfilled, so every avatar looks as it did until a person changes it.

alter table bots add column if not exists color text;
