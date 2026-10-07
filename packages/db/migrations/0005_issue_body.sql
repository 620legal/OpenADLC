-- The issue's own body, so the dispatcher can read what it says it waits for.
--
-- `blocked` was a note rather than a mechanism: nothing removed it, because the
-- Dependencies field lives in the body and the body was never stored. Keeping it
-- means the dispatcher can decide without a GitHub client of its own — the
-- bridge stays the only component that talks to GitHub — and means the decision
-- can be exercised in a demo install with no account at all.
alter table issues add column if not exists body text not null default '';
