-- A thread says which role and which seat it was a conversation with.
--
-- Seats that share one GitHub account (the crew account intake, design, build
-- and ship post as; the reviewer account the three reviewers approve as) are
-- one handle on GitHub, and the console told their conversations apart only by
-- the bot row, whose name follows the account. The role is what a person
-- means by "the lead reviewer said", so it is kept on the thread, from the bot
-- it was opened for, and never rewritten: a seat moved to another role later
-- does not move what was said in the old one.
alter table threads add column if not exists role text, add column if not exists seat text;

update threads t
   set role = b.role, seat = b.slot
  from bots b
 where b.id = t.bot_id and t.role is null;

-- A work item's conversation is every thread about any of its subjects (the
-- request, the issue, its pull request), read by subject rather than by bot.
create index if not exists threads_subject on threads (subject_ref);

-- And the item's stream asks every second whether any task on those subjects
-- changed: without this, a scan of every task the install ever ran.
create index if not exists tasks_subject on tasks (subject_ref);
