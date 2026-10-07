-- What a person with access stood behind on an issue whose author FleetADLC
-- does not act for. Labelling a stranger's issue is what lets the crew start
-- on it, and the label vouches for the text as it was then. GitHub lets the
-- author edit it at any time, and every later task re-read the live text:
-- an edit after the label steered the builder and widened Expected paths.
--
-- Null for every issue until the bridge takes a snapshot (`learnIssue`). Not
-- backfilled: SQL cannot tell which authors are unheard, and freezing the
-- text of people with access would lose their edits.

alter table issues add column if not exists vouched_title text;
alter table issues add column if not exists vouched_body text;
alter table issues add column if not exists vouched_by text;
alter table issues add column if not exists vouched_at timestamptz;
