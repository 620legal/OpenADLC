-- Which seat each bot sits in, apart from the name it goes by.
--
-- A bot is the GitHub account connected to it. Its name — the key its
-- container, work folder, secrets and sessions are all named by — becomes
-- that account's login, lowercased, and before an account connects it is the
-- seat's. The seat is the `config/bots.yaml` entry the row was seeded from
-- (`builder`, `lead-reviewer`), and `fleet up` now finds the row by it: a
-- name moves when an account connects, and a seed keyed by the name would add
-- a second row for the same bot.
--
-- Every existing row gets the seat its persona name was. A name this does not
-- recognise sits in a seat of its own name, which is what config/bots.yaml
-- would have to say to keep seeding it. If two rows would land in one seat —
-- an install with both an `atlas` and a bot somebody called `builder` — both
-- keep their own names as seats rather than failing `fleet up` on the unique
-- index below.
--
-- SQL cannot move a secret file, a folder or a container, so no bot is renamed
-- here. The bridge does that when it next starts, one bot at a time, through
-- the same routine that renames a bot when an account connects.

alter table bots add column if not exists slot text;

with wanted as (
  select id,
    case
      when name = 'mira' then 'intake'
      when name = 'nova' then 'system-engineer'
      when name = 'atlas' then 'builder'
      when name ~ '^atlas-[0-9]+$' then 'builder-' || substr(name, 7)
      when name = 'sydney' then 'lead-reviewer'
      when name = 'grok' then 'second-reviewer'
      when name = 'cipher' then 'security-reviewer'
      when name = 'harbor' then 'sre'
      when name = 'vega' then 'qa'
      when name = 'flow' then 'automation'
      else name
    end as slot
  from bots
),
contested as (
  select slot from wanted group by slot having count(*) > 1
)
update bots
set slot = case when wanted.slot in (select slot from contested) then bots.name else wanted.slot end
from wanted
where wanted.id = bots.id and bots.slot is null;

alter table bots alter column slot set not null;
alter table bots drop constraint if exists bots_slot_key;
alter table bots add constraint bots_slot_key unique (slot);

-- The name a bot had before a rename whose secrets have not all moved yet.
--
-- A rename moves the bot's container and folder, then its row, then its
-- secret files. The row is the point of no return: once it carries the new
-- name, the token broker refreshes under it, so a secret left under the old
-- name is the stale one. Set with the new name and cleared once the old files
-- are gone, so a bridge that stops in between finishes the move on its next
-- start instead of leaving a copy of a signing key under a name nothing uses.
alter table bots add column if not exists renamed_from text;
