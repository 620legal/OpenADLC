-- A person's message to a role whose task is live waits here for that
-- task's session to take it at its next turn (`taskInbox.take`), or, when
-- the task stops being live first, is returned and starts the role's work
-- as a new message would (`taskInbox.settle`). Each row is claimed once, by
-- one `update … where state = 'queued' returning`, so a message is never
-- both read live and started again. See
-- docs/adr/0028-a-message-to-a-running-task-waits-in-its-inbox.md.
--
-- Additive, no backfill: a row is only ever written for a task that is live
-- after the bridge is upgraded.

create table if not exists task_inbox (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  bot_id uuid not null references bots(id) on delete cascade,
  role text not null,
  subject_ref text not null,
  -- The console identity that sent it, and its console role as the route checked it.
  sender text not null,
  sender_access text not null,
  text text not null,
  github_url text,
  state text not null default 'queued' check (state in ('queued', 'taken', 'returned')),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create index if not exists task_inbox_queued on task_inbox (task_id) where state = 'queued';

-- Whether the running session's engine takes a message between turns, as its
-- runner says with `running`; null until it does, and once it leaves running.
alter table tasks add column if not exists takes_messages boolean;
