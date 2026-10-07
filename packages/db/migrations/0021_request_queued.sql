-- A console request can wait its turn.
--
-- A request sent while the intake bot was triaging another one was refused as
-- busy after it had been written, and nothing started it again. It is now
-- `queued`, and the bridge starts queued requests oldest first once intake is
-- free (apps/bridge/src/request-queue.ts).
--
-- A queued request intake cannot start — a repository it cannot work in, say —
-- is not left at the head of the line holding every other one back: it is
-- passed over, and how many times and why is kept on it, so the console can
-- say, and a request tried too often waits for a person's "Try again".
--
-- Numbered 0021: 0020 is taken by another change in review.
alter table requests drop constraint if exists requests_state_check;
alter table requests add constraint requests_state_check
  check (state in ('queued', 'draft', 'questions', 'filed', 'abandoned'));

alter table requests add column if not exists queue_attempts int not null default 0;
alter table requests add column if not exists queue_reason text;

create index if not exists requests_queued on requests (created_at) where state = 'queued';
