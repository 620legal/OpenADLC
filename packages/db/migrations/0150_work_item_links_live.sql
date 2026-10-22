-- What the board reads of the work items' links: every link of the items
-- with a link still open, or closed in the week Done shows (`boardLinks`,
-- packages/db/src/store/work-items.ts).
--
-- The board read every link there had ever been, every fifteen seconds for
-- each person looking. These keep the read to the open links and those
-- closed since a time, however many closed before it, and each item's links
-- are then read by `work_item_links_item`.
--
-- - `work_item_links_open`: the items with a link still open.
-- - `work_item_links_closed`: links by when they closed, or opened for one
--   nobody saw close (numbered from history, or closed before 0149). Not
--   partial: on a partial index the planner has no statistics for the
--   expression, guessed a third of the table, and read every link to join.

create index if not exists work_item_links_open on work_item_links (work_item_id) where state = 'open';
create index if not exists work_item_links_closed on work_item_links ((coalesce(closed_at, opened_at)));
