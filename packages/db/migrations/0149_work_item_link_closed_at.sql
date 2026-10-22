-- When a work item's link was last seen to close or merge.
--
-- The board's Done column shows a card for a week from when it shipped. A
-- pull request alone on its item has no issue to say when, and its link kept
-- only `opened_at`: a pull opened eight days ago left Done the day it merged.
-- `seen_at` is no stand-in, since the reconciler's sweep refreshes it on
-- closed links too, and every closed lone pull would stay in Done for good.
--
-- - `closed_at`: set when a link's state goes from open to closed or merged,
--   or when it is first linked already closed by a delivery; cleared when it
--   reopens.
--
-- Nullable: a link closed before this migration, or numbered from history,
-- has no close time, and the board falls back to when it was opened.

alter table work_item_links add column if not exists closed_at timestamptz;
