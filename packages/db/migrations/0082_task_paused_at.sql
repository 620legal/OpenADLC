-- When a task last went into `paused`.
--
-- A task answered while every host was full is resumed by a retry that lived
-- only in the bridge's memory, so a bridge that restarted in that hour left it
-- paused with its question answered and nothing to start it. The answered
-- gate is the durable record that a resume is owed, but only when the answer
-- came after the task paused: a task that resumed and paused again without a
-- new question (at its cost cap) still has that older answered gate.
-- `updated_at` does not say when it paused, since giving back a paused task's
-- computer bumps it too.

alter table tasks add column if not exists paused_at timestamptz;
update tasks set paused_at = updated_at where state = 'paused' and paused_at is null;
